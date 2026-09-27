import { expect, test, vi, beforeEach } from "vitest";
import type { IR, IRNode, Page, Section } from "@/core/ir";
import { AppError } from "@/core/errors";
import { PNG } from "pngjs";
import { applySectionNames, buildOutline, capOutlineText, estimateTokens, fitImages, fitRequest, MAX_IMAGE_WIDTH, MAX_IMAGES_B64, MAX_REQUEST_TOKENS, nameSections, thumbnailOf, type SectionOutline } from "@/core/naming";

vi.mock("@/core/gateway", () => ({ generate: vi.fn() }));
import { generate } from "@/core/gateway";
const generateMock = vi.mocked(generate);

let nextId = 0;
function node(tag: string, children: IRNode[] = [], extra: Partial<IRNode> = {}): IRNode {
  nextId += 1;
  return { id: `n${nextId}`, tag, attrs: {}, cls: [], children, ...extra };
}
function txt(text: string): IRNode {
  return node("#text", [], { text });
}
function section(id: string, role: string, root: IRNode): Section {
  return { id, pageId: "p1", name: `raw-${id}`, role, hash: "h", origin: "capture", root };
}
function makeIr(sections: Section[], sectionIds = sections.map((s) => s.id)): IR {
  const page: Page = { id: "p1", path: "/", title: "t", meta: {}, sectionIds, shell: node("html") };
  return {
    pages: [page],
    sections,
    layouts: [],
    components: [],
    classes: {},
    tokens: {},
    cssom: { keyframes: [], fontFace: [], vars: {} },
    interactions: [],
  };
}

beforeEach(() => {
  nextId = 0;
  generateMock.mockReset();
});

test("buildOutline never includes attrs (secrets can't reach the AI)", () => {
  const input = node("input", [], { attrs: { value: "hunter2", type: "password" } });
  const s1 = section("s1", "form", node("section", [input]));
  const ir = makeIr([s1]);

  const outline = buildOutline(ir, "p1");

  expect(JSON.stringify(outline)).not.toContain("hunter2");
  expect(outline).toEqual([{ id: "s1", tag: { tag: "section", children: [{ tag: "input", children: [] }] }, text: "" }]);
});

test("buildOutline caps tag tree at depth 3 and text at 200 chars", () => {
  const deep = node("a", [node("b", [node("c", [node("d", [])])])]);
  const longText = "x".repeat(250);
  const s1 = section("s1", "hero", node("section", [deep, txt(longText)]));
  const ir = makeIr([s1]);

  const [outline] = buildOutline(ir, "p1");

  expect(outline!.text).toHaveLength(200);
  // depth 3 from section root: section(1) > a(2) > b(3) -> b's children dropped
  expect(outline!.tag).toEqual({
    tag: "section",
    children: [{ tag: "a", children: [{ tag: "b", children: [] }] }, { tag: "#text", children: [] }],
  });
});

test("valid JSON response maps sections to name/role, exactly one generate call", async () => {
  const s1 = section("s1", "header", node("header", [txt("Logo")]));
  const s2 = section("s2", "footer", node("footer", [txt("Copy")]));
  const ir = makeIr([s1, s2]);
  generateMock.mockResolvedValue({
    text: JSON.stringify({ s1: { name: "Top Nav!", role: "navigation" }, s2: { name: "footer", role: "footer" } }),
    tokens: 10,
  });

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({
    s1: { name: "top-nav", role: "navigation" },
    s2: { name: "footer", role: "footer" },
  });
  expect(result.error).toBeUndefined();
  expect(generateMock).toHaveBeenCalledTimes(1);
  expect(generateMock.mock.calls[0]![1]).toMatchObject({ role: "vision", projectId: "proj1" });
  expect(generateMock.mock.calls[0]![1].jsonSchema).toBeDefined();
});

test("garbage response falls back to section-1..N with existing roles and AI_BAD_RESPONSE error", async () => {
  const s1 = section("s1", "header", node("header"));
  const s2 = section("s2", "footer", node("footer"));
  const ir = makeIr([s1, s2]);
  generateMock.mockResolvedValue({ text: "not json at all {{{", tokens: 3 });

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({
    s1: { name: "section-1", role: "header" },
    s2: { name: "section-2", role: "footer" },
  });
  expect(result.error).toBe("AI_BAD_RESPONSE");
  expect(result.errorMessage).toBe("naming reply is not JSON");
});

test("generate throws AI_RATE_LIMIT -> fallback names + error code, never throws", async () => {
  const s1 = section("s1", "hero", node("section"));
  const ir = makeIr([s1]);
  generateMock.mockRejectedValue(new AppError("AI_RATE_LIMIT", "rate limited", {}));

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({ s1: { name: "section-1", role: "hero" } });
  expect(result.error).toBe("AI_RATE_LIMIT");
  expect(result.errorMessage).toBe("rate limited");
});

test("partial response: missing/invalid sections fall back individually, others keep AI names", async () => {
  const s1 = section("s1", "header", node("header"));
  const s2 = section("s2", "footer", node("footer"));
  const s3 = section("s3", "body", node("main"));
  const ir = makeIr([s1, s2, s3]);
  generateMock.mockResolvedValue({
    text: JSON.stringify({ s1: { name: "top-bar", role: "navigation" }, s2: { name: 42 /* invalid shape */ } }),
    tokens: 5,
  });

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({
    s1: { name: "top-bar", role: "navigation" },
    s2: { name: "section-2", role: "footer" },
    s3: { name: "section-3", role: "body" },
  });
});

test("unknown ids in the AI response are ignored", async () => {
  const s1 = section("s1", "header", node("header"));
  const ir = makeIr([s1]);
  generateMock.mockResolvedValue({
    text: JSON.stringify({ s1: { name: "top", role: "nav" }, "ghost-id": { name: "x", role: "y" } }),
    tokens: 2,
  });

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({ s1: { name: "top", role: "nav" } });
});

test("applySectionNames is pure/immutable and only touches name/role", () => {
  const s1 = section("s1", "header", node("header"));
  const ir = Object.freeze(makeIr([s1]));
  const before = JSON.stringify(ir);

  const next = applySectionNames(ir, { s1: { name: "top-nav", role: "navigation" } });

  expect(JSON.stringify(ir)).toBe(before);
  expect(next.sections[0]).toEqual({ ...s1, name: "top-nav", role: "navigation" });
  expect(next).not.toBe(ir);
});

test("fallback names use the position on the owning page: a shared layout is never renumbered by another page", async () => {
  // p1 owns [a, shared, b]; p2 = [shared, c, d] reuses p1's layout section at a different position
  const a = section("a", "hero", node("section"));
  const shared = section("shared", "nav", node("nav"));
  const b = section("b", "body", node("main"));
  const c = { ...section("c", "body", node("main")), pageId: "p2" };
  const d = { ...section("d", "footer", node("footer")), pageId: "p2" };
  const ir = makeIr([a, shared, b, c, d], ["a", "shared", "b"]);
  ir.pages.push({ id: "p2", path: "/2", title: "t", meta: {}, sectionIds: ["shared", "c", "d"], shell: node("html") });
  generateMock.mockRejectedValue(new AppError("AI_RATE_LIMIT", "rate limited", {}));

  const p1 = await nameSections({} as never, "proj1", ir, "p1");
  const p2 = await nameSections({} as never, "proj1", ir, "p2");
  const merged = { ...p1.names, ...p2.names };

  expect(p1.names.shared).toEqual({ name: "section-2", role: "nav" });
  expect(p2.names).toEqual({ c: { name: "section-2", role: "body" }, d: { name: "section-3", role: "footer" } }); // shared left to its owner
  expect(new Set(["a", "shared", "b"].map((id) => merged[id]!.name)).size).toBe(3);
});

test("thumbnailOf: nearest-neighbour downscale to <= 400px wide, height capped; small shots keep their size", () => {
  const src = new PNG({ width: 1440, height: 3000 });
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const left = x < 720;
      src.data.set([left ? 255 : 0, 0, left ? 0 : 255, 255], i); // left red, right blue
    }
  const t = thumbnailOf(src);
  expect([t.width, t.height]).toEqual([400, 833]);
  const at = (x: number, y: number) => [...t.data.subarray((y * t.width + x) * 4, (y * t.width + x) * 4 + 3)];
  expect(at(10, 10)).toEqual([255, 0, 0]);
  expect(at(390, 800)).toEqual([0, 0, 255]);
  expect(thumbnailOf(new PNG({ width: 1440, height: 5000 })).height).toBe(1200); // tall page (1389px scaled): top part only
  const small = thumbnailOf(new PNG({ width: 300, height: 100 }));
  expect([small.width, small.height]).toEqual([300, 100]);
});

test("the run's abort signal goes with the naming call (pause cancels it)", async () => {
  const ir = makeIr([section("s1", "header", node("header"))]);
  generateMock.mockResolvedValue({ text: "{}", tokens: 1 });
  const signal = new AbortController().signal;
  await nameSections({} as never, "proj1", ir, "p1", { signal });
  expect(generateMock.mock.calls[0]![1].signal).toBe(signal);
});

test("nameSections: outline text sent to AI is capped at 24 000 chars total even with many long sections", async () => {
  const sections: Section[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 200; i++) {
    const id = `s${i}`;
    sections.push(section(id, "body", node("section", [txt("x".repeat(199))]))); // 199, not 200: keeps 24 000 / N off a clean boundary
    ids.push(id);
  }
  const ir = makeIr(sections, ids);
  generateMock.mockResolvedValue({ text: "{}", tokens: 1 });

  await nameSections({} as never, "proj1", ir, "p1");

  const sent = JSON.parse(generateMock.mock.calls[0]![1].messages[1]!.content as string) as SectionOutline[];
  expect(sent.reduce((sum, o) => sum + o.text.length, 0)).toBeLessThanOrEqual(24_000);
  expect(sent.some((o) => o.text.endsWith("…"))).toBe(true); // the section where the budget ran out
});

test("capOutlineText: total capped, the section where budget runs out gets a trailing …, later ones lose text", () => {
  const outline: SectionOutline[] = [
    { id: "s1", tag: { tag: "div", children: [] }, text: "a".repeat(10) },
    { id: "s2", tag: { tag: "div", children: [] }, text: "b".repeat(10) },
    { id: "s3", tag: { tag: "div", children: [] }, text: "c".repeat(10) },
  ];

  const capped = capOutlineText(outline, 15);

  expect(capped.map((o) => o.text)).toEqual(["a".repeat(10), `${"b".repeat(4)}…`, ""]);
});

// PNG filled with varying bytes so it doesn't compress away to nothing (defeats testing a size cap).
function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 37 + 11) % 256;
  return PNG.sync.write(png);
}

test("fitImages: downscales each image to <= maxWidth (aspect kept)", () => {
  const buf = noisyPng(2880, 50);

  const [b64] = fitImages([buf], { maxWidth: 1024, maxTotalB64: Number.MAX_SAFE_INTEGER });

  const out = PNG.sync.read(Buffer.from(b64!, "base64"));
  expect(out.width).toBe(1024);
  expect(out.height).toBe(Math.round((50 * 1024) / 2880)); // aspect kept: same width scale applied to height
});

test("fitImages: over the base64 cap drops from the end (heat, then clone), keeping order and never throwing", () => {
  const buf = noisyPng(300, 300);
  const [solo] = fitImages([buf], { maxWidth: 2000, maxTotalB64: Number.MAX_SAFE_INTEGER });
  const capForTwo = solo!.length * 2 + 10; // room for 2 of these, not 3

  const trio = fitImages([buf, buf, buf], { maxWidth: 2000, maxTotalB64: capForTwo });
  expect(trio).toEqual([solo, solo]); // orig + clone kept, heat (last) dropped

  // even a single image over cap: halving loop is bounded, still returns something
  const tiny = fitImages([noisyPng(2000, 2000)], { maxWidth: 1024, maxTotalB64: 1 });
  expect(tiny).toHaveLength(1);
});

// Real-run evidence (hardening spec §8): one 1024x608 crop was 1 245 662 base64 chars, which the proxy counted
// as ~311k tokens. Every request's images are now capped at 384 KiB of base64 in total (~98k tokens worst case).
test("MAX_IMAGES_B64 is 384 KiB: a real-run sized noisy crop trio is fitted under it", () => {
  expect(MAX_IMAGES_B64).toBe(384 * 1024);
  const noise = () => {
    const png = new PNG({ width: 1024, height: 608 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    return PNG.sync.write(png);
  };
  const fitted = fitImages([noise(), noise(), noise()], { maxWidth: MAX_IMAGE_WIDTH, maxTotalB64: MAX_IMAGES_B64 });
  expect(fitted.length).toBeGreaterThan(0);
  expect(fitted.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(384 * 1024);
});

// Real-run evidence (hardening spec §8): the fix request of home-s2 was a 1 245 662-char image + ~156k chars of
// text ≈ 360k tokens (limit 270k). Every request is estimated at chars/4, base64 included, and kept <= 120 000.
test("fitRequest: the real-run request (1 245 662-char image + 156k text) fits under 120k tokens once the image is dropped", () => {
  expect(MAX_REQUEST_TOKENS).toBe(120_000);
  const scales: number[] = [];
  const build = (scale: number) => (scales.push(scale), [{ role: "user" as const, content: "t".repeat(Math.round(156_000 * scale)) }]);
  const image = "i".repeat(1_245_662);
  expect(estimateTokens(build(1), [image])).toBeGreaterThan(350_000);
  scales.length = 0;
  const fitted = fitRequest(build, [image]);
  expect(fitted.images).toEqual([]);
  expect(estimateTokens(fitted.messages, fitted.images)).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
  expect(scales).toEqual([1]); // the text was never shrunk: dropping the image was enough
});

test("fitRequest: images drop from the end first; then the text budgets halve (<= 3 steps); still over -> sent anyway", () => {
  const text = (chars: number) => (scale: number) => [{ role: "user" as const, content: "t".repeat(Math.round(chars * scale)) }];
  // the small first image survives when dropping the big last one is enough
  expect(fitRequest(text(1000), ["a".repeat(100), "b".repeat(600_000)]).images).toEqual(["a".repeat(100)]);
  // 1M chars of text: 250k tokens at scale 1, 125k at 1/2, 62.5k at 1/4
  const scales: number[] = [];
  const shrinkable = fitRequest((s) => (scales.push(s), text(1_000_000)(s)), ["a".repeat(100)]);
  expect(scales).toEqual([1, 0.5, 0.25]);
  expect(shrinkable.images).toEqual([]);
  expect(estimateTokens(shrinkable.messages)).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
  // text that ignores the scale: 3 halvings, then it goes as is (the provider decides)
  scales.length = 0;
  const stuck = fitRequest((s) => (scales.push(s), text(2_000_000)(1)), []);
  expect(scales).toEqual([1, 0.5, 0.25, 0.125]);
  expect(stuck.messages[0]!.content.length).toBe(2_000_000);
});

test("nameSections: a request over 120k estimated tokens goes without the thumbnail", async () => {
  const ir = makeIr([section("s1", "header", node("header"))]);
  generateMock.mockResolvedValue({ text: "{}", tokens: 1 });
  await nameSections({} as never, "proj1", ir, "p1", { thumbnail: "a".repeat(500_000) });
  expect(generateMock.mock.calls[0]![1].images).toBeUndefined();
  await nameSections({} as never, "proj1", ir, "p1", { thumbnail: "abc" });
  expect(generateMock.mock.calls[1]![1].images).toEqual(["abc"]);
});

// Hardening spec §8: a 0-height crop encoded as PNG does not read back ("bad png - invalid inflate data
// response") and that throw failed the whole project. A buffer that does not decode is skipped instead.
test("fitImages: buffers that fail to decode (0-height PNG, garbage, empty) are skipped, never thrown", () => {
  const zeroHeight = PNG.sync.write(new PNG({ width: 1024, height: 0 }));
  expect(() => PNG.sync.read(zeroHeight)).toThrow();
  const good = noisyPng(50, 50);
  const [solo] = fitImages([good], { maxWidth: 1024, maxTotalB64: Number.MAX_SAFE_INTEGER });
  const opts = { maxWidth: 1024, maxTotalB64: Number.MAX_SAFE_INTEGER };
  expect(fitImages([good, zeroHeight, Buffer.from("not a png"), Buffer.alloc(0)], opts)).toEqual([solo]);
  expect(fitImages([zeroHeight, good], opts)).toEqual([solo]);
  expect(fitImages([zeroHeight], opts)).toEqual([]);
});
