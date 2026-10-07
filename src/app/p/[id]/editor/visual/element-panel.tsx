"use client";
// E3 §2 right panel, tab Style (E3a, R14): the selected node — tag, name, size; replace an image from the project's
// asset library or an upload (§5), its alt; a link's href; Detach / reset overrides on an instance (E1 §4).
// Hiệu ứng: the existing presets as setStyle(animation) at the current breakpoint.
import { useRef, useState } from "react";
import { isSafeAttr } from "@/core/safe-names";
import type { LibraryAsset } from "@/core/upload";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { safeHref } from "./inline-text";
import { generatedNode, guard, imageBatch, labelOf, type Batch, type Bp, type DocIndex, type Entry } from "./model";

// mirrors MAX_FILE_BYTES / DEFAULT_BUDGET_BYTES (core/assets is server-side; the unit test pins the values)
export const UPLOAD_LIMITS = { fileBytes: 25 * 1024 * 1024, projectBytes: 500 * 1024 * 1024 } as const;
const MB = 1024 * 1024;
const TOO_LARGE = `Ảnh vượt ${UPLOAD_LIMITS.fileBytes / MB} MB.`;

// alt / href: one setAttribute ('' removes it); a link only through the inline editor's safe-href allowlist
export function attrBatch(index: DocIndex, id: string, name: "alt" | "href", value: string): Batch {
  const why = guard(index, [], id, "edit"); // "edit" never reads the component list
  if (why) return { error: why };
  const tag = index.get(id)!.node.tag;
  if (value !== "" && (!isSafeAttr(tag, name, value) || (name === "href" && !safeHref(value)))) return { error: "Link không hợp lệ — chỉ nhận http(s), mailto, tel, #neo hoặc đường dẫn tương đối." };
  return { commands: [{ op: "setAttribute", id, name, value: value === "" ? null : value }] };
}

export function uploadError(status: number, body: { code?: string; message?: string }): string {
  switch (body.code) {
    case "ASSET_TOO_LARGE": case "PAYLOAD_TOO_LARGE": return TOO_LARGE;
    case "PROJECT_SIZE_LIMIT": return `Tổng ảnh của project vượt ${UPLOAD_LIMITS.projectBytes / MB} MB.`;
    case "UPLOAD_INVALID": return body.message || "Chỉ nhận ảnh png/jpg/webp/gif/svg/avif — đuôi file và nội dung phải khớp."; // storeUpload's reasons are Vietnamese
    default: return `Tải ảnh lỗi (HTTP ${status}${body.code ? `, ${body.code}` : ""}).`;
  }
}

export type Optimistic = { apply(): void; rollback(): void };
type Props = { projectId: string; index: DocIndex; entry: Entry; element: HTMLElement | null; bp: Bp; assets: LibraryAsset[]; onBatch(b: Batch, label: string, optimistic?: Optimistic): void; onUploaded(a: LibraryAsset): void; onMessage(text: string): void; canEdit?(): boolean };

// an uncontrolled text box that saves on Enter / leaving it, once per value (Enter then blur is one save)
function AttrInput({ label, value, onCommit }: { label: string; value: string; onCommit(v: string): void }) {
  const last = useRef(value);
  const commit = (v: string) => { if (v !== last.current) { last.current = v; onCommit(v); } };
  return (
    <Field label={label}>
      <input defaultValue={value} onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); }} onBlur={(e) => commit(e.currentTarget.value)} />
    </Field>
  );
}

export function ElementPanel({ projectId, index, entry, element, bp, assets, onBatch, onUploaded, onMessage, canEdit = () => true }: Props) {
  const [busy, setBusy] = useState(false);
  const node = entry.node;
  const background = !!element && element.ownerDocument.defaultView!.getComputedStyle(element).backgroundImage.includes("url("); // a pure gradient is not a replaceable image
  const kind = node.tag === "img" ? "img" : node.tag === "source" ? "source" : background ? "background" : undefined;
  const generated = generatedNode(node);
  const apply = (asset: LibraryAsset) => {
    if (!kind) return;
    const b = imageBatch(index, node.id, kind, asset.key, bp);
    if ("error" in b || !element || kind === "source") return onBatch(b, "Thay ảnh");
    // optimistic: the served file now (an <img> / CSS url(), never inlined), the section from the server after the step
    const el = element;
    let prev = { src: el.getAttribute("src"), srcset: el.getAttribute("srcset"), bg: el.style.backgroundImage };
    onBatch(b, "Thay ảnh", {
      apply: () => {
        prev = { src: el.getAttribute("src"), srcset: el.getAttribute("srcset"), bg: el.style.backgroundImage };
        if (kind === "img") { el.removeAttribute("srcset"); el.setAttribute("src", asset.url); }
        else el.style.backgroundImage = `url("${asset.url}")`;
      },
      rollback: () => {
        if (prev.src === null) el.removeAttribute("src"); else el.setAttribute("src", prev.src);
        if (prev.srcset === null) el.removeAttribute("srcset"); else el.setAttribute("srcset", prev.srcset);
        el.style.backgroundImage = prev.bg;
      },
    });
  };
  const upload = async (file: File) => {
    if (file.size > UPLOAD_LIMITS.fileBytes) return onMessage(TOO_LARGE);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { key?: string; url?: string; code?: string; message?: string };
      if (!res.ok || !body.key || !body.url) return onMessage(uploadError(res.status, body));
      // the route's key and url, never built here
      const asset = { key: body.key, url: body.url, size: file.size, type: body.key.slice(body.key.lastIndexOf(".") + 1) };
      onUploaded(asset);
      // the editor went view-only (R9) during the upload: the file is in the library, nothing is sent
      if (!canEdit()) return onMessage("Ảnh đã tải lên nhưng chưa gắn — đang ở chế độ chỉ xem.");
      apply(asset);
    } catch {
      onMessage("Tải ảnh lỗi (mất kết nối) — thử lại.");
    } finally {
      setBusy(false);
    }
  };
  const attr = (name: "alt" | "href", value: string) => onBatch(attrBatch(index, node.id, name, value), name === "alt" ? "Sửa alt" : "Sửa link");
  const rect = element?.getBoundingClientRect();
  return (
    <Card title="Phần tử" data-ui="ui_editor_element_card">
      <p className="t-label-md">{`${node.tag} · ${labelOf(entry)}${rect ? ` · ${Math.round(rect.width)}×${Math.round(rect.height)}` : ""}`}</p>
      {node.component?.role === "instance" && !generated && (
        <div className="cmp-actions">
          <Button onClick={() => onBatch({ commands: [{ op: "detachComponent", instanceId: node.id }] }, "Tách khỏi component")}>Tách khỏi component</Button>
          <Button variant="ghost" onClick={() => onBatch({ commands: [{ op: "resetOverride", instanceId: node.id }] }, "Bỏ override")}>Bỏ mọi override</Button>
        </div>
      )}
      {generated && <p className="t-body-sm text-2">Phần tử lấy từ main component: bấm Sửa main, hoặc Tách khỏi component ở instance gốc.</p>}
      {kind && !generated && (
        <div className="stack" data-ui="ui_editor_image_panel">
          <span className="field-label">Ảnh ({kind === "background" ? "nền" : kind})</span>
          <ul className="ve-assets" data-ui="ui_editor_asset_grid">
            {assets.map((a) => (
              <li key={a.key}>
                <button type="button" aria-label={`Dùng ảnh ${a.type}, ${Math.ceil(a.size / 1024)} KB`} title={`Dùng ảnh ${a.type}, ${Math.ceil(a.size / 1024)} KB`} onClick={() => apply(a)}>
                  <img src={a.url} alt="" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
          <Field label="Tải ảnh lên (png, jpg, webp, gif, svg, avif — tối đa 25 MB)" data-ui="ui_editor_upload">
            <input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.avif" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
          </Field>
          {kind === "img" && <AttrInput key={`${node.id}-alt-${node.attrs.alt ?? ""}`} label="Alt" value={node.attrs.alt ?? ""} onCommit={(v) => attr("alt", v)} />}
        </div>
      )}
      {node.tag === "a" && !generated && <AttrInput key={`${node.id}-href-${node.attrs.href ?? ""}`} label="Link (href)" value={node.attrs.href ?? ""} onCommit={(v) => attr("href", v)} />}
    </Card>
  );
}

const DEFAULT_EFFECT_MS = 600;
export function EffectsCard({ effects, disabled, onApply }: { effects: string[]; disabled: boolean; onApply(animation: string): void }) {
  const [effect, setEffect] = useState(effects[0] ?? "sp1-fade-in");
  const [ms, setMs] = useState(DEFAULT_EFFECT_MS);
  return (
    <Card title="Hiệu ứng" data-ui="ui_editor_effects_panel">
      <Field label="Keyframes">
        <select value={effect} onChange={(e) => setEffect(e.target.value)}>
          {effects.map((name) => <option key={name}>{name}</option>)}
        </select>
      </Field>
      <Field label="Thời lượng (ms)">
        <input type="number" min={100} max={10_000} step={100} value={ms} onChange={(e) => setMs(Number(e.target.value) || DEFAULT_EFFECT_MS)} />
      </Field>
      <Button onClick={() => onApply(`${effect} ${ms}ms ease-out both`)} disabled={disabled}>Áp cho phần tử đang chọn</Button>
    </Card>
  );
}
