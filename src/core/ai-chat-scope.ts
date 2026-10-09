// E4 §2: what the editor's AI may touch (the sections holding the selection, else the whole page; never the shell,
// another page or a main) and what it reads (OUTLINE, node details, read-only tools). Pure over the stored document
// and its resolved view (R8: a canvas selection may be a generated `instance:` id; commands may only name stored ids).
import { pageSectionIds } from "./editor-canvas";
import type { ToolDef } from "./gateway";
import { aiPatchable, itemsOf, type InteractiveKind } from "./interactive";
import { resolveComponents } from "./ir-component";
import type { IRNodeV2, IRV2 } from "./ir-v2";

export const SCOPE_LIMITS = { outlineChars: 24_000, toolChars: 8_000, selected: 10, components: 50, findResults: 20, subtreeDepth: 4, lineText: 60, attrChars: 300 } as const;
export type ChatBp = 1440 | 768 | 375;
export type ChatScope = {
  pageId: string;
  sectionIds: string[];
  roots: string[];
  allowed: ReadonlySet<string>;
  nodes: ReadonlyMap<string, IRNodeV2>;
  parent: ReadonlyMap<string, string>;
  sectionOf: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
  shared: ReadonlyMap<string, number>;
  focus: string[];
  components: ReadonlyMap<string, InteractiveKind>;
};

const walk = (n: IRNodeV2, visit: (n: IRNodeV2, parent?: IRNodeV2) => void, parent?: IRNodeV2): void => {
  visit(n, parent);
  for (const c of n.children) walk(c, visit, n);
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cap = (s: string, n: number = SCOPE_LIMITS.toolChars) => clip(s, n);
const err = (message: string) => JSON.stringify({ error: message });

// The caller checked that the page exists.
export function chatScope(doc: IRV2, pageId: string, selection: readonly string[]): ChatScope {
  const resolved = new Map(resolveComponents(doc).sections.map((s) => [s.id, s]));
  const pageSections = pageSectionIds(doc, pageId).filter((sid) => resolved.has(sid));
  const home = new Map<string, string>();
  for (const sid of pageSections) walk(resolved.get(sid)!.root, (n) => home.set(n.id, sid));
  const picked = pageSections.filter((sid) => selection.some((id) => home.get(id) === sid));
  const sectionIds = picked.length ? picked : pageSections;
  const nodes = new Map<string, IRNodeV2>(), parent = new Map<string, string>(), sectionOf = new Map<string, string>(), names = new Map<string, string>(), shared = new Map<string, number>();
  const roots: string[] = [];
  for (const sid of sectionIds) {
    const s = resolved.get(sid)!;
    roots.push(s.root.id);
    names.set(sid, s.name);
    const layout = s.layoutId !== undefined ? doc.layouts.find((l) => l.id === s.layoutId) : undefined;
    shared.set(sid, layout?.pageIds.length ?? 1);
    walk(s.root, (n, p) => { nodes.set(n.id, n); sectionOf.set(n.id, sid); if (p) parent.set(n.id, p.id); });
  }
  const allowed = new Set<string>(), components = new Map<string, InteractiveKind>();
  const stored = new Map(doc.sections.map((s) => [s.id, s.root]));
  for (const sid of sectionIds) walk(stored.get(sid)!, (n) => { allowed.add(n.id); if (n.interactive) components.set(n.id, n.interactive.kind); });
  const focus = selection.filter((id) => nodes.has(id)).slice(0, SCOPE_LIMITS.selected);
  return { pageId, sectionIds, roots, allowed, nodes, parent, sectionOf, names, shared, focus, components };
}

// One OUTLINE line: id · tag · type · name · "text…" · W×H (+ flags).
export function nodeLine(scope: ChatScope, n: IRNodeV2, bp: ChatBp): string {
  const parts = [n.id, n.tag];
  if (n.tag !== "#text") parts.push(n.type);
  if (n.name) parts.push(n.name);
  const text = n.tag === "#text" ? n.text?.replace(/\s+/g, " ").trim() : undefined;
  if (text) parts.push(JSON.stringify(clip(text, SCOPE_LIMITS.lineText)));
  const box = n.box?.[bp] ?? n.box?.[1440];
  if (box) parts.push(`${Math.round(box[2])}×${Math.round(box[3])}`);
  if (n.hidden) parts.push("ẩn");
  if (n.interactive) parts.push(`component ${n.interactive.kind}`);
  if (!scope.allowed.has(n.id)) parts.push("chỉ đọc (thuộc main)");
  const sid = scope.sectionOf.get(n.id);
  if (sid !== undefined && scope.roots.includes(n.id)) {
    const k = scope.shared.get(sid) ?? 1;
    parts.push(`section ${JSON.stringify(scope.names.get(sid) ?? sid)}${k > 1 ? ` · dùng chung ${k} trang` : ""}`);
  }
  return parts.join(" · ");
}

const kidsOf = (scope: ChatScope, id: string) => scope.nodes.get(id)?.children.map((c) => c.id) ?? [];
const depthOf = (scope: ChatScope, id: string) => { let d = 0; for (let p = scope.parent.get(id); p !== undefined; p = scope.parent.get(p)) d++; return d; };

function render(scope: ChatScope, bp: ChatBp, id: string, depth: number, shown: (id: string) => boolean, lines: string[], maxDepth = Infinity): void {
  lines.push(`${"  ".repeat(depth)}${nodeLine(scope, scope.nodes.get(id)!, bp)}`);
  const kids = kidsOf(scope, id);
  const visible = depth + 1 > maxDepth ? [] : kids.filter(shown);
  for (const k of visible) render(scope, bp, k, depth + 1, shown, lines, maxDepth);
  if (kids.length > visible.length) lines.push(`${"  ".repeat(depth + 1)}… +${kids.length - visible.length} con`);
}

// E4 §2 OUTLINE: priority = ancestors of the focus, the focus and its siblings, its subtree, then the rest (breadth
// first); a node only goes in under an included parent; what does not fit folds into "… +N con" (lines are about maxChars).
export function outlineText(scope: ChatScope, bp: ChatBp, maxChars: number): string {
  const order: string[] = [], seen = new Set<string>();
  const add = (id: string | undefined) => { if (id !== undefined && scope.nodes.has(id) && !seen.has(id)) { seen.add(id); order.push(id); } };
  const bfs = (starts: string[]) => { const q = [...starts]; for (let i = 0; i < q.length; i++) { add(q[i]); q.push(...kidsOf(scope, q[i]!)); } };
  for (const f of scope.focus) { const up: string[] = []; for (let p = scope.parent.get(f); p !== undefined; p = scope.parent.get(p)) up.unshift(p); up.forEach(add); }
  for (const f of scope.focus) { add(f); const p = scope.parent.get(f); if (p !== undefined) kidsOf(scope, p).forEach(add); }
  bfs(scope.focus.flatMap((f) => kidsOf(scope, f)));
  bfs(scope.roots);
  const included = new Set<string>();
  let used = 0;
  for (const id of order) {
    const p = scope.parent.get(id);
    if (p !== undefined && !included.has(p)) continue;
    const len = depthOf(scope, id) * 2 + nodeLine(scope, scope.nodes.get(id)!, bp).length + 1;
    if (used + len > maxChars) continue;
    included.add(id);
    used += len;
  }
  const lines: string[] = [];
  for (const r of scope.roots) if (included.has(r)) render(scope, bp, r, 0, (id) => included.has(id), lines);
  return lines.join("\n");
}

const SECRET = (n: IRNodeV2, name: string) => /^on/i.test(name) || name === "srcdoc" || (name === "value" && n.tag === "input" && n.attrs.type?.toLowerCase() === "password");
const safeAttrs = (n: IRNodeV2): Record<string, string> =>
  Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !SECRET(n, k)).map(([k, v]) => [k, clip(v, SCOPE_LIMITS.attrChars)]));

function interactiveView(scope: ChatScope, n: IRNodeV2) {
  const spec = n.interactive!;
  const config = Object.fromEntries(aiPatchable(spec.kind).filter((k) => k in spec).map((k) => [k, (spec as unknown as Record<string, unknown>)[k]]));
  return { kind: spec.kind, config, items: itemsOf(spec, (x) => scope.parent.get(x), n.id).map((i) => i.id) };
}

// E4 §2 SELECTED / readNode: every style target, safe attrs, text, component; JSON, cut at maxChars.
export function nodeDetail(scope: ChatScope, id: string, maxChars: number = SCOPE_LIMITS.toolChars): string {
  const n = scope.nodes.get(id);
  if (!n) return err(`${clip(id, 80)} không thuộc phạm vi`);
  return cap(JSON.stringify({
    id: n.id, tag: n.tag, type: n.type, ...(n.name && { name: n.name }), ...(n.hidden && { hidden: true }),
    editable: scope.allowed.has(n.id), ...(n.text !== undefined && { text: n.text }),
    attrs: safeAttrs(n), styles: n.styles,
    ...(n.component && { component: n.component }),
    ...(n.interactive && { interactive: interactiveView(scope, n) }),
    children: n.children.map((c) => c.id),
  }), maxChars);
}

// COMPONENTS: the stored interactive roots in scope with their AI fields and item ids (<= 50).
export function componentList(scope: ChatScope): { id: string; kind: InteractiveKind; config: Record<string, unknown>; items: string[] }[] {
  return [...scope.components.keys()].slice(0, SCOPE_LIMITS.components).flatMap((id) => {
    const n = scope.nodes.get(id);
    return n?.interactive ? [{ id, ...interactiveView(scope, n) }] : [];
  });
}

const idParam = { type: "string", description: "node id from OUTLINE" };
export const CHAT_TOOLS: ToolDef[] = [
  { name: "readNode", description: "Read one node of the scope in full: styles of every target, attributes, text, component.", parameters: { type: "object", properties: { id: idParam }, required: ["id"] } },
  { name: "readSubtree", description: "Outline of a node's subtree (depth 1-4, default 2).", parameters: { type: "object", properties: { id: idParam, depth: { type: "integer", minimum: 1, maximum: 4 } }, required: ["id"] } },
  { name: "findText", description: "Up to 20 text nodes of the scope whose text contains the query (case-insensitive).", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

export function callChatTool(scope: ChatScope, bp: ChatBp, name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "readNode": return nodeDetail(scope, str("id"));
    case "readSubtree": {
      const id = str("id");
      if (!scope.nodes.has(id)) return err(`${clip(id, 80)} không thuộc phạm vi`);
      const depth = Math.min(Math.max(Math.trunc(Number(a.depth)) || 2, 1), SCOPE_LIMITS.subtreeDepth);
      const lines: string[] = [];
      render(scope, bp, id, 0, () => true, lines, depth);
      return cap(lines.join("\n"));
    }
    case "findText": {
      const q = str("query").trim().toLowerCase();
      if (!q) return err("query rỗng");
      const hits: { id: string; text: string; readOnly?: true }[] = [];
      for (const n of scope.nodes.values()) {
        if (hits.length >= SCOPE_LIMITS.findResults) break;
        if (n.tag === "#text" && n.text?.toLowerCase().includes(q)) hits.push({ id: n.id, text: clip(n.text.replace(/\s+/g, " ").trim(), SCOPE_LIMITS.attrChars), ...(!scope.allowed.has(n.id) && { readOnly: true as const }) });
      }
      return cap(JSON.stringify(hits));
    }
    default: return err(`không có tool ${clip(name, 40)}`);
  }
}
