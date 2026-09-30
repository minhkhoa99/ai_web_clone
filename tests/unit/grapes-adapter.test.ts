import { expect, test } from "vitest";
import { AppError } from "@/core/errors";
import { compileV2, renderSiteV2 } from "@/core/emit-html";
import { styleTargetFidelity } from "@/core/fidelity";
import { grapesToCommands, irIdsByElementId, irToGrapes, type GrapesComponent, type GrapesJson } from "@/core/grapes-adapter";
import { promoteLayout, syncSections, type IR, type IRNode } from "@/core/ir";
import { applyCommands, prepareCommands, type EditorCommand } from "@/core/ir-command";
import { promoteLegacyComponents, resolveComponents } from "@/core/ir-component";
import { toV2, type IRNodeV2, type IRV2 } from "@/core/ir-v2";

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
const doc = (ir: IR = sampleIr()): IRV2 => toV2(ir, []);
// What the editor sends back: GrapesJS JSON of the canvas built from the document (copied: edits don't touch it).
const grapesJson = (d: IRV2, pageId = "p1", opts: typeof OPTS = OPTS): GrapesJson & { components: GrapesComponent[] } =>
  JSON.parse(JSON.stringify({ components: irToGrapes(compileV2(d), pageId, opts).components, styles: [] })) as GrapesJson & { components: GrapesComponent[] };
const kids = (c: GrapesComponent) => c.components!;
// a textnode as GrapesJS re-creates it after rich-text editing: no attributes
const textnode = (content: string) => ({ type: "textnode", content }) as GrapesComponent;
// the commands as the server stores them: IDs allocated, validated and applied in order
const apply = (d: IRV2, commands: EditorCommand[]) => {
  let n = 0;
  return applyCommands(d, prepareCommands(d, commands, () => `new${++n}`)).ir;
};
const ids = (n: { children: { id: string }[] }) => n.children.map((c) => c.id);
const section = (d: IRV2, id: string) => d.sections.find((s) => s.id === id)!.root;

// --- IR -> GrapesJS (the canvas is the compiled display view) ------------------------

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

test("irToGrapes of a v2 document (compileV2): every element carries its IR id, styles come from the derived classes", () => {
  const project = irToGrapes(compileV2(doc()), "p1", OPTS);
  const all = (c: GrapesComponent): GrapesComponent[] => [c, ...(c.components ?? []).flatMap(all)];
  const elements = project.components.flatMap(all).filter((c) => c.type !== "textnode");
  expect(elements.map((c) => c.attributes["data-ir-id"])).toEqual(["p1-s1", "h", "p", "a", "f1"]);
  expect(project.styles).toMatch(/color:red/);
});

test("canvas: <script>/<meta> and script-valued attrs never shown, and not diffed either", () => {
  const ir = sampleIr();
  const hero = ir.sections[0]!.root;
  hero.children.push(el("m", "meta", [], { "http-equiv": "refresh", content: "0;url=https://evil.test" }), el("sc", "script", [txt("sc.0", "x()")]));
  hero.children.push(el("an", "animate", [], { attributeName: "href", values: "#a;javascript:alert(1)" }));
  const project = irToGrapes(ir, "p1", OPTS);
  expect(kids(project.components[0]!).map((c) => c.tagName)).toEqual(["h1", "p", "a", "animate"]);
  expect(kids(project.components[0]!)[3]!.attributes).toEqual({ "data-ir-id": "an", attributeName: "href" });
  const d = doc(ir);
  expect(grapesToCommands(d, "p1", grapesJson(d), OPTS)).toEqual([]);
  // a structural edit next to the hidden nodes keeps them (indices count them)
  const json = grapesJson(d);
  kids(json.components[0]!).reverse();
  const out = section(apply(d, grapesToCommands(d, "p1", json, OPTS)), "p1-s1");
  expect(ids(out)).toEqual(["an", "a", "p", "h", "m", "sc"]);
});

// The canvas is based on out/<page file>: attrs are shown as the emitter writes them (downloaded asset -> local path).
const SHA = "a".repeat(64);
const ASSET_OPTS = { assetMap: { "https://x.test/img/logo.png": `assets/${SHA}.png` }, pageUrls: { p1: "https://x.test/", p2: "https://x.test/two" } };
const withLogo = () => {
  const ir = sampleIr();
  ir.sections[0]!.root.children.push(el("img", "img", [], { src: "img/logo.png", alt: "logo" }));
  ir.classes.c2 = { base: { background: "url(https://x.test/img/logo.png)" } };
  return ir;
};

test("canvas: page file for the <base>, img src and stylesheet urls point at the local out/ assets", () => {
  const project = irToGrapes(withLogo(), "p1", ASSET_OPTS);
  expect(project.pageFile).toBe("index.html");
  expect(kids(project.components[0]!)[3]!.attributes).toEqual({ "data-ir-id": "img", src: `assets/${SHA}.png`, alt: "logo" });
  expect(project.styles).toContain(`url(assets/${SHA}.png)`); // relative to out/, not out/css/
  expect(project.styles).not.toContain("../assets/");
});

test("layout sections are labelled 'Layout chung'", () => {
  const ir = promoteLayout(sampleIr(), ["p1-s2", "p2-s1"]);
  const project = irToGrapes(ir, "p2", OPTS);
  expect(project.components[0]).toMatchObject({ name: "Layout chung · footer", attributes: { "data-ir-id": "f1" } });
});

test("irToGrapes: markup-looking text stays a textnode (content = raw text, no element), in a text element and bare", () => {
  const ir = sampleIr();
  const evil = '<img src=x onerror="alert(1)">';
  ir.sections[0]!.root.children[0]!.children[0]!.text = evil; // h1 text
  ir.sections[0]!.root.children.push(txt("bare", evil));
  const [hero] = irToGrapes(ir, "p1", OPTS).components;
  expect(kids(kids(hero!)[0]!)).toEqual([{ type: "textnode", content: evil, attributes: {}, classes: [] }]);
  expect(kids(hero!).at(-1)).toEqual({ type: "textnode", content: evil, attributes: {}, classes: [] });
  expect(JSON.stringify(hero)).not.toContain('"tagName":"img"');
});

// --- GrapesJS -> editor commands ------------------------------------------------------

test("roundtrip with no edits -> no commands (display urls map back to the raw ones)", () => {
  expect(grapesToCommands(doc(), "p1", grapesJson(doc()), OPTS)).toEqual([]);
  const d = doc(withLogo());
  expect(grapesToCommands(d, "p1", grapesJson(d, "p1", ASSET_OPTS), ASSET_OPTS)).toEqual([]);
});

test("reordering siblings keeps their IDs: moveNode, never replaceSubtree", () => {
  const d = doc();
  const json = grapesJson(d);
  const hero = kids(json.components[0]!);
  [hero[0], hero[1]] = [hero[1]!, hero[0]!];
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toContainEqual({ op: "moveNode", id: "p", parentId: "p1-s1", index: 0 });
  expect(commands).toHaveLength(1);
  expect(JSON.stringify(commands)).not.toContain("replaceSubtree");
  expect(ids(section(apply(d, commands), "p1-s1"))).toEqual(["p", "h", "a"]);
});

test("a node moved into another parent of the same section keeps its ID", () => {
  const d = doc();
  const json = grapesJson(d);
  const hero = kids(json.components[0]!);
  const [link] = hero.splice(2, 1);
  kids(hero[1]!).push(link!); // <a> into the <p>
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toEqual([{ op: "moveNode", id: "a", parentId: "p", index: 1 }]);
  const p = section(apply(d, commands), "p1-s1").children[1]!;
  expect(ids(p)).toEqual(["p.0", "a"]);
});

test("reordering sections in the body moves the shell placeholders", () => {
  const d = doc();
  const json = grapesJson(d);
  json.components.reverse();
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toEqual([{ op: "moveNode", id: "p1:ph2", parentId: "p1:0.1", index: 0 }]);
  const next = apply(d, commands);
  expect(next.pages[0]!.shell.children[0]!.children.map((c) => c.attrs["data-section"])).toEqual(["p1-s2", "p1-s1"]);
  expect(next.pages[0]!.sectionIds).toEqual(["p1-s2", "p1-s1"]);
});

test("a reorder plus an edit inside a moved section: both land", () => {
  const d = doc();
  const json = grapesJson(d);
  json.components.reverse();
  kids(json.components[0]!)[0]!.content = "(c) edited";
  const next = apply(d, grapesToCommands(d, "p1", json, OPTS));
  expect(section(next, "p1-s2").children[0]!.text).toBe("(c) edited");
  expect(next.pages[0]!.shell.children[0]!.children.map((c) => c.tag)).toEqual(["#section", "#section"]);
});

test("a changed text -> one setText; RTE-recreated textnodes still map to the #text by position", () => {
  const d = doc();
  const json = grapesJson(d);
  kids(kids(json.components[0]!)[0]!)[0]!.content = "Hi there";
  kids(json.components[1]!)[0] = textnode("(c) 2026");
  expect(grapesToCommands(d, "p1", json, OPTS)).toEqual([
    { op: "setText", id: "h.0", text: "Hi there" },
    { op: "setText", id: "f1.0", text: "(c) 2026" },
  ]);
});

test("attribute change -> setAttribute; a removed attribute -> null; data-ir-id/class/style/id and handlers are not diffed", () => {
  const d = doc(withLogo());
  const json = grapesJson(d, "p1", ASSET_OPTS);
  const hero = kids(json.components[0]!);
  hero[2]!.attributes = { ...hero[2]!.attributes, href: "https://x.test/new", id: "i9x", style: "color:red", onmouseover: "x()" };
  hero[3]!.attributes = { "data-ir-id": "img", src: `assets/${SHA}.png` }; // alt removed, src still the display value
  const commands = grapesToCommands(d, "p1", json, ASSET_OPTS);
  expect(commands).toEqual([
    { op: "setAttribute", id: "a", name: "href", value: "https://x.test/new" },
    { op: "setAttribute", id: "img", name: "alt", value: null },
  ]);
  const next = section(apply(d, commands), "p1-s1");
  expect(next.children[3]!.attrs).toEqual({ src: "img/logo.png" });
  expect(next.children[2]!.attrs).toEqual({ href: "https://x.test/new", onclick: "alert(1)" }); // IR attrs kept (emit strips on*)
});

test("deleted children and sections -> deleteNode (a section's placeholder); the page's sectionIds follow", () => {
  const d = doc();
  const json = grapesJson(d);
  kids(json.components[0]!).splice(1, 1);
  json.components.pop(); // the footer section
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toEqual([
    { op: "deleteNode", id: "p" },
    { op: "deleteNode", id: "p1:ph2" },
  ]);
  const next = apply(d, commands);
  expect(ids(section(next, "p1-s1"))).toEqual(["h", "a"]);
  expect(next.pages[0]!.sectionIds).toEqual(["p1-s1"]);
  expect(next.sections.map((s) => s.id)).toEqual(["p1-s1", "p2-s1"]);
});

test("deleting a shared layout on one page keeps it for the others", () => {
  const d = toV2(promoteLayout(sampleIr(), ["p1-s2", "p2-s1"]), []);
  const json = grapesJson(d, "p1");
  json.components.pop();
  const next = apply(d, grapesToCommands(d, "p1", json, OPTS));
  expect(next.pages.map((p) => p.sectionIds)).toEqual([["p1-s1"], ["p1-s2"]]);
  expect(next.layouts).toEqual([{ ...d.layouts[0]!, pageIds: ["p2"] }]);
});

test("added children -> createNode drafts at their index: unsafe tags/attrs dropped, the server allocates the IDs", () => {
  const d = doc();
  const json = grapesJson(d);
  kids(json.components[0]!).splice(
    1,
    0,
    { tagName: "script", attributes: {}, classes: [], components: [textnode("alert(1)")] },
    { tagName: "b", attributes: { onclick: "x()", title: "t", "data-ir-id": "stale-or-forged" }, classes: [], components: [textnode("New")] },
  );
  kids(json.components[0]!).push({ tagName: "img", attributes: { "bad name": "1", src: "https://x.test/i.png" }, classes: [] }, { type: "link", attributes: {}, classes: [] });
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toEqual([
    { op: "createNode", parentId: "p1-s1", index: 1, draft: { tag: "b", attrs: { title: "t" }, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [{ tag: "#text", text: "New" }] } },
    { op: "createNode", parentId: "p1-s1", index: 4, draft: { tag: "img", attrs: { src: "https://x.test/i.png" }, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [] } },
    { op: "createNode", parentId: "p1-s1", index: 5, draft: { tag: "a", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [] } },
  ]);
  const root = section(apply(d, commands), "p1-s1");
  expect(root.children.map((c) => c.tag)).toEqual(["h1", "b", "p", "a", "img", "a"]);
  expect(root.children[1]!.id).toBe("new1");
});

test("a section copy dropped from another page is created from its source (raw attrs, resolved styles), with new IDs", () => {
  const ir = sampleIr();
  ir.sections[2]!.root.cls = ["c1"];
  const d = doc(ir);
  const json = grapesJson(d);
  const block = irToGrapes(compileV2(d), "p2", OPTS).sections.find((s) => s.id === "p2-s1")!.component;
  kids(json.components[0]!).push(JSON.parse(JSON.stringify(block)) as GrapesComponent);
  const [command] = grapesToCommands(d, "p1", json, OPTS);
  expect(command).toEqual({
    op: "createNode", parentId: "p1-s1", index: 3,
    draft: { tag: "footer", type: "container", attrs: {}, styles: { base: { color: "red" }, bp: {}, state: {}, pseudo: {} }, children: [{ tag: "#text", text: "(c)" }] },
  });
});

test("a node dragged into another section is re-created there and deleted from its own (a node never changes tree)", () => {
  const d = doc();
  const json = grapesJson(d);
  const [heading] = kids(json.components[0]!).splice(0, 1);
  kids(json.components[1]!).push(heading!);
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands.map((c) => c.op)).toEqual(["createNode", "deleteNode"]);
  const next = apply(d, commands);
  expect(section(next, "p1-s2").children.map((c) => c.tag)).toEqual(["#text", "h1"]);
  expect(section(next, "p1-s2").children[1]!.styles.base).toEqual({ color: "red" });
  expect(ids(section(next, "p1-s1"))).toEqual(["p", "a"]);
});

test("the page body only holds sections: a new element there is refused; id-less stray top-level components are ignored", () => {
  const d = doc();
  const stray = grapesJson(d);
  stray.components.push({ tagName: "div", attributes: {}, classes: [], components: [textnode("stray")] });
  expect(grapesToCommands(d, "p1", stray, OPTS)).toEqual([]);
  const dropped = grapesJson(d);
  dropped.components.push(JSON.parse(JSON.stringify(irToGrapes(compileV2(d), "p2", OPTS).components[0])) as GrapesComponent);
  expect(() => grapesToCommands(d, "p1", dropped, OPTS)).toThrow("Thân trang chỉ chứa section: thả khối hoặc phần tử mới vào bên trong một section.");
});

test("component styles: base / 768 / 375 / hover targets from mediaText + state; '' removes; unsafe and unrepresentable are skipped", () => {
  const d = doc();
  const json = grapesJson(d);
  kids(json.components[0]!)[0]!.attributes.id = "iabc";
  json.styles = [
    { selectors: ["#iabc"], style: { color: "red", "font-size": "40px", "bad}": "x", width: "1px}body{x:y" } },
    { selectors: ["#iabc"], style: { color: "blue" }, mediaText: "(max-width: 1439.98px)", atRuleType: "media" },
    { selectors: [{ name: "iabc", type: 2 }], style: { color: "green" }, mediaText: "(max-width: 767.98px)", atRuleType: "media" },
    { selectors: ["#iabc"], style: { color: "pink" }, state: "hover" },
    { selectors: ["#iabc"], style: { color: "gold" }, state: "hover", mediaText: "(max-width: 767.98px)", atRuleType: "media" },
    { selectors: ["#iabc"], style: { color: "gold" }, mediaText: "(min-width: 2000px)", atRuleType: "media" },
  ];
  const skipped: string[] = [];
  const commands = grapesToCommands(d, "p1", json, { ...OPTS, skipped });
  expect(commands).toEqual([
    { op: "setStyle", id: "h", target: "base", changes: { "font-size": "40px" } },
    { op: "setStyle", id: "h", target: 768, changes: { color: "blue" } },
    { op: "setStyle", id: "h", target: 375, changes: { color: "green" } },
    { op: "setStyle", id: "h", target: "hover", changes: { color: "pink" } },
  ]);
  expect(skipped).toHaveLength(2);
  // Save: the skipped rules name the GrapesJS element id; irIdsByElementId maps it to the IR node for Fidelity
  const irIds = irIdsByElementId(json.components);
  expect(irIds.get("iabc")).toBe("h");
  expect(styleTargetFidelity("p1", skipped, (x) => irIds.get(x)).map((x) => [x.feature, x.status, x.nodeId])).toEqual([["style-target", "unsupported", "h"], ["style-target", "unsupported", "h"]]);
  const h = section(apply(d, commands), "p1-s1").children[0]!;
  expect(h.styles).toEqual({ base: { color: "red", "font-size": "40px" }, bp: { 768: { color: "blue" }, 375: { color: "green" } }, state: { hover: { color: "pink" } }, pseudo: {} });

  const cleared = grapesJson(d);
  kids(cleared.components[0]!)[0]!.attributes.id = "iabc";
  cleared.styles = [{ selectors: ["#iabc"], style: { color: "" } }];
  expect(grapesToCommands(d, "p1", cleared, OPTS)).toEqual([{ op: "setStyle", id: "h", target: "base", changes: { color: null } }]);
});

test("effect preset -> setStyle animation; the emitted CSS carries the preset's @keyframes", () => {
  const d = doc();
  const json = grapesJson(d);
  json.components[1]!.attributes.id = "ifoot";
  json.styles = [{ selectors: [{ name: "ifoot", type: 2 }], style: { animation: "sp1-slide-up 600ms ease-out both" } }];
  const commands = grapesToCommands(d, "p1", json, OPTS);
  expect(commands).toEqual([{ op: "setStyle", id: "f1", target: "base", changes: { animation: "sp1-slide-up 600ms ease-out both" } }]);
  const css = renderSiteV2(apply(d, commands), OPTS)["css/styles.css"]!;
  expect(css.match(/@keyframes sp1-slide-up\{/g)).toHaveLength(1);
  expect(renderSiteV2(d, OPTS)["css/styles.css"]).not.toContain("sp1-slide-up");
});

test("the Layers eye (display:none on the base rule) -> setHidden plus the display style", () => {
  const d = doc();
  const json = grapesJson(d);
  kids(json.components[0]!)[1]!.attributes.id = "ip";
  json.styles = [{ selectors: ["#ip"], style: { display: "none" } }];
  expect(grapesToCommands(d, "p1", json, OPTS)).toEqual([
    { op: "setStyle", id: "p", target: "base", changes: { display: "none" } },
    { op: "setHidden", id: "p", hidden: true },
  ]);
});

test("a refused attribute value keeps the old value and is reported, never deleted", () => {
  const d = doc();
  const json = grapesJson(d);
  const link = kids(json.components[0]!)[2]!;
  link.attributes = { ...link.attributes, href: "javascript:alert(1)", title: "ok" };
  const skipped: string[] = [];
  expect(grapesToCommands(d, "p1", json, { ...OPTS, skipped })).toEqual([{ op: "setAttribute", id: "a", name: "title", value: "ok" }]);
  expect(skipped).toEqual(["a [href]"]);
});

test("unhide: a hidden node whose base display becomes visible again -> setHidden(false)", () => {
  const ir = sampleIr();
  const p = ir.sections[0]!.root.children[1]!;
  p.hidden = true;
  p.cls = ["gone"];
  ir.classes.gone = { base: { display: "none" } };
  const d = doc(ir);
  const json = grapesJson(d);
  kids(json.components[0]!)[1]!.attributes.id = "ip";
  json.styles = [{ selectors: ["#ip"], style: { display: "block" } }];
  expect(grapesToCommands(d, "p1", json, OPTS)).toEqual([
    { op: "setStyle", id: "p", target: "base", changes: { display: "block" } },
    { op: "setHidden", id: "p", hidden: false },
  ]);
  json.styles = [{ selectors: ["#ip"], style: { display: "" } }];
  expect(grapesToCommands(d, "p1", json, OPTS)).toEqual([
    { op: "setStyle", id: "p", target: "base", changes: { display: null } },
    { op: "setHidden", id: "p", hidden: false },
  ]);
});

test("preset keyframes match the animation name exactly, not a substring", () => {
  const d = doc();
  const json = grapesJson(d);
  json.components[1]!.attributes.id = "ifoot";
  json.styles = [{ selectors: ["#ifoot"], style: { animation: "my-sp1-fade-in-x 1s", "animation-name": "sp1-fade-inner" } }];
  const css = renderSiteV2(apply(d, grapesToCommands(d, "p1", json, OPTS)), OPTS)["css/styles.css"]!;
  expect(css).not.toContain("@keyframes sp1-fade-in");
  json.styles = [{ selectors: ["#ifoot"], style: { animation: "fast, sp1-fade-in 1s" } }];
  expect(renderSiteV2(apply(d, grapesToCommands(d, "p1", json, OPTS)), OPTS)["css/styles.css"]).toContain("@keyframes sp1-fade-in{");
});

// cards: three instances of one main; after promotion the main gains a child, which the instances show under
// generated IDs that are not in the document.
const cards = (): IRV2 => {
  const l = (id: string, tag: string, children: IRNode[] = [], text?: string): IRNode => ({ id, tag, attrs: {}, cls: [], children, ...(text === undefined ? {} : { text }) });
  const v1: IR = {
    pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: l("shell", "html", [l("body", "body", [{ ...l("ph", "#section"), attrs: { "data-section": "s" } }])]) }],
    sections: [{ id: "s", pageId: "p", name: "cards", role: "main", hash: "s", origin: "capture", root: l("section", "section", [0, 1].map((i) => l(`card${i}`, "article", [l(`label${i}`, "span", [l(`text${i}`, "#text", [], `Card ${i}`)])]))) }],
    components: [{ id: "cards", hash: "cards", instanceIds: ["card0", "card1"] }],
    classes: {}, layouts: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [],
  };
  const promoted = promoteLegacyComponents(toV2(v1, []), v1.components);
  const main = promoted.components[0]!.root;
  return apply(promoted, [{ op: "createNode", parentId: main.id, index: 1, draft: { tag: "small", children: [{ tag: "#text", text: "new" }] } }]);
};

test("instances: edits on document nodes stay on the instance; edits on generated IDs go to the main node; no unknown ID is sent", () => {
  const d = cards();
  const json = grapesJson(d, "p");
  const [card0] = kids(json.components[0]!);
  kids(kids(card0!)[0]!)[0]!.content = "Zero";
  const generated = kids(card0!)[1]!;
  expect(generated.attributes["data-ir-id"]).toMatch(/^instance:/);
  generated.attributes.title = "t";
  kids(generated)[0]!.content = "changed in main";
  const commands = grapesToCommands(d, "p", json, OPTS);
  const main = d.components[0]!.root;
  const small = main.children[1]!;
  expect(commands).toEqual([
    { op: "setText", id: "text0", text: "Zero" },
    { op: "setText", id: small.children[0]!.id, text: "changed in main" },
    { op: "setAttribute", id: small.id, name: "title", value: "t" },
  ]);
  const known = new Set<string>();
  const visit = (n: IRNodeV2): void => { known.add(n.id); n.children.forEach(visit); };
  [...d.sections.map((s) => s.root), ...d.components.map((c) => c.root)].forEach(visit);
  for (const c of commands) expect(known.has((c as { id: string }).id)).toBe(true);
  const shown = resolveComponents(apply(d, commands)).sections[0]!.root.children;
  expect(shown.map((c) => c.children[1]!.attrs.title)).toEqual(["t", "t"]); // the main edit reaches both instances
});

test("instances: structure inside an instance is refused with a clear message", () => {
  const d = cards();
  const json = grapesJson(d, "p");
  kids(kids(json.components[0]!)[0]!).reverse();
  expect(() => grapesToCommands(d, "p", json, OPTS)).toThrow(/component instance/);
});

test("oversized editor JSON -> IR_PATCH_INVALID", () => {
  let deep: GrapesComponent = { tagName: "div", attributes: {}, classes: [] };
  for (let i = 0; i < 600; i++) deep = { tagName: "div", attributes: {}, classes: [], components: [deep] };
  expect(() => grapesToCommands(doc(), "p1", { components: [deep] }, OPTS)).toThrow(AppError);
  const wide = { components: Array.from({ length: 60_001 }, () => ({ tagName: "div", attributes: {}, classes: [] })) };
  expect(() => grapesToCommands(doc(), "p1", wide, OPTS)).toThrow(/60000 nodes/);
});

test("an unknown page is refused", () => {
  expect(() => grapesToCommands(doc(), "nope", { components: [] }, OPTS)).toThrow(AppError);
});

// --- ir.ts layout helpers (still shared by the promoteLayout command) ------------------

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
  // editing the layout on page 2 edits the one shared copy
  const d = toV2(next, []);
  const json = grapesJson(d, "p2");
  kids(json.components[0]!)[0]!.content = "shared";
  expect(grapesToCommands(d, "p2", json, OPTS)).toEqual([{ op: "setText", id: "f1.0", text: "shared" }]);
});

test("syncSections on an unedited IR changes nothing", () => {
  const ir = promoteLayout(sampleIr(), ["p1-s2", "p2-s1"]);
  expect(syncSections(ir)).toEqual(ir);
});

test("promoteLayout: a layout already shown on p1+p2 can't be merged with a section of p2", () => {
  const base = sampleIr();
  base.pages[1]!.sectionIds.push("p2-s2");
  base.pages[1]!.shell.children[0]!.children.push(slot("p2:ph2", "p2-s2"));
  base.sections.push({ id: "p2-s2", pageId: "p2", name: "extra", role: "section", hash: "h3", origin: "capture", root: el("x2", "div", [txt("x2.0", "x")]) });
  const ir = promoteLayout(base, ["p1-s2", "p2-s1"]); // layout L on p1 + p2
  expect(() => promoteLayout(ir, ["p1-s2", "p2-s2"])).toThrow(/different pages/);
  expect(() => promoteLayout(ir, ["p2-s2", "p1-s2"])).toThrow(AppError);
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
