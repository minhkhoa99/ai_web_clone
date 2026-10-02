import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { alignChildren } from "@/core/ir-build";
import type { CarouselSpec, ModalSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const el = (tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], bbox: CaptureNode["bbox"] = [0, 0, 100, 20], style: Record<string, string> = {}): CaptureNode => ({ tag, attrs, bbox, style, children });
const txt = (text: string): CaptureNode => ({ tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] });
const doc = (...body: CaptureNode[]) => el("html", {}, [el("head"), el("body", {}, body)]);
// a footer beside the carousel section: a lone body child would be unwrapped by splitSections, cutting the carousel apart
const foot = () => el("footer", {}, [txt("f")]);
// a Swiper track at one breakpoint: `dups` duplicates at each end around 3 real slides of width w + gap g
function swiper(dups: number, w: number, g: number, fontSize: string): CaptureNode {
  const slide = (k: number, clone: boolean, x: number) => el("div", { class: `swiper-slide${clone ? " swiper-slide-duplicate" : ""}${!clone && k === 0 ? " swiper-slide-active" : ""}`, "data-swiper-slide-index": String(k) }, [txt(`S${k}`)], [x, 0, w, 100], { "font-size": fontSize });
  const real = [0, 1, 2], head = real.slice(-dups), tail = real.slice(0, dups);
  const kids = [...head.map((k) => slide(k, true, 0)), ...real.map((k) => slide(k, false, 0)), ...tail.map((k) => slide(k, true, 0))].map((s, i) => ({ ...s, bbox: [i * (w + g), 0, w, 100] as CaptureNode["bbox"] }));
  return el("section", {}, [el("div", { class: "swiper", id: "sw" }, [el("div", { class: "swiper-wrapper" }, kids, [0, 0, 3000, 100]), el("button", { class: "swiper-button-next" }, [txt(">")])], [0, 0, 3 * w + 2 * g, 100])]);
}
function capture(extra: Partial<PageCapture> = {}): PageCapture {
  return {
    url: "https://x.test/", pageId: "p1", capturedAt: "2026-10-02T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [{ bp: 1440, dom: doc(swiper(2, 300, 30, "20px"), foot()), truncated: false }, { bp: 768, dom: doc(swiper(1, 300, 20, "16px"), foot()), truncated: false }, { bp: 375, dom: doc(swiper(3, 300, 10, "14px"), foot()), truncated: false }],
    interactions: [], assets: {}, skippedAssets: [], dynamic: [], ...extra,
  };
}
const same = (dom: CaptureNode) => [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })) as PageCapture["breakpoints"];
const walk = (ir: IRV2): IRNodeV2[] => { const out: IRNodeV2[] = []; const v = (n: IRNodeV2) => { out.push(n); n.children.forEach(v); }; ir.sections.forEach((s) => v(s.root)); return out; };
const carouselOf = (ir: IRV2) => walk(ir).find((n) => n.interactive?.kind === "carousel")!;

test("Review Focus 1 — loop clones + per-bp duplicate counts: real slides only, clones hidden, bp styles kept by key, spv/gap per bp", () => {
  const ir = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }] })]);
  const root = carouselOf(ir), spec = root.interactive as CarouselSpec;
  const nodes = new Map(walk(ir).map((n) => [n.id, n]));
  expect(spec.slides.map((id) => nodes.get(id)!.children[0]!.text)).toEqual(["S0", "S1", "S2"]);
  const track = nodes.get(spec.track)!;
  expect(track.children.filter((c) => c.hidden).length).toBe(4); // 2 + 2 at 1440
  expect(spec.active).toBe(0);
  expect(nodes.get(spec.slides[1]!)!.styles.bp[375]).toMatchObject({ "font-size": "14px" }); // aligned by data-swiper-slide-index
  expect(nodes.get(spec.slides[1]!)!.styles.bp[768]).toMatchObject({ "font-size": "16px" });
  expect(spec.slidesPerView).toEqual({ "1440": 3, "768": 3, "375": 3 });
  expect(spec.gap).toEqual({ "1440": 30, "768": 20, "375": 10 });
  expect(spec).toMatchObject({ source: "swiper", confidence: "observed", loop: true, arrows: { next: expect.any(String) } });
  expect(ir.fidelity.some((x) => x.feature === "component-note" && x.note.includes("slide clone"))).toBe(true);
  // R7: a 1440 clone with no counterpart at 768 (2 duplicates there vs 1) is display:none at 768; keyed alignment is noted
  const clone768 = track.children.filter((c) => c.hidden).find((c) => c.styles.bp[768]?.display === "none");
  expect(clone768).toBeDefined();
  expect(ir.fidelity.some((x) => x.feature === "breakpoint-structure" && x.note.includes("ghép theo khoá slide"))).toBe(true);
  expect(ir.fidelity.some((x) => x.feature === "breakpoint-structure" && x.note.includes("không được clone"))).toBe(false);
});

test("config record wins over measurement; an unreproducible effect stays partial; a config record without effect is supported", () => {
  const read = { perBp: { "1440": { spv: 2.5, gap: 12 } }, loop: true, autoplay: true, interval: 4000, effect: "coverflow", speed: 600, direction: "horizontal" as const };
  const ir = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "config", read }] })]);
  const spec = carouselOf(ir).interactive as CarouselSpec;
  expect(spec).toMatchObject({ confidence: "config", autoplay: true, interval: 4000, speed: 600, transition: "slide", slidesPerView: { "1440": 2.5 }, gap: { "1440": 12 } });
  expect(ir.fidelity.find((x) => x.feature === "component")!.status).toBe("partial");
  expect(ir.fidelity.some((x) => x.note.includes("coverflow"))).toBe(true);

  const plain = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "config", read: { ...read, effect: "fade", perBp: { "1440": { spv: 1.234 } } } }] })]);
  expect(carouselOf(plain).interactive).toMatchObject({ transition: "fade", slidesPerView: { "1440": 1.23 } }); // R1: 2 decimals
  expect(plain.fidelity.find((x) => x.feature === "component")!.status).toBe("supported");
});

test(">100 slides is unsupported 'vượt giới hạn 100 item', not truncated", () => {
  const slides = Array.from({ length: 101 }, (_, k) => el("div", { class: "swiper-slide" }, [txt(`S${k}`)], [k * 100, 0, 100, 100]));
  const dom = doc(el("section", {}, [el("div", { class: "swiper", id: "sw" }, [el("div", { class: "swiper-wrapper" }, slides)], [0, 0, 300, 100])]), foot());
  const ir = buildIR([capture({ breakpoints: same(dom), interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }] })]);
  expect(walk(ir).some((n) => n.interactive)).toBe(false);
  expect(ir.fidelity.some((x) => x.status === "unsupported" && x.note.includes("vượt giới hạn 100 item"))).toBe(true);
});

test("limits: 51 tablists on a page -> 50 components, the rest unsupported 'vượt giới hạn'", () => {
  const tablist = (i: number) => el("div", {}, [el("div", { role: "tablist" }, [el("button", { role: "tab", "aria-controls": `p${i}`, "aria-selected": "true" }, [txt("t")])]), el("div", { role: "tabpanel", id: `p${i}` }, [txt("x")])]);
  const dom = doc(el("main", {}, Array.from({ length: 51 }, (_, i) => tablist(i))));
  const ir = buildIR([capture({ breakpoints: same(dom) })]);
  expect(walk(ir).filter((n) => n.interactive).length).toBe(50);
  expect(ir.fidelity.some((x) => x.status === "unsupported" && x.note.includes("vượt giới hạn"))).toBe(true);
});

test("a hover record turns the guessed dropdown at that trigger into openOn hover (observed); the structural guess adds no conflict note", () => {
  const nav = el("nav", {}, [el("ul", {}, [el("li", { class: "has-sub" }, [el("a", { href: "#x", "aria-haspopup": "true" }, [txt("Sản phẩm")]), el("ul", { class: "sub" }, [el("li", {}, [txt("A")])], [0, 0, 0, 0], { display: "none" })])])]);
  const dom = doc(el("header", {}, [nav]));
  const ir = buildIR([capture({
    breakpoints: same(dom),
    interactives: [{ kind: "dropdown", selector: "html:nth-of-type(1) > body:nth-of-type(1) > header:nth-of-type(1) > nav:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)", panel: "x", openOn: "hover" }],
  })]);
  expect(walk(ir).find((n) => n.interactive)!.interactive).toMatchObject({ kind: "menu", openOn: "hover", confidence: "observed" });
  expect(ir.fidelity.some((x) => x.status === "unsupported" && x.feature === "component-note")).toBe(false);
});

test("a modal with more than 100 triggers keeps 100 and notes the rest (never silently)", () => {
  const triggers = Array.from({ length: 101 }, () => el("button", { "aria-haspopup": "dialog", "data-modal": "#dlg" }, [txt("Mở")]));
  const dom = doc(el("section", {}, triggers), el("footer", {}, [el("div", { id: "dlg", role: "dialog" }, [txt("Hi")])]));
  const ir = buildIR([capture({ breakpoints: same(dom) })]);
  const modal = walk(ir).find((n) => n.interactive?.kind === "modal")!.interactive as ModalSpec;
  expect(modal.triggers).toHaveLength(100);
  expect(ir.fidelity.some((x) => x.feature === "component-note" && x.note.includes("vượt giới hạn 100 item"))).toBe(true);
});

test("alignChildren: positional when counts match, keyed only when every element child on both sides has a key", () => {
  const k = (i: string, extra: Record<string, string> = {}) => el("div", { "data-index": i, ...extra });
  expect(alignChildren(el("ul", {}, [k("0"), k("1")]), el("ul", {}, [k("1"), k("0")]))).toMatchObject({ keyed: false, kids: [{ attrs: { "data-index": "1" } }, { attrs: { "data-index": "0" } }] });
  const a = alignChildren(el("ul", {}, [k("0"), txt(" "), k("1"), k("2")]), el("ul", {}, [k("2"), k("0")]))!;
  expect(a.keyed).toBe(true);
  expect(a.kids.map((x) => x?.attrs["data-index"])).toEqual(["0", undefined, undefined, "2"]);
  expect(alignChildren(el("ul", {}, [k("0"), el("div")]), el("ul", {}, [k("0")]))).toBeUndefined();
  expect(alignChildren(el("ul", {}, [k("0")]), el("ol", {}, [k("0")]))).toBeUndefined();
  // a clone and a real slide with the same index never pair up
  expect(alignChildren(el("ul", {}, [k("0", { class: "slick-cloned" }), k("0")]), el("ul", {}, [k("0")]))!.kids).toEqual([undefined, expect.objectContaining({ attrs: { "data-index": "0" } })]);
});

test("section split never unwraps into a carousel root: body > div.wrapper > div.swiper -> one section holding the whole carousel", () => {
  const slides = [0, 1, 2].map((k) => el("div", { class: "swiper-slide" }, [txt(`S${k}`)], [k * 300, 0, 300, 100]));
  const dom = doc(el("div", { class: "wrapper" }, [el("div", { class: "swiper", id: "sw" }, [el("div", { class: "swiper-wrapper" }, slides), el("button", { class: "swiper-button-next" }, [txt(">")])], [0, 0, 900, 100])]));
  const ir = buildIR([capture({ breakpoints: same(dom), interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }] })]);
  expect(ir.sections).toHaveLength(1);
  expect(ir.sections[0]!.root.attrs.class).toBe("swiper");
  expect(ir.sections[0]!.root.interactive).toMatchObject({ kind: "carousel", slides: expect.any(Array), arrows: { next: expect.any(String) } });
  // without the record the old split still applies (no carousel known before the split)
  expect(buildIR([capture({ breakpoints: same(dom) })]).sections.length).toBeGreaterThan(1);
});

test("768/375 slide boxes follow the slide key: uneven widths and per-bp duplicate counts measure the real slides", () => {
  // 768: no duplicates, uneven real slides 100 / 200 / 600 px, gap 10, viewport 700
  const widths = [100, 200, 600];
  let x = 0;
  const real768 = widths.map((w, k) => { const s = el("div", { class: "swiper-slide", "data-swiper-slide-index": String(k) }, [txt(`S${k}`)], [x, 0, w, 100]); x += w + 10; return s; });
  const dom768 = doc(el("section", {}, [el("div", { class: "swiper", id: "sw" }, [el("div", { class: "swiper-wrapper" }, real768, [0, 0, 3000, 100]), el("button", { class: "swiper-button-next" }, [txt(">")])], [0, 0, 700, 100])]), foot());
  const ir = buildIR([capture({
    breakpoints: [{ bp: 1440, dom: doc(swiper(2, 300, 30, "20px"), foot()), truncated: false }, { bp: 768, dom: dom768, truncated: false }, { bp: 375, dom: doc(swiper(3, 300, 10, "14px"), foot()), truncated: false }],
    interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }],
  })]);
  const spec = carouselOf(ir).interactive as CarouselSpec;
  const nodes = new Map(walk(ir).map((n) => [n.id, n]));
  expect(spec.slides.map((id) => nodes.get(id)!.box?.[768]?.[2])).toEqual([100, 200, 600]);
  expect(spec.slides.map((id) => nodes.get(id)!.box?.[375]?.[0])).toEqual([3 * 310, 4 * 310, 5 * 310]); // the real slides after 3 duplicates
  expect(spec.gap["768"]).toBe(10);
  expect(spec.slidesPerView["768"]).toBe(Math.round((710 / 210) * 100) / 100); // median real slide 200 + gap
});

test("ids regenerated per breakpoint (no 1440 child finds its key) fall back to E1 pairing: nothing is hidden", () => {
  expect(alignChildren(el("ul", {}, [el("li", { id: "a" }), el("li", { id: "b" })]), el("ul", {}, [el("li", { id: "x" })]))).toBeUndefined();
  const list = (...ids: string[]) => doc(el("section", {}, [el("ul", {}, ids.map((id) => el("li", { id }, [txt(id)])))]), foot());
  const ir = buildIR([capture({ breakpoints: [{ bp: 1440, dom: list("a", "b"), truncated: false }, { bp: 768, dom: list("a", "b"), truncated: false }, { bp: 375, dom: list("x"), truncated: false }] })]);
  const lis = walk(ir).filter((n) => n.tag === "li");
  expect(lis).toHaveLength(2);
  for (const li of lis) expect(li.styles.bp[375]?.display).toBeUndefined();
});

test("no capture-box notes for loop clones or text nodes a keyed parent left without counterpart", () => {
  const ir = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }] })]);
  const spec = carouselOf(ir).interactive as CarouselSpec;
  const nodes = new Map(walk(ir).map((n) => [n.id, n]));
  const quiet = new Set<string>();
  for (const c of nodes.get(spec.track)!.children) if (c.hidden) { quiet.add(c.id); c.children.forEach((t) => quiet.add(t.id)); }
  for (const s of spec.slides) nodes.get(s)!.children.forEach((t) => quiet.add(t.id));
  expect(ir.fidelity.filter((x) => x.feature === "capture-box" && quiet.has(x.nodeId ?? ""))).toEqual([]);
});

test("a fresh clone's captured SP1 modal interaction is noted as detected at clone time, never as migrated from v1", () => {
  const dom = doc(el("header", {}, [el("button", { id: "open", "aria-haspopup": "dialog", "aria-controls": "dlg" }, [txt("Mở")])]), el("footer", {}, [el("div", { id: "dlg", role: "dialog", hidden: "" }, [txt("Hi")], [0, 0, 0, 0], { display: "none" })]));
  const ir = buildIR([capture({ breakpoints: same(dom), interactions: [{ id: "i1", kind: "modal", trigger: "#open", status: "captured" }] })]);
  const modal = [...walk(ir), ...ir.pages.flatMap((p) => { const out: IRNodeV2[] = []; const v = (n: IRNodeV2) => { out.push(n); n.children.forEach(v); }; v(p.shell); return out; })].find((n) => n.interactive?.kind === "modal")!;
  const notes = ir.fidelity.filter((x) => x.feature === "component-note" && x.nodeId === modal.id).map((x) => x.note);
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every((note) => note.startsWith("Nhận diện khi clone"))).toBe(true);
});
