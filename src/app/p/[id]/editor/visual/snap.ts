// E3 §3 free placement aids (pure): snapping the moving box to its siblings / parent / viewport (4 px, R11) with guide
// lines, and the Alt+hover distances between the selection and another node.
import type { Box } from "./model";

export const SNAP_PX = 4;
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
export type Gap = { x1: number; y1: number; x2: number; y2: number; value: number };
const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];

export function snap(moving: Box, others: readonly Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const best = (mine: number[], lines: (b: Box) => number[]) => {
    let hit: { d: number; at: number } | undefined;
    for (const o of others) for (const line of lines(o)) for (const m of mine) {
      const d = line - m;
      if (Math.abs(d) <= threshold && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: line };
    }
    return hit;
  };
  const bx = best(xs(moving), xs), by = best(ys(moving), ys);
  const moved = { ...moving, x: moving.x + (bx?.d ?? 0), y: moving.y + (by?.d ?? 0) };
  const span = (at: number, lines: (b: Box) => number[], lo: (b: Box) => number, hi: (b: Box) => number) => {
    const boxes = [moved, ...others.filter((o) => lines(o).some((l) => Math.abs(l - at) < 0.5))];
    return { from: Math.min(...boxes.map(lo)), to: Math.max(...boxes.map(hi)) };
  };
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: "x", at: bx.at, ...span(bx.at, xs, (b) => b.y, (b) => b.y + b.h) });
  if (by) guides.push({ axis: "y", at: by.at, ...span(by.at, ys, (b) => b.x, (b) => b.x + b.w) });
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides };
}

export function gaps(a: Box, b: Box): Gap[] {
  const holds = (o: Box, i: Box) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  if (holds(b, a) || holds(a, b)) {
    const [o, i] = holds(b, a) ? [b, a] : [a, b];
    const cx = i.x + i.w / 2, cy = i.y + i.h / 2;
    return [
      { x1: cx, y1: o.y, x2: cx, y2: i.y, value: i.y - o.y },
      { x1: i.x + i.w, y1: cy, x2: o.x + o.w, y2: cy, value: o.x + o.w - (i.x + i.w) },
      { x1: cx, y1: i.y + i.h, x2: cx, y2: o.y + o.h, value: o.y + o.h - (i.y + i.h) },
      { x1: o.x, y1: cy, x2: i.x, y2: cy, value: i.x - o.x },
    ].map((g) => ({ ...g, value: Math.round(g.value) }));
  }
  const out: Gap[] = [];
  const overlapY = Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h), overlapX = Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w);
  const y = overlapY ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : a.y + a.h / 2;
  const x = overlapX ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : a.x + a.w / 2;
  if (b.x >= a.x + a.w) out.push({ x1: a.x + a.w, y1: y, x2: b.x, y2: y, value: Math.round(b.x - a.x - a.w) });
  else if (a.x >= b.x + b.w) out.push({ x1: b.x + b.w, y1: y, x2: a.x, y2: y, value: Math.round(a.x - b.x - b.w) });
  if (b.y >= a.y + a.h) out.push({ x1: x, y1: a.y + a.h, x2: x, y2: b.y, value: Math.round(b.y - a.y - a.h) });
  else if (a.y >= b.y + b.h) out.push({ x1: x, y1: b.y + b.h, x2: x, y2: a.y, value: Math.round(a.y - b.y - b.h) });
  return out;
}
