"use client";
// E3 §3 Style Manager: the selected node's properties at the open breakpoint and state, each with its value source and
// "↺ bỏ"; applied to the canvas at once (inline, optimistic), sent 300 ms after typing stops with a coalesce key so
// edits on one field within 1.5 s are one Undo step (R3). Unsafe CSS never leaves the panel (nor reaches the canvas).
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IRNodeV2 } from "@/core/ir-v2";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import type { Batch, Bp } from "./model";
import { CHOICES, clearField, fieldOf, GROUPS, otherProps, scrub, setField, SOURCE_VI, styleKey, type StateName } from "./style-model";

export const STYLE_DEBOUNCE_MS = 300;
type Extra = { coalesceKey?: string; apply?: () => void; rollback?: () => void };
type Props = { node: IRNodeV2; element: HTMLElement | null; bp: Bp; fonts: string[]; onBatch(b: Batch, label: string, extra: Extra): void; onMessage(text: string): void };
const SIDES = ["top", "right", "bottom", "left"] as const;
const SPACING_LABEL: Record<(typeof SIDES)[number], string> = { top: "trên", right: "phải", bottom: "dưới", left: "trái" };

export function StylePanel({ node, element, bp, fonts, onBatch, onMessage }: Props) {
  const [state, setState] = useState<"" | StateName>("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [freeProp, setFreeProp] = useState("");
  const [freeValue, setFreeValue] = useState("");
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send(): void }>()); // typed, not sent yet
  const burst = useRef(new Map<string, string>()); // the inline value before this field's current burst of edits
  const live = useRef({ node, element });
  live.current = { node, element }; // a section swap replaces the element: timers act on the current one
  const st = state || undefined;
  const flush = () => { for (const p of [...pending.current.values()]) { clearTimeout(p.timer); p.send(); } };
  // another breakpoint / state: what was typed at the old one is sent there now (the maps are keyed by prop alone)
  useEffect(() => { flush(); setDrafts({}); setErrors({}); }, [bp, state]);
  // a new server value (a step done, Undo, ↺): drafts already sent give way to it; typed-but-unsent and refused ones stay
  useEffect(() => setDrafts((d) => {
    const keep = Object.entries(d).filter(([p]) => pending.current.has(p) || p in errors);
    return keep.length === Object.keys(d).length ? d : Object.fromEntries(keep);
  }), [node]); // `errors` is read at the node change only
  const endScrub = useRef<(() => void) | null>(null); // removes a running scrub's window listeners
  // leaving the node (another selection) sends what was typed instead of dropping it under its inline preview
  useEffect(() => () => { endScrub.current?.(); flush(); }, []);

  const inline = (prop: string, value: string) => {
    const el = live.current.element;
    if (!el || st) return; // states are not previewed inline
    if (value === "") el.style.removeProperty(prop); else el.style.setProperty(prop, value);
  };
  const send = (prop: string, value: string) => {
    pending.current.delete(prop);
    const b = setField(live.current.node, bp, st, prop, value);
    const prev = burst.current.get(prop) ?? "";
    burst.current.delete(prop);
    const rollback = () => inline(prop, prev);
    if ("error" in b) { rollback(); setErrors((e) => ({ ...e, [prop]: b.error })); return; }
    if (b.commands.length) onBatch(b, `Style ${prop}`, { coalesceKey: styleKey(node.id, bp, st, prop), apply: () => inline(prop, value.trim()), rollback });
  };
  const edit = (prop: string, value: string) => {
    setDrafts((d) => ({ ...d, [prop]: value }));
    setErrors(({ [prop]: _gone, ...rest }) => rest);
    if (!burst.current.has(prop)) burst.current.set(prop, live.current.element?.style.getPropertyValue(prop) ?? "");
    const check = setField(live.current.node, bp, st, prop, value);
    if ("error" in check) setErrors((e) => ({ ...e, [prop]: check.error }));
    else inline(prop, value.trim()); // validated (isSafeCss) before it touches the canvas
    clearTimeout(pending.current.get(prop)?.timer);
    const go = () => send(prop, value);
    pending.current.set(prop, { timer: setTimeout(go, STYLE_DEBOUNCE_MS), send: go });
  };
  const reset = (prop: string) => {
    clearTimeout(pending.current.get(prop)?.timer);
    pending.current.delete(prop);
    onBatch(clearField(node, bp, st, prop), `Bỏ ${prop}`, {});
  };
  const cs = element ? element.ownerDocument.defaultView!.getComputedStyle(element) : undefined; // one per render (R14 placeholders)
  // "kéo trực tiếp trên số": only on a number (scrub refuses auto, normal…); the unit stays
  const scrubbing = (prop: string, start: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (scrub(start, 0) === undefined) return;
    e.preventDefault();
    const x0 = e.clientX;
    const move = (m: PointerEvent) => { const next = scrub(start, Math.round(m.clientX - x0)); if (next) edit(prop, next); };
    endScrub.current?.();
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); endScrub.current = null; };
    endScrub.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const field = (prop: string, label: string = prop, compact = false) => {
    const f = fieldOf(node, bp, st, prop);
    const value = drafts[prop] ?? f?.value ?? "";
    const choices = prop === "font-family" ? fonts : CHOICES[prop];
    const listId = `ve-${prop}-choices`;
    return (
      <div key={prop} className={`ve-field${compact ? " is-compact" : ""}`} data-ui="ui_editor_style_field" data-prop={prop}>
        <span className="ve-field-name" title={compact ? `${prop} — kéo ngang để đổi số` : prop} onPointerDown={compact ? scrubbing(prop, value || (cs?.getPropertyValue(prop) ?? "")) : undefined}>{label}</span>
        <input value={value} placeholder={cs?.getPropertyValue(prop) ?? ""} aria-label={prop} list={choices ? listId : undefined} onChange={(e) => edit(prop, e.target.value)} />
        {choices && <datalist id={listId}>{choices.map((c) => <option key={c} value={c} />)}</datalist>}
        {!compact && <IconButton icon="replay" label={`Bỏ ${prop} ở lớp này`} disabled={f?.source !== "here"} onClick={() => reset(prop)} />}
        {!compact && f && <span className="ve-field-source"><Badge tone={f.source === "here" ? "primary" : "neutral"}>{SOURCE_VI[f.source]}</Badge></span>}
        {errors[prop] && <span role="alert" className="cmp-error t-body-sm">{errors[prop]}</span>}
      </div>
    );
  };
  const addFree = () => {
    const b = setField(node, bp, st, freeProp, freeValue);
    if ("error" in b) return onMessage(b.error);
    onBatch(b, `Style ${freeProp}`, {});
    setFreeProp("");
    setFreeValue("");
  };
  return (
    <div className="stack" data-ui="ui_editor_style_panel">
      <SegmentedControl<"" | StateName> label="Trạng thái" full data-ui="ui_editor_style_state" value={state} onChange={setState}
        options={[{ value: "", label: "Mặc định" }, { value: "hover", label: ":hover" }, { value: "focus", label: ":focus" }, { value: "active", label: ":active" }]} />
      {st && <p className="t-body-sm text-2">Trạng thái áp cho mọi breakpoint.</p>}
      {GROUPS.map((g) => (
        <Disclosure key={g.id} summary={g.label} defaultOpen={g.id === "typography" || g.id === "layout"} data-ui="ui_editor_style_group">
          {g.id === "spacing" ? (
            <div className="ve-box">
              <span className="t-label-sm text-3">margin</span>
              {SIDES.map((s) => <div key={s} className={`ve-box-${s}`}>{field(`margin-${s}`, SPACING_LABEL[s], true)}</div>)}
              <div className="ve-box-inner">
                <span className="t-label-sm text-3">padding</span>
                {SIDES.map((s) => <div key={s} className={`ve-box-${s}`}>{field(`padding-${s}`, SPACING_LABEL[s], true)}</div>)}
              </div>
            </div>
          ) : <div className="stack ve-fields">{g.props.map((p) => field(p))}</div>}
        </Disclosure>
      ))}
      <Disclosure summary="Thuộc tính khác" data-ui="ui_editor_style_free">
        <div className="stack ve-fields">
          {otherProps(node, bp, st).map((p) => field(p))}
          <div className="ve-free">
            <input aria-label="Thuộc tính" placeholder="vd. outline-offset" value={freeProp} onChange={(e) => setFreeProp(e.target.value.trim())} />
            <input aria-label="Giá trị" placeholder="vd. 2px" value={freeValue} onChange={(e) => setFreeValue(e.target.value)} />
            <Button onClick={addFree} disabled={!freeProp || !freeValue}>Thêm</Button>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
