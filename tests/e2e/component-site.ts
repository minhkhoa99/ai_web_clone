// Hand-built IR v2 pages with components, emitted and served for runtime / QA tests (E2 Tasks 3, 4, 9).
import { join } from "node:path";
import { emitHtml } from "@/core/emit-html";
import type { CarouselSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { serveDir } from "@/core/serve";

export const css = (base: Record<string, string> = {}) => ({ base, bp: {}, state: {}, pseudo: {} });
export const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: css(), children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
export const t = (id: string, text: string) => n(id, "#text", [], { text });
export function siteOf(...roots: IRNodeV2[]): IRV2 {
  const sections = roots.map((root, i) => ({ id: `s${i}`, pageId: "home", name: `s${i}`, role: "block", hash: `h${i}`, origin: "capture" as const, root }));
  return {
    version: 2, revision: 0,
    pages: [{ id: "home", path: "/", title: "R", meta: {}, sectionIds: sections.map((s) => s.id), shell: n("html", "html", [n("body", "body",
      sections.map((s) => n(`ph-${s.id}`, "#section", [], { attrs: { "data-section": s.id } })), { styles: css({ margin: "0px" }) })]) }],
    sections, layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
  };
}
const COLORS = ["rgb(200, 0, 0)", "rgb(0, 200, 0)", "rgb(0, 0, 200)"];
export function carouselRoot(over: Partial<CarouselSpec> = {}, prefix = ""): IRNodeV2 {
  const p = (id: string) => `${prefix}${id}`;
  const slides = [0, 1, 2].map((i) => n(p(`sl${i}`), "div", [t(p(`sl${i}t`), `Slide ${i + 1}`)], { styles: css({ height: "100px", "background-color": COLORS[i]! }) }));
  return n(p("root"), "section", [
    n(p("vp"), "div", [n(p("tr"), "div", slides, { styles: css({ display: "flex" }) })], { styles: css({ width: "300px" }) }),
    n(p("prev"), "button", [t(p("pt"), "Prev")]), n(p("next"), "button", [t(p("nt"), "Next")]),
    n(p("dots"), "div", [0, 1, 2].map((i) => n(p(`d${i}`), "span", [t(p(`d${i}t`), "•")], { styles: css({ opacity: i === 0 ? "1" : "0.4" }) }))),
  ], { interactive: {
    kind: "carousel", source: "swiper", confidence: "config", viewport: p("vp"), track: p("tr"), slides: slides.map((s) => s.id), active: 0,
    autoplay: false, interval: 1000, loop: false, direction: "horizontal", transition: "slide", speed: 0,
    slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, arrows: { prev: p("prev"), next: p("next") }, pagination: { container: p("dots"), kind: "bullets" }, ...over,
  } });
}
export async function emitAndServe(ir: IRV2, dir: string): Promise<{ url: string; outDir: string; close(): Promise<void> }> {
  const outDir = join(dir, "out");
  await emitHtml(ir, { outDir, workspaceDir: dir, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  const server = await serveDir(outDir);
  return { url: `${server.url}/index.html`, outDir, close: server.close };
}
