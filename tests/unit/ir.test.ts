import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import type { Interaction } from "@/core/interactions";
import { AppError } from "@/core/errors";
import { applyPatch, buildIR, type IR, type IRNode } from "@/core/ir";

type Opts = { style?: Record<string, string>; bbox?: [number, number, number, number]; pseudo?: CaptureNode["pseudo"]; hidden?: boolean };

function el(tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], opts: Opts = {}): CaptureNode {
  const node: CaptureNode = { tag, attrs, bbox: opts.bbox ?? [0, 0, 100, 20], style: opts.style ?? {}, children };
  if (opts.pseudo) node.pseudo = opts.pseudo;
  if (opts.hidden) node.hidden = true;
  return node;
}

function txt(text: string): CaptureNode {
  return { tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] };
}

function doc(body: CaptureNode[]): CaptureNode {
  return el("html", {}, [el("head", {}, [el("title", {}, [txt("t")])]), el("body", {}, body)]);
}

type CapOpts = { dom768?: CaptureNode; dom375?: CaptureNode; interactions?: Interaction[]; dynamic?: PageCapture["dynamic"] };

function capture(pageId: string, url: string, dom: CaptureNode, opts: CapOpts = {}): PageCapture {
  return {
    url,
    pageId,
    capturedAt: "2026-09-23T00:00:00.000Z",
    title: `title ${pageId}`,
    meta: { description: pageId },
    cssom: { keyframes: ["@keyframes a {}"], fontFace: [], media: [], vars: { "--x": pageId }, stateSelectors: [] },
    breakpoints: [
      { bp: 1440, dom, truncated: false },
      { bp: 768, dom: opts.dom768 ?? dom, truncated: false },
      { bp: 375, dom: opts.dom375 ?? dom, truncated: false },
    ],
    interactions: opts.interactions ?? [],
    assets: {},
    skippedAssets: [],
    dynamic: opts.dynamic ?? [],
  };
}

const header = () => el("header", { class: "top" }, [el("a", { href: "/" }, [txt("Logo")])], { style: { color: "red" } });

function find(ir: IR, id: string): IRNode | undefined {
  const walk = (n: IRNode): IRNode | undefined => (n.id === id ? n : n.children.map(walk).find(Boolean));
  return ir.sections.map((s) => walk(s.root)).find(Boolean);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("two pages with the same header -> one layout, header stored once, both pages reference it", () => {
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([header(), el("section", {}, [el("h1", {}, [txt("Home")])])])),
    capture("p2", "https://x.test/about?a=1", doc([header(), el("article", {}, [el("p", {}, [txt("About")])])])),
  ]);

  expect(ir.layouts).toHaveLength(1);
  const layout = ir.layouts[0]!;
  expect(layout.pageIds).toEqual(["p1", "p2"]);
  expect(layout.sectionId).toBe("p1-s1");
  expect(layout.id).toMatch(/^layout-[0-9a-f]{6}$/);
  expect(layout.hash).toBe(ir.sections[0]!.hash);
  expect(ir.sections.filter((s) => s.role === "header")).toHaveLength(1);
  expect(ir.sections.find((s) => s.id === "p1-s1")?.layoutId).toBe(layout.id);
  expect(ir.pages.map((p) => p.sectionIds)).toEqual([
    ["p1-s1", "p1-s2"],
    ["p1-s1", "p2-s2"],
  ]);
  expect(ir.pages[1]).toMatchObject({ id: "p2", path: "/about?a=1", title: "title p2", meta: { description: "p2" } });
  expect(ir.cssom).toEqual({ keyframes: ["@keyframes a {}"], fontFace: [], vars: { "--x": "p1" } });
});

test("applyPatch setText changes the right node and never mutates the input", () => {
  const ir = deepFreeze(buildIR([capture("p1", "https://x.test/", doc([header()]))]));
  const before = JSON.stringify(ir);

  const next = applyPatch(ir, [{ op: "setText", id: "p1:0.1.0.0.0", text: "Brand" }]);

  expect(find(next, "p1:0.1.0.0.0")?.text).toBe("Brand");
  expect(JSON.stringify(ir)).toBe(before);
  expect(find(ir, "p1:0.1.0.0.0")?.text).toBe("Logo");
});

test("node ids are deterministic tree paths from <html>", () => {
  const caps = [capture("p1", "https://x.test/", doc([header(), el("div", {}, [txt("x")])]))];
  const a = buildIR(caps);
  expect(a).toEqual(buildIR(caps));
  expect(a.sections[0]!.root.id).toBe("p1:0.1.0");
  expect(a.sections[0]!.root.children[0]!.id).toBe("p1:0.1.0.0");
  expect(a.sections[1]!.root.children[0]).toMatchObject({ id: "p1:0.1.1.0", tag: "#text", text: "x", cls: [] });
});

test("breakpoint diff -> media, absent prop -> revert, merge stops where child count differs", () => {
  const at = (color: string | undefined, kids: number) =>
    doc([
      el(
        "div",
        {},
        Array.from({ length: kids }, () => el("p", {}, [], { style: { "font-size": color ? "12px" : "20px" } })),
        { style: color ? { color, "margin-top": "10px" } : { color: "red" }, pseudo: { before: { content: '"*"' } } },
      ),
      el("footer"),
    ]);
  const ir = buildIR([capture("p1", "https://x.test/", at("red", 1), { dom768: at(undefined, 1), dom375: at("red", 2) })]);

  const root = ir.sections[0]!.root;
  expect(ir.classes[root.cls[0]!]).toEqual({
    base: { color: "red", "margin-top": "10px" },
    before: { content: '"*"' },
    media: { "768": { "margin-top": "revert" } },
  });
  // 768 has the same child count -> child merged; 375 has 2 children -> not merged below root.
  expect(ir.classes[root.children[0]!.cls[0]!]).toEqual({ base: { "font-size": "12px" }, media: { "768": { "font-size": "20px" } } });
});

test("sections: landmarks, main children, blocks; single wrappers unwrapped; body text dropped", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", { id: "app" }, [
          header(),
          el("div", { role: "navigation" }, [el("a", {}, [txt("n")])]),
          el("main", {}, [el("section", {}, [txt("a")]), txt(" "), el("section", {}, [txt("b")])]),
          el("div", {}, [txt("hero")], { bbox: [0, 0, 1440, 400] }),
          el("footer", {}, [txt("f")]),
          txt("stray"),
        ]),
      ]),
    ),
  ]);

  expect(ir.sections.map((s) => [s.id, s.name, s.role, s.origin])).toEqual([
    ["p1-s1", "section-1", "header", "capture"],
    ["p1-s2", "section-2", "nav", "capture"],
    ["p1-s3", "section-3", "block", "capture"],
    ["p1-s4", "section-4", "block", "capture"],
    ["p1-s5", "section-5", "block", "capture"],
    ["p1-s6", "section-6", "footer", "capture"],
  ]);
  expect(ir.sections[2]!.root.tag).toBe("section");
  expect(ir.sections.every((s) => /^[0-9a-f]{6}$/.test(s.hash))).toBe(true);
});

test("sections: a non-landmark wrapper holding main among siblings is descended; noise is not a section but stays in the shell", () => {
  const cap = capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", { id: "__next" }, [
          el("div", { class: "page-wrapper" }, [
            header(),
            el("main", {}, [el("section", { id: "s1" }, [txt("a")]), el("section", { id: "s2" }, [txt("b")])]),
            el("footer", {}, [txt("f")]),
          ]),
        ]),
        el("next-route-announcer", {}, [el("p", {}, [txt("")])]),
        el("div", { id: "hidden" }, [txt("h")], { style: { display: "none" } }),
        el("div", { id: "invisible" }, [txt("v")], { style: { visibility: "hidden" } }),
        el("div", { id: "flat" }, [txt("z")], { bbox: [0, 0, 1440, 0] }),
      ]),
  );
  const ir = buildIR([cap]);

  expect(ir.sections.map((s) => [s.role, s.root.tag, s.root.attrs.id ?? ""])).toEqual([
    ["header", "header", ""],
    ["block", "section", "s1"],
    ["block", "section", "s2"],
    ["footer", "footer", ""],
  ]);
  const body = ir.pages[0]!.shell.children.find((c) => c.tag === "body")!;
  expect(body.children.map((c) => c.tag)).toEqual(["div", "next-route-announcer", "div", "div", "div"]);
  // Same capture -> same ids.
  const ids = (x: IR) => x.sections.map((s) => [s.id, s.root.id]);
  expect(ids(buildIR([cap]))).toEqual(ids(ir));
});

test("sections: when every candidate is noise, the unfiltered list is kept", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([el("div", { id: "a" }, [txt("a")], { bbox: [0, 0, 0, 0] }), el("div", { id: "b" }, [txt("b")], { bbox: [0, 0, 0, 0] })]))]);
  expect(ir.sections.map((s) => s.root.attrs.id)).toEqual(["a", "b"]);
});

test("component: >=3 same-structure siblings with element descendants", () => {
  const item = (t: string) => el("li", { class: "i" }, [el("a", {}, [txt(t)])]);
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([el("ul", {}, [item("a"), item("b"), item("c")]), el("ol", {}, [item("x"), item("y")]), el("div", {}, [el("p", {}), el("p", {}), el("p", {})])]),
    ),
  ]);

  expect(ir.components).toHaveLength(1);
  expect(ir.components[0]!.instanceIds).toEqual(["p1:0.1.0.0", "p1:0.1.0.1", "p1:0.1.0.2"]);
  expect(ir.components[0]!.id).toBe(`cmp-${ir.components[0]!.hash}`);
});

test("interactions: hover -> state class, menu -> behavior id, failed -> unresolved, skipped/unmatched -> none", () => {
  const interactions: Interaction[] = [
    { id: "i1", kind: "hover", trigger: "#b\\31 ", styleDelta: { color: "blue" }, status: "captured" },
    { id: "i2", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "captured" },
    { id: "i3", kind: "tab", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2)", status: "failed" },
    { id: "i4", kind: "modal", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1)", status: "skipped" },
    { id: "i5", kind: "menu", trigger: "#missing", status: "captured" },
  ];
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("div", {}, [el("button", { id: "b1" }, [txt("go")])]), el("nav", {}), el("div", {})]), { interactions }),
  ]);

  const button = find(ir, "p1:0.1.0.0")!;
  expect(ir.classes[button.states!.hover!]).toEqual({ base: { color: "blue" } });
  expect(find(ir, "p1:0.1.1")?.behavior).toBe("i2");
  expect(find(ir, "p1:0.1.2")?.behavior).toBe("unresolved");
  expect(find(ir, "p1:0.1.0")?.behavior).toBeUndefined();
  expect(ir.interactions.map((i) => [i.id, i.pageId])).toEqual([
    ["i1", "p1"],
    ["i2", "p1"],
    ["i3", "p1"],
    ["i4", "p1"],
    ["i5", "p1"],
  ]);
});

test("canvas -> img with the dynamic asset, matched by document order", () => {
  const canvas = () => el("canvas", { "data-dynamic": "canvas" }, [txt("fallback")], { bbox: [0, 0, 300.4, 150.6] });
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("div", {}, [canvas(), canvas()]), el("footer")]), { dynamic: [{ order: 1, asset: "assets/c.png" }] }),
  ]);

  const [first, second] = ir.sections[0]!.root.children;
  expect(first!.tag).toBe("canvas");
  expect(second).toMatchObject({ tag: "img", attrs: { src: "assets/c.png", "data-dynamic": "canvas", width: "300", height: "151" }, children: [] });
});

test("applyPatch: setStyle, setAttr, setText on element, replaceSubtree, setBehavior", () => {
  const ir = deepFreeze(buildIR([capture("p1", "https://x.test/", doc([header()]))]));
  const next = applyPatch(ir, [
    { op: "setStyle", id: "p1:0.1.0", style: { color: "green" } },
    { op: "setAttr", id: "p1:0.1.0.0", attrs: { href: "/home", title: "t" } },
    { op: "setText", id: "p1:0.1.0.0", text: "Home" },
    { op: "setBehavior", id: "p1:0.1.0", behavior: "i9" },
  ]);

  const root = next.sections[0]!.root;
  expect(next.classes[root.cls[0]!]).toEqual({ base: { color: "green" } });
  expect(root.behavior).toBe("i9");
  expect(root.children[0]).toMatchObject({ attrs: { href: "/home", title: "t" }, children: [{ id: "p1:0.1.0.0.0", tag: "#text", text: "Home" }] });

  const node: IRNode = { id: "other", tag: "span", attrs: {}, cls: [], children: [] };
  const replaced = applyPatch(next, [{ op: "replaceSubtree", id: "p1:0.1.0.0", node }]);
  expect(replaced.sections[0]!.root.children[0]).toEqual({ ...node, id: "p1:0.1.0.0" });
});

test("applyPatch unknown id -> IR_PATCH_INVALID with context", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([header()]))]);
  let caught: unknown;
  try {
    applyPatch(ir, [{ op: "setText", id: "nope", text: "x" }]);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code: "IR_PATCH_INVALID", context: { op: "setText", id: "nope" } });
});

test("same structure but different content on two pages -> separate sections, no layout", () => {
  const block = (t: string) => el("section", {}, [el("h2", {}, [txt(t)])]);
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([header(), block("One")])),
    capture("p2", "https://x.test/b", doc([header(), block("Two")])),
  ]);

  expect(ir.sections[1]!.hash).toBe(ir.sections[2]!.hash);
  expect(ir.layouts).toHaveLength(1); // the identical header only
  expect(ir.pages.map((p) => p.sectionIds)).toEqual([
    ["p1-s1", "p1-s2"],
    ["p1-s1", "p2-s2"],
  ]);
});

test("page shell: html > body > wrapper keeps styles, sections become placeholders in order", () => {
  const dom = el("html", {}, [
    el("head", {}, [el("title", {}, [txt("t")])]),
    el("body", {}, [el("div", { id: "app" }, [header(), txt("between"), el("main", {}, [el("section", {}, [txt("a")])])], { style: { display: "grid" } })], {
      style: { margin: "0px" },
    }),
  ]);
  const ir = buildIR([capture("p1", "https://x.test/", dom), capture("p2", "https://x.test/2", doc([header(), el("footer")]))]);

  const shell = ir.pages[0]!.shell;
  expect(shell.tag).toBe("html");
  expect(shell.children.map((c) => c.tag)).toEqual(["body"]);
  const body = shell.children[0]!;
  expect(ir.classes[body.cls[0]!]).toEqual({ base: { margin: "0px" } });
  const app = body.children[0]!;
  expect(ir.classes[app.cls[0]!]).toEqual({ base: { display: "grid" } });
  expect(app.children.map((c) => [c.tag, c.attrs["data-section"] ?? c.text])).toEqual([
    ["#section", "p1-s1"],
    ["#text", "between"],
    ["main", undefined],
  ]);
  expect(app.children[2]!.children).toEqual([{ id: "p1-s2", tag: "#section", attrs: { "data-section": "p1-s2" }, cls: [], children: [] }]);
  // p2's shared header slot points at the layout section.
  expect(ir.pages[1]!.shell.children[0]!.children.map((c) => c.attrs["data-section"])).toEqual(["p1-s1", "p2-s2"]);
});

test("applyPatch setStyle merges into the existing class, keeping other props, media and pseudo", () => {
  const styled = (size: string) =>
    doc([el("div", {}, [txt("x")], { style: { color: "red", "font-size": size }, pseudo: { after: { content: '"!"' } } }), el("footer")]);
  const ir = buildIR([capture("p1", "https://x.test/", styled("16px"), { dom768: styled("14px") })]);

  const next = applyPatch(ir, [{ op: "setStyle", id: "p1:0.1.0", style: { color: "green" } }]);

  expect(next.classes[next.sections[0]!.root.cls[0]!]).toEqual({
    base: { color: "green", "font-size": "16px" },
    after: { content: '"!"' },
    media: { "768": { "font-size": "14px" } },
  });
  expect(ir.classes[ir.sections[0]!.root.cls[0]!]!.base.color).toBe("red");
});

test("nth-of-type trigger counts same-tag siblings only", () => {
  const interactions: Interaction[] = [
    { id: "i1", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2)", status: "captured" },
  ];
  const ir = buildIR([capture("p1", "https://x.test/", doc([el("p"), el("div"), el("p"), el("div")]), { interactions })]);

  expect(find(ir, "p1:0.1.3")?.behavior).toBe("i1");
  expect(find(ir, "p1:0.1.2")?.behavior).toBeUndefined();
});

function patchError(ir: IR, op: Parameters<typeof applyPatch>[1][number]): unknown {
  try {
    applyPatch(ir, [op]);
  } catch (err) {
    return err;
  }
  return undefined;
}

test("applyPatch reaches page shell nodes (setStyle on body)", () => {
  const ir = deepFreeze(buildIR([capture("p1", "https://x.test/", doc([header(), el("footer")]))]));
  const next = applyPatch(ir, [{ op: "setStyle", id: "p1:0.1", style: { background: "black" } }]);

  const body = next.pages[0]!.shell.children[0]!;
  expect(body.id).toBe("p1:0.1");
  expect(next.classes[body.cls[0]!]).toEqual({ base: { background: "black" } });
  expect(ir.pages[0]!.shell.children[0]!.cls).toEqual([]);
});

test("replaceSubtree: input unchanged, old subtree ids reusable, duplicate ids rejected", () => {
  const ir = deepFreeze(buildIR([capture("p1", "https://x.test/", doc([header(), el("footer", {}, [txt("f")])]))]));
  const before = JSON.stringify(ir);
  const node = (childId: string): IRNode => ({ id: "x", tag: "div", attrs: {}, cls: [], children: [{ id: childId, tag: "#text", attrs: {}, text: "hi", cls: [], children: [] }] });

  const next = applyPatch(ir, [{ op: "replaceSubtree", id: "p1:0.1.0", node: node("p1:0.1.0.0") }]);
  expect(next.sections[0]!.root).toMatchObject({ id: "p1:0.1.0", tag: "div", children: [{ id: "p1:0.1.0.0", text: "hi" }] });
  expect(JSON.stringify(ir)).toBe(before);

  for (const dup of ["p1:0.1.1.0", "p1:0.1"]) {
    expect(patchError(ir, { op: "replaceSubtree", id: "p1:0.1.0", node: node(dup) })).toMatchObject({
      code: "IR_PATCH_INVALID",
      context: { op: "replaceSubtree", id: "p1:0.1.0" },
    });
  }
});

test("setStyle / setBehavior on a #text node -> IR_PATCH_INVALID", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([header()]))]);
  expect(patchError(ir, { op: "setStyle", id: "p1:0.1.0.0.0", style: { color: "red" } })).toMatchObject({ code: "IR_PATCH_INVALID" });
  expect(patchError(ir, { op: "setBehavior", id: "p1:0.1.0.0.0", behavior: "i1" })).toMatchObject({
    code: "IR_PATCH_INVALID",
    context: { op: "setBehavior", id: "p1:0.1.0.0.0" },
  });
});
