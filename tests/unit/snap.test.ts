import { expect, test } from "vitest";
import { gaps, snap } from "@/app/p/[id]/editor/visual/snap";

test("snap: within the threshold the moving box's left/centre/right and top/middle/bottom jump to the nearest line of a sibling, the parent or the viewport, with the guide spanning both boxes", () => {
  const sib = { x: 100, y: 0, w: 50, h: 50 };
  expect(snap({ x: 103, y: 200, w: 30, h: 30 }, [sib], 4)).toEqual({ dx: -3, dy: 0, guides: [{ axis: "x", at: 100, from: 0, to: 230 }] });
  expect(snap({ x: 160, y: 200, w: 30, h: 30 }, [sib], 4)).toEqual({ dx: 0, dy: 0, guides: [] });
  const parent = { x: 0, y: 0, w: 400, h: 300 };
  expect(snap({ x: 200, y: 298, w: 10, h: 10 }, [parent], 4)).toEqual({ dx: 0, dy: 2, guides: [{ axis: "x", at: 200, from: 0, to: 310 }, { axis: "y", at: 300, from: 0, to: 400 }] });
  expect(snap({ x: 103, y: 200, w: 30, h: 30 }, [sib], 2).dx).toBe(0); // 4 screen px at 200 % = 2 document px (R11)
});

test("gaps: the free space on each axis where two boxes do not overlap; the four inner distances when one holds the other", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  expect(gaps(a, { x: 30, y: 0, w: 10, h: 10 })).toEqual([{ x1: 10, y1: 5, x2: 30, y2: 5, value: 20 }]);
  expect(gaps(a, { x: 0, y: 25, w: 10, h: 10 })).toEqual([{ x1: 5, y1: 10, x2: 5, y2: 25, value: 15 }]);
  expect(gaps({ x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }).map((g) => g.value)).toEqual([10, 80, 30, 10]);
});
