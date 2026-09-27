import { expect, test } from "vitest";
import { buildIR } from "@/core/ir";
import { migrateIR } from "@/core/ir-migrate";
import { AppError, Codes } from "@/core/errors";
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

test("subtree limits reject deep and oversized legacy input", () => {
  const legacy = buildIR([capture]);
  const root = legacy.sections[0]!.root;
  let deep = root;
  for (let i = 0; i < 20; i++) {
    const child = { ...deep, id: `deep-${i}`, children: [] };
    deep.children = [child];
    deep = child;
  }
  expect(() => migrateIR(legacy, [capture])).toThrowError(AppError);

  const wide = buildIR([capture]);
  wide.sections[0]!.root.children = Array.from({ length: 500 }, (_, i) => ({ id: `wide-${i}`, tag: "div", attrs: {}, cls: [], children: [] }));
  expect(() => migrateIR(wide, [capture])).toThrowError(AppError);
});
