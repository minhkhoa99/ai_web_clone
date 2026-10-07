// E3 client model (pure: no DOM, no React — unit-tested in node): the page tree the editor shows, the layer rows,
// the selection rules and the command batches user actions become. Server rules are mirrored only to answer early
// in Vietnamese (spec §2 "Bảo vệ"); the server judges every command again.
import type { CanvasPage } from "@/core/editor-canvas";
import type { PanelComponent } from "@/core/interactive";
import type { EditorCommand, NodeDraft, StyleTarget } from "@/core/ir-command";
import type { IRNodeV2, NodeStyles } from "@/core/ir-v2";
import { isSafeAttr, isSafeCss, tagSchema } from "@/core/safe-names";

export type Bp = 1440 | 768 | 375;
export const BPS: readonly Bp[] = [1440, 768, 375];
// mirrors COMMAND_LIMITS (ir-command imports server modules; the unit test pins the values)
export const LIMITS = { batch: 50, clipboard: 500, depth: 20 } as const;
export const GENERATED = "instance:"; // resolveComponents' view-only ids of a main's nodes inside an instance
export const ROW_HEIGHT = 24;
export const MAX_ROWS = 200;
export type Batch = { commands: EditorCommand[] } | { error: string };
export type Entry = {
  node: IRNodeV2;
  parent?: string; // the node commands move it within: its IR parent, or (a section root) its placeholder's shell parent
  subject: string; // the id tree commands name: the node, or a section root's placeholder
  index: number; // the subject's index in `parent`'s IR children
  depth: number;
  children: string[]; // element children shown (placeholders as their section roots, no #text)
  sectionId?: string;
  sectionName?: string; // only on a section root
  layout?: boolean;
  shell: boolean; // a page-shell node: only placeholders move or go there
  hidden: boolean; // the node or an ancestor is hidden
};
export type DocIndex = Map<string, Entry>;
export type Row = { id: string; depth: number; label: string; type: IRNodeV2["type"]; section: boolean; hasChildren: boolean; open: boolean; hidden: boolean; dimmed: boolean; role?: "main" | "instance"; kind?: string };
export type Zone = "before" | "after" | "inside";
export type Box = { x: number; y: number; w: number; h: number };
export type Clip = { draft: NodeDraft; count: number };
export type KeyAction = "undo" | "redo" | "delete" | "duplicate" | "hide" | "copy" | "paste" | "up" | "down" | "child" | "parent" | "siblings";

const GEN_MSG = "Phần tử này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach).";
const INSTANCE_MSG = "Cấu trúc bên trong instance lấy từ main — sửa ở main hoặc Tách khỏi component (Detach).";
const SHELL_MSG = "Khung trang (shell) chỉ cho đổi thứ tự hoặc xoá section.";
const KIND_VI: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const TYPE_VI: Record<IRNodeV2["type"], string> = { container: "Khung", text: "Chữ", image: "Ảnh", link: "Link", button: "Nút", input: "Ô nhập", media: "Media", svg: "SVG", "component-root": "Component" };
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
const INLINE = new Set(["#text", "b", "i", "strong", "em", "a", "br", "span", "small", "code", "u", "s", "sub", "sup"]);

export function indexPage(page: Pick<CanvasPage, "shell" | "sections">): DocIndex {
  const index: DocIndex = new Map();
  const sections = new Map(page.sections.map((s) => [s.id, s]));
  const visit = (node: IRNodeV2, parent: string | undefined, i: number, depth: number, section: string | undefined, hidden: boolean): string | undefined => {
    let entry: Entry, kids: IRNodeV2[], sid = section;
    if (node.tag === "#section") {
      const s = sections.get(node.attrs["data-section"] ?? "");
      if (!s) return undefined;
      entry = { node: s.root, parent, subject: node.id, index: i, depth, children: [], sectionId: s.id, sectionName: s.name, layout: s.layoutId !== undefined, shell: false, hidden: hidden || !!s.root.hidden };
      kids = s.root.children;
      sid = s.id;
    } else {
      entry = { node, parent, subject: node.id, index: i, depth, children: [], shell: section === undefined, hidden: hidden || !!node.hidden, ...(section !== undefined && { sectionId: section }) };
      kids = node.children;
    }
    index.set(entry.node.id, entry);
    kids.forEach((c, k) => {
      const id = visit(c, entry.node.id, k, depth + 1, sid, entry.hidden);
      if (id && c.tag !== "#text") entry.children.push(id);
    });
    return entry.node.id;
  };
  visit(page.shell, undefined, 0, 0, undefined, false);
  return index;
}
export const bodyOf = (page: Pick<CanvasPage, "shell">): string => page.shell.children.find((c) => c.tag === "body")?.id ?? page.shell.id;

const firstText = (n: IRNodeV2): string | undefined => (n.tag === "#text" ? n.text?.trim() || undefined : n.children.map(firstText).find(Boolean));
export function labelOf(e: Entry): string {
  if (e.node.name) return e.node.name;
  if (e.sectionName !== undefined) return e.sectionName;
  const text = firstText(e.node);
  return text ? `${TYPE_VI[e.node.type]} ${text.slice(0, 30)}` : `${TYPE_VI[e.node.type]} <${e.node.tag}>`;
}
export function ancestorsOf(index: DocIndex, id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at !== undefined && index.has(at); at = index.get(at)!.parent) out.push(at);
  return out;
}
const inside = (index: DocIndex, id: string, root: string) => ancestorsOf(index, id).includes(root);

export function layerRows(index: DocIndex, rootId: string, open: ReadonlySet<string>, query: string, components: readonly PanelComponent[]): Row[] {
  const q = query.trim().toLowerCase();
  const kinds = new Map(components.map((c) => [c.rootId, c.spec.kind as string]));
  let keep: Set<string> | undefined;
  if (q) {
    keep = new Set();
    for (const [id, e] of index) if (e.node.tag !== "#text" && (labelOf(e).toLowerCase().includes(q) || (firstText(e.node) ?? "").toLowerCase().includes(q))) for (const a of ancestorsOf(index, id)) keep.add(a);
  }
  const rows: Row[] = [];
  const walk = (id: string, depth: number): void => {
    const e = index.get(id);
    if (!e || (keep && !keep.has(id))) return;
    const isOpen = keep ? true : open.has(id);
    rows.push({
      id, depth, label: labelOf(e), type: e.node.type, section: e.sectionName !== undefined, hasChildren: e.children.length > 0, open: isOpen,
      hidden: !!e.node.hidden, dimmed: e.hidden, ...(e.node.component && { role: e.node.component.role }), ...(kinds.has(id) && { kind: kinds.get(id) }),
    });
    if (isOpen) for (const c of e.children) walk(c, depth + 1);
  };
  walk(rootId, 0);
  return rows;
}
export function rowWindow(total: number, scrollTop: number, height: number, overscan = 10): { start: number; end: number } {
  const start = Math.max(0, Math.min(total, Math.floor(scrollTop / ROW_HEIGHT) - overscan));
  return { start, end: Math.min(total, start + Math.min(MAX_ROWS, Math.ceil(height / ROW_HEIGHT) + 2 * overscan)) };
}
// the four bands of a margin (outside the border box) or a padding (inside it): top, right, bottom, left
export function bands(box: Box, [t, r, b, l]: readonly [number, number, number, number], insideBox: boolean): Box[] {
  const o = insideBox ? box : { x: box.x - l, y: box.y - t, w: box.w + l + r, h: box.h + t + b };
  return [{ x: o.x, y: o.y, w: o.w, h: t }, { x: o.x + o.w - r, y: o.y + t, w: r, h: o.h - t - b }, { x: o.x, y: o.y + o.h - b, w: o.w, h: b }, { x: o.x, y: o.y + t, w: l, h: o.h - t - b }];
}

const pageRoot = (e: Entry) => e.shell && (e.node.tag === "html" || e.node.tag === "body");
// spec §2: the deepest node under the pointer, never a #text, a hidden node (or inside one) or html/body
export function pickTarget(index: DocIndex, id: string): string | undefined {
  for (const a of ancestorsOf(index, id)) {
    const e = index.get(a)!;
    if (e.hidden || pageRoot(e)) return undefined;
    if (e.node.tag !== "#text") return a;
  }
  return undefined;
}
export function parentOf(index: DocIndex, id: string): string | undefined {
  const p = index.get(id)?.parent;
  return p !== undefined && !pageRoot(index.get(p)!) ? p : undefined;
}
export function siblingsOf(index: DocIndex, id: string): string[] {
  const p = index.get(id)?.parent;
  return p === undefined ? [id] : index.get(p)!.children.filter((c) => !index.get(c)!.hidden);
}
export function topMost(index: DocIndex, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestorsOf(index, id).slice(1).some((a) => set.has(a)));
}
export function isTextHost(node: IRNodeV2): boolean {
  const inline = (c: IRNodeV2): boolean => INLINE.has(c.tag) && c.children.every(inline);
  return node.tag !== "#text" && node.children.some((c) => c.tag === "#text" && (c.text ?? "").trim() !== "") && node.children.every(inline);
}

function roleOwner(index: DocIndex, components: readonly PanelComponent[], id: string): PanelComponent | undefined {
  return components.find((c) => !inside(index, c.rootId, id) && c.members.some((m) => index.has(m) && inside(index, m, id)));
}
const holdsComponent = (n: IRNodeV2): boolean => !!n.component || n.children.some(holdsComponent);
export function guard(index: DocIndex, components: readonly PanelComponent[], id: string, op: "delete" | "move" | "duplicate" | "edit"): string | undefined {
  const e = index.get(id);
  if (!e) return "Không tìm thấy phần tử (trang vừa đổi) — tải lại.";
  if (id.startsWith(GENERATED)) return GEN_MSG;
  if (op === "edit") return undefined;
  if (e.shell) return SHELL_MSG;
  if (e.parent !== undefined && index.get(e.parent)!.node.component?.role === "instance") return INSTANCE_MSG;
  if (op === "duplicate") {
    if (e.sectionName !== undefined) return "Chưa nhân bản được cả section.";
    if (holdsComponent(e.node)) return "Chưa nhân bản được phần tử thuộc component (main/instance).";
    return undefined;
  }
  const owner = roleOwner(index, components, id);
  if (owner) return `Phần tử là một phần của ${KIND_VI[owner.spec.kind]} — dùng panel Component (Lên/Xuống, Xoá, Bỏ hành vi).`;
  return undefined;
}
export function guardParent(index: DocIndex, components: readonly PanelComponent[], parentId: string): string | undefined {
  const p = index.get(parentId);
  if (!p) return "Không tìm thấy vị trí thả.";
  if (parentId.startsWith(GENERATED) || p.node.component?.role === "instance") return INSTANCE_MSG;
  if (p.shell) return "Không thả phần tử vào khung trang (shell).";
  if (p.node.tag === "#text" || VOID.has(p.node.tag)) return `Phần tử <${p.node.tag}> không chứa con được.`;
  if (components.some((c) => c.spec.kind === "carousel" && c.spec.track === parentId)) return "Đây là track của carousel — thêm slide bằng nút Thêm trong panel Component.";
  return undefined;
}
const capped = (commands: EditorCommand[]): Batch =>
  commands.length === 0 ? { error: "Chưa chọn phần tử." } : commands.length > LIMITS.batch ? { error: `Tối đa ${LIMITS.batch} lệnh mỗi thao tác — chọn ít phần tử hơn.` } : { commands };
const first = (index: DocIndex, components: readonly PanelComponent[], ids: string[], op: "delete" | "move" | "duplicate") => {
  for (const id of ids) { const why = guard(index, components, id, op); if (why) return why; }
  return undefined;
};

export function deleteBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "delete");
  return why ? { error: why } : capped(top.map((id) => ({ op: "deleteNode", id: index.get(id)!.subject })));
}
// later siblings first: the earlier indexes stay right while the batch inserts copies
export function duplicateBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "duplicate");
  if (why) return { error: why };
  const order = [...top].sort((a, b) => index.get(b)!.index - index.get(a)!.index);
  return capped(order.map((id) => { const e = index.get(id)!; return { op: "duplicateNode", id: e.subject, parentId: e.parent!, index: e.index + 1 }; }));
}
// R9: the hidden flag + display:none on the base rule (show: display dropped only when the base hides it)
export function hideBatch(index: DocIndex, ids: readonly string[], hidden: boolean): Batch {
  const commands: EditorCommand[] = [];
  for (const id of topMost(index, ids)) {
    const e = index.get(id);
    if (!e) return { error: "Không tìm thấy phần tử." };
    if (id.startsWith(GENERATED)) return { error: GEN_MSG };
    if (pageRoot(e)) return { error: "Không ẩn được khung trang." };
    commands.push({ op: "setHidden", id, hidden });
    if (hidden) commands.push({ op: "setStyle", id, target: "base", changes: { display: "none" } });
    else if (e.node.styles.base.display === "none") commands.push({ op: "setStyle", id, target: "base", changes: { display: null } });
  }
  return capped(commands);
}
// moveNode's index counts after lifting: ±1 lands next to the neighbour; moving down goes last-first, up first-first
export function reorderBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[], delta: -1 | 1): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "move");
  if (why) return { error: why };
  const order = [...top].sort((a, b) => (index.get(a)!.index - index.get(b)!.index) * -delta);
  const commands: EditorCommand[] = [];
  for (const id of order) {
    const e = index.get(id)!, count = index.get(e.parent!)!.node.children.length, to = e.index + delta;
    if (to >= 0 && to < count) commands.push({ op: "moveNode", id: e.subject, parentId: e.parent!, index: to });
  }
  return commands.length ? capped(commands) : { error: "Đã ở đầu / cuối danh sách." };
}
export function dropCommand(index: DocIndex, components: readonly PanelComponent[], dragId: string, overId: string, zone: Zone): Batch {
  const drag = index.get(dragId), over = index.get(overId);
  if (!drag || !over) return { error: "Không tìm thấy phần tử." };
  if (drag.sectionName !== undefined) { // a section row: reorder its placeholder among the others
    if (over.sectionName === undefined || zone === "inside") return { error: "Section chỉ đổi thứ tự với section khác." };
    let at = over.index + (zone === "after" ? 1 : 0);
    if (drag.parent === over.parent && drag.index < at) at -= 1;
    return { commands: [{ op: "moveNode", id: drag.subject, parentId: over.parent!, index: at }] }; // placeholders may sit in different shell parents
  }
  const why = guard(index, components, dragId, "move");
  if (why) return { error: why };
  const parentId = zone === "inside" ? over.node.id : over.sectionName !== undefined ? undefined : over.parent;
  if (parentId === undefined) return { error: "Thả vào trong section, không đặt cạnh section." };
  const parentWhy = guardParent(index, components, parentId);
  if (parentWhy) return { error: parentWhy };
  if (inside(index, parentId, dragId)) return { error: "Không thả phần tử vào chính nó." };
  if (index.get(parentId)!.sectionId !== drag.sectionId) return { error: "Chưa chuyển được phần tử sang section khác." }; // R11 (E3b lifts it)
  let at = zone === "inside" ? over.node.children.length : over.index + (zone === "after" ? 1 : 0);
  if (parentId === drag.parent && drag.index < at) at -= 1;
  return { commands: [{ op: "moveNode", id: drag.subject, parentId, index: at }] };
}

// R19: a draft checkNewNode accepts — no ids, no box/component/interactive/behavior, unsafe subtrees/attrs/CSS left out
const cleanDecl = (d: Record<string, string> | undefined) => Object.fromEntries(Object.entries(d ?? {}).filter(([p, v]) => isSafeCss(p, v)));
const cleanStyles = (s: NodeStyles): NodeStyles => ({
  base: cleanDecl(s.base),
  bp: Object.fromEntries(Object.entries(s.bp).map(([k, d]) => [k, cleanDecl(d)])),
  state: Object.fromEntries(Object.entries(s.state).map(([k, d]) => [k, cleanDecl(d)])),
  pseudo: Object.fromEntries(Object.entries(s.pseudo).map(([k, d]) => [k, cleanDecl(d)])),
});
export function copyClip(index: DocIndex, id: string): Clip | { error: string } {
  const e = index.get(id);
  if (!e) return { error: "Không tìm thấy phần tử." };
  if (e.shell) return { error: "Không sao chép khung trang (shell)." };
  let count = 0, deep = false;
  const draftOf = (n: IRNodeV2, depth: number): NodeDraft | null => {
    if (n.tag === "#section" || !tagSchema.safeParse(n.tag).success) return null;
    count++;
    if (depth > LIMITS.depth) deep = true;
    if (n.tag === "#text") return { tag: "#text", text: n.text ?? "" };
    const d: NodeDraft = { tag: n.tag, ...(n.type !== "component-root" && { type: n.type }), attrs: Object.fromEntries(Object.entries(n.attrs).filter(([k, v]) => isSafeAttr(n.tag, k, v))), styles: cleanStyles(n.styles), children: n.children.map((c) => draftOf(c, depth + 1)).filter((c): c is NodeDraft => c !== null) };
    if (n.name) d.name = n.name;
    if (n.hidden) d.hidden = true;
    return d;
  };
  const draft = draftOf(e.node, 1);
  if (!draft) return { error: `Không sao chép được <${e.node.tag}>.` };
  if (count > LIMITS.clipboard) return { error: `Clipboard tối đa ${LIMITS.clipboard} phần tử (phần tử này có ${count}).` };
  if (deep) return { error: `Clipboard tối đa ${LIMITS.depth} tầng.` };
  return { draft, count };
}
// right after the node in its parent; after a section root: at the end inside it
export function insertAt(index: DocIndex, components: readonly PanelComponent[], afterId: string | undefined): { parentId: string; index: number } | { error: string } {
  const e = afterId ? index.get(afterId) : undefined;
  if (!e) return { error: "Chọn một phần tử để chèn / dán sau nó." };
  const [parentId, at] = e.sectionName !== undefined ? [e.node.id, e.node.children.length] : [e.parent, e.index + 1];
  if (parentId === undefined) return { error: SHELL_MSG };
  const why = guardParent(index, components, parentId);
  return why ? { error: why } : { parentId, index: at };
}
export function pasteBatch(index: DocIndex, components: readonly PanelComponent[], clip: Clip, afterId: string | undefined): Batch {
  const at = insertAt(index, components, afterId);
  return "error" in at ? at : { commands: [{ op: "createNode", parentId: at.parentId, index: at.index, draft: clip.draft }] };
}
export function renameBatch(index: DocIndex, id: string, name: string): Batch {
  if (id.startsWith(GENERATED)) return { error: GEN_MSG };
  const trimmed = name.trim();
  if (!index.has(id)) return { error: "Không tìm thấy phần tử." };
  if (trimmed.length < 1 || trimmed.length > 80) return { error: "Tên cần 1–80 ký tự." };
  return { commands: [{ op: "setName", id, name: trimmed }] };
}
export const styleTarget = (bp: Bp, state?: "hover" | "focus" | "active"): StyleTarget => state ?? (bp === 1440 ? "base" : bp);

export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, typing: boolean): KeyAction | undefined {
  if (typing) return undefined;
  const mod = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && key === "z") return e.shiftKey ? "redo" : "undo";
  if (mod && key === "y") return "redo";
  if (mod && key === "d") return "duplicate";
  if (mod && key === "c") return "copy";
  if (mod && key === "v") return "paste";
  if (mod && key === "a") return "siblings";
  if (mod && key === "Enter") return "child";
  if (mod) return undefined;
  if (e.altKey && key === "ArrowUp") return "up";
  if (e.altKey && key === "ArrowDown") return "down";
  if (e.altKey) return undefined;
  if (key === "Delete") return "delete";
  if (key === "Escape") return "parent";
  if (key === "h") return "hide";
  return undefined;
}

// R13: an <img> loses its srcset and its <picture> sources show the same image; a <source> takes srcset; a background
// goes to the current breakpoint
export function imageBatch(index: DocIndex, id: string, kind: "img" | "source" | "background", key: string, bp: Bp): Batch {
  const e = index.get(id);
  if (!e) return { error: "Không tìm thấy phần tử." };
  if (id.startsWith(GENERATED)) return { error: GEN_MSG };
  if (kind === "background") return { commands: [{ op: "setStyle", id, target: styleTarget(bp), changes: { "background-image": `url("${key}")` } }] };
  if (kind === "source") return { commands: [{ op: "setAttribute", id, name: "srcset", value: key }] };
  const commands: EditorCommand[] = [{ op: "setAttribute", id, name: "src", value: key }];
  if (e.node.attrs.srcset !== undefined) commands.push({ op: "setAttribute", id, name: "srcset", value: null });
  const parent = e.parent !== undefined ? index.get(e.parent) : undefined;
  if (parent?.node.tag === "picture") for (const c of parent.node.children) if (c.tag === "source") commands.push({ op: "setAttribute", id: c.id, name: "srcset", value: key });
  return capped(commands);
}
// the Component panel's role choices: the node + descendants (≤ max), like the GrapesJS selectionOf
export function outlineOf(index: DocIndex, id: string, max = 100): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  const walk = (nid: string, depth: number): void => {
    const e = index.get(nid);
    if (!e || out.length >= max) return;
    out.push({ id: nid, label: `${e.node.tag} ${(firstText(e.node) ?? "").slice(0, 30)}`.trim(), depth });
    e.children.forEach((c) => walk(c, depth + 1));
  };
  walk(id, 0);
  return out;
}
