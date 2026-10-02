"use client";
import type { KeyboardEvent } from "react";
import { Field } from "@/app/_ui/Field";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import type { Bp, PanelComponent } from "@/core/interactive";

type Patch = Record<string, unknown>;
const BPS: [Bp, string][] = [["1440", "Desktop"], ["768", "Tablet"], ["375", "Mobile"]];

// A number committed on blur / Enter (each change is one server command + an editor reload, not one per keystroke).
// key = the current value: a new document value resets the input. "" = no value (a breakpoint inherits the wider one).
function NumberInput({ label, value, min, max, step = 1, onCommit }: { label: string; value: number | undefined; min: number; max: number; step?: number; onCommit(v: number | undefined): void }) {
  const commit = (raw: string) => {
    const v = raw.trim() === "" ? undefined : Number(raw);
    if (v === value || (v !== undefined && (!Number.isFinite(v) || v < min || v > max))) return;
    onCommit(v);
  };
  return (
    <Field label={label}>
      <input key={String(value)} type="number" min={min} max={max} step={step} defaultValue={value ?? ""} onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </Field>
  );
}
const Check = ({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) => (
  <label className="check">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);

// E2 §7 form per kind: every change sends updateComponent({ field: value }) (PATCHABLE in core/interactive).
export function ComponentForm({ component: c, onPatch }: { component: PanelComponent; onPatch(patch: Patch): void }) {
  const s = c.spec;
  let body;
  switch (s.kind) {
    case "carousel": {
      const perBp = (field: "slidesPerView" | "gap", bp: Bp, v: number | undefined) => {
        const next: Partial<Record<Bp, number>> = { ...s[field] };
        if (v === undefined) delete next[bp]; else next[bp] = v;
        onPatch({ [field]: next });
      };
      body = (
        <>
          <Check label="Tự chạy" checked={s.autoplay} onChange={(v) => onPatch({ autoplay: v })} />
          <NumberInput label="Khoảng thời gian (ms)" value={s.interval} min={1000} max={60000} step={100} onCommit={(v) => v !== undefined && onPatch({ interval: v })} />
          <Check label="Lặp" checked={s.loop} onChange={(v) => onPatch({ loop: v })} />
          <SegmentedControl label="Hướng" value={s.direction} onChange={(v) => onPatch({ direction: v })} options={[{ value: "horizontal", label: "Ngang" }, { value: "vertical", label: "Dọc" }]} />
          <SegmentedControl label="Chuyển cảnh" value={s.transition} onChange={(v) => onPatch({ transition: v })} options={[{ value: "slide", label: "Trượt" }, { value: "fade", label: "Mờ dần" }]} />
          <NumberInput label="Tốc độ (ms)" value={s.speed} min={0} max={5000} step={50} onCommit={(v) => v !== undefined && onPatch({ speed: v })} />
          {BPS.map(([bp, name]) => (
            <div key={bp} className="cmp-bp">
              <NumberInput label={`Số slide hiển thị · ${name}`} value={s.slidesPerView[bp]} min={1} max={10} step={0.01} onCommit={(v) => perBp("slidesPerView", bp, v)} />
              <NumberInput label={`Khoảng cách (px) · ${name}`} value={s.gap[bp]} min={0} max={200} onCommit={(v) => perBp("gap", bp, v)} />
            </div>
          ))}
          {/* arrows / pagination need their nodes: only the captured ones can be turned off (Undo brings them back) */}
          <Check label="Mũi tên" checked={!!s.arrows} disabled={!s.arrows} onChange={() => onPatch({ arrows: null })} />
          <SegmentedControl<"bullets" | "fraction" | "off">
            label="Pagination"
            value={s.pagination?.kind ?? "off"}
            onChange={(v) => onPatch({ pagination: v === "off" ? null : { container: s.pagination!.container, kind: v } })}
            options={[{ value: "bullets", label: "Chấm", disabled: !s.pagination }, { value: "fraction", label: "Phân số", disabled: !s.pagination }, { value: "off", label: "Tắt" }]}
          />
        </>
      );
      break;
    }
    case "tabs":
      body = (
        <Field label="Tab mặc định">
          <select value={s.active} onChange={(e) => onPatch({ active: Number(e.target.value) })}>
            {c.items.map((item, k) => <option key={item.id} value={k}>{item.label}</option>)}
          </select>
        </Field>
      );
      break;
    case "accordion":
      body = (
        <>
          <Check label="Cho mở nhiều mục" checked={s.multiple} onChange={(v) => onPatch({ multiple: v })} />
          {s.items.map((x, k) => (
            <Check key={x.trigger} label={`Mở sẵn: ${c.items[k]?.label ?? k + 1}`} checked={x.open} onChange={(v) => onPatch({ items: s.items.map((y, j) => (j === k ? { ...y, open: v } : y)) })} />
          ))}
        </>
      );
      break;
    case "modal": {
      const set = (k: "esc" | "backdrop" | "button", on: boolean) => onPatch({ closeOn: on ? [...s.closeOn, k] : s.closeOn.filter((x) => x !== k) });
      body = (
        <>
          <Check label="Đóng bằng Esc" checked={s.closeOn.includes("esc")} onChange={(v) => set("esc", v)} />
          <Check label="Đóng khi bấm nền" checked={s.closeOn.includes("backdrop")} onChange={(v) => set("backdrop", v)} />
          <Check label="Đóng bằng nút đóng" checked={s.closeOn.includes("button")} disabled={!s.closeButton} onChange={(v) => set("button", v)} />
        </>
      );
      break;
    }
    case "dropdown":
    case "menu":
      body = <SegmentedControl label="Mở bằng" value={s.openOn} onChange={(v) => onPatch({ openOn: v })} options={[{ value: "click", label: "Click" }, { value: "hover", label: "Hover" }]} />;
      break;
    case "video":
      body = (
        <>
          <Check label="Tự chạy" checked={s.autoplay} onChange={(v) => onPatch(v ? { autoplay: true, muted: true } : { autoplay: false })} />
          <Check label="Tắt tiếng" checked={s.muted || s.autoplay} disabled={s.autoplay} onChange={(v) => onPatch({ muted: v })} />
          <Check label="Lặp" checked={s.loop} onChange={(v) => onPatch({ loop: v })} />
          <Check label="Điều khiển" checked={s.controls} onChange={(v) => onPatch({ controls: v })} />
        </>
      );
  }
  return <div className="stack cmp-form" data-ui="ui_editor_component_form">{body}</div>;
}
