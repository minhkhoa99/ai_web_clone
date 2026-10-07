"use client";
// E3 §3 panel "Thêm": a click inserts after the selection; a press dragged 4 px onto the canvas uses the insertion bar.
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/app/_ui/Icon";
import { TEMPLATES, type Template } from "./templates";

export function InsertPanel({ onInsert, onDragStart }: { onInsert(t: Template): void; onDragStart(t: Template, e: ReactPointerEvent): void }) {
  return (
    <ul className="ve-insert" data-ui="ui_editor_insert_panel" aria-label="Thêm phần tử">
      {TEMPLATES.map((t) => (
        <li key={t.id}>
          <button type="button" className="ve-insert-item" data-ui="ui_editor_insert_item" title={`${t.label} — nhấp để chèn sau phần tử đang chọn, hoặc kéo vào canvas`}
            onClick={() => onInsert(t)} onPointerDown={(e) => { if (e.button === 0) onDragStart(t, e); }}>
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
