"use client";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { IconButton } from "@/app/_ui/IconButton";
import type { EditorCommand } from "@/core/ir-command";
import { ComponentForm } from "./component-form";
import { ConvertWizard } from "./convert-wizard";
import { componentFor, generatedId, moveCommand, thumbStyle, type PanelDocument } from "./panel-model";

const KIND: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const CONF: Record<string, string> = { config: "cấu hình thư viện", observed: "quan sát", guessed: "suy đoán", manual: "gắn tay" };
const TONE = { supported: "success", partial: "warn", unsupported: "danger" } as const;
const FID = { supported: "hỗ trợ", partial: "một phần", unsupported: "không hỗ trợ" } as const;
const OPENS = new Set(["modal", "dropdown", "menu"]); // no item list: the canvas opens the whole component

// E2 §7: plain React over the document + commands (no GrapesJS import); E3 reuses it as is. Only edit-time state here.
// onShow(root, k) shows item k on the canvas (postMessage, never saved); onShow(root, -1) closes it again.
export function ComponentPanel({ document: doc, selectedId, revision: _revision, onCommands, onShow }: { document: PanelDocument; selectedId: string | null; revision: number; onCommands(commands: EditorCommand[]): void; onShow(rootId: string, index: number): void }) {
  const [wizard, setWizard] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const c = componentFor(doc, selectedId);
  const rootId = c?.rootId;
  const show = useRef(onShow);
  show.current = onShow;
  // the selection left the component: close what the panel opened on the canvas
  useEffect(() => (rootId ? () => show.current(rootId, -1) : undefined), [rootId]);
  useEffect(() => setWizard(false), [selectedId]);
  if (!selectedId) return null;
  if (!c) return (
    <Card title="Component" data-ui="ui_editor_component_panel">
      {/* a main's node shown inside an instance has a view-only id: roles must name document nodes */}
      {generatedId(selectedId) ? <p className="t-body-sm text-2">Phần tử này thuộc component instance: đánh dấu ở main, hoặc tách (detach) instance trước.</p>
        : wizard ? <ConvertWizard rootId={selectedId} outline={doc.outline.filter((o) => !generatedId(o.id))} onCancel={() => setWizard(false)} onSubmit={(cmd) => { setWizard(false); onCommands([cmd]); }} />
        : <Button data-ui="ui_editor_component_convert" onClick={() => setWizard(true)}>Đánh dấu là component…</Button>}
    </Card>
  );
  const add = (from?: string, index = c.items.length) => onCommands([{ op: "addComponentItem", id: c.rootId, index, ...(from && { from }) }]);
  const lock = c.instance;
  return (
    <Card title="Component" data-ui="ui_editor_component_panel">
      <div className="cmp-head" data-ui="ui_editor_component_header">
        <strong>{KIND[c.spec.kind]}</strong> <span className="t-body-sm text-2">nguồn {c.spec.source} · {CONF[c.spec.confidence]}</span>
        {c.fidelity && <Badge tone={TONE[c.fidelity]}>{FID[c.fidelity]}</Badge>}
        {c.spec.confidence === "guessed" && <p className="t-body-sm text-2">Clone lại để đọc cấu hình thật.</p>}
      </div>
      {c.items.length > 0 && (
        <ol className="cmp-items" data-ui="ui_editor_component_items" aria-label="Các mục">
          {c.items.map((item, k) => (
            <li key={item.id} className={`cmp-item${drag === item.id ? " is-drag" : ""}`} data-ui="ui_editor_component_item" draggable={!lock}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag(item.id); }} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (drag && drag !== item.id) onCommands([{ op: "moveComponentItem", id: c.rootId, itemId: drag, index: k }]); setDrag(null); }}>
              <button type="button" className="cmp-item-pick" onClick={() => onShow(c.rootId, k)} title={`Hiện trên canvas: ${item.label}`}>
                <span className="cmp-thumb" style={thumbStyle(item.box, doc.shot)} aria-hidden="true" />
                <span className="ellipsis">{item.label}</span>
              </button>
              <IconButton icon="arrow_upward" label={`Lên: ${item.label}`} onClick={() => { const m = moveCommand(c, item.id, -1); if (m) onCommands([m]); }} disabled={lock || k === 0} />
              <IconButton icon="arrow_downward" label={`Xuống: ${item.label}`} onClick={() => { const m = moveCommand(c, item.id, 1); if (m) onCommands([m]); }} disabled={lock || k === c.items.length - 1} />
              <IconButton icon="content_copy" label={`Nhân bản: ${item.label}`} onClick={() => add(item.id, k + 1)} disabled={lock} />
              <IconButton icon="delete" tone="danger" label={`Xoá: ${item.label}`} onClick={() => onCommands([{ op: "removeComponentItem", id: c.rootId, itemId: item.id }])} disabled={lock || c.items.length === 1} />
            </li>
          ))}
        </ol>
      )}
      {c.items.length > 0 && <Button icon="add" onClick={() => add()} disabled={lock}>Thêm</Button>}
      {OPENS.has(c.spec.kind) && <Button data-ui="ui_editor_component_show_on_canvas" icon="visibility" onClick={() => onShow(c.rootId, 0)}>Mở trên canvas</Button>}
      {lock && <p className="t-body-sm text-2">Instance: sửa danh sách ở main hoặc tách (detach) trước.</p>}
      <ComponentForm component={c} onPatch={(patch) => onCommands([{ op: "updateComponent", id: c.rootId, patch }])} />
      <Button data-ui="ui_editor_component_unwrap" variant="warn" icon="block" onClick={() => onCommands([{ op: "unwrapComponent", id: c.rootId }])}>Bỏ hành vi</Button>
    </Card>
  );
}
