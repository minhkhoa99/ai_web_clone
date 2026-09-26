import { expect, test, vi, beforeEach } from "vitest";
import type { IR, IRNode, Page, Section } from "@/core/ir";
import { AppError } from "@/core/errors";
import { PNG } from "pngjs";
import { applySectionNames, buildOutline, nameSections, thumbnailOf } from "@/core/naming";

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
