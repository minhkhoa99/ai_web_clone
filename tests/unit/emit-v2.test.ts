import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { migrateIR } from "@/core/ir-migrate";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { emitSection, emitSectionV2, renderSite, renderSiteV2, renderStylesheet, renderStylesheetV2, type RenderOpts } from "@/core/emit-html";

const el = (tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], style: Record<string, string> = {}): CaptureNode =>
  ({ tag, attrs, bbox: [0, 0, 100, 20], style, children });
const txt = (text: string): CaptureNode => ({ tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] });
const doc = (body: CaptureNode[]) => el("html", { lang: "en" }, [el("head"), el("body", {}, body, { margin: "0px" })]);

const header = () => el("header", {}, [el("a", { href: "/about" }, [txt("Logo")]), el("button", { id: "menu", "aria-controls": "nav" }, [txt("Menu")]), el("ul", { id: "nav" }, [el("li", {}, [txt("A")])], { display: "none" })], { color: "red" });
const card = (i: number, color: string) =>
  el("article", i === 1 ? { "data-x": "1", title: `card ${i}` } : { title: `card ${i}` }, [el("h3", {}, [txt(`Card ${i}`)], { "font-size": "20px" }), el("img", { src: "https://x.test/a.png", alt: `a${i}` })], { color, padding: "8px" });
const main = (color: string) => el("section", {}, [el("a", { id: "cta", href: "https://x.test/about" }, [txt("Go")], { color: "black" }), ...[0, 1, 2].map(i => card(i, i === 1 ? "green" : color))]);

function capture(pageId: string, url: string, dom: CaptureNode, dom768: CaptureNode, extra: Partial<PageCapture> = {}): PageCapture {
  return {
    url, pageId, capturedAt: "2026-09-23T00:00:00.000Z", title: pageId, meta: { description: pageId },
    cssom: { keyframes: [], fontFace: ["@font-face{font-family:F;src:url(f.woff2)}"], media: [], vars: { "--v": "1" }, stateSelectors: [] },
    breakpoints: [{ bp: 1440, dom, truncated: false }, { bp: 768, dom: dom768, truncated: false }, { bp: 375, dom, truncated: false }],
    interactions: [], assets: {}, skippedAssets: [], dynamic: [], ...extra,
  };
}
const captures = (): PageCapture[] => [
  capture("p1", "https://x.test/", doc([header(), main("red")]), doc([header(), main("blue")]), {
    interactions: [
      { id: "ix-menu", kind: "menu", trigger: "#menu", status: "captured" },
      { id: "ix-hover", kind: "hover", trigger: "#cta", styleDelta: { color: "orange" }, status: "captured" },
    ],
  }),
  capture("p2", "https://x.test/about", doc([header(), el("p", {}, [txt("About")])]), doc([header(), el("p", {}, [txt("About")])])),
];
const opts: RenderOpts = { assetMap: { "https://x.test/a.png": `assets/${"a".repeat(64)}.png` }, pageUrls: { p1: "https://x.test/", p2: "https://x.test/about" } };
// Attribute order inside a start tag is not rendered: an instance resolved from its main lists main's attrs first.
const sortAttrs = (html: string) => html.replace(/<([a-z][\w-]*)((?: [^\s"'<>/=]+="[^"]*")*)>/gi, (_m, tag: string, attrs: string) =>
  `<${tag}${(attrs.match(/ [^\s"'<>/=]+="[^"]*"/g) ?? []).sort().join("")}>`);
const normalize = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sortAttrs(v)]));
const walk = (n: IRNodeV2, f: (n: IRNodeV2) => void): void => { f(n); n.children.forEach(c => walk(c, f)); };

test("v2 output equals v1 output for the same capture (HTML, CSS at 1440/768/375, sections)", () => {
  const caps = captures();
  const v1 = buildIR(caps);
  const v2 = migrateIR(v1, caps);
  expect(v2.components.length).toBeGreaterThan(0);
  const files = renderSiteV2(v2, opts);
  const v1Files = renderSite(v1, opts);
  expect(files["css/styles.css"]).toBe(v1Files["css/styles.css"]);
  expect(normalize(files)).toEqual(normalize(v1Files));
  expect(files["css/styles.css"]).toContain("@media (max-width: 1439.98px)");
  expect(files["css/styles.css"]).toContain("@media (max-width: 767.98px)");
  expect(files["index.html"]).toContain('data-behavior="toggle"');
  expect(files["index.html"]).toContain(`assets/${"a".repeat(64)}.png`);
  expect(renderStylesheetV2(v2, opts)).toBe(renderStylesheet(v1, opts));
  for (const s of v1.sections) expect(sortAttrs(emitSectionV2(v2, s.id, opts))).toBe(sortAttrs(emitSection(v1, s.id, opts)));
});

test("emit never writes classes into IRV2; 768 override falls back to base at 375; state/pseudo rules", () => {
  const caps = captures();
  const v2 = migrateIR(buildIR(caps), caps);
  let target: IRNodeV2 | undefined;
  walk(v2.sections.find(s => s.pageId === "p2")!.root, n => { if (n.tag === "p") target = n; });
  target!.styles = { base: { color: "rgb(1, 2, 3)" }, bp: { 768: { color: "blue", margin: "4px" } }, state: { focus: { color: "pink" } }, pseudo: { after: { content: '"x"' } } };
  const before = JSON.stringify(v2);
  const files = renderSiteV2(v2, opts);
  expect(JSON.stringify(v2)).toBe(before);
  expect(before).not.toMatch(/"(cls|classes)"/);
  const css = files["css/styles.css"]!;
  const cls = /<p class="(s-[0-9a-f]+) st-(s-[0-9a-f]+)"/.exec(files["about.html"]!)!;
  expect(cls).not.toBeNull();
  expect(css).toContain(`.${cls[1]}{color:rgb(1, 2, 3)}`);
  expect(css).toContain(`.${cls[1]}::after{content:"x"}`);
  expect(css).toContain(`.st-${cls[2]}:focus{color:pink}`);
  const [, at768 = "", at375 = ""] = css.split(/@media \(max-width: (?:1439|767)\.98px\)/);
  expect(at768).toContain(`.${cls[1]}{color:blue;margin:4px}`);
  expect(at375).toContain(`.${cls[1]}{color:rgb(1, 2, 3);margin:revert}`);
});

test("instance overrides and main edits reach the output through resolveComponents", () => {
  const caps = captures();
  const v2: IRV2 = migrateIR(buildIR(caps), caps);
  const component = v2.components[0]!;
  component.root.attrs.title = "main title";
  const html = renderSiteV2(v2, opts)["index.html"]!;
  const ids = component.instanceIds;
  // card1 overrode its title at capture time; the others follow the main.
  expect(html).toMatch(new RegExp(`title="main title" class="[^"]+" data-ir-id="${ids[0]}"`));
  expect(html).toContain(`title="card 1"`);
  expect(emitSectionV2(v2, v2.sections.find(s => s.pageId === "p1" && s.role !== "header")!.id, opts)).toContain("main title");
});
