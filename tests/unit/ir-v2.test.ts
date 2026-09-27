import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { toV2 } from "@/core/ir-v2";

const node = (tag: string, children: CaptureNode[] = [], style: Record<string, string> = {}): CaptureNode => ({
  tag, attrs: {}, bbox: [1, 2, 30, 40], style, children,
});
const dom = (color: string) => node("html", [node("body", [node("section", [node("span", [node("#text")])], { color }), node("footer")])]);
const capture: PageCapture = {
  pageId: "p1", url: "https://x.test/", capturedAt: "2026-09-27", title: "test", meta: {},
  cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
  breakpoints: [
    { bp: 1440, dom: dom("blue"), truncated: false },
    { bp: 768, dom: dom("red"), truncated: false },
    { bp: 375, dom: dom("green"), truncated: false },
  ],
  interactions: [], assets: {}, skippedAssets: [], dynamic: [],
};

test("converts class styles, responsive overrides, pseudo, parent and matching boxes", () => {
  const legacy = buildIR([capture]);
  const root = legacy.sections[0]!.root;
  legacy.classes[root.cls[0]!]!.before = { content: '"x"' };
  legacy.classes[root.cls[0]!]!.after = { content: '"y"' };
  legacy.classes.extra = { base: { color: "purple" } };
  root.states = { hover: "extra" };
  const v2 = toV2(legacy, [capture]);
  const converted = v2.sections[0]!.root;
  expect(v2.version).toBe(2);
  expect(converted.id).toBe(root.id);
  expect(converted.styles).toMatchObject({ base: { color: "blue" }, bp: { 768: { color: "red" }, 375: { color: "green" } }, state: { hover: { color: "purple" } }, pseudo: { before: { content: '"x"' }, after: { content: '"y"' } } });
  expect(converted.children[0]!.parentId).toBe(converted.id);
  expect(converted.children[0]!.type).toBe("text");
  expect(converted.box?.[1440]).toEqual([1, 2, 30, 40]);
  expect(converted.children[0]!.children[0]!.type).toBe("text");
});

test("missing class fails instead of silently losing style", () => {
  const legacy = buildIR([capture]);
  legacy.sections[0]!.root.cls = ["missing"];
  expect(() => toV2(legacy, [capture])).toThrow(/missing class: missing/);
});

test("resolves classes in order and omits a box when the captured tag differs", () => {
  const legacy = buildIR([capture]);
  const root = legacy.sections[0]!.root;
  legacy.classes.override = { base: { color: "orange" }, media: { "768": { color: "purple" } } };
  root.cls.push("override");
  const changed = structuredClone(capture);
  changed.breakpoints[0]!.dom.children[0]!.children[0]!.tag = "article";

  const converted = toV2(legacy, [changed]).sections[0]!.root;
  expect(converted.styles.base.color).toBe("orange");
  expect(converted.styles.bp[768]?.color).toBe("purple");
  expect(converted.box?.[1440]).toBeUndefined();
  expect(converted.box?.[768]).toEqual([1, 2, 30, 40]);
});
