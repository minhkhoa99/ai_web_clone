import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import type { Interaction } from "@/core/interactions";
import { buildIR } from "@/core/ir";
import { emitSection, renderSite, type RenderOpts } from "@/core/emit-html";

type Opts = { style?: Record<string, string>; bbox?: [number, number, number, number] };

function el(tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], opts: Opts = {}): CaptureNode {
  return { tag, attrs, bbox: opts.bbox ?? [0, 0, 100, 20], style: opts.style ?? {}, children };
}

function txt(text: string): CaptureNode {
  return { tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] };
}

function doc(body: CaptureNode[]): CaptureNode {
  return el("html", { lang: "en" }, [el("head", {}, [el("title", {}, [txt("t")])]), el("body", {}, body, { style: { margin: "0px" } })]);
}

type CapOpts = { dom768?: CaptureNode; dom375?: CaptureNode; interactions?: Interaction[]; fontFace?: string[]; vars?: Record<string, string> };

function capture(pageId: string, url: string, dom: CaptureNode, opts: CapOpts = {}): PageCapture {
  return {
    url,
    pageId,
    capturedAt: "2026-09-23T00:00:00.000Z",
    title: `title ${pageId}`,
    meta: { description: `desc "${pageId}"`, "og:title": pageId, viewport: "width=1" },
    cssom: { keyframes: ["@keyframes spin { to { transform: rotate(1turn); } }"], fontFace: opts.fontFace ?? [], media: [], vars: opts.vars ?? {}, stateSelectors: [] },
    breakpoints: [
      { bp: 1440, dom, truncated: false },
      { bp: 768, dom: opts.dom768 ?? dom, truncated: false },
      { bp: 375, dom: opts.dom375 ?? dom, truncated: false },
    ],
    interactions: opts.interactions ?? [],
    assets: {},
    skippedAssets: [],
    dynamic: [],
  };
}

const header = () => el("header", { class: "top" }, [el("a", { href: "/" }, [txt("Logo")])], { style: { color: "red" } });
const noUrls: RenderOpts = { assetMap: {}, pageUrls: { p1: "https://x.test/", p2: "https://x.test/about" } };

test("pages get data-ir-id, CSS gets .s- classes, shared layout stored once but rendered on every page", () => {
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([header(), el("section", {}, [el("h1", {}, [txt("Home")])])])),
    capture("p2", "https://x.test/about", doc([header(), el("article", {}, [el("p", {}, [txt("About")])])])),
  ]);
  expect(ir.layouts).toHaveLength(1);

  const files = renderSite(ir, noUrls);

  expect(Object.keys(files).sort()).toEqual(["about.html", "css/styles.css", "index.html"]);
  const headerRoot = ir.sections.find((s) => s.role === "header")!.root;
  for (const page of ["index.html", "about.html"]) {
    expect(files[page]).toContain(`<header class="${headerRoot.cls[0]}" data-ir-id="${headerRoot.id}">`);
    expect(files[page]!.match(/<header/g)).toHaveLength(1);
  }
  expect(files["index.html"]).toContain("<h1");
  expect(files["about.html"]).toContain(">About</p>");
  expect(files["css/styles.css"]).toMatch(/\.s-[0-9a-f]{6}\{color:red\}/);
});

test("page document: doctype, html attrs, head with title/meta/css/runtime, original class dropped", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([header()]))]);
  const html = renderSite(ir, noUrls)["index.html"]!;

  expect(html.startsWith('<!DOCTYPE html>\n<html lang="en" data-ir-id="p1:0">')).toBe(true);
  expect(html).toContain("<title>title p1</title>");
  expect(html).toContain('<meta name="description" content="desc &quot;p1&quot;">');
  expect(html).toContain('<meta property="og:title" content="p1">');
  expect(html).not.toContain("width=1");
  expect(html).toContain('<link rel="stylesheet" href="css/styles.css">');
  expect(html).toContain('<script src="js/runtime.js" defer></script>');
  expect(html).not.toContain('class="top"');
  expect(html).toMatch(/<body class="s-[0-9a-f]{6}" data-ir-id="p1:0\.1">/);
  expect(html.trimEnd().endsWith("</body></html>")).toBe(true);
});

test("escaping: script-looking text stays inert, attrs quoted, on* dropped, void elements not closed", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", { title: 'a"b<c>&d', onclick: "alert(1)", "bad\"name": "x" }, [
          txt("<script>alert(1)</script> & more"),
          el("br"),
          el("img", { src: "data:image/png;base64,AAAA", alt: "i" }),
          el("input", { value: "v" }),
        ]),
      ]),
    ),
  ]);
  const html = renderSite(ir, noUrls)["index.html"]!;

  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
  expect(html).not.toContain("<script>alert");
  expect(html).toContain('title="a&quot;b&lt;c&gt;&amp;d"');
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("bad");
  expect(html).toMatch(/<br data-ir-id="[^"]+">/);
  expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="i"');
  expect(html).not.toMatch(/<\/(br|img|input)>/);
});

test("stripIds removes data-ir-id everywhere", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([header()]))]);
  const files = renderSite(ir, { ...noUrls, stripIds: true });
  expect(files["index.html"]).not.toContain("data-ir-id");
  expect(emitSection(ir, ir.sections[0]!.id, { ...noUrls, stripIds: true })).not.toContain("data-ir-id");
});

test("tokens + cssom vars in :root, token values written as var(), other values verbatim", () => {
  const card = (c: string) => el("p", {}, [txt(c)], { style: { color: "rgb(1, 2, 3)", "line-height": "1.37" } });
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("div", {}, [card("a"), card("b"), card("c")])]), {
      vars: { "--brand": "#f60", "--color-1": "clash" },
    }),
  ]);
  expect(ir.tokens["--color-1"]).toBe("rgb(1, 2, 3)");

  const css = renderSite(ir, noUrls)["css/styles.css"]!;
  expect(css.startsWith(":root{--color-1:rgb(1, 2, 3);--brand:#f60}\n")).toBe(true);
  expect(css).not.toContain("clash");
  expect(css).toContain("color:var(--color-1);line-height:1.37");
  expect(css).toContain("@keyframes spin { to { transform: rotate(1turn); } }");
});

test("media: 768 under max-width 1439.98, 375 compensates 768-only props with base or revert", () => {
  const at = (style: Record<string, string>) => doc([el("div", {}, [txt("x")], { style })]);
  const ir = buildIR([
    capture("p1", "https://x.test/", at({ color: "red", "margin-top": "10px" }), {
      dom768: at({ color: "blue", "margin-top": "10px", "padding-top": "5px" }),
      dom375: at({ color: "red", "margin-top": "2px" }),
    }),
  ]);
  const cls = ir.sections[0]!.root.cls[0]!;
  const css = renderSite(ir, noUrls)["css/styles.css"]!;

  expect(css).toContain(`@media (max-width: 1439.98px){\n.${cls}{color:blue;padding-top:5px}\n}`);
  expect(css).toContain(`@media (max-width: 767.98px){\n.${cls}{margin-top:2px;color:red;padding-top:revert}\n}`);
  expect(css.indexOf("1439.98px")).toBeLessThan(css.indexOf("767.98px"));
});

test("hover state -> st- class on the node and a :hover rule from the state class base", () => {
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("a", { id: "cta", href: "#go" }, [txt("Go")], { style: { color: "red" } })]), {
      interactions: [{ id: "ix1", kind: "hover", trigger: "#cta", styleDelta: { color: "blue" }, status: "captured" }],
    }),
  ]);
  const hover = ir.sections[0]!.root.states!.hover!;
  const files = renderSite(ir, noUrls);

  expect(files["index.html"]).toContain(`class="${ir.sections[0]!.root.cls[0]} st-${hover}"`);
  expect(files["index.html"]).toContain('href="#go"');
  expect(files["css/styles.css"]).toContain(`.st-${hover}:hover{color:blue}`);
});

test("behavior: captured -> data-behavior kind + data-ix, failed -> unresolved", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([el("nav", {}, [el("button", { id: "menu" }, [txt("Menu")]), el("ul", {}, [el("li", {}, [txt("a")])])]), el("div", { id: "tabs" }, [txt("t")])]),
      {
        interactions: [
          { id: "ix-menu", kind: "menu", trigger: "#menu", status: "captured" },
          { id: "ix-tab", kind: "tab", trigger: "#tabs", status: "failed" },
        ],
      },
    ),
  ]);
  const html = renderSite(ir, noUrls)["index.html"]!;
  expect(html).toContain('<button id="menu" data-behavior="toggle" data-ix="ix-menu"');
  expect(html).toContain('<div id="tabs" data-behavior="unresolved"');
});

test("URL rewrite: assets -> relative, cloned page links -> local .html, others -> absolute", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", {}, [
          el("img", { src: "/img/a.png", srcset: "/img/a.png 1x, /img/b.png 2x" }),
          el("img", { src: "missing.png" }),
          el("video", { poster: "https://x.test/img/a.png" }),
          el("a", { href: "/about/#team" }, [txt("about")]),
          el("a", { href: "/pricing" }, [txt("pricing")]),
          el("a", { href: "https://other.test/x" }, [txt("other")]),
          el("a", { href: "mailto:a@b.c" }, [txt("mail")]),
          el("link", { rel: "icon", href: "/img/a.png" }),
        ]),
        el("section", {}, [txt("bg")], { style: { "background-image": 'url("https://x.test/img/a.png")' } }),
      ]),
      { fontFace: ['@font-face { font-family: F; src: url("../fonts/f.woff2") format("woff2"); }'] },
    ),
    capture("p2", "https://x.test/about", doc([el("p", {}, [txt("About")])])),
  ]);
  const opts: RenderOpts = {
    assetMap: {
      "https://x.test/img/a.png": "assets/aaa.png",
      "https://x.test/img/b.png": "assets/bbb.png",
      "https://x.test/static/fonts/f.woff2": "assets/fff.woff2",
    },
    pageUrls: { p1: "https://x.test/", p2: "https://x.test/about" },
  };
  const files = renderSite(ir, opts);
  const html = files["index.html"]!;
  const css = files["css/styles.css"]!;

  expect(html).toContain('<img src="assets/aaa.png" srcset="assets/aaa.png 1x, assets/bbb.png 2x"');
  expect(html).toContain('<img src="https://x.test/missing.png"');
  expect(html).toContain('<video poster="assets/aaa.png"');
  expect(html).toContain('href="about.html#team"');
  expect(html).toContain('href="https://x.test/pricing"');
  expect(html).toContain('href="https://other.test/x"');
  expect(html).toContain('href="mailto:a@b.c"');
  expect(html).toContain('<link rel="icon" href="assets/aaa.png"');
  expect(css).toContain('background-image:url("../assets/aaa.png")');
  expect(css).toContain('src: url("../assets/fff.woff2") format("woff2")');
  expect(emitSection(ir, ir.sections[0]!.id, opts)).toContain('src="assets/aaa.png"');
});

test("page file names are flat, deterministic and collision-free; renders are byte-identical", () => {
  const page = (id: string, url: string) => capture(id, url, doc([el("p", {}, [txt(id)])]));
  const caps = [page("a", "https://x.test/"), page("b", "https://x.test/a/b"), page("c", "https://x.test/A/B"), page("d", "https://x.test/index.html")];
  const opts: RenderOpts = { assetMap: {}, pageUrls: Object.fromEntries(caps.map((c) => [c.pageId, c.url])) };

  const first = renderSite(buildIR(caps), opts);
  expect(Object.keys(first).sort()).toEqual(["A-B-2.html", "a-b.html", "css/styles.css", "index-2.html", "index.html"]);
  expect(JSON.stringify(renderSite(buildIR(caps), opts))).toBe(JSON.stringify(first));
});

test("emitSection renders one section; unknown id throws", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([header(), el("footer", {}, [txt("f")])]))]);
  const html = emitSection(ir, "p1-s2", noUrls);
  expect(html).toBe(`<footer class="${ir.sections[1]!.root.cls[0] ?? ""}" data-ir-id="p1:0.1.1">f</footer>`.replace(' class=""', ""));
  expect(() => emitSection(ir, "nope", noUrls)).toThrow(/nope/);
});

test("javascript: URLs neutralised (href -> #, other attrs dropped), srcdoc dropped", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", {}, [
          el("a", { href: " JavaScript:alert(1)" }, [txt("js")]),
          el("a", { href: "java\tscript:alert(2)" }, [txt("js2")]),
          el("iframe", { src: "javascript:alert(3)", srcdoc: "<script>alert(4)</script>" }),
          el("form", { action: "javascript:alert(5)" }),
        ]),
      ]),
    ),
  ]);
  const html = renderSite(ir, noUrls)["index.html"]!;
  expect(html).not.toMatch(/script:|alert|srcdoc/i);
  expect(html.match(/<a href="#"/g)).toHaveLength(2);
  expect(html).toMatch(/<iframe data-ir-id=/);
  expect(html).toMatch(/<form data-ir-id=/);
});

test("srcset splits candidates on comma+whitespace only (commas inside URLs survive)", () => {
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        el("div", {}, [
          el("img", { srcset: "https://cdn.test/w_100,h_50/a.png 1x, /img/b.png 2x" }),
          el("img", { srcset: "data:image/png;base64,AAAA 1x, /img/b.png 2x" }),
        ]),
      ]),
    ),
  ]);
  const html = renderSite(ir, { ...noUrls, assetMap: { "https://cdn.test/w_100,h_50/a.png": "assets/aaa.png", "https://x.test/img/b.png": "assets/bbb.png" } })["index.html"]!;
  expect(html).toContain('srcset="assets/aaa.png 1x, assets/bbb.png 2x"');
  expect(html).toContain('srcset="data:image/png;base64,AAAA 1x, assets/bbb.png 2x"');
});

test("whitespace text between inline siblings is emitted as-is", () => {
  const ir = buildIR([capture("p1", "https://x.test/", doc([el("p", {}, [el("a", {}, [txt("x")]), txt(" "), el("a", {}, [txt("y")])])]))]);
  expect(renderSite(ir, { ...noUrls, stripIds: true })["index.html"]).toContain("<p><a>x</a> <a>y</a></p>");
});
