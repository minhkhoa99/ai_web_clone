import { expect, test } from "vitest";
import { affectedOf, canvasPayload, MAX_AFFECTED_SECTIONS, pageSectionIds } from "@/core/editor-canvas";
import { applyCommands } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const SHA = "a".repeat(64);
const doc = (count = 2): IRV2 => {
  const ks = Array.from({ length: count }, (_, i) => i);
  return {
    version: 2, revision: 0,
    pages: [{ id: "pg", path: "/", title: "T", meta: {}, sectionIds: ks.map((i) => `s${i}`), shell: n("html", "html", [n("body", "body", ks.map((i) => n(`ph${i}`, "#section", [], { attrs: { "data-section": `s${i}` } })))]) }],
    sections: ks.map((i) => ({
      id: `s${i}`, pageId: "pg", name: `S${i}`, role: "main", hash: `h${i}`, origin: "capture" as const,
      root: n(`r${i}`, "section", [
        n(`h${i}`, "h2", [n(`t${i}`, "#text", [], { text: i === 0 ? '<img src=x onerror="window.top.__pwned=1">' : `Title ${i}` })],
          { type: "text", styles: { base: { color: "red", "font-family": '"Inter", sans-serif', "background-image": 'url("http://x.test/a.png")' }, bp: {}, state: {}, pseudo: {} } }),
        n(`img${i}`, "img", [], { type: "image", attrs: { src: "http://x.test/a.png" } }),
      ]),
    })),
    layouts: [], components: [], tokens: {},
    cssom: { keyframes: ["@keyframes spin{to{transform:rotate(1turn)}}"], fontFace: ['@font-face{font-family:"Brand Sans";src:url("http://x.test/f.woff2")}'], vars: {} },
    interactions: [], fidelity: [],
  };
};
const opts = { assetMap: { "http://x.test/a.png": `assets/${SHA}.png` }, pageUrls: { pg: "http://x.test/" } };
const files = "http://127.0.0.1:3000/api/projects/p1/files";
const urls = (file: string) => ({ base: `${files}/out/${file}`, runtime: `${files}/out/js/runtime.js?edit=1` });

test("canvas document: based on out/<page>, a meta CSP that lets only the runtime run, one inline stylesheet slot, the edit-mode runtime, data-ir-id kept, text escaped", () => {
  const out = canvasPayload(doc(), "pg", opts, urls);
  const html = out.page.html;
  expect(out.page.file).toBe("index.html");
  const charset = html.indexOf('<meta charset="utf-8">'), base = html.indexOf(`<base href="${files}/out/index.html">`), csp = html.indexOf('http-equiv="Content-Security-Policy"');
  expect(charset).toBeGreaterThan(-1);
  expect(base).toBeGreaterThan(charset);
  expect(csp).toBeGreaterThan(base);
  expect(html).toContain(`script-src ${files}/out/js/runtime.js;`);
  expect(html).toContain("object-src 'none'; form-action 'none'; base-uri 'self'");
  expect(html).toContain("<style data-aiwc-css></style>");
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html).toContain(`<script src="${files}/out/js/runtime.js?edit=1"></script>`);
  expect(html).not.toContain("css/styles.css");
  expect(html).toContain('data-ir-id="h0"');
  expect(html).toContain(`src="assets/${SHA}.png"`);
  expect(html).toContain("&lt;img src=x onerror=");
  expect(out.css).toContain("color:red");
  expect(out.css).toContain(`url("assets/${SHA}.png")`);
  expect(out.css).not.toContain("../assets/");
  expect(out.page.sections.map((s) => [s.id, s.name, s.root.id])).toEqual([["s0", "S0", "r0"], ["s1", "S1", "r1"]]);
  expect(out.page.shell.id).toBe("html");
  expect(out.fonts).toEqual(["Brand Sans", "Inter"]);
  expect(out.effects).toEqual(expect.arrayContaining(["spin", "sp1-fade-in", "sp1-slide-up"]));
  expect(out.pages).toEqual([{ id: "pg", path: "/" }]);
  expect(pageSectionIds(doc(), "pg")).toEqual(["s0", "s1"]);
  expect(() => canvasPayload(doc(), "nope", opts, urls)).toThrow(/unknown page/);
});

test("affected: a style edit in one section returns only that section (html + resolved root), the new stylesheet and the page's components", () => {
  const before = doc();
  const after = applyCommands(before, [{ op: "setStyle", id: "h1", target: "base", changes: { color: "blue" } }]).ir;
  const a = affectedOf(before, after, "pg", opts);
  expect(a.shellChanged).toBe(false);
  expect(a.sections.map((s) => s.id)).toEqual(["s1"]);
  expect(a.sections[0]!.html.startsWith("<section")).toBe(true);
  expect(a.sections[0]!.html).toContain('data-ir-id="r1"');
  expect(a.sections[0]!.root.children[0]!.styles.base.color).toBe("blue");
  expect(a.css).toContain("color:blue");
  expect(a.css).not.toContain("../assets/");
  expect(a.interactives).toEqual([]);
  expect(affectedOf(before, before, "pg", opts).sections).toEqual([]);
});

test("affected: a change only the resolved tree shows (setName, a bare setHidden) still returns its section, so the layer tree gets the new root", () => {
  const before = doc();
  const named = applyCommands(before, [{ op: "setName", id: "h1", name: "Tiêu đề" }]).ir;
  const a = affectedOf(before, named, "pg", opts);
  expect(a.shellChanged).toBe(false);
  expect(a.sections.map((s) => s.id)).toEqual(["s1"]);
  expect(a.sections[0]!.root.children[0]!.name).toBe("Tiêu đề");
  const hidden = applyCommands(before, [{ op: "setHidden", id: "h0", hidden: true }]).ir;
  expect(affectedOf(before, hidden, "pg", opts).sections.map((s) => s.id)).toEqual(["s0"]);
});

test("affected: a shell change (section order) or more than 20 changed sections asks for a page reload", () => {
  const before = doc();
  const moved = applyCommands(before, [{ op: "moveNode", id: "ph1", parentId: "body", index: 0 }]).ir;
  expect(affectedOf(before, moved, "pg", opts)).toMatchObject({ shellChanged: true, sections: [], css: "" });
  const many = doc(MAX_AFFECTED_SECTIONS + 1);
  const restyle = (ks: number[]) => applyCommands(many, ks.map((i) => ({ op: "setStyle" as const, id: `r${i}`, target: "base" as const, changes: { color: "blue" } }))).ir;
  expect(affectedOf(many, restyle([...Array(21).keys()]), "pg", opts)).toMatchObject({ shellChanged: true, sections: [] });
  expect(affectedOf(many, restyle([...Array(20).keys()]), "pg", opts).sections).toHaveLength(20);
});

test("canvas page and affected sections match the site emit for that page (only the editor head lines differ)", async () => {
  const { renderSite, renderStylesheet } = await import("@/core/emit-html");
  const site = renderSite(doc(), opts)["index.html"]!;
  const canvas = canvasPayload(doc(), "pg", opts, urls);
  const head = (html: string) => html.split("\n").filter((l) => !/^<(base|meta http-equiv|style data-aiwc-css|link rel="stylesheet"|script)/.test(l)).join("\n");
  expect(head(canvas.page.html)).toBe(head(site));
  expect(canvas.css).toBe(renderStylesheet(doc(), opts).replaceAll("../assets/", "assets/"));
  const after = applyCommands(doc(), [{ op: "setStyle", id: "h1", target: "base", changes: { color: "blue" } }]).ir;
  const a = affectedOf(doc(), after, "pg", opts);
  expect(renderSite(after, opts)["index.html"]).toContain(a.sections[0]!.html);
  // deleting a whole section (its placeholder in the shell) reloads the page
  const removed = applyCommands(doc(), [{ op: "deleteNode", id: "ph1" }]).ir;
  expect(affectedOf(doc(), removed, "pg", opts)).toMatchObject({ shellChanged: true, sections: [] });
});

// modal dlg in s0, its trigger b1 in s1 (roles are written from a spec in another section)
const modalDoc = (withSpec = true): IRV2 => {
  const d = doc();
  d.sections[0]!.root.children.push(n("dlg", "div", [n("x", "button")], withSpec ? { interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["b1"], dialog: "dlg", closeOn: ["esc"] } } : {}));
  d.sections[1]!.root.children.push(n("b1", "button"));
  return d;
};

test("affected: unwrapping / converting a modal also re-renders the section holding its trigger", () => {
  const before = modalDoc();
  const unwrapped = applyCommands(before, [{ op: "unwrapComponent", id: "dlg" }]).ir;
  const a = affectedOf(before, unwrapped, "pg", opts);
  expect(a.sections.map((s) => s.id)).toEqual(["s0", "s1"]);
  expect(a.sections[1]!.html).not.toContain("data-c-role");
  const plain = modalDoc(false);
  const converted = applyCommands(plain, [{ op: "convertToComponent", id: "dlg", kind: "modal", roles: { triggers: ["b1"], dialog: "dlg" } }]).ir;
  const c = affectedOf(plain, converted, "pg", opts);
  expect(c.sections.map((s) => s.id)).toEqual(["s0", "s1"]);
  expect(c.sections[1]!.html).toContain('data-c-role="trigger"');
});

test("affected: a class renamed by a hash collision re-renders the untouched section that uses it", () => {
  // z-index 1899 and 4759 share the first 6 hex of their style hash; the first one visited keeps s-69a3b7, the other widens
  const before = doc();
  before.sections[1]!.root.children[1]!.styles.base = { "z-index": "1899" };
  const after = applyCommands(before, [{ op: "setStyle", id: "img0", target: "base", changes: { "z-index": "4759" } }]).ir;
  expect(canvasPayload(before, "pg", opts, urls).page.html).toContain(`class="s-69a3b7" data-ir-id="img1"`);
  const a = affectedOf(before, after, "pg", opts);
  expect(a.sections.map((s) => s.id)).toEqual(["s0", "s1"]);
  expect(a.sections[1]!.html).toContain("s-69a3b79f");
  expect(a.css).toContain(".s-69a3b79f");
});

test("affected (edit main, R17): a main edit re-renders every section whose instances resolve differently", () => {
  const main = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}) => n(id, tag, children, { ...extra, component: { id: "k", role: "main" } });
  const inst = (id: string, sourceId: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}) => n(id, tag, children, { ...extra, component: { id: "k", role: "instance", sourceId, overrides: [] } });
  const before = doc(2);
  before.components = [{ id: "k", root: main("m", "div", [main("mh", "h3", [main("mt", "#text", [], { text: "Card" })])]), instanceIds: ["i0", "i1"] }];
  before.sections.forEach((s, i) => s.root.children.push({ ...inst(`i${i}`, "m", "div", [inst(`i${i}h`, "mh", "h3", [inst(`i${i}t`, "mt", "#text", [], { text: "Card" })])]), parentId: s.root.id }));
  const after = applyCommands(before, [{ op: "setStyle", id: "mh", target: "base", changes: { color: "blue" } }]).ir;
  const a = affectedOf(before, after, "pg", opts);
  expect(a.shellChanged).toBe(false);
  expect(a.sections.map((s) => s.id)).toEqual(["s0", "s1"]);
  expect(a.css).toContain("color:blue");
});
