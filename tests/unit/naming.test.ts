import { expect, test, vi, beforeEach } from "vitest";
import type { IR, IRNode, Page, Section } from "@/core/ir";
import { AppError } from "@/core/errors";
import { applySectionNames, buildOutline, nameSections } from "@/core/naming";

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
});

test("generate throws AI_RATE_LIMIT -> fallback names + error code, never throws", async () => {
  const s1 = section("s1", "hero", node("section"));
  const ir = makeIr([s1]);
  generateMock.mockRejectedValue(new AppError("AI_RATE_LIMIT", "rate limited", {}));

  const result = await nameSections({} as never, "proj1", ir, "p1");

  expect(result.names).toEqual({ s1: { name: "section-1", role: "hero" } });
  expect(result.error).toBe("AI_RATE_LIMIT");
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
