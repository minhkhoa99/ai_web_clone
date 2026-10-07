"use client";
// E3 §3 / R12 canvas gestures: a press on a selected node becomes a drag after 4 px — along the flow, or free with Alt
// (R6) — and the parent window's fixed capture overlay and the frame (Chrome keeps routing a mouse pressed inside it
// there) both feed the move / release. A resize / padding / gap handle (R13, in this window's overlay) starts one at
// once. Cancelled (nothing sent, the preview put back, the release click swallowed) by Escape, a blur, a lost
// pointerup, a reload or a result swapping the canvas, and (but for a flow drag) a scroll of the frame: the measured
// boxes would no longer match.
import { useRef, useState, type RefObject } from "react";
import type { PanelComponent } from "@/core/interactive";
import type { EditorCommand } from "@/core/ir-command";
import type { CanvasHandle } from "./canvas";
import { axisOf, dropZone, freeCommands, indicator, resizeCommands, spacingCommand, type Axis, type Handle, type ResizeInput, type Side } from "./gestures";
import { ancestorsOf, dropCommand, guard, guardParent, isTextHost, pickTarget, styleTarget, type Batch, type Box, type Bp, type DocIndex } from "./model";
import { measure } from "./overlay";
import { snap, SNAP_PX, type Guide } from "./snap";

export type Drop = { key: string; box: Box; ok: boolean; reason?: string; batch?: Batch };
type Flow = { kind: "flow"; id: string; drop?: Drop };
// the node follows the pointer by an inline `translate` (layout untouched) until the server's section arrives
type Free = { kind: "free"; id: string; parentId: string; el: HTMLElement; parent: HTMLElement; start: Point; box: Box; width: number; others: Box[]; guides: Guide[]; dx: number; dy: number; prevTranslate: string };
// R13: a handle previews inline (the node's own inline values kept in `prev`, put back on end) at the current breakpoint
type Resize = { kind: "resize"; id: string; el: HTMLElement; prev: Record<string, string>; handle: Handle; start: Point; size: ResizeInput["start"]; dx: number; dy: number; shift: boolean };
type Spacing = { kind: "spacing"; id: string; el: HTMLElement; prev: Record<string, string>; what: Side | "gap"; axis: Axis; start: Point; from: number; delta: number };
export type Gesture = Flow | Free | Resize | Spacing; // Tasks 10–11: insert / pan
export type GestureLive = { data: { interactives: PanelComponent[] } | null; index: DocIndex; selection: string[]; bp: Bp; zoom: number };
type Point = { x: number; y: number };
type Extra = { apply?(): void; rollback?(): void };
type HandlePress = { button: number; clientX: number; clientY: number; shiftKey: boolean; stopPropagation(): void; preventDefault(): void };
const SNAP_SIBLINGS = 200; // ponytail: the first 200 siblings are snap targets, a spatial index if a parent ever holds more
const SIZE_PROPS = ["width", "height", "top", "left"];
const spacingProp = (what: Side | "gap") => (what === "gap" ? "gap" : `padding-${what}`);
const unpaint = (g: Resize | Spacing) => { for (const [p, v] of Object.entries(g.prev)) g.el.style.setProperty(p, v); };
const paint = (g: Resize | Spacing, commands: EditorCommand[]) => {
  unpaint(g); // a property the last move set but this one does not (Shift released) goes back too
  for (const c of commands) if (c.op === "setStyle") for (const [p, v] of Object.entries(c.changes)) if (v) g.el.style.setProperty(p, v);
};

export function useGestures(o: {
  canvas: RefObject<CanvasHandle | null>;
  live: RefObject<GestureLive>;
  editing: RefObject<HTMLElement | null>;
  batch(b: Batch, label: string, extra?: Extra): boolean;
  setMsg(text: string): void;
}) {
  const { canvas, live } = o;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const drag = useRef<{ gesture: Gesture | null; stop?: () => void; dropped: boolean }>({ gesture: null, dropped: false });
  const setG = (g: Gesture | null) => { drag.current.gesture = g; setGesture(g); };
  const endGesture = () => {
    const g = drag.current.gesture;
    if (g?.kind === "free") g.el.style.translate = g.prevTranslate; // a drop re-applies it through the op's apply()
    if (g?.kind === "resize" || g?.kind === "spacing") unpaint(g); // likewise
    drag.current.stop?.(); drag.current.stop = undefined; setG(null);
  };
  // interrupted with the button still held (Escape, a blur, a reload, a result swapping the canvas): nothing is sent and
  // the click the frame fires on release is swallowed (reset by the next press). true = a gesture was cancelled
  const cancelGesture = (): boolean => { if (!drag.current.gesture) return false; drag.current.dropped = true; endGesture(); return true; };
  // the click the frame fires right after a drop: true = swallow it
  const consumeDrop = (): boolean => { if (!drag.current.dropped) return false; drag.current.dropped = false; return true; };
  // the drop under a frame document point: the indicator (blue) with its batch, or red with dropCommand's reason
  const flowOver = (g: Flow, p: Point): Drop | undefined => {
    const c = canvas.current, ix = live.current.index, comps = live.current.data?.interactives ?? [];
    if (!c) return undefined;
    const raw = c.hit(p.x, p.y), over = raw ? pickTarget(ix, raw) : undefined, el = over ? c.element(over) : null;
    if (!over || !el) return undefined;
    const { box } = measure(el, false), parentId = ix.get(over)!.parent, parentEl = parentId ? c.element(parentId) : null;
    const cs = parentEl?.ownerDocument.defaultView?.getComputedStyle(parentEl);
    const axis = cs ? axisOf(cs.display, cs.flexDirection) : "y";
    // Task 6 carry: the caller decides what is a container — not the dragged node, a void, a text host or a refused parent
    const container = over !== g.id && !isTextHost(ix.get(over)!.node) && guardParent(ix, comps, over) === undefined;
    const zone = dropZone(box, p, axis, container), b = dropCommand(ix, comps, g.id, over, zone), ib = indicator(box, zone, axis);
    return { key: `${over}|${zone}|${ib.x},${ib.y},${ib.w},${ib.h}`, box: ib, ok: !("error" in b), ...("error" in b ? { reason: b.error } : { batch: b }) };
  };
  // R6 / R11: Alt+drag measures once at the start — the node, its parent, the snap targets (siblings, parent, the frame's
  // viewport) and the computed width it keeps. undefined = refused (the message says why) or not measurable
  const startFree = (nid: string, start: Point): Free | undefined => {
    const c = canvas.current, ix = live.current.index, e = ix.get(nid);
    const why = guard(ix, live.current.data?.interactives ?? [], nid, "move");
    if (why) { o.setMsg(why); return undefined; }
    const el = c?.element(nid), parent = e?.parent ? c?.element(e.parent) : null;
    if (!c || !e?.parent || !el || !parent) return undefined;
    const box = measure(el, false).box, root = el.ownerDocument.documentElement;
    const siblings = ix.get(e.parent)!.children.filter((s) => s !== nid).slice(0, SNAP_SIBLINGS)
      .flatMap((s) => { const se = c.element(s); return se ? [measure(se, false).box] : []; });
    const viewport = { x: 0, y: 0, w: root.clientWidth, h: root.clientHeight };
    // the computed width (border-box or content-box, whatever box-sizing says `width` is); an inline box: its rect
    const width = parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).width);
    return { kind: "free", id: nid, parentId: e.parent, el, parent, start, box, width: Number.isFinite(width) ? width : box.w, others: [...siblings, measure(parent, false).box, viewport], guides: [], dx: 0, dy: 0, prevTranslate: el.style.translate };
  };
  const freeMove = (g: Free, p: Point): Free => {
    const raw = { ...g.box, x: g.box.x + p.x - g.start.x, y: g.box.y + p.y - g.start.y };
    const s = snap(raw, g.others, SNAP_PX / live.current.zoom); // 4 screen px (R11)
    const dx = raw.x + s.dx - g.box.x, dy = raw.y + s.dy - g.box.y;
    g.el.style.translate = `${dx}px ${dy}px`;
    return { ...g, dx, dy, guides: s.guides };
  };
  // one batch (parent relative if static + the node absolute at top/left/width) at the current breakpoint = one Undo;
  // [] for no movement or a non-finite measurement: nothing sent
  const freeBatch = (g: Free) => {
    if (g.dx === 0 && g.dy === 0) return [];
    const win = g.parent.ownerDocument.defaultView!, pcs = win.getComputedStyle(g.parent), cs = win.getComputedStyle(g.el), px = (v: string) => parseFloat(v) || 0;
    return freeCommands({
      id: g.id, parentId: g.parentId, parentStatic: pcs.position === "static", target: styleTarget(live.current.bp),
      box: { ...g.box, x: g.box.x + g.dx, y: g.box.y + g.dy }, width: g.width, parentBox: measure(g.parent, false).box,
      parentBorder: { top: px(pcs.borderTopWidth), left: px(pcs.borderLeftWidth) }, parentScroll: { top: g.parent.scrollTop, left: g.parent.scrollLeft },
      margin: { top: px(cs.marginTop), left: px(cs.marginLeft) },
    });
  };
  // the gap band between the first two element children of a flex / grid node: side by side -> the column gap (x),
  // else the row gap (y). undefined: not flex / grid, or fewer than two rendered children
  const gapOf = (nid: string): { box: Box; axis: Axis } | undefined => {
    const c = canvas.current, el = c?.element(nid);
    if (!c || !el || !/flex|grid/.test(el.ownerDocument.defaultView!.getComputedStyle(el).display)) return undefined;
    const kids: Box[] = [];
    for (const k of live.current.index.get(nid)?.children ?? []) {
      const ke = c.element(k);
      if (ke) kids.push(measure(ke, false).box);
      if (kids.length === 2) break;
    }
    const [a, b] = kids;
    if (!a || !b) return undefined;
    return b.x >= a.x + a.w - 0.5
      ? { axis: "x", box: { x: a.x + a.w, y: a.y, w: Math.max(4, b.x - a.x - a.w), h: a.h } }
      : { axis: "y", box: { x: a.x, y: a.y + a.h, w: a.w, h: Math.max(4, b.y - a.y - a.h) } };
  };
  // a handle press (this window): the one selected node, not refused; the start point in frame document px
  const handleStart = (e: HandlePress) => {
    if (e.button !== 0) return undefined;
    e.stopPropagation();
    e.preventDefault(); // no text selection / focus change in this window
    const c = canvas.current, d = c?.doc(), nid = live.current.selection[0], el = nid ? c?.element(nid) : null;
    if (!c || !d || !nid || !el || live.current.selection.length !== 1 || drag.current.gesture) return undefined;
    const why = guard(live.current.index, live.current.data?.interactives ?? [], nid, "edit");
    if (why) { o.setMsg(why); return undefined; }
    return { d, nid, el, cs: el.ownerDocument.defaultView!.getComputedStyle(el), start: c.toDoc(e.clientX, e.clientY) };
  };
  // Task 6 carry: the computed width / height (what `width` holds per box-sizing; an inline box: its rect)
  const startResize = (handle: Handle, e: HandlePress) => {
    const s = handleStart(e);
    if (!s) return;
    const rect = s.el.getBoundingClientRect(), num = (v: string, or: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : or);
    const size = { w: num(s.cs.width, rect.width), h: num(s.cs.height, rect.height), top: num(s.cs.top, 0), left: num(s.cs.left, 0) };
    setG({ kind: "resize", id: s.nid, el: s.el, prev: Object.fromEntries(SIZE_PROPS.map((p) => [p, s.el.style.getPropertyValue(p)])), handle, start: s.start, size, dx: 0, dy: 0, shift: e.shiftKey });
    hold(s.d);
  };
  const startSpacing = (what: Side | "gap", e: HandlePress) => {
    const s = handleStart(e);
    if (!s) return;
    const axis = what === "gap" ? gapOf(s.nid)?.axis ?? "x" : "y";
    const from = parseFloat(s.cs.getPropertyValue(what === "gap" ? (axis === "x" ? "column-gap" : "row-gap") : `padding-${what}`)) || 0; // "normal" gap = 0
    const prop = spacingProp(what);
    setG({ kind: "spacing", id: s.nid, el: s.el, prev: { [prop]: s.el.style.getPropertyValue(prop) }, what, axis, start: s.start, from, delta: 0 });
    hold(s.d);
  };
  // nothing for a press without movement (a click on a handle)
  const resizeOf = (g: Resize) => (Math.round(g.dx) === 0 && Math.round(g.dy) === 0 ? [] : resizeCommands({ id: g.id, target: styleTarget(live.current.bp), handle: g.handle, start: g.size, dx: g.dx, dy: g.dy, keepRatio: g.shift }));
  // nothing for no movement, a non-finite measurement or the value it already has (a padding dragged below 0)
  const spacingOf = (g: Spacing): EditorCommand[] => {
    if (Math.round(g.delta) === 0) return [];
    const cmd = spacingCommand(g.id, styleTarget(live.current.bp), g.what, g.from, g.delta);
    return cmd?.op === "setStyle" && cmd.changes[spacingProp(g.what)] !== `${Math.max(0, Math.round(g.from))}px` ? [cmd] : [];
  };
  // buttons 0 = the pointerup was lost: end without sending. Re-render only when the drop / the guides change (a handle's
  // preview re-measures the selection through the editor's style observer)
  const gestureMove = (p: Point, buttons: number, shift = false) => {
    const g = drag.current.gesture;
    if (!g) return;
    if (buttons === 0) return endGesture();
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (g.kind === "resize") {
      const n = { ...g, dx: p.x - g.start.x, dy: p.y - g.start.y, shift };
      drag.current.gesture = n;
      const cmds = resizeOf(n);
      if (cmds.length) paint(n, cmds);
      return;
    }
    if (g.kind === "spacing") {
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      const delta = g.what === "top" ? dy : g.what === "bottom" ? -dy : g.what === "left" ? dx : g.what === "right" ? -dx : g.axis === "x" ? dx : dy;
      const n = { ...g, delta };
      drag.current.gesture = n;
      paint(n, spacingOf(n));
      return;
    }
    if (g.kind === "free") {
      const n = freeMove(g, p);
      if (JSON.stringify(n.guides) !== JSON.stringify(g.guides)) setG(n); else drag.current.gesture = n;
      return;
    }
    const drop = flowOver(g, p);
    if (drop?.key !== g.drop?.key) setG({ ...g, drop });
  };
  // one batch = one revision, one Undo; a refused drop (red) sends nothing
  const gestureUp = () => {
    const g = drag.current.gesture, free = g?.kind === "free" ? freeBatch(g) : [];
    const sized = g?.kind === "resize" ? resizeOf(g) : g?.kind === "spacing" ? spacingOf(g) : [];
    endGesture();
    if ((g?.kind === "resize" || g?.kind === "spacing") && sized.length) {
      o.batch({ commands: sized }, g.kind === "resize" ? "Đổi kích thước" : "Khoảng cách", { apply: () => paint(g, sized), rollback: () => unpaint(g) });
    }
    if (g?.kind === "flow" && g.drop?.batch) o.batch(g.drop.batch, "Di chuyển");
    if (g?.kind === "free" && free.length) {
      const { el, dx, dy, prevTranslate } = g;
      o.batch({ commands: free }, "Đặt tự do", { apply: () => { el.style.translate = `${dx}px ${dy}px`; }, rollback: () => { el.style.translate = prevTranslate; } });
    }
  };
  // while a gesture is held: the frame's moves / release are forwarded (frame client px = document px); a blur of the
  // frame or this window (Alt+Tab) cancels, and so does a frame scroll for every gesture but a flow drag (it re-measures).
  // Scroll anchoring is off meanwhile, else a padding preview would scroll the frame itself. Returns the move forwarder.
  function hold(d: Document) {
    const fwdMove = (m: PointerEvent) => { d.getSelection()?.removeAllRanges(); gestureMove({ x: m.clientX, y: m.clientY }, m.buttons, m.shiftKey); };
    const fwdUp = () => { drag.current.dropped = true; gestureUp(); };
    const scrolled = () => { if (drag.current.gesture?.kind !== "flow") cancelGesture(); };
    const fw = d.defaultView, root = d.documentElement, anchor = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    d.addEventListener("pointermove", fwdMove);
    d.addEventListener("pointerup", fwdUp);
    d.addEventListener("pointercancel", endGesture);
    fw?.addEventListener("scroll", scrolled);
    fw?.addEventListener("blur", cancelGesture);
    window.addEventListener("blur", cancelGesture);
    drag.current.stop = () => {
      d.removeEventListener("pointermove", fwdMove); d.removeEventListener("pointerup", fwdUp); d.removeEventListener("pointercancel", endGesture);
      fw?.removeEventListener("scroll", scrolled); fw?.removeEventListener("blur", cancelGesture); window.removeEventListener("blur", cancelGesture);
      root.style.overflowAnchor = anchor;
    };
    return fwdMove;
  }
  // R12: a press on a selected node (or inside one: the selected ancestor is dragged) becomes a drag after 4 px and a
  // fixed overlay in this window takes the pointer. Chrome keeps routing a mouse pressed inside the frame to the frame
  // until release, so its moves / release are forwarded too (frame client px = document px). Without moving, the
  // click still selects; after a drop, the click the frame fires on release is swallowed.
  const onPress = (raw: string, e: PointerEvent) => {
    drag.current.dropped = false;
    const target = ancestorsOf(live.current.index, raw).find((a) => live.current.selection.includes(a));
    const d = canvas.current?.doc();
    if (!target || !d || drag.current.gesture || o.editing.current?.isConnected) return; // mouse text selection while editing
    const unpress = () => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", unpress); d.removeEventListener("pointercancel", unpress); };
    const move = (m: PointerEvent) => {
      if (m.buttons === 0) return unpress();
      if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
      unpress();
      const g: Gesture | undefined = e.altKey ? startFree(target, { x: e.clientX, y: e.clientY }) : { kind: "flow", id: target };
      if (!g) return;
      setG(g);
      hold(d)(m);
    };
    d.addEventListener("pointermove", move);
    d.addEventListener("pointerup", unpress);
    d.addEventListener("pointercancel", unpress);
  };
  // the capture overlay's handlers (parent client px -> frame document px)
  const capture = {
    onPointerMove: (e: { clientX: number; clientY: number; buttons: number; shiftKey: boolean }) => { const p = canvas.current?.toDoc(e.clientX, e.clientY); if (p) gestureMove(p, e.buttons, e.shiftKey); },
    onPointerUp: gestureUp,
    onPointerCancel: endGesture,
  };
  return { gesture, onPress, cancelGesture, consumeDrop, capture, startResize, startSpacing, gapOf };
}
