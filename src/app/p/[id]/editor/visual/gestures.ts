// E3 §3 gestures (pure): pointer geometry -> command batches. Boxes are document px of the canvas frame (model.Box).
import type { EditorCommand, StyleTarget } from "@/core/ir-command";
import type { Box, Zone } from "./model";

export type Axis = "x" | "y";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type Side = "top" | "right" | "bottom" | "left";
// isSafeCss only checks the string's shape ("NaNpx" passes), so a non-finite measurement must stop the gesture here
const px = (n: number, min = -Infinity): string | undefined => (Number.isFinite(n) ? `${Math.max(min, Math.round(n))}px` : undefined);

// the outer quarters (along the parent's main axis) insert before / after; the middle half of a container drops inside
export function dropZone(box: Box, point: { x: number; y: number }, axis: Axis, container: boolean): Zone {
  const [start, size, at] = axis === "x" ? [box.x, box.w, point.x] : [box.y, box.h, point.y];
  const f = size > 0 ? (at - start) / size : 0.5;
  if (container && f > 0.25 && f < 0.75) return "inside";
  return f < 0.5 ? "before" : "after";
}
export function indicator(box: Box, zone: Zone, axis: Axis): Box {
  if (zone === "inside") return box;
  const edge = zone === "before" ? 0 : 1;
  return axis === "y" ? { x: box.x, y: box.y + edge * box.h - 1, w: box.w, h: 2 } : { x: box.x + edge * box.w - 1, y: box.y, w: 2, h: box.h };
}
export const axisOf = (display: string, direction: string): Axis => (display.includes("flex") && direction.startsWith("row") ? "x" : "y");

export type FreeInput = { id: string; parentId: string; parentStatic: boolean; target: StyleTarget; box: Box; width: number; parentBox: Box; parentBorder: { top: number; left: number }; parentScroll: { top: number; left: number }; margin: { top: number; left: number } };
// R6: from the parent's padding box (its border box minus the border, plus its scroll), the node's margin removed
export function freeCommands(i: FreeInput): EditorCommand[] {
  const left = px(i.box.x - i.parentBox.x - i.parentBorder.left + i.parentScroll.left - i.margin.left);
  const top = px(i.box.y - i.parentBox.y - i.parentBorder.top + i.parentScroll.top - i.margin.top);
  const width = px(i.width);
  if (!left || !top || !width) return [];
  return [
    ...(i.parentStatic ? [{ op: "setStyle" as const, id: i.parentId, target: i.target, changes: { position: "relative" } }] : []),
    { op: "setStyle", id: i.id, target: i.target, changes: { position: "absolute", left, top, width } },
  ];
}

export const handlesFor = (absolute: boolean): Handle[] => (absolute ? ["n", "s", "e", "w", "ne", "nw", "se", "sw"] : ["e", "s", "se"]);
export type ResizeInput = { id: string; target: StyleTarget; handle: Handle; start: { w: number; h: number; top: number; left: number }; dx: number; dy: number; keepRatio: boolean };
// R13: width/height px (≥ 1) at the target; a w/n handle keeps the opposite edge still by moving left/top
export function resizeCommands(i: ResizeInput): EditorCommand[] {
  if (![i.dx, i.dy, i.start.w, i.start.h, i.start.top, i.start.left].every(Number.isFinite)) return []; // clamping would hide ±Infinity
  const east = i.handle.includes("e"), west = i.handle.includes("w"), south = i.handle.includes("s"), north = i.handle.includes("n");
  let w = i.start.w + (east ? i.dx : west ? -i.dx : 0), h = i.start.h + (south ? i.dy : north ? -i.dy : 0);
  const horizontal = east || west, vertical = north || south;
  if (i.keepRatio && i.start.w > 0 && i.start.h > 0) {
    const ratio = i.start.w / i.start.h;
    if (horizontal && (!vertical || Math.abs(w / i.start.w - 1) >= Math.abs(h / i.start.h - 1))) h = w / ratio; else w = h * ratio;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const changes: Record<string, string | undefined> = {};
  if (horizontal || i.keepRatio) changes.width = px(w);
  if (vertical || i.keepRatio) changes.height = px(h);
  if (west) changes.left = px(i.start.left + i.start.w - w);
  if (north) changes.top = px(i.start.top + i.start.h - h);
  return Object.values(changes).every((v) => v !== undefined) ? [{ op: "setStyle", id: i.id, target: i.target, changes: changes as Record<string, string> }] : [];
}
export function spacingCommand(id: string, target: StyleTarget, what: Side | "gap", start: number, delta: number): EditorCommand | undefined {
  const v = px(start + delta, 0);
  return v ? { op: "setStyle", id, target, changes: { [what === "gap" ? "gap" : `padding-${what}`]: v } } : undefined;
}

// R8: Ctrl± and the buttons walk the presets; Ctrl+wheel ×1.1 per notch; "Vừa khung" = (pane − 16) / bp; all clamped 25–200 %
export const ZOOM = { min: 0.25, max: 2, presets: [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2] } as const;
export const clampZoom = (z: number): number => (Number.isNaN(z) ? 1 : Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100)));
export function zoomStep(z: number, dir: 1 | -1): number {
  const p = ZOOM.presets;
  return dir > 0 ? (p.find((x) => x > z + 1e-9) ?? ZOOM.max) : ([...p].reverse().find((x) => x < z - 1e-9) ?? ZOOM.min);
}
export const wheelZoom = (z: number, deltaY: number): number => clampZoom(z * (deltaY < 0 ? 1.1 : 1 / 1.1));
export const fitZoom = (paneWidth: number, bp: number): number => clampZoom((paneWidth - 16) / bp);
