"use client";
// E3 visual editor (spec §1–§4): the server's page in a canvas frame, the command bus for every edit, partial canvas
// updates from `affected`. Selection lives here; panels render from the resolved page tree (model.indexPage).
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { CanvasPayload } from "@/core/editor-canvas";
import type { PanelComponent } from "@/core/interactive";
import type { EditorCommand } from "@/core/ir-command";
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeAttr } from "@/core/safe-names";
import type { LibraryAsset } from "@/core/upload";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { ComponentPanel } from "../component-panel/component-panel";
import { Canvas, type CanvasHandle } from "./canvas";
import { CommandBus, type BusEvent, type Op, type StepResult } from "./command-bus";
import { EffectsCard, ElementPanel } from "./element-panel";
import { fitZoom, handlesFor, wheelZoom, ZOOM, zoomStep } from "./gestures";
import { InsertPanel } from "./insert-panel";
import { LayerTree } from "./layer-tree";
import { textBatch, type DomLike } from "./inline-text";
import { ancestorsOf, bodyOf, BPS, copyClip, deleteBatch, duplicateBatch, guard, hideBatch, indexPage, insertAt, instanceRootOf, isTextHost, keyAction, labelOf, mainView, outlineOf, parentOf, pasteBatch, pickTarget, reorderBatch, siblingsOf, styleTarget, toMain, viewIdOf, type Batch, type Bp, type Clip, type DocIndex } from "./model";
import { at, measure, Overlay } from "./overlay";
import { gaps } from "./snap";
import { StylePanel } from "./style-panel";
import { insertBatch, type Template } from "./templates";
import { useGestures } from "./use-gestures";

export type EditorData = CanvasPayload & { revision: number; canUndo: boolean; canRedo: boolean; interactives: PanelComponent[]; shot: string; assets: LibraryAsset[] };
type Halt = { kind: "stale" | "unwritten" | "failed"; text: string };
type RightTab = "style" | "component" | "effects";
type CommandsOp = Extract<Op, { kind: "commands" }>;
const DONE: Record<Op["kind"], string> = { commands: "Đã lưu — điểm QA cần chạy lại", undo: "Đã hoàn tác — điểm QA cần chạy lại", redo: "Đã làm lại — điểm QA cần chạy lại" };
type Drawn = { tag: string; id?: string; text?: string; attrs?: Record<string, string>; children?: Drawn[] };
// an inline edit's optimistic result, drawn from its sanitized batch (the IR's children with the new texts, or the
// batch's drafts) — never from the edited DOM's markup. Classes come from the host's server-rendered elements.
function drawText(host: HTMLElement, ir: IRNodeV2, commands: EditorCommand[]): void {
  const doc = host.ownerDocument;
  const texts = new Map(commands.flatMap((c) => (c.op === "setText" ? [[c.id, c.text] as const] : [])));
  const cls = new Map([...host.querySelectorAll("[data-ir-id]")].map((e) => [e.getAttribute("data-ir-id")!, e.getAttribute("class")]));
  const draw = (n: Drawn): Node => {
    if (n.tag === "#text") return doc.createTextNode(n.id && texts.has(n.id) ? texts.get(n.id)! : n.text ?? "");
    const el = doc.createElement(n.tag);
    for (const [k, v] of Object.entries(n.attrs ?? {})) if (isSafeAttr(n.tag, k, v)) el.setAttribute(k, v);
    if (n.id) { el.setAttribute("data-ir-id", n.id); const c = cls.get(n.id); if (c) el.setAttribute("class", c); }
    for (const c of n.children ?? []) el.append(draw(c));
    return el;
  };
  const structural = commands.some((c) => c.op !== "setText");
  const kids: Drawn[] = structural ? commands.flatMap((c) => (c.op === "createNode" ? [c.draft] : [])) : ir.children;
  host.replaceChildren(...kids.map(draw));
}
const BAND_LIMIT = 20;
const typingIn = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")); };
// Space pans only from the canvas: anywhere in the frame but a text being typed (its content is not interactive in the
// editor), or this page's body / the canvas pane with no dialog open. A focused button, link, tab, tree row… keeps
// Space for its own activation (keyboard access).
const panKey = (t: EventTarget | null): boolean => {
  const el = t as (Node & Partial<HTMLElement>) | null;
  if (!el || typingIn(el)) return false;
  if ((el.ownerDocument ?? el) !== document) return true; // the canvas frame
  if (document.querySelector("dialog[open], [aria-modal='true']")) return false;
  return el === document.body || el === document.documentElement || (el as Element).matches?.('[data-ui="ui_editor_canvas_chrome"]') === true;
};

// a media query as state: right from the first client render (false on the server render and while hydrating)
function useMedia(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const m = window.matchMedia(query);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
const VIEW_ONLY = "Dùng màn hình ≥ 768px để chỉnh sửa";

export function VisualEditor({ projectId: id, initialPage }: { projectId: string; initialPage: string }) {
  const [pageId, setPageId] = useState(initialPage); // "" = the API's default page
  const [load, setLoad] = useState(0); // bumped: refetch + a fresh frame (shellChanged, Tải lại, a drifted frame)
  const [data, setData] = useState<EditorData | null>(null);
  const [bp, setBp] = useState<Bp>(1440);
  const [selection, setSelection] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [alt, setAlt] = useState(false); // Alt held over the canvas: distances from the selection to the hovered node
  const [tick, setTick] = useState(0); // the frame scrolled / resized / changed: overlays re-measure
  const [msg, setMsg] = useState("");
  const [halt, setHalt] = useState<Halt | null>(null);
  const [pending, setPending] = useState(0);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<RightTab>("style");
  const [left, setLeft] = useState<"layers" | "insert">("layers");
  const [loading, setLoading] = useState(true); // a (re)fetch is on its way: no bus, nothing can be pushed
  const [zoom, setZoom] = useState(1); // R8: view only, never saved
  const [picked, setPicked] = useState<string[]>([]); // the Section card's choice (R10), sections of any page
  // R9: up to 1099px the side panels are drawers; below 768px the editor only views and selects
  const narrow = useMedia("(max-width: 1099px)");
  const viewOnly = useMedia("(max-width: 767.98px)");
  // the gate follows viewOnly one step late: the transition effect below saves what was typed first, then locks
  const [locked, setLocked] = useState(viewOnly);
  const editable = !locked;
  const styleFlush = useRef<(() => void) | null>(null); // the Style panel's "send what is typed now"
  const endEdit = useRef<(() => void) | null>(null); // the open inline text's "save and close"
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
  const toggles = useRef<Record<"left" | "right", HTMLButtonElement | null>>({ left: null, right: null });
  const panels = useRef<Record<"left" | "right", HTMLElement | null>>({ left: null, right: null });
  const canvas = useRef<CanvasHandle>(null);
  const bus = useRef<CommandBus | null>(null);
  const clip = useRef<Clip | null>(null); // internal clipboard (R19): one subtree, never the OS clipboard
  const [editMain, setEditMain] = useState<string | null>(null); // R17: the open instance's root (a canvas id)
  const raw: DocIndex = useMemo(() => (data ? indexPage(data.page) : new Map()), [data]);
  // a reload / an edit that removed the instance closes the mode (the effect below clears editMain too)
  const open = editMain && raw.get(editMain)?.node.component?.role === "instance" ? editMain : null;
  // every panel, gesture, shortcut and inline edit reads `index`: while a main is open, its instance without refs
  const index: DocIndex = useMemo(() => (open ? mainView(raw, open) : raw), [raw, open]);
  const live = useRef({ data, index, raw, open, selection, bp, zoom, editable });
  live.current = { data, index, raw, open, selection, bp, zoom, editable };

  const drift = useRef(false); // the frame no longer matches the server: reload once the queue drains
  const send = (op: Op, body: object) => api<StepResult>(`/api/projects/${id}/editor/${op.kind}`, { body });
  const applyResult = (r: StepResult, keepSelection = false, mainRoot?: string) => {
    gestures.cancelGesture(); // a drag's drop was built from the index / DOM this result replaces
    const a = r.affected, d = live.current.data;
    if (!d) return;
    const roots = new Map(d.page.sections.map((s) => [s.id, s.root.id]));
    // shellChanged / no affected / a missing section root -> reload; never patch a DOM that already drifted
    const partial = !drift.current && !!a && !a.shellChanged && !!canvas.current?.replace(a, (sid) => roots.get(sid));
    if (!partial) drift.current = true;
    const fresh = new Map(a?.sections.map((s) => [s.id, s.root]));
    setData((cur) => cur && {
      ...cur, revision: r.revision, canUndo: r.canUndo, canRedo: r.canRedo,
      ...(partial && a && {
        css: a.css, interactives: a.interactives,
        page: { ...cur.page, sections: cur.page.sections.map((s) => (fresh.has(s.id) ? { ...s, root: fresh.get(s.id)! } : s)) },
      }),
    });
    // R18: a node created in the main shows in the open instance under its generated id
    if (!keepSelection) setSelection((s) => (r.createdIds.length ? r.createdIds.map((c) => (mainRoot ? viewIdOf(mainRoot, c) : c)) : s));
  };
  // refetch the page; the old bus is dropped at once so nothing more is pushed to it
  const refetch = () => { gestures.cancelGesture(); bus.current = null; setLoading(true); setLoad((x) => x + 1); };
  const say = (e: BusEvent) => {
    switch (e.type) {
      case "saving": return;
      case "done":
        setSaved(true);
        setMsg(e.op.done ?? DONE[e.op.kind]);
        // allSections spans every page: a merge, or an Undo/Redo that changed nothing on this page (another page's step,
        // a merge's layout), reloads so the Section card is current
        if (e.op.kind === "commands" ? e.op.commands.some((c) => c.op === "promoteLayout") : !e.result.affected?.shellChanged && !e.result.affected?.sections.length) drift.current = true;
        return e.op.kind === "commands" ? applyResult(e.result, !!e.op.keepSelection, e.op.mainRoot) : applyResult(e.result);
      case "refused": return setMsg(e.message);
      case "full": return setMsg("Đang lưu… chờ chút");
      case "stale": {
        const text = `Dự án đã thay đổi ở nơi khác${e.revision !== undefined ? ` (revision ${e.revision})` : ""}. Tải lại để tiếp tục.`;
        setMsg(text);
        return setHalt({ kind: "stale", text });
      }
      case "unwritten": return setHalt({ kind: "unwritten", text: "Đã lưu nhưng chưa ghi được bản xuất — thử lại sau ít phút." });
      case "failed": return setHalt({ kind: "failed", text: `Chưa lưu được: ${e.message}` });
    }
  };
  const onEvent = (e: BusEvent) => {
    setPending(bus.current?.pending ?? 0);
    say(e);
    // the queue settled (whatever the last step's outcome) on a drifted frame: a reload makes a new bus at the fetched
    // revision, so it waits until this one has nothing left to send
    if ((e.type === "done" || e.type === "refused" || e.type === "failed") && drift.current && !bus.current?.pending) {
      drift.current = false;
      refetch();
    }
  };

  useEffect(() => {
    let cancelled = false;
    api<EditorData>(`/api/projects/${id}/editor${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`).then(
      (d) => {
        if (cancelled) return;
        const next = indexPage(d.page);
        setData(d);
        setHalt(null);
        drift.current = false;
        setSelection((s) => s.filter((x) => next.has(x)));
        bus.current = new CommandBus(d.revision, d.page.id, send, onEvent);
        setPending(0);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        // a stale or mistyped ?page= falls back to the default page
        if (pageId !== "" && pageId === initialPage && (e as { code?: string }).code === "NOT_FOUND") return setPageId("");
        setMsg(errorText(e));
      },
    );
    return () => { cancelled = true; };
  }, [id, pageId, load, initialPage]); // send / onEvent read `live` and setters only: no stale state

  // false = not queued (the bus already said why: full / stale); no bus yet = the page is still loading
  // view-only (R9): the gate is read at call time, so no callback captured earlier (a debounce, an upload's follow-up)
  // gets past it
  // R17: every commands op (panels, gestures, shortcuts, inline text, Thêm) passes here — while a main is open its canvas
  // ids become the main's (toMain refuses what cannot be one, nothing sent)
  const run = (op: Op): boolean => {
    if (!live.current.editable) { setMsg(VIEW_ONLY); return false; }
    setMsg("");
    if (!bus.current) { setMsg("Editor chưa sẵn sàng."); return false; }
    const root = live.current.open;
    if (root && op.kind === "commands") {
      const m = toMain(live.current.raw, root, op.commands);
      if ("error" in m) { setMsg(m.error); return false; }
      op = { ...op, commands: m.commands, mainRoot: root };
    }
    return bus.current.push(op);
  };
  const commands = (list: EditorCommand[], label: string, extra: Partial<CommandsOp> = {}) => run({ kind: "commands", commands: list, label, ...extra });
  const batch = (b: Batch, label: string, extra: Partial<CommandsOp> = {}) => ("error" in b ? (setMsg(b.error), false) : commands(b.commands, label, extra));
  const select = (ids: string[]) => setSelection(ids);
  const editing = useRef<HTMLElement | null>(null); // the text host being edited
  const gestures = useGestures({ canvas, live, editing, batch, setMsg });
  const { gesture } = gestures;
  // E3 §3 "Thêm": after the selected node (a section root: last inside it), one batch; a drag's release click never inserts
  const insert = (t: Template) => {
    if (gestures.consumeDrop()) return;
    const { index: ix, data: d, selection: sel } = live.current;
    const at = insertAt(ix, d?.interactives ?? [], sel[0]);
    if ("error" in at) return setMsg(at.error);
    batch(insertBatch(t, at), `Thêm ${t.label}`);
  };
  // spec §2: the deepest pickable node; Shift toggles it in the selection. flushSync: the overlay is drawn in the
  // same task as the click (§9 hiệu năng)
  const pick = (raw: string, shift: boolean) => {
    if (gestures.consumeDrop()) return;
    const target = pickTarget(live.current.index, raw);
    if (!target) return;
    flushSync(() => setSelection((s) => (shift ? (s.includes(target) ? s.filter((x) => x !== target) : [...s, target]) : [target])));
  };
  // spec §2 / R12: contenteditable on a text host; Enter or leaving it saves one batch, Esc cancels. Paste is plain
  // text (the canvas's capture listener). true = the node is a text host (editing, or refused with a message)
  const startEdit = (nid: string): boolean => {
    const { index: ix, data: d } = live.current;
    if (!live.current.editable) return true; // R9 view-only: a double click selects, never edits
    const e = ix.get(nid), el = canvas.current?.element(nid);
    if (!e || !el || !d || !isTextHost(e.node)) return false;
    const why = guard(ix, d.interactives, nid, "edit");
    if (why) { setMsg(why); return true; }
    if (editing.current?.isConnected) return true; // one edit at a time; a swapped-out host no longer counts
    const before = el.innerHTML; // the server's render: trusted
    editing.current = el;
    endEdit.current = () => finish(true);
    // Enter keeps the edit open on a refusal ("Esc để huỷ"); blur / Esc always end it
    const finish = (save: boolean, keepOnError = false) => {
      if (editing.current !== el) return;
      const node = live.current.index.get(nid)?.node;
      const b = save && node ? textBatch(node, el as unknown as DomLike) : undefined;
      if (b && "error" in b && keepOnError) { setMsg(b.error); return; }
      editing.current = null;
      endEdit.current = null;
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("blur", onBlur);
      el.removeAttribute("contenteditable");
      el.innerHTML = before; // the op's apply() draws the sanitized result over the server's render
      if (!b || !node) return;
      if ("error" in b) { setMsg(b.error); return; }
      if (!b.commands.length) return;
      let prev: string | null = null;
      const host = () => canvas.current?.element(nid) ?? null; // a partial update may have swapped the element
      run({
        kind: "commands", commands: b.commands, label: "Sửa chữ", keepSelection: true, // recreated children are #text / b / br: the host stays selected
        apply: () => { const h = host(); if (h) { prev = h.innerHTML; drawText(h, node, b.commands); } },
        rollback: () => { const h = host(); if (h && prev !== null) h.innerHTML = prev; },
      });
    };
    const onKeyDown = (k: KeyboardEvent) => {
      k.stopPropagation(); // the editor's shortcuts stay off while typing
      if (k.isComposing) return; // an IME (Vietnamese input) owns Enter / Esc mid-word
      if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); finish(true, true); }
      else if (k.key === "Escape") { k.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("blur", onBlur);
    el.contentEditable = "true";
    el.focus();
    // re-set the caret: a selection made while the host was not editable is not an editing one until it changes
    // (insertText from a paste would do nothing); the double-click's caret stays, else the end of the text
    const sel = el.ownerDocument.getSelection(), r = sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    if (sel && r) { sel.removeAllRanges(); sel.addRange(r); } else if (sel) { sel.selectAllChildren(el); sel.collapseToEnd(); }
    return true;
  };
  // R18: a text host starts inline editing; a container goes down to its first element child
  const double = (raw: string) => {
    const target = pickTarget(live.current.index, raw);
    if (!target || startEdit(target)) return;
    const child = live.current.index.get(target)?.children[0];
    if (child) select([child]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === " " && panKey(e.target)) { gestures.spaceKey(true); e.preventDefault(); return; } // Space+drag pans
    if (e.key === "Escape" && gestures.cancelGesture()) { e.preventDefault(); return; }
    if (e.key === "Escape" && narrow && drawer) { e.preventDefault(); closeDrawer(); return; }
    const action = keyAction(e, typingIn(e.target));
    if (!action) return;
    const { index: ix, selection: sel } = live.current, first = sel[0], comps = live.current.data?.interactives ?? [];
    switch (action) {
      case "undo": case "redo": { e.preventDefault(); run({ kind: action, label: action === "undo" ? "Hoàn tác" : "Làm lại" }); return; }
      case "delete": {
        if (!sel.length) return;
        e.preventDefault();
        if (batch(deleteBatch(ix, comps, sel), "Xoá")) setSelection([]);
        return;
      }
      case "duplicate": { if (!sel.length) return; e.preventDefault(); batch(duplicateBatch(ix, comps, sel), "Nhân bản"); return; }
      case "hide": {
        if (!sel.length) return;
        e.preventDefault();
        const all = sel.every((x) => ix.get(x)?.node.hidden);
        batch(hideBatch(ix, sel, !all), all ? "Hiện" : "Ẩn");
        return;
      }
      case "up": case "down": { if (!sel.length) return; e.preventDefault(); batch(reorderBatch(ix, comps, sel, action === "up" ? -1 : 1), "Đổi thứ tự"); return; }
      case "copy": {
        const at = e.target as Node, doc = at.ownerDocument ?? (at as Document);
        if (!first || doc.getSelection?.()?.isCollapsed === false) return; // highlighted text: the browser's own copy
        e.preventDefault();
        const c = copyClip(ix, first);
        if ("error" in c) return setMsg(c.error);
        clip.current = c;
        setMsg(`Đã sao chép ${c.count} phần tử`);
        return;
      }
      case "paste": { if (!clip.current) return; e.preventDefault(); batch(pasteBatch(ix, comps, clip.current, first), "Dán"); return; }
      case "parent": {
        e.preventDefault();
        if (live.current.open && (!first || first === live.current.open)) { setEditMain(null); return; } // R18: Esc at the instance root leaves
        const p = first ? parentOf(ix, first) : undefined;
        return select(p ? [p] : []);
      }
      case "child": { e.preventDefault(); const c = first ? ix.get(first)?.children[0] : undefined; if (c) select([c]); return; }
      case "siblings": { if (!first) return; e.preventDefault(); return select(siblingsOf(ix, first)); }
      // the browser's own page zoom prevented
      case "zoomIn": e.preventDefault(); setZoom((z) => zoomStep(z, 1)); return;
      case "zoomOut": e.preventDefault(); setZoom((z) => zoomStep(z, -1)); return;
      case "zoomReset": e.preventDefault(); setZoom(1); return;
      default: return;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") gestures.spaceKey(false); };
  const keyRef = useRef({ onKey, onKeyUp });
  keyRef.current = { onKey, onKeyUp };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current.onKey(e), up = (e: KeyboardEvent) => keyRef.current.onKeyUp(e);
    // another app took the focus (its Space keyup goes there); focus moving into the frame keeps hasFocus()
    const lost = () => { if (!document.hasFocus()) keyRef.current.onKeyUp(new KeyboardEvent("keyup", { key: " " })); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lost);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", lost); };
  }, []);
  // a drawer (≤ 1099px) takes the focus when it opens and gives it back to its toggle when it closes; not modal: the
  // canvas stays usable beside it
  const openDrawer = (side: "left" | "right") => { flushSync(() => setDrawer(side)); panels.current[side]?.focus({ preventScroll: true }); };
  const closeDrawer = () => { const side = drawer; setDrawer(null); if (side) toggles.current[side]?.focus(); };
  const drawerToggle = (side: "left" | "right", name: string) => (
    <IconButton icon={side === "left" ? "layers" : "edit"} label={`${drawer === side ? "Đóng" : "Mở"} ${name}`} aria-expanded={drawer === side} aria-controls={`ve-${side}`}
      ref={(b) => { toggles.current[side] = b; }} onClick={() => (drawer === side ? closeDrawer() : openDrawer(side))} />
  );
  // R9 transition to view-only, deliberately in this order: a drag in progress is cancelled (nothing sent); what was
  // typed while editable — a focused right-panel field (committed by its blur), the Style panel's pending (debounced)
  // fields, an open inline text — is saved now, while the gate is still open (one batch each). Then the gate closes:
  // from here on run() refuses every op. The Style drawer and the Thêm tab close (the focus, if it was there, goes to
  // the Layers toggle).
  useEffect(() => {
    if (!viewOnly) { setLocked(false); return; }
    const a = document.activeElement as HTMLElement | null;
    const inRight = !!a && (a === toggles.current.right || !!panels.current.right?.contains(a));
    gestures.cancelGesture();
    if (inRight) a.blur(); // a field that commits on blur (alt, href) commits now
    styleFlush.current?.();
    endEdit.current?.();
    live.current.editable = false; // closed now, not at the next render
    setEditMain(null); // R18: view-only leaves the edit-main mode (what was typed above went to the main)
    setLocked(true);
    if (inRight) toggles.current.left?.focus();
    setDrawer((d) => (d === "right" ? null : d));
    setLeft("layers");
  }, [viewOnly]); // gestures.cancelGesture and the refs only: no stale state
  useEffect(() => { if (!narrow) setDrawer(null); }, [narrow]); // wide again: the panels are columns
  // R18: the instance is gone -> leave; a selection in another instance of the same component moves the open instance
  // there (same main); any other selection outside it leaves
  useEffect(() => {
    if (editMain && !open) return setEditMain(null);
    if (!open || selection.every((sid) => ancestorsOf(raw, sid).includes(open))) return;
    const cmp = raw.get(open)!.node.component!.id, roots = new Set(selection.map((sid) => instanceRootOf(raw, sid)));
    const [next] = roots;
    setEditMain(roots.size === 1 && next && raw.get(next)!.node.component!.id === cmp ? next : null);
  }, [selection, open, editMain, raw]);
  // "Vừa khung": the breakpoint's width across the pane (R8)
  const fit = () => { const w = canvas.current?.pane()?.clientWidth; if (w) setZoom(fitZoom(w, bp)); };

  // the selection boxes follow layout changes that resize nothing in the frame (a Style Manager preview, a padding or
  // width change): watch the selected elements' size and inline style (E3a Task 9 carry)
  useEffect(() => {
    const els = selection.slice(0, BAND_LIMIT).flatMap((sid) => canvas.current?.element(sid) ?? []); // bounded
    const w = els[0]?.ownerDocument.defaultView;
    if (!w) return;
    const bump = () => setTick((t) => t + 1);
    const ro = new w.ResizeObserver(bump), mo = new w.MutationObserver(bump);
    for (const el of els) { ro.observe(el); mo.observe(el, { attributes: true, attributeFilter: ["style"] }); }
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [selection, data]);

  const showItems = (data?.interactives ?? []).flatMap((c) => (c.spec.kind === "carousel" || c.spec.kind === "tabs" ? [{ root: c.rootId, index: c.spec.active }] : []));
  const reload = () => { setHalt(null); setMsg(""); refetch(); };
  // measured on every render the selection, hover or frame (tick) changes: cheap getBoundingClientRect + computed style
  void tick;
  const measured = (nid: string) => { const el = canvas.current?.element(nid); return el ? measure(el) : undefined; };
  // margin / padding bands (one getComputedStyle each) only for a small selection; a big one gets its boxes alone
  const spacing = selection.length <= BAND_LIMIT;
  const selectedBoxes = selection.flatMap((sid) => { const el = canvas.current?.element(sid), m = el && measure(el, spacing); return m ? [{ id: sid, m }] : []; });
  const parentId = selection.length === 1 ? parentOf(index, selection[0]!) : undefined;
  const parentBox = parentId ? measured(parentId) : undefined;
  const hoverId = hover ? pickTarget(index, hover) : undefined;
  const hoverM = hoverId ? measured(hoverId) : undefined;
  // R13 / Task 8 decision: absolute and fixed nodes get all 8 handles, others (sticky too: in flow) e / s / se
  const handleEl = selection.length === 1 && editable ? canvas.current?.element(selection[0]!) : null;
  const handles = handleEl ? (() => {
    const pos = handleEl.ownerDocument.defaultView!.getComputedStyle(handleEl).position, gap = gestures.gapOf(selection[0]!);
    return { id: selection[0]!, list: handlesFor(pos === "absolute" || pos === "fixed"), onHandle: gestures.startResize, onSpacing: gestures.startSpacing, ...(gap && { gap: gap.box }) };
  })() : undefined;
  const mainBox = open ? measured(open) : undefined;
  const hoverInfo = hoverId && hoverM ? { id: hoverId, m: hoverM, label: `${index.get(hoverId)!.node.tag} · ${labelOf(index.get(hoverId)!)} · ${Math.round(hoverM.box.w)}×${Math.round(hoverM.box.h)}` } : undefined;
  return (
    <div className="ve">
      <div className="editor-toolbar" data-ui="ui_editor_toolbar">
        <label className="inline-field">
          <span className="field-label">Trang</span>
          <select value={data?.page.id ?? ""} onChange={(e) => { refetch(); setPageId(e.target.value); }} disabled={pending > 0 || loading}>
            {data?.pages.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
          </select>
        </label>
        <SegmentedControl<string> label="Thiết bị" data-ui="ui_editor_bp_switch" value={String(bp)} onChange={(v) => setBp(Number(v) as Bp)} options={BPS.map((w) => ({ value: String(w), label: String(w) }))} />
        <div className="ve-zoom" data-ui="ui_editor_zoom" role="group" aria-label="Zoom">
          <IconButton icon="zoom_out" label="Thu nhỏ" onClick={() => setZoom((z) => zoomStep(z, -1))} disabled={zoom <= ZOOM.min} />
          {/* a span, not <output>: its implicit role "status" would be a second one beside the editor message */}
          <span className="t-label-md" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <IconButton icon="zoom_in" label="Phóng to" onClick={() => setZoom((z) => zoomStep(z, 1))} disabled={zoom >= ZOOM.max} />
          <IconButton icon="fit_screen" label="Vừa khung" onClick={fit} />
        </div>
        <IconButton icon="undo" label="Hoàn tác" onClick={() => run({ kind: "undo", label: "Hoàn tác" })} disabled={!data?.canUndo || !!halt || loading || !editable} />
        <IconButton icon="redo" label="Làm lại" onClick={() => run({ kind: "redo", label: "Làm lại" })} disabled={!data?.canRedo || !!halt || loading || !editable} />
        <span className="t-label-md text-2" data-ui="ui_editor_save_state" aria-live="polite">{pending > 0 ? "Đang lưu…" : "Đã lưu"}</span>
        <span role="status" className="t-label-md text-2">{msg}</span>
        <span className="ve-drawer-toggle" data-ui="ui_editor_drawer_toggle">
          {drawerToggle("left", "Layers")}
          {editable && drawerToggle("right", "bảng Style")}
        </span>
        {saved && <Link href={`/p/${id}/preview`}>Mở Preview</Link>}
      </div>
      {!editable && <Banner tone="info" icon="phone_iphone" data-ui="ui_editor_viewonly_notice" title={VIEW_ONLY}>Ở màn hình này chỉ xem và chọn phần tử.</Banner>}
      {halt && (
        <Banner tone={halt.kind === "stale" ? "warn" : "danger"} icon="warning" data-ui="ui_editor_stale_banner" title={halt.text}
          actions={halt.kind === "failed"
            ? <Button icon="refresh" onClick={() => { setHalt(null); bus.current?.retry(); }}>Thử lại</Button>
            : <Button icon="refresh" onClick={reload}>{halt.kind === "stale" ? "Tải lại" : "Thử lại"}</Button>} />
      )}
      <div className="ve-grid">
        <aside id="ve-left" ref={(el) => { panels.current.left = el; }} tabIndex={-1} className={`ve-left panel${drawer === "left" ? " is-open" : ""}`} data-ui="ui_editor_layers" aria-label="Layers">
          <SegmentedControl<"layers" | "insert"> label="Bảng bên trái" semantics="tabs" data-ui="ui_editor_left_tabs" value={left} onChange={setLeft}
            options={editable ? [{ value: "layers", label: "Layers" }, { value: "insert", label: "Thêm" }] : [{ value: "layers", label: "Layers" }]} />
          {left === "insert" && editable && <InsertPanel onInsert={insert} onDragStart={gestures.startInsert} />}
          {left === "layers" && data && <LayerTree key={data.page.id} index={index} rootId={bodyOf(data.page)} rootLabel={`Trang ${data.pages.find((p) => p.id === data.page.id)?.path ?? data.page.file}`} components={data.interactives} selection={selection} onSelect={select} onBatch={(b, label) => batch(b, label)} editable={editable} />}
          {left === "layers" && data && (
            <Card title="Section" variant="section" data-ui="ui_editor_sections_panel">
              <p className="t-body-sm text-2">Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung.</p>
              <ul className="editor-sections">
                {data.allSections.map((s) => (
                  <li key={s.id}>
                    <label className="check">
                      <input type="checkbox" checked={picked.includes(s.id)} onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />
                      <span className="mono">{s.name}</span> <span className="text-3">{data.pages.find((p) => p.id === s.pageId)?.path}</span>
                      {s.layoutId && <Badge tone="primary">Layout chung</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
              <Button onClick={() => { if (commands([{ op: "promoteLayout", sectionIds: picked }], "Gộp layout", { done: "Đã gộp thành layout chung" })) setPicked([]); }} disabled={picked.length < 2 || pending > 0 || !editable}>Gộp thành layout</Button>
            </Card>
          )}
        </aside>
        <div className="ve-center">
        {open && (
          <div className="ve-main-bar" data-ui="ui_editor_edit_main_bar">
            <Icon name="widgets" size={16} />
            <span className="t-body-sm">Đang sửa main component — thay đổi áp cho mọi instance chưa override thuộc tính đó.</span>
            <Button onClick={() => setEditMain(null)}>Xong</Button>
          </div>
        )}
        {data ? (
          <Canvas ref={canvas} frameKey={load} html={data.page.html} css={data.css} width={bp} zoom={zoom} showItems={showItems}
            onPick={pick} onDouble={double} onHover={(h, a) => { setHover(h); setAlt(a); }} onKey={onKey} onKeyUp={onKeyUp} onPress={gestures.onPress}
            onZoomWheel={(dy) => setZoom((z) => wheelZoom(z, dy))} onFrame={() => setTick((t) => t + 1)}>
            <Overlay zoom={zoom} hover={hoverInfo} selected={selectedBoxes} parent={parentBox} handles={handles} frame={mainBox}>
              {(gesture?.kind === "flow" || gesture?.kind === "insert") && gesture.drop && (
                <div className={`ve-drop${gesture.drop.ok ? "" : " is-bad"}`} data-ui="ui_editor_drop_indicator" style={at(gesture.drop.box, zoom)}>
                  {!gesture.drop.ok && <span className="ve-label">{gesture.drop.reason}</span>}
                </div>
              )}
              {gesture?.kind === "free" && gesture.guides.map((g, i) => (
                <div key={i} className="ve-guide" data-ui="ui_editor_guides" style={g.axis === "x" ? at({ x: g.at, y: g.from, w: 0, h: g.to - g.from }, zoom) : at({ x: g.from, y: g.at, w: g.to - g.from, h: 0 }, zoom)} />
              ))}
              {alt && hoverInfo && selectedBoxes.length === 1 && hoverInfo.id !== selectedBoxes[0]!.id && gaps(selectedBoxes[0]!.m.box, hoverInfo.m.box).map((g, i) => (
                <div key={i} className="ve-measure" style={at({ x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) }, zoom)}>
                  <span className="ve-label" data-ui="ui_editor_measure">{g.value}</span>
                </div>
              ))}
            </Overlay>
          </Canvas>
        ) : <div className="ve-pane" data-ui="ui_editor_canvas_chrome" />}
        </div>
        <aside id="ve-right" ref={(el) => { panels.current.right = el; }} tabIndex={-1} className={`ve-right panel${drawer === "right" ? " is-open" : ""}`} aria-label="Bảng Style">
          {editable && <>
          <SegmentedControl<RightTab> label="Bảng bên phải" semantics="tabs" data-ui="ui_editor_right_tabs" value={tab} onChange={setTab}
            options={[{ value: "style", label: "Style" }, { value: "component", label: "Component" }, { value: "effects", label: "Hiệu ứng" }]} />
          {data && tab === "style" && (selection[0] && index.get(selection[0]) ? (<>
            <StylePanel key={selection[0]} node={index.get(selection[0])!.node} element={canvas.current?.element(selection[0]) ?? null} bp={bp} fonts={data.fonts} flushRef={styleFlush}
              onBatch={(b, label, extra) => batch(b, label, extra)} onMessage={setMsg} />
            <ElementPanel projectId={id} index={index} entry={index.get(selection[0])!} element={canvas.current?.element(selection[0]) ?? null} bp={bp} assets={data.assets} onBatch={batch}
              onUploaded={(a) => setData((d) => d && { ...d, assets: [a, ...d.assets.filter((x) => x.key !== a.key)] })} onMessage={setMsg} canEdit={() => live.current.editable}
              onEditMain={(r) => { setEditMain(r); setMsg("Đang sửa main component"); }} />
          </>) : <p className="t-body-sm text-2">Chọn một phần tử trên canvas hoặc trong Layers.</p>)}
          {/* the main's nodes have no component of their own here (toMain refuses component ops): Xong first */}
          {data && tab === "component" && open && <p className="t-body-sm text-2">Đang sửa main component — bấm Xong để dùng panel Component.</p>}
          {data && tab === "component" && !open && (
            <fieldset className="cmp-fieldset" disabled={pending > 0 || loading}>
              <ComponentPanel
                document={{ components: data.interactives, ancestors: selection[0] ? ancestorsOf(index, selection[0]) : [], outline: selection[0] ? outlineOf(index, selection[0]) : [], shot: data.shot }}
                selectedId={selection[0] ?? null} revision={data.revision}
                onCommands={(list) => commands(list, "Component", { done: "Đã cập nhật component — điểm QA cần chạy lại" })}
                onShow={(root, k) => canvas.current?.post(k < 0 ? { type: "aiwc:hide", root } : { type: "aiwc:show", root, index: k })} />
            </fieldset>
          )}
          {data && tab === "effects" && (
            <EffectsCard effects={data.effects} disabled={!selection[0]}
              onApply={(animation) => {
                const sid = live.current.selection[0];
                const why = sid ? guard(index, data.interactives, sid, "edit") : "Chọn một phần tử trên canvas trước.";
                if (why || !sid) return setMsg(why ?? "");
                commands([{ op: "setStyle", id: sid, target: styleTarget(bp), changes: { animation } }], "Hiệu ứng");
              }} />
          )}
          </>}
        </aside>
      </div>
      {gesture && <div className="ve-capture" {...gestures.capture} />}
    </div>
  );
}
