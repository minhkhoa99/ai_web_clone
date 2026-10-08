"use client";
// E3 §2 overlay (in the parent window, over the frame): hover box + "tag · tên · W×H", selection boxes with margin
// (outside) / padding (inside) bands, the parent outlined. Coordinates: the frame's viewport px × zoom (the overlay
// sits at the frame's origin inside the stage, so the frame's own scroll is already in getBoundingClientRect).
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { Handle, Side } from "./gestures";
import { bands, type Box } from "./model";

export type Measured = { box: Box; margin: [number, number, number, number]; padding: [number, number, number, number] };
// spacing = false: the box alone (no getComputedStyle), for large selections
export function measure(el: Element, spacing = true): Measured {
  const r = el.getBoundingClientRect(), box = { x: r.left, y: r.top, w: r.width, h: r.height };
  if (!spacing) return { box, margin: [0, 0, 0, 0], padding: [0, 0, 0, 0] };
  const cs = el.ownerDocument.defaultView!.getComputedStyle(el), px = (v: string) => parseFloat(v) || 0;
  return {
    box,
    margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
  };
}
export const at = (b: Box, z: number): CSSProperties => ({ left: b.x * z, top: b.y * z, width: Math.max(0, b.w * z), height: Math.max(0, b.h * z) });
export type Handles = { id: string; list: Handle[]; onHandle(h: Handle, e: ReactPointerEvent): void; onSpacing(side: Side | "gap", e: ReactPointerEvent): void; gap?: Box };
const HANDLE = 8;
// R13 handles (8 px, inside the box: a full-width node's edge is the frame's edge, where the overlay clips) and the
// padding bars (24 × 4 screen px at each inner padding edge, kept inside the box); handles drawn last so they win an overlap
function HandleLayer({ m, zoom, handles }: { m: Measured; zoom: number; handles: Handles }) {
  const { box: b, padding: [pt, pr, pb, pl] } = m;
  const along = (start: number, size: number, lo: boolean, hi: boolean) => (hi ? (start + size) * zoom - HANDLE : lo ? start * zoom : (start + size / 2) * zoom - HANDLE / 2);
  const k = 1 / zoom; // the bars keep their screen size at any zoom (document px × k)
  const bars: Record<Side, Box> = {
    top: { x: b.x + b.w / 2 - 12 * k, y: Math.max(b.y, b.y + pt - 2 * k), w: 24 * k, h: 4 * k },
    bottom: { x: b.x + b.w / 2 - 12 * k, y: Math.min(b.y + b.h - 4 * k, b.y + b.h - pb - 2 * k), w: 24 * k, h: 4 * k },
    left: { x: Math.max(b.x, b.x + pl - 2 * k), y: b.y + b.h / 2 - 12 * k, w: 4 * k, h: 24 * k },
    right: { x: Math.min(b.x + b.w - 4 * k, b.x + b.w - pr - 2 * k), y: b.y + b.h / 2 - 12 * k, w: 4 * k, h: 24 * k },
  };
  return (
    <>
      {(Object.keys(bars) as Side[]).map((s) => <div key={s} className="ve-spacing-handle" data-ui="ui_editor_spacing_handle" data-side={s} style={at(bars[s], zoom)} onPointerDown={(e) => handles.onSpacing(s, e)} />)}
      {handles.gap && <div className="ve-spacing-handle is-gap" data-ui="ui_editor_spacing_handle" data-side="gap" style={at(handles.gap, zoom)} onPointerDown={(e) => handles.onSpacing("gap", e)} />}
      {handles.list.map((h) => (
        <div key={h} className={`ve-handle is-${h}`} data-ui="ui_editor_resize_handle" data-handle={h} onPointerDown={(e) => handles.onHandle(h, e)}
          style={{ left: along(b.x, b.w, h.includes("w"), h.includes("e")), top: along(b.y, b.h, h.includes("n"), h.includes("s")) }} />
      ))}
    </>
  );
}

// frame: the instance whose main is being edited (R17)
export function Overlay({ zoom, hover, selected, parent, handles, frame, children }: { zoom: number; hover?: { id: string; m: Measured; label: string }; selected: { id: string; m: Measured }[]; parent?: Measured; handles?: Handles; frame?: Measured; children?: ReactNode }) {
  return (
    <div className="ve-overlay" aria-hidden="true">
      {frame && <div className="ve-main-frame" data-ui="ui_editor_edit_main_frame" style={at(frame.box, zoom)} />}
      {parent && <div className="ve-parent" data-ui="ui_editor_parent_box" style={at(parent.box, zoom)} />}
      {selected.map(({ id, m }) => (
        <div key={id}>
          {bands(m.box, m.margin, false).map((b, i) => <div key={`m${i}`} className="ve-margin" data-ui="ui_editor_spacing" style={at(b, zoom)} />)}
          {bands(m.box, m.padding, true).map((b, i) => <div key={`p${i}`} className="ve-padding" data-ui="ui_editor_spacing" style={at(b, zoom)} />)}
          <div className="ve-selected" data-ui="ui_editor_selection_box" data-for={id} style={at(m.box, zoom)} />
        </div>
      ))}
      {handles && selected.length === 1 && selected[0]!.id === handles.id && <HandleLayer m={selected[0]!.m} zoom={zoom} handles={handles} />}
      {hover && (
        <div className="ve-hover" data-ui="ui_editor_hover_box" data-for={hover.id} style={at(hover.m.box, zoom)}>
          <span className={hover.m.box.y * zoom < 16 ? "ve-label ve-label-in" : "ve-label"}>{hover.label}</span>
        </div>
      )}
      {children}
    </div>
  );
}
