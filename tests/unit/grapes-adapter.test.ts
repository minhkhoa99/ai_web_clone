import { expect, test } from "vitest";
import { AppError } from "@/core/errors";
import { grapesToPatch, irToGrapes, type GrapesComponent, type GrapesJson } from "@/core/grapes-adapter";
import { applyPatch, promoteLayout, type IR, type IRNode } from "@/core/ir";

const txt = (id: string, text: string): IRNode => ({ id, tag: "#text", attrs: {}, text, cls: [], children: [] });
const el = (id: string, tag: string, children: IRNode[] = [], attrs: Record<string, string> = {}, cls: string[] = []): IRNode => ({
  id,
  tag,
  attrs,
  cls,
  children,
});
const slot = (id: string, sectionId: string): IRNode => ({ id, tag: "#section", attrs: { "data-section": sectionId }, cls: [], children: [] });

// p1: hero + footer sections; p2: its own footer (same content as p1's, not yet a layout).
function sampleIr(): IR {
  const hero = el(
    "p1-s1",
    "section",
    [
      el("h", "h1", [txt("h.0", "Hello")], {}, ["c1"]),
      el("p", "p", [txt("p.0", "Body")]),
      el("a", "a", [txt("a.0", "Go")], { href: "https://x.test/go", onclick: "alert(1)" }),
    ],
    {},
    ["c2"],
  );
  const shell = (page: string, slots: IRNode[]) => el(`${page}:0`, "html", [el(`${page}:0.1`, "body", slots, {}, ["cb"])], { lang: "en" });
  return {
    pages: [
      { id: "p1", path: "/", title: "One", meta: {}, sectionIds: ["p1-s1", "p1-s2"], shell: shell("p1", [slot("p1:ph1", "p1-s1"), slot("p1:ph2", "p1-s2")]) },
      { id: "p2", path: "/two", title: "Two", meta: {}, sectionIds: ["p2-s1"], shell: shell("p2", [slot("p2:ph1", "p2-s1")]) },
    ],
    sections: [
      { id: "p1-s1", pageId: "p1", name: "hero", role: "section", hash: "h1", origin: "capture", root: hero },
      { id: "p1-s2", pageId: "p1", name: "footer", role: "footer", hash: "h2", origin: "capture", root: el("f1", "footer", [txt("f1.0", "(c)")]) },
      { id: "p2-s1", pageId: "p2", name: "footer", role: "footer", hash: "h2", origin: "capture", root: el("f2", "footer", [txt("f2.0", "(c)")]) },
    ],
    layouts: [],
    components: [],
    classes: { c1: { base: { color: "red" } }, c2: { base: { padding: "8px" } }, cb: { base: { margin: "0" } } },
    tokens: {},
    cssom: { keyframes: ["@keyframes spin{to{transform:rotate(1turn)}}"], fontFace: [], vars: {} },
    interactions: [],
  };
}

const OPTS = { assetMap: {}, pageUrls: {} };
// What the editor sends back: GrapesJS JSON (copied, so edits don't touch irToGrapes' output).
const grapesJson = (ir: IR, pageId = "p1"): GrapesJson & { components: GrapesComponent[] } =>
  JSON.parse(JSON.stringify({ components: irToGrapes(ir, pageId, OPTS).components, styles: [] })) as GrapesJson & { components: GrapesComponent[] };
const kids = (c: GrapesComponent) => c.components!;
const idsOf = (n: IRNode) => n.children.map((c) => c.id);
// a textnode as GrapesJS re-creates it after rich-text editing: no attributes
const textnode = (content: string) => ({ type: "textnode", content }) as GrapesComponent;

test("irToGrapes: page body with sections substituted, ids in data-ir-id, text elements editable, unsafe attrs left out", () => {
  const project = irToGrapes(sampleIr(), "p1", OPTS);
  expect(project.components.map((c) => c.attributes["data-ir-id"])).toEqual(["p1-s1", "f1"]);
  const [hero] = project.components;
  expect(hero).toMatchObject({ tagName: "section", classes: ["c2"], name: "hero" });
  expect(kids(hero!)[0]).toEqual({ tagName: "h1", type: "text", attributes: { "data-ir-id": "h" }, classes: ["c1"], components: [{ type: "textnode", content: "Hello", attributes: {}, classes: [] }] });
  expect(kids(hero!)[2]!.attributes).toEqual({ "data-ir-id": "a", href: "https://x.test/go" });
  expect(project.bodyClasses).toEqual(["cb"]);
  expect(project.styles).toContain(".c1{color:red}");
  expect(project.styles).toContain("@keyframes sp1-fade-in");
  expect(project.effects).toEqual(["spin", "sp1-fade-in", "sp1-slide-up"]);
  expect(project.sections.map((s) => [s.id, s.pageId])).toEqual([
    ["p1-s1", "p1"],
    ["p1-s2", "p1"],
    ["p2-s1", "p2"],
  ]);
  expect(project.pages).toEqual([
    { id: "p1", path: "/" },
    { id: "p2", path: "/two" },
  ]);
});

test("roundtrip with no edits -> zero ops", () => {
  const ir = sampleIr();
  expect(grapesToPatch(ir, "p1", grapesJson(ir))).toEqual({ ops: [], keyframes: [] });
});

test("a changed text -> exactly one setText on that #text node", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  kids(kids(json.components[0]!)[0]!)[0]!.content = "Hi there";
  const { ops } = grapesToPatch(ir, "p1", json);
  expect(ops).toEqual([{ op: "setText", id: "h.0", text: "Hi there" }]);
  expect(applyPatch(ir, ops).sections[0]!.root.children[0]!.children[0]!.text).toBe("Hi there");
});

test("RTE-style edit: textnodes re-created without attributes still map to the #text by position", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  kids(json.components[1]!)[0] = textnode("(c) 2026");
  expect(grapesToPatch(ir, "p1", json).ops).toEqual([{ op: "setText", id: "f1.0", text: "(c) 2026" }]);
});

test("attribute change -> setAttr; data-ir-id/class/style/id and event handlers are not diffed", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  const link = kids(json.components[0]!)[2]!;
  link.attributes = { ...link.attributes, href: "https://x.test/new", id: "i9x", style: "color:red", onmouseover: "x()" };
  expect(grapesToPatch(ir, "p1", json).ops).toEqual([{ op: "setAttr", id: "a", attrs: { href: "https://x.test/new" } }]);
});

test("component style (GrapesJS #id rule) -> setStyle with only the changed declarations", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  kids(json.components[0]!)[0]!.attributes.id = "iabc";
  json.styles = [
    { selectors: ["#iabc"], style: { color: "red", "font-size": "40px", "bad}": "x", width: "1px}body{x:y" } },
    { selectors: ["#iabc"], mediaText: "(max-width: 375px)", style: { color: "blue" } },
  ];
  const { ops } = grapesToPatch(ir, "p1", json);
  expect(ops).toEqual([{ op: "setStyle", id: "h", style: { "font-size": "40px" } }]);
  const next = applyPatch(ir, ops);
  const cls = next.sections[0]!.root.children[0]!.cls[0]!;
  expect(next.classes[cls]!.base).toEqual({ color: "red", "font-size": "40px" });
});

test("effect preset -> setStyle animation + the preset's @keyframes returned", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  json.components[1]!.attributes.id = "ifoot";
  json.styles = [{ selectors: [{ name: "ifoot", type: 2 }], style: { animation: "sp1-slide-up 600ms ease-out both" } }];
  const { ops, keyframes } = grapesToPatch(ir, "p1", json);
  expect(ops).toEqual([{ op: "setStyle", id: "f1", style: { animation: "sp1-slide-up 600ms ease-out both" } }]);
  expect(keyframes).toHaveLength(1);
  expect(keyframes[0]).toMatch(/^@keyframes sp1-slide-up\{/);
});

test("child removal -> one replaceSubtree of the parent, applied cleanly", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  kids(json.components[0]!).splice(1, 1);
  const { ops } = grapesToPatch(ir, "p1", json);
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({ op: "replaceSubtree", id: "p1-s1" });
  const root = applyPatch(ir, ops).sections[0]!.root;
  expect(idsOf(root)).toEqual(["h", "a"]);
  expect(root.cls).toEqual(["c2"]);
  expect(root.children[1]!.attrs).toEqual({ href: "https://x.test/go", onclick: "alert(1)" }); // IR attrs kept (emit strips on*)
});

test("added children: unsafe tags and attrs dropped, new nodes get <parentId>~<n> ids, known classes kept", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  kids(json.components[0]!).push(
    { tagName: "script", attributes: {}, classes: [], components: [textnode("alert(1)")] },
    { tagName: "b", attributes: { onclick: "x()", title: "t" }, classes: ["c1", "nope"], components: [textnode("New")] },
    { tagName: "img", attributes: { "bad name": "1", src: "https://x.test/i.png" }, classes: [] },
  );
  const { ops } = grapesToPatch(ir, "p1", json);
  expect(ops).toHaveLength(1);
  const next = applyPatch(ir, ops);
  const root = next.sections[0]!.root;
  expect(idsOf(root)).toEqual(["h", "p", "a", "p1-s1~1", "p1-s1~2"]);
  expect(root.children[3]).toEqual({
    id: "p1-s1~1",
    tag: "b",
    attrs: { title: "t" },
    cls: ["c1"],
    children: [{ id: "p1-s1~1~1", tag: "#text", attrs: {}, text: "New", cls: [], children: [] }],
  });
  expect(root.children[4]).toMatchObject({ tag: "img", attrs: { src: "https://x.test/i.png" } });
});

test("reordering sections in the body -> replaceSubtree of the body keeping the placeholders", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  json.components.reverse();
  const { ops } = grapesToPatch(ir, "p1", json);
  expect(ops).toHaveLength(1);
  const body = applyPatch(ir, ops).pages[0]!.shell.children[0]!;
  expect(body).toMatchObject({ id: "p1:0.1", cls: ["cb"] });
  expect(body.children).toEqual([slot("p1:ph2", "p1-s2"), slot("p1:ph1", "p1-s1")]);
});

test("a reorder plus an edit inside a moved section: both land (section root stays a section)", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  json.components.reverse();
  kids(json.components[0]!)[0]!.content = "(c) edited";
  const next = applyPatch(ir, grapesToPatch(ir, "p1", json).ops);
  expect(next.sections[1]!.root.children[0]!.text).toBe("(c) edited");
  expect(next.pages[0]!.shell.children[0]!.children.map((c) => c.tag)).toEqual(["#section", "#section"]);
});

test("top-level components without data-ir-id are ignored", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  json.components.push({ tagName: "div", attributes: {}, classes: [], components: [textnode("stray")] });
  expect(grapesToPatch(ir, "p1", json).ops).toEqual([]);
});

test("a section copy dropped from another page gets fresh ids (never a duplicate id)", () => {
  const ir = sampleIr();
  const json = grapesJson(ir);
  const block = irToGrapes(ir, "p2", OPTS).sections.find((s) => s.id === "p2-s1")!.component;
  kids(json.components[0]!).push(JSON.parse(JSON.stringify(block)) as GrapesComponent);
  const next = applyPatch(ir, grapesToPatch(ir, "p1", json).ops);
  const added = next.sections[0]!.root.children[3]!;
  expect(added).toMatchObject({ id: "p1-s1~1", tag: "footer", children: [{ id: "p1-s1~1~1", text: "(c)" }] });
});

test("oversized editor JSON -> IR_PATCH_INVALID", () => {
  const ir = sampleIr();
  let deep: GrapesComponent = { tagName: "div", attributes: {}, classes: [] };
  for (let i = 0; i < 600; i++) deep = { tagName: "div", attributes: {}, classes: [], components: [deep] };
  expect(() => grapesToPatch(ir, "p1", { components: [deep] })).toThrow(AppError);
});

test("layout sections are labelled 'Layout chung'", () => {
  const ir = promoteLayout(sampleIr(), ["p1-s2", "p2-s1"]);
  const project = irToGrapes(ir, "p2", OPTS);
  expect(project.components[0]).toMatchObject({ name: "Layout chung · footer", attributes: { "data-ir-id": "f1" } });
});

test("promoteLayout: first section becomes the layout, the other page's copy is dropped and its placeholder repointed", () => {
  const ir = sampleIr();
  const next = promoteLayout(ir, ["p1-s2", "p2-s1"]);
  expect(next.sections.map((s) => s.id)).toEqual(["p1-s1", "p1-s2"]);
  const layout = next.layouts[0]!;
  expect(next.layouts).toHaveLength(1);
  expect(layout).toMatchObject({ sectionId: "p1-s2", hash: "h2", pageIds: ["p1", "p2"] });
  expect(layout.id).toMatch(/^layout-[0-9a-f]{6}$/);
  expect(next.sections[1]!.layoutId).toBe(layout.id);
  expect(next.pages[1]!.sectionIds).toEqual(["p1-s2"]);
  expect(next.pages[1]!.shell.children[0]!.children[0]).toEqual(slot("p2:ph1", "p1-s2"));
  expect(ir.sections).toHaveLength(3); // pure
  // editing the layout on page 2 patches the one shared copy
  const json = grapesJson(next, "p2");
  kids(json.components[0]!)[0]!.content = "shared";
  expect(grapesToPatch(next, "p2", json).ops).toEqual([{ op: "setText", id: "f1.0", text: "shared" }]);
});

test("promoteLayout rejects sections on the same page, unknown ids and a single section", () => {
  const ir = sampleIr();
  const code = (ids: string[]) => {
    try {
      promoteLayout(ir, ids);
      return "ok";
    } catch (e) {
      return e instanceof AppError ? e.code : "other";
    }
  };
  expect(code(["p1-s1", "p1-s2"])).toBe("IR_PATCH_INVALID");
  expect(code(["p1-s1", "nope"])).toBe("IR_PATCH_INVALID");
  expect(code(["p1-s1"])).toBe("IR_PATCH_INVALID");
});
