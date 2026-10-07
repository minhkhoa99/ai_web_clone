"use client";
// E3 §3 / R12 canvas gestures: a press on a selected node becomes a drag after 4 px — along the flow, or free with Alt
// (R6) — and the parent window's fixed capture overlay and the frame (Chrome keeps routing a mouse pressed inside it
// there) both feed the move / release. Cancelled (nothing sent, the release click swallowed) by Escape, a blur, a lost
// pointerup, a reload or a result swapping the canvas.
import { useRef, useState, type RefObject } from "react";
import type { PanelComponent } from "@/core/interactive";
import type { CanvasHandle } from "./canvas";
import { axisOf, dropZone, freeCommands, indicator } from "./gestures";
import { ancestorsOf, dropCommand, guard, guardParent, isTextHost, pickTarget, styleTarget, type Batch, type Box, type Bp, type DocIndex } from "./model";
import { measure } from "./overlay";
import { snap, SNAP_PX, type Guide } from "./snap";

export type Drop = { key: string; box: Box; ok: boolean; reason?: string; batch?: Batch };
type Flow = { kind: "flow"; id: string; drop?: Drop };
// the node follows the pointer by an inline `translate` (layout untouched) until the server's section arrives
type Free = { kind: "free"; id: string; parentId: string; el: HTMLElement; parent: HTMLElement; start: Point; box: Box; width: number; others: Box[]; guides: Guide[]; dx: number; dy: number; prevTranslate: string };
export type Gesture = Flow | Free; // Tasks 9–11: resize / spacing / insert / pan
export type GestureLive = { data: { interactives: PanelComponent[] } | null; index: DocIndex; selection: string[]; bp: Bp; zoom: number };
type Point = { x: number; y: number };
type Extra = { apply?(): void; rollback?(): void };
const SNAP_SIBLINGS = 200; // ponytail: the first 200 siblings are snap targets, a spatial index if a parent ever holds more

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
  // buttons 0 = the pointerup was lost: end without sending. Re-render only when the drop / the guides change
  const gestureMove = (p: Point, buttons: number) => {
    const g = drag.current.gesture;
    if (!g) return;
    if (buttons === 0) return endGesture();
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
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
    endGesture();
    if (g?.kind === "flow" && g.drop?.batch) o.batch(g.drop.batch, "Di chuyển");
    if (g?.kind === "free" && free.length) {
      const { el, dx, dy, prevTranslate } = g;
      o.batch({ commands: free }, "Đặt tự do", { apply: () => { el.style.translate = `${dx}px ${dy}px`; }, rollback: () => { el.style.translate = prevTranslate; } });
    }
  };
  // R12: a press on a selected node (or inside one: the selected ancestor is dragged) becomes a drag after 4 px and a
  // fixed overlay in this window takes the pointer. Chrome keeps routing a mouse pressed inside the frame to the frame
  // until release, so its moves / release are forwarded too (frame client px = document px). Without moving, the
  // click still selects; after a drop, the click the frame fires on release is swallowed.
  const onPress = (raw: string, e: PointerEvent) => {
    drag.current.dropped = false;
    const target = ancestorsOf(live.current.index, raw).find((a) => live.current.selection.includes(a));
    const d = canvas.current?.doc();
    if (!target || !d || drag.current.gesture || o.editing.current?.isConnected) return; // mouse text selection while editing
    const fwdMove = (m: PointerEvent) => { d.getSelection()?.removeAllRanges(); gestureMove({ x: m.clientX, y: m.clientY }, m.buttons); };
    const fwdUp = () => { drag.current.dropped = true; gestureUp(); };
    const unpress = () => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", unpress); d.removeEventListener("pointercancel", unpress); };
    const move = (m: PointerEvent) => {
      if (m.buttons === 0) return unpress();
      if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
      unpress();
      const g: Gesture | undefined = e.altKey ? startFree(target, { x: e.clientX, y: e.clientY }) : { kind: "flow", id: target };
      if (!g) return;
      setG(g);
      d.addEventListener("pointermove", fwdMove);
      d.addEventListener("pointerup", fwdUp);
      d.addEventListener("pointercancel", endGesture);
      const fw = d.defaultView; // focus left the frame or this window (Alt+Tab): cancel
      fw?.addEventListener("blur", cancelGesture);
      window.addEventListener("blur", cancelGesture);
      drag.current.stop = () => {
        d.removeEventListener("pointermove", fwdMove); d.removeEventListener("pointerup", fwdUp); d.removeEventListener("pointercancel", endGesture);
        fw?.removeEventListener("blur", cancelGesture); window.removeEventListener("blur", cancelGesture);
      };
      fwdMove(m);
    };
    d.addEventListener("pointermove", move);
    d.addEventListener("pointerup", unpress);
    d.addEventListener("pointercancel", unpress);
  };
  // the capture overlay's handlers (parent client px -> frame document px)
  const capture = {
    onPointerMove: (e: { clientX: number; clientY: number; buttons: number }) => { const p = canvas.current?.toDoc(e.clientX, e.clientY); if (p) gestureMove(p, e.buttons); },
    onPointerUp: gestureUp,
    onPointerCancel: endGesture,
  };
  return { gesture, onPress, cancelGesture, consumeDrop, capture };
}
