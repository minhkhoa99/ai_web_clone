import { expect, test } from "vitest";
import { buildIR } from "@/core/ir";
import { migrateIR } from "@/core/ir-migrate";
import { AppError, Codes } from "@/core/errors";
import { MAX_CAPTURE_NODES } from "@/core/limit";
import type { CaptureNode, PageCapture } from "@/core/capture";

const node = (tag: string, children: CaptureNode[] = []): CaptureNode => ({ tag, attrs: {}, bbox: [1, 2, 30, 40], style: {}, children });
const dom = () => node("html", [node("body", [node("section", [node("span", [node("#text")])]), node("footer")])]);
const capture: PageCapture = {
  pageId: "p1", url: "https://x.test/", capturedAt: "2026-09-27", title: "test", meta: {},
  cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
  breakpoints: [{ bp: 1440, dom: dom(), truncated: false }, { bp: 768, dom: dom(), truncated: false }],
  interactions: [], assets: {}, skippedAssets: [], dynamic: [],
};

test("migration is pure and idempotent, preserving only captured boxes", () => {
  const legacy = buildIR([capture]);
  const before = structuredClone(legacy);
  const migrated = migrateIR(legacy, [capture]);
  expect(legacy).toEqual(before);
  expect(migrateIR(migrated, [])).toBe(migrated);
  expect(migrated.sections[0]!.root.box?.[1440]).toEqual([1, 2, 30, 40]);
  expect(migrated.sections[0]!.root.box?.[768]).toEqual([1, 2, 30, 40]);
  expect(migrated.sections[0]!.root.box?.[375]).toBeUndefined();
  expect(migrated.fidelity.some((x) => x.status === "partial" && x.breakpoint === 375 && x.note.includes("capture"))).toBe(true);
});

test("unsupported version and malformed v1 fail with coded errors without mutation", () => {
  const legacy = buildIR([capture]);
  expect(() => migrateIR({ ...legacy, version: 3 }, [capture])).toThrowError(AppError);
  try { migrateIR({ ...legacy, version: 3 }, [capture]); } catch (error) { expect((error as AppError).code).toBe(Codes.IR_VERSION_UNSUPPORTED); }
  const cases = [
    (ir: typeof legacy) => { ir.sections[0]!.root.cls = ["missing"]; },
    (ir: typeof legacy) => { ir.sections[0]!.root.children[0]!.id = ir.sections[0]!.root.id; },
    (ir: typeof legacy) => { ir.sections[0]!.root.children = [null as never]; },
  ];
  for (const change of cases) {
    const input = structuredClone(legacy);
    change(input);
    const before = structuredClone(input);
    expect(() => migrateIR(input, [capture])).toThrowError(AppError);
    expect(input).toEqual(before);
  }
});

test("tag mismatch omits box and reports partial capture fidelity", () => {
  const legacy = buildIR([capture]);
  const changed = structuredClone(capture);
  changed.breakpoints[0]!.dom.children[0]!.children[0]!.tag = "article";
  const migrated = migrateIR(legacy, [changed]);
  const root = migrated.sections[0]!.root;
  expect(root.box?.[1440]).toBeUndefined();
  expect(migrated.fidelity.some((x) => x.nodeId === root.id && x.breakpoint === 1440 && x.status === "partial")).toBe(true);
});

// Loader bounds are the capture ceiling per page (MAX_CAPTURE_NODES) and a 1 000-level stack guard; the 500/20
// limits belong to edited subtrees (ir-command), so real captured sections above them still load.
const chain = (prefix: string, levels: number, leaf: (id: string) => object) => {
  let n = leaf(`${prefix}-${levels}`) as { id: string; children: object[] };
  for (let i = levels - 1; i >= 0; i--) n = { ...(leaf(`${prefix}-${i}`) as object), children: [n] } as typeof n;
  return n;
};
test("real-size sections load (v1 and v2); pages over the capture ceiling or 1 000 levels are refused", () => {
  const v1leaf = (id: string) => ({ id, tag: "div", attrs: {}, cls: [], children: [] });
  const legacy = buildIR([capture]);
  legacy.sections[0]!.root.children = [chain("deep", 25, v1leaf) as never, ...Array.from({ length: 600 }, (_, i) => v1leaf(`wide-${i}`))];
  const v2 = migrateIR(legacy, [capture]);
  expect(v2.sections[0]!.root.children).toHaveLength(601);
  expect(migrateIR(v2, [capture])).toBe(v2);

  const v2leaf = (id: string) => ({ id, tag: "div", type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [] });
  const tooWide = { ...v2, sections: [{ ...v2.sections[0]!, root: { ...v2.sections[0]!.root, children: Array.from({ length: MAX_CAPTURE_NODES }, (_, i) => v2leaf(`w${i}`)) } }] };
  const tooDeep = { ...v2, sections: [{ ...v2.sections[0]!, root: { ...v2.sections[0]!.root, children: [chain("d", 1_000, v2leaf)] } }] };
  for (const bad of [tooWide, tooDeep]) expect(() => migrateIR(bad, [])).toThrow(/page limit/);
  const legacyWide = buildIR([capture]);
  legacyWide.sections[0]!.root.children = Array.from({ length: MAX_CAPTURE_NODES }, (_, i) => v1leaf(`w${i}`));
  expect(() => migrateIR(legacyWide, [capture])).toThrow(/page limit/);
});

test("malformed v2 is rejected with a coded error before reference return", () => {
  const valid = migrateIR(buildIR([capture]), [capture]);
  for (const bad of [{ version: 2 }, { ...valid, sections: [{ ...valid.sections[0], root: { ...valid.sections[0]!.root, styles: null } }] }]) {
    try {
      migrateIR(bad, []);
      throw new Error("accepted malformed v2");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(Codes.IR_PATCH_INVALID);
    }
  }
});

test("malformed legacy cssom is rejected with a coded error", () => {
  const legacy = buildIR([capture]);
  for (const cssom of [{}, { keyframes: [], fontFace: null, vars: {} }, { keyframes: [], fontFace: [], vars: null }]) {
    try {
      migrateIR({ ...legacy, cssom }, [capture]);
      throw new Error("accepted malformed cssom");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(Codes.IR_PATCH_INVALID);
    }
  }
});

test("v2 rejects unknown node types and non-string declaration or attribute values", () => {
  const valid = migrateIR(buildIR([capture]), [capture]);
  const root = valid.sections[0]!.root;
  for (const changed of [
    { type: "not-a-node-type" },
    { attrs: { title: 42 } },
    { styles: { ...root.styles, base: { color: 42 } } },
    { styles: { ...root.styles, bp: { 768: { color: 42 } } } },
  ]) {
    const bad = { ...valid, sections: [{ ...valid.sections[0], root: { ...root, ...changed } }] };
    try {
      migrateIR(bad, []);
      throw new Error("accepted malformed v2 node");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(Codes.IR_PATCH_INVALID);
    }
  }
});
