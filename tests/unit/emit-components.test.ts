import { expect, test } from "vitest";
import { compileV2, EMBED_CSP, HIDDEN_RULE, renderSite } from "@/core/emit-html";
import { grapesToCommands, irToGrapes, type GrapesComponent } from "@/core/grapes-adapter";
import { embedSrc, videoAttrs, type CarouselSpec, type VideoSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const css = (base: Record<string, string> = {}) => ({ base, bp: {}, state: {}, pseudo: {} });
const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: css(), children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const spec: CarouselSpec = {
  kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1"], active: 0,
  autoplay: false, interval: 5000, loop: true, direction: "horizontal", transition: "slide", speed: 300,
  slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, arrows: { next: "nx" },
};
const site = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p1", path: "/", title: "t", meta: {}, sectionIds: ["p1-s1"], shell: n("p1:0", "html", [n("p1:0.1", "body", [n("p1-s1", "#section", [], { attrs: { "data-section": "p1-s1" } })])]) }],
  sections: [{ id: "p1-s1", pageId: "p1", name: "hero", role: "block", hash: "h", origin: "capture", root: n("root", "section", [
    n("vp", "div", [n("tr", "div", [
      n("clone", "div", [n("c.t", "#text", [], { text: "B" })], { hidden: true }),
      n("s0", "div", [n("s0.t", "#text", [], { text: "A" })], { styles: css({ width: "300px", "flex-shrink": "1" }) }),
      n("s1", "div", [n("s1.t", "#text", [], { text: "B" })], { styles: css({ width: "300px", "flex-shrink": "1" }) }),
    ])]),
    n("nx", "button", [n("nx.t", "#text", [], { text: "Next" })]),
    n("plain", "p", [n("plain.t", "#text", [], { text: "x" })]),
  ], { interactive: spec }) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const opts = { assetMap: {}, pageUrls: { p1: "https://x.test/" } };

test("root gets data-c + data-c-cfg (ids, no source/confidence), parts get data-c-role, loop clones are not emitted", () => {
  const html = renderSite(site(), opts)["index.html"]!;
  const root = /<section[^>]*data-c="carousel"[^>]*>/.exec(html)![0];
  const cfg = JSON.parse(/data-c-cfg="([^"]*)"/.exec(root)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  expect(cfg).toMatchObject({ kind: "carousel", viewport: "vp", track: "tr", slides: ["s0", "s1"], loop: true });
  expect(cfg).not.toHaveProperty("confidence");
  expect(html).toMatch(/data-c-role="viewport"/);
  expect(html.match(/data-c-role="slide"/g)).toHaveLength(2);
  expect(html).toMatch(/<button[^>]*data-c-role="next"/);
  expect(html).not.toContain('data-ir-id="clone"');
  expect(html).not.toContain("data-behavior");
});

test("CSS: base decl per role through dedupe (slide flex-shrink:0, viewport overflow hidden) and the [hidden] rule", () => {
  const out = renderSite(site(), opts)["css/styles.css"]!;
  expect(out).toContain(HIDDEN_RULE);
  expect(out).toMatch(/flex-shrink:0/);
  expect(out).toMatch(/overflow-x:hidden/);
  const plain = site();
  delete plain.sections[0]!.root.interactive;
  expect(renderSite(plain, opts)["css/styles.css"]).not.toContain(HIDDEN_RULE);
});

test("stripIds keeps data-ir-id only on nodes the cfg references (R6)", () => {
  const html = renderSite(site(), { ...opts, stripIds: true })["index.html"]!;
  for (const id of ["root", "vp", "tr", "s0", "s1", "nx"]) expect(html).toContain(`data-ir-id="${id}"`);
  expect(html).not.toContain('data-ir-id="plain"');
});

test("canvas: data-c* attributes shown, clone hidden, an untouched save diffs to no command", () => {
  const ir = site();
  const project = irToGrapes(compileV2(ir), "p1", opts);
  const root = project.components[0]!;
  expect(root.attributes["data-c"]).toBe("carousel");
  const track = root.components![0]!.components![0]!;
  expect(track.components!.map((c: GrapesComponent) => c.attributes["data-ir-id"])).toEqual(["s0", "s1"]);
  const json = JSON.parse(JSON.stringify({ components: project.components, styles: [] }));
  expect(grapesToCommands(ir, "p1", json, opts)).toEqual([]);
});

test("nested components: a carousel root that is a tabs panel carries both, roles join without collision", () => {
  const ir = site();
  const car = ir.sections[0]!.root;
  car.interactive = { ...spec, source: "scroll-snap", viewport: "tr" }; // scroll-snap: the box is viewport and track
  const tabs = n("tabs", "div", [n("tb", "button", [n("tb.t", "#text", [], { text: "T" })]), car]);
  ir.sections[0]!.root = n("outer", "section", [tabs]);
  tabs.interactive = { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "tb", panel: "root" }], active: 0 };
  const html = renderSite(ir, opts)["index.html"]!;
  expect(html).toMatch(/<section[^>]*data-c="carousel"[^>]*data-c-role="panel"/);
  expect(html).toMatch(/<div[^>]*data-c="tabs"/);
  expect(html).toMatch(/data-c-role="viewport track"[^>]*data-ir-id="tr"/);
  expect(html.match(/data-c-role=/g)).toHaveLength(6); // panel, tab, viewport track, slide x2, next
});

test("captured data-c / data-c-* attributes are dropped: only the interactive spec writes them", () => {
  const ir = site();
  const root = ir.sections[0]!.root;
  delete root.interactive;
  root.attrs = { "data-c": "carousel", "data-c-cfg": "{}", "data-c-role": "slide", "data-c-x": "1", "data-cat": "keep" };
  const files = renderSite(ir, opts);
  expect(files["index.html"]).not.toMatch(/data-c(-[a-z]+)?=/);
  expect(files["index.html"]).toContain('data-cat="keep"');
  expect(files["css/styles.css"]).not.toContain(HIDDEN_RULE);
});

const embed: VideoSpec = { kind: "video", source: "native", confidence: "guessed", node: "if", mode: "embed", autoplay: true, muted: true, loop: false, controls: true };
test("embed: only allowlisted hosts, YouTube goes to youtube-nocookie; the page gets the frame-src meta CSP", () => {
  expect(embedSrc("https://www.youtube.com/embed/abc123?rel=0", embed)).toBe("https://www.youtube-nocookie.com/embed/abc123?autoplay=1&mute=1");
  expect(embedSrc("https://player.vimeo.com/video/42", { ...embed, autoplay: false, muted: false })).toBe("https://player.vimeo.com/video/42");
  expect(embedSrc("https://evil.test/embed/abc", embed)).toBeUndefined();
  const ir = site();
  ir.sections[0]!.root.children.push({ id: "if", parentId: "root", tag: "iframe", type: "media", attrs: { src: "https://www.youtube.com/embed/abc123" }, styles: css(), children: [] });
  ir.sections[0]!.root.children.at(-1)!.interactive = embed;
  const html = renderSite(ir, opts)["index.html"]!;
  expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc123?autoplay=1&amp;mute=1"');
  expect(html).not.toContain("www.youtube.com");
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">`);
  expect(renderSite(site(), opts)["index.html"]).not.toContain("Content-Security-Policy");
});

test("embed edge cases: non-https / look-alike hosts / other paths refused; loop and controls map to params; a refused embed loses its src", () => {
  for (const raw of ["http://www.youtube.com/embed/abc", "https://www.youtube.com.evil.test/embed/abc", "https://www.youtube.com/watch?v=abc", "https://player.vimeo.com/video/42/../x", "javascript:alert(1)", "not a url"])
    expect(embedSrc(raw, embed)).toBeUndefined();
  expect(embedSrc("https://youtube.com/embed/a_b-1", { ...embed, autoplay: false, muted: false, loop: true, controls: false })).toBe("https://www.youtube-nocookie.com/embed/a_b-1?loop=1&controls=0");
  expect(embedSrc("https://player.vimeo.com/video/42", embed)).toBe("https://player.vimeo.com/video/42?autoplay=1&muted=1");
  const ir = site();
  ir.sections[0]!.root.children.push({ id: "if", parentId: "root", tag: "iframe", type: "media", attrs: { src: "https://evil.test/embed/abc" }, styles: css(), children: [], interactive: embed });
  const html = renderSite(ir, opts)["index.html"]!;
  expect(html).not.toContain("evil.test");
  expect(html).not.toContain("Content-Security-Policy");
});

test("native video: videoAttrs writes the spec flags (autoplay forces muted + playsinline) and drops captured ones the spec turns off", () => {
  const vid: VideoSpec = { kind: "video", source: "native", confidence: "guessed", node: "v", mode: "native", autoplay: true, muted: false, loop: false, controls: false };
  expect(videoAttrs(vid)).toEqual({ autoplay: "", muted: "", loop: null, controls: null, playsinline: "" });
  const ir = site();
  ir.sections[0]!.root.children.push({ id: "v", parentId: "root", tag: "video", type: "media", attrs: { controls: "", loop: "" }, styles: css(), children: [], interactive: { ...vid, muted: true } });
  const tag = /<video[^>]*>/.exec(renderSite(ir, opts)["index.html"]!)![0];
  expect(tag).toMatch(/ autoplay=""/);
  expect(tag).toMatch(/ muted=""/);
  expect(tag).not.toMatch(/ controls=| loop=/);
});
