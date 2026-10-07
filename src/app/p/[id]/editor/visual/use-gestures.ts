"use client";
// E3 §3 / R12 canvas gestures: a press on a selected node becomes a drag after 4 px; the parent window's fixed capture
// overlay and the frame (Chrome keeps routing a mouse pressed inside it there) both feed the move / release. Cancelled
// (nothing sent, the release click swallowed) by Escape, a blur, a lost pointerup, a reload or a result swapping the canvas.
import { useRef, useState, type RefObject } from "react";
import type { PanelComponent } from "@/core/interactive";
import type { CanvasHandle } from "./canvas";
import { axisOf, dropZone, indicator } from "./gestures";
import { ancestorsOf, dropCommand, guardParent, isTextHost, pickTarget, type Batch, type Box, type DocIndex } from "./model";
import { measure } from "./overlay";

export type Drop = { key: string; box: Box; ok: boolean; reason?: string; batch?: Batch };
export type Gesture = { kind: "flow"; id: string; drop?: Drop }; // Tasks 8–11: free / resize / spacing / insert / pan
export type GestureLive = { data: { interactives: PanelComponent[] } | null; index: DocIndex; selection: string[] };
type Point = { x: number; y: number };

export function useGestures(o: {
  canvas: RefObject<CanvasHandle | null>;
  live: RefObject<GestureLive>;
  editing: RefObject<HTMLElement | null>;
  batch(b: Batch, label: string): boolean;
}) {
  const { canvas, live } = o;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const drag = useRef<{ gesture: Gesture | null; stop?: () => void; dropped: boolean }>({ gesture: null, dropped: false });
  const setG = (g: Gesture | null) => { drag.current.gesture = g; setGesture(g); };
  const endGesture = () => { drag.current.stop?.(); drag.current.stop = undefined; setG(null); };
  // interrupted with the button still held (Escape, a blur, a reload, a result swapping the canvas): nothing is sent and
  // the click the frame fires on release is swallowed (reset by the next press). true = a gesture was cancelled
  const cancelGesture = (): boolean => { if (!drag.current.gesture) return false; drag.current.dropped = true; endGesture(); return true; };
  // the click the frame fires right after a drop: true = swallow it
  const consumeDrop = (): boolean => { if (!drag.current.dropped) return false; drag.current.dropped = false; return true; };
  // the drop under a frame document point: the indicator (blue) with its batch, or red with dropCommand's reason
  const flowOver = (g: Gesture, p: Point): Drop | undefined => {
    const c = canvas.current, ix = live.current.index, comps = live.current.data?.interactives ?? [];
    if (!c || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
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
  // buttons 0 = the pointerup was lost: end without sending. Re-render only when the drop changes
  const gestureMove = (p: Point, buttons: number) => {
    const g = drag.current.gesture;
    if (!g) return;
    if (buttons === 0) return endGesture();
    const drop = flowOver(g, p);
    if (drop?.key !== g.drop?.key) setG({ ...g, drop });
  };
  // one batch = one revision, one Undo; a refused drop (red) sends nothing
  const gestureUp = () => { const b = drag.current.gesture?.drop?.batch; endGesture(); if (b) o.batch(b, "Di chuyển"); };
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
      setG({ kind: "flow", id: target }); // Task 8: alt -> "free"
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
