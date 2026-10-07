import { expect, test } from "vitest";
import { isSafeCss } from "@/core/safe-names";
import { axisOf, clampZoom, dropZone, fitZoom, freeCommands, handlesFor, indicator, resizeCommands, spacingCommand, wheelZoom, ZOOM, zoomStep } from "@/app/p/[id]/editor/visual/gestures";

const box = { x: 100, y: 100, w: 200, h: 40 };

test("dropZone: outer quarters insert before/after along the parent's axis; the middle half of a container drops inside; indicator geometry", () => {
  expect(dropZone(box, { x: 150, y: 105 }, "y", true)).toBe("before");
  expect(dropZone(box, { x: 150, y: 120 }, "y", true)).toBe("inside");
  expect(dropZone(box, { x: 150, y: 120 }, "y", false)).toBe("after");
  expect(dropZone(box, { x: 150, y: 139 }, "y", true)).toBe("after");
  expect(dropZone(box, { x: 110, y: 120 }, "x", true)).toBe("before");
  expect(indicator(box, "before", "y")).toEqual({ x: 100, y: 99, w: 200, h: 2 });
  expect(indicator(box, "after", "x")).toEqual({ x: 299, y: 100, w: 2, h: 40 });
  expect(indicator(box, "inside", "y")).toEqual(box);
  expect([axisOf("flex", "row"), axisOf("inline-flex", "row-reverse"), axisOf("flex", "column"), axisOf("block", "row"), axisOf("grid", "row")]).toEqual(["x", "x", "y", "y", "y"]);
});

test("freeCommands (R6): absolute at the dropped place from the parent's padding box (border, scroll, margin); a static parent made relative first; all at the breakpoint target; width locked", () => {
  const input = { id: "n", parentId: "p", parentStatic: true, target: 768 as const, box: { x: 150, y: 120, w: 100, h: 40 }, width: 98, parentBox: { x: 100, y: 100, w: 500, h: 300 }, parentBorder: { top: 2, left: 3 }, parentScroll: { top: 10, left: 0 }, margin: { top: 5, left: 4 } };
  expect(freeCommands(input)).toEqual([
    { op: "setStyle", id: "p", target: 768, changes: { position: "relative" } },
    { op: "setStyle", id: "n", target: 768, changes: { position: "absolute", left: "43px", top: "23px", width: "98px" } },
  ]);
  expect(freeCommands({ ...input, parentStatic: false, target: "base" })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { position: "absolute", left: "43px", top: "23px", width: "98px" } }]);
});

test("resize (R13): e/s/se for flow nodes, 8 handles for absolute; width/height px at the target; Shift keeps the ratio; w/n move left/top", () => {
  expect(handlesFor(false)).toEqual(["e", "s", "se"]);
  expect(handlesFor(true)).toHaveLength(8);
  const start = { w: 100, h: 50, top: 10, left: 20 };
  expect(resizeCommands({ id: "n", target: 768, handle: "se", start, dx: 20, dy: 10, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: 768, changes: { width: "120px", height: "60px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start, dx: 50, dy: 0, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "150px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start, dx: 50, dy: 0, keepRatio: true })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "150px", height: "75px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "nw", start, dx: -10, dy: -10, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "110px", height: "60px", left: "10px", top: "0px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "s", start, dx: 0, dy: -80, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { height: "1px" } }]);
});

test("padding / gap handles and zoom helpers (R8)", () => {
  expect(spacingCommand("n", 375, "top", 8, 12)).toEqual({ op: "setStyle", id: "n", target: 375, changes: { "padding-top": "20px" } });
  // one gap axis at a time: the other one (row-gap / column-gap) is never written
  expect(spacingCommand("n", "base", "column-gap", 16, -30)).toEqual({ op: "setStyle", id: "n", target: "base", changes: { "column-gap": "0px" } });
  expect(spacingCommand("n", 768, "row-gap", 16, 8)).toEqual({ op: "setStyle", id: "n", target: 768, changes: { "row-gap": "24px" } });
  expect([clampZoom(0.1), clampZoom(3), clampZoom(0.506)]).toEqual([0.25, 2, 0.51]);
  expect([zoomStep(1, 1), zoomStep(1, -1), zoomStep(0.6, -1), zoomStep(2, 1), zoomStep(0.25, -1)]).toEqual([1.25, 0.75, 0.5, 2, 0.25]);
  expect([wheelZoom(1, -100), wheelZoom(1, 100), wheelZoom(1.95, -1)]).toEqual([1.1, 0.91, 2]);
  expect([fitZoom(736, 1440), fitZoom(616, 375), fitZoom(100, 1440)]).toEqual([0.5, 1.6, 0.25]);
  expect(ZOOM.presets).toEqual([0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2]);
});

test("edge cases: zero-size boxes, non-finite zoom, every produced value passes isSafeCss", () => {
  expect(dropZone({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 }, "y", true)).toBe("inside");
  expect(dropZone({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 }, "y", false)).toBe("after");
  expect([clampZoom(NaN), fitZoom(800, 0), wheelZoom(NaN, -1)]).toEqual([1, 2, 1]);
  const flat = { w: 100, h: 0, top: 0, left: 0 };
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start: flat, dx: 10, dy: 0, keepRatio: true })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "110px", height: "1px" } }]);
  const start = { w: 100, h: 50, top: 10, left: 20 };
  const all = [
    ...handlesFor(true).flatMap((handle) => resizeCommands({ id: "n", target: "base", handle, start, dx: -500, dy: 300.4, keepRatio: handle === "ne" })),
    ...freeCommands({ id: "n", parentId: "p", parentStatic: true, target: "base", box, width: 199.6, parentBox: box, parentBorder: { top: 0, left: 0 }, parentScroll: { top: 0, left: 0 }, margin: { top: 0, left: 0 } }),
    spacingCommand("n", "base", "left", 4, 2.5), spacingCommand("n", "base", "column-gap", 4, 2.5), spacingCommand("n", "base", "row-gap", 4, 2.5),
  ];
  for (const c of all) if (c?.op === "setStyle") for (const [p, v] of Object.entries(c.changes)) expect(isSafeCss(p, v), `${p}: ${v}`).toBe(true);
});

test("non-finite measurements emit nothing (isSafeCss accepts \"NaNpx\"): empty batch for free/resize, undefined for spacing", () => {
  const free = { id: "n", parentId: "p", parentStatic: true, target: "base" as const, box, width: 100, parentBox: box, parentBorder: { top: 0, left: 0 }, parentScroll: { top: 0, left: 0 }, margin: { top: 0, left: 0 } };
  expect([freeCommands({ ...free, margin: { top: NaN, left: 0 } }), freeCommands({ ...free, width: Infinity }), freeCommands({ ...free, parentScroll: { top: 0, left: -Infinity } })]).toEqual([[], [], []]);
  const start = { w: 100, h: 50, top: 10, left: 20 };
  for (const handle of handlesFor(true)) for (const [dx, dy] of [[Infinity, Infinity], [NaN, NaN], [-Infinity, -Infinity]] as const) for (const keepRatio of [false, true]) {
    expect(resizeCommands({ id: "n", target: "base", handle, start, dx, dy, keepRatio }), `${handle} ${dx} ${keepRatio}`).toEqual([]);
  }
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start: { ...start, left: NaN }, dx: 10, dy: 0, keepRatio: false })).toEqual([]);
  expect([spacingCommand("n", "base", "top", NaN, 4), spacingCommand("n", "base", "row-gap", 4, Infinity), spacingCommand("n", "base", "left", -Infinity, 0)]).toEqual([undefined, undefined, undefined]);
});
