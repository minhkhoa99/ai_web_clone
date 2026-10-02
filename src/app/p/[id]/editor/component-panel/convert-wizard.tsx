"use client";
import { useState } from "react";
import { Button } from "@/app/_ui/Button";
import { Field } from "@/app/_ui/Field";
import type { EditorCommand } from "@/core/ir-command";
import type { InteractiveKind } from "@/core/interactive";
import type { PanelDocument } from "./panel-model";

type Outline = PanelDocument["outline"];
const KINDS: [InteractiveKind, string][] = [["carousel", "Carousel"], ["tabs", "Tabs"], ["accordion", "Accordion"], ["modal", "Modal"], ["dropdown", "Dropdown"], ["menu", "Menu"], ["video", "Video"]];
// The roles each kind asks for: one node, or several (list) in outline order; pairs zip two lists (k-th tab ↔ k-th panel).
type RoleField = { key: string; label: string; list?: true; optional?: true };
const FIELDS: Record<InteractiveKind, RoleField[]> = {
  carousel: [{ key: "viewport", label: "Khung nhìn (viewport)" }, { key: "track", label: "Dải slide (track)" }, { key: "slides", label: "Các slide (con của track)", list: true }],
  tabs: [{ key: "triggers", label: "Các tab", list: true }, { key: "panels", label: "Các panel", list: true }],
  accordion: [{ key: "triggers", label: "Các tiêu đề", list: true }, { key: "panels", label: "Các nội dung", list: true }],
  modal: [{ key: "triggers", label: "Nút mở", list: true }, { key: "dialog", label: "Hộp thoại" }, { key: "closeButton", label: "Nút đóng", optional: true }],
  dropdown: [{ key: "trigger", label: "Nút mở" }, { key: "panel", label: "Panel" }],
  menu: [{ key: "trigger", label: "Nút mở" }, { key: "panel", label: "Panel" }],
  video: [{ key: "node", label: "Video / iframe" }],
};

function rolesOf(kind: InteractiveKind, picked: Record<string, string[]>, mode: "native" | "embed"): Record<string, unknown> {
  const one = (k: string) => picked[k]?.[0];
  const pairs = () => (picked.triggers ?? []).map((trigger, k) => ({ trigger, panel: picked.panels?.[k] }));
  switch (kind) {
    case "carousel": return { viewport: one("viewport"), track: one("track"), slides: picked.slides ?? [] };
    case "tabs": return { tabs: pairs() };
    case "accordion": return { items: pairs() };
    case "modal": return { triggers: picked.triggers ?? [], dialog: one("dialog"), ...(one("closeButton") && { closeButton: one("closeButton"), closeOn: ["esc", "backdrop", "button"] }) };
    case "video": return { node: one("node"), mode };
    default: return { trigger: one("trigger"), panel: one("panel") };
  }
}

// E2 §7 "Đánh dấu là component…": the kind, then its roles among the selected node and its descendants (≤ 100, the
// outline). The server validates like a load (refs inside the root, slides are track children…) and names what is wrong.
export function ConvertWizard({ rootId, outline, onCancel, onSubmit }: { rootId: string; outline: Outline; onCancel(): void; onSubmit(command: EditorCommand): void }) {
  const [kind, setKind] = useState<InteractiveKind>("carousel");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<"native" | "embed">("native");
  const options = outline.map((o) => <option key={o.id} value={o.id}>{`${"· ".repeat(o.depth)}${o.label}`}</option>);
  const fields = FIELDS[kind];
  const ready = fields.every((f) => f.optional || (picked[f.key]?.length ?? 0) > 0);
  return (
    <div className="stack cmp-wizard" data-ui="ui_editor_component_wizard">
      <Field label="Loại component">
        <select value={kind} onChange={(e) => { setKind(e.target.value as InteractiveKind); setPicked({}); }}>
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </Field>
      {fields.map((f) => (
        <Field key={`${kind}-${f.key}`} label={f.label} hint={f.list ? "Giữ Ctrl / ⌘ để chọn nhiều" : undefined}>
          {f.list ? (
            <select multiple size={Math.min(6, Math.max(3, outline.length))} value={picked[f.key] ?? []} onChange={(e) => setPicked({ ...picked, [f.key]: [...e.target.selectedOptions].map((o) => o.value) })}>
              {options}
            </select>
          ) : (
            <select value={picked[f.key]?.[0] ?? ""} onChange={(e) => setPicked({ ...picked, [f.key]: e.target.value ? [e.target.value] : [] })}>
              <option value="">{f.optional ? "— không có —" : "— chọn —"}</option>
              {options}
            </select>
          )}
        </Field>
      ))}
      {kind === "video" && (
        <Field label="Kiểu video">
          <select value={mode} onChange={(e) => setMode(e.target.value as "native" | "embed")}>
            <option value="native">Thẻ video</option>
            <option value="embed">Nhúng (YouTube / Vimeo)</option>
          </select>
        </Field>
      )}
      <div className="cmp-actions">
        <Button variant="primary" disabled={!ready} onClick={() => onSubmit({ op: "convertToComponent", id: rootId, kind, roles: rolesOf(kind, picked, mode) })}>Tạo component</Button>
        <Button variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </div>
  );
}
