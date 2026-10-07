"use client";
// E3 §2 layer tree: shell -> sections -> nodes of one page, only the visible rows rendered (≤ ~200, spec §6), search
// by name or text, rename (setName), the eye (R9), drag a row (moveNode, dropCommand). Two-way with the canvas:
// the selection opens its ancestors and scrolls into view. Keyboard: the tree takes focus, ↑/↓ move the selection,
// →/← open / close (← on a closed row goes to its parent), F2 renames.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { PanelComponent } from "@/core/interactive";
import type { IRNodeV2 } from "@/core/ir-v2";
import { Badge } from "@/app/_ui/Badge";
import { Icon } from "@/app/_ui/Icon";
import type { IconName } from "@/app/_ui/icons.gen";
import { IconButton } from "@/app/_ui/IconButton";
import { SearchInput } from "@/app/_ui/SearchInput";
import { ancestorsOf, dropCommand, hideBatch, layerRows, renameBatch, ROW_HEIGHT, rowWindow, type Batch, type DocIndex, type Zone } from "./model";

const ICON: Record<IRNodeV2["type"], IconName> = { container: "crop_square", text: "title", image: "image", link: "link", button: "touch_app", input: "input", media: "movie", svg: "shapes", "component-root": "widgets" };
const KIND: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
type Props = { index: DocIndex; rootId: string; components: readonly PanelComponent[]; selection: string[]; onSelect(ids: string[]): void; onBatch(b: Batch, label: string): void };
const domId = (id: string) => `ve-layer-${id}`;

export function LayerTree({ index, rootId, components, selection, onSelect, onBatch }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([rootId]));
  const [query, setQuery] = useState("");
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const first = selection[0];
  useEffect(() => {
    if (!first) return;
    setOpen((o) => { const next = new Set(o); for (const a of ancestorsOf(index, first).slice(1)) next.add(a); return next; });
  }, [first, index]);
  const rows = useMemo(() => layerRows(index, rootId, open, query, components), [index, rootId, open, query, components]);
  useEffect(() => {
    const el = list.current, at = rows.findIndex((r) => r.id === first);
    if (!el || at < 0) return;
    const top = at * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
  }, [rows, first]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { start, end } = rowWindow(rows.length, scroll, height);
  const shown = rows.slice(start, end);
  const zoneOf = (e: DragEvent<HTMLElement>): Zone => { const r = e.currentTarget.getBoundingClientRect(), f = (e.clientY - r.top) / r.height; return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside"; };
  const toggle = (rid: string) => setOpen((o) => { const n = new Set(o); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  const endRename = () => { setRenaming(null); list.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // a row's button or the rename box
    const at = rows.findIndex((r) => r.id === first), row = rows[at];
    const go = (i: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, i))]; if (r) onSelect([r.id]); };
    switch (e.key) {
      case "ArrowDown": go(at + 1); break;
      case "ArrowUp": go(at < 0 ? 0 : at - 1); break;
      case "ArrowRight": if (row?.hasChildren && !row.open) toggle(row.id); else go(at + 1); break;
      case "ArrowLeft": {
        if (row?.hasChildren && row.open && !query) { toggle(row.id); break; }
        const p = row ? index.get(row.id)?.parent : undefined;
        if (p && rows.some((r) => r.id === p)) onSelect([p]);
        break;
      }
      case "F2": if (row) setRenaming(row.id); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation(); // the editor's own shortcuts (Esc = parent…) stay off the tree's keys
  };
  return (
    <div className="ve-layers">
      <SearchInput label="Tìm lớp" placeholder="Tên hoặc chữ…" value={query} onChange={setQuery} data-ui="ui_editor_layer_search" />
      <div ref={list} className="ve-layer-list" role="tree" aria-label="Layers" aria-multiselectable="true" tabIndex={0} onKeyDown={onKey}
        aria-activedescendant={first && shown.some((r) => r.id === first) ? domId(first) : undefined}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {shown.map((r, k) => {
            const on = selection.includes(r.id);
            return (
              <div key={r.id} id={domId(r.id)} role="treeitem" aria-selected={on} aria-level={r.depth + 1} {...(r.hasChildren && { "aria-expanded": r.open })}
                className={`ve-layer${on ? " is-selected" : ""}${r.dimmed ? " is-dimmed" : ""}`} data-ui="ui_editor_layer_row" data-id={r.id}
                style={{ top: (start + k) * ROW_HEIGHT, paddingInlineStart: 4 + r.depth * 12 }}
                draggable={renaming !== r.id}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); setDrag(r.id); }}
                onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (drag && drag !== r.id) onBatch(dropCommand(index, components, drag, r.id, zoneOf(e)), "Di chuyển"); setDrag(null); }}
                onClick={(e) => onSelect(e.shiftKey ? (on ? selection.filter((x) => x !== r.id) : [...selection, r.id]) : [r.id])}>
                <IconButton icon={r.open ? "expand_more" : "chevron_right"} label={`${r.open ? "Thu gọn" : "Mở"}: ${r.label}`} disabled={!r.hasChildren} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggle(r.id); }} />
                <Icon name={r.section ? "layers" : ICON[r.type]} size={14} />
                {renaming === r.id ? (
                  <input autoFocus defaultValue={r.label} aria-label="Tên lớp" maxLength={80} onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { onBatch(renameBatch(index, r.id, e.currentTarget.value), "Đổi tên"); endRename(); } if (e.key === "Escape") endRename(); }}
                    onBlur={() => setRenaming(null)} />
                ) : (
                  <span className="ve-layer-name ellipsis" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(r.id); }}>{r.label}</span>
                )}
                {r.kind && <Badge tone="accent">{KIND[r.kind] ?? r.kind}</Badge>}
                {r.role && <Badge tone={r.role === "main" ? "primary" : "neutral"}>{r.role}</Badge>}
                <IconButton icon={r.hidden ? "visibility_off" : "visibility"} label={`${r.hidden ? "Hiện" : "Ẩn"}: ${r.label}`}
                  onClick={(e) => { e.stopPropagation(); onBatch(hideBatch(index, [r.id], !r.hidden), r.hidden ? "Hiện" : "Ẩn"); }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
