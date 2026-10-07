// E3 §2 inline text editing (pure, R12): the edited element's DOM, read through a minimal node interface (unit-tested
// without a browser), becomes the smallest batch — setText per changed #text when the inline structure is unchanged,
// else the element's children replaced by text + b / i / a / br in one batch (one Undo). Anything else is refused.
import type { EditorCommand, NodeDraft } from "@/core/ir-command";
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeAttr } from "@/core/safe-names";
import { GENERATED, LIMITS, type Batch } from "./model";

export type DomLike = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomLike>; getAttribute?(name: string): string | null };
type Inline = "b" | "i" | "a" | "br";
type Piece = { text: string } | { tag: string; node?: IRNodeV2; href?: string; children: Piece[] };
const RENAME: Record<string, Inline> = { B: "b", STRONG: "b", I: "i", EM: "i", A: "a", BR: "br" };
const SIMPLE = new Set<string>(["b", "i", "a", "br"]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE"]); // their text is code, not content
const ESC = "Không giữ được định dạng của đoạn này — chỉ sửa chữ, hoặc Esc để huỷ.";

// a[href] allowlist: http(s), mailto, tel, #anchor, relative and // paths. Whitespace/control chars are stripped
// before reading the scheme (browsers do), so "java\tscript:" / "DATA:" / "vbscript:" are all dropped.
const SCHEME = /^([a-z][a-z0-9+.-]*):/;
export const safeHref = (v: string): boolean => {
  const m = SCHEME.exec(v.replace(/[\u0000-\u0020]/g, "").toLowerCase());
  return !m || ["http", "https", "mailto", "tel"].includes(m[1]!);
};

// texts merged; b/strong -> b, i/em -> i, a (safe href), br; an element the IR has (data-ir-id, looked up only in the
// edited subtree) kept as that node; any other element unwrapped: pasted markup never reaches the document
function read(el: DomLike, known: ReadonlyMap<string, IRNodeV2>): Piece[] {
  const out: Piece[] = [];
  const add = (p: Piece) => {
    const last = out.at(-1);
    if ("text" in p && last && "text" in last) last.text += p.text;
    else if (!("text" in p) || p.text) out.push(p);
  };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) { add({ text: c.textContent ?? "" }); continue; }
    if (c.nodeType !== 1 || SKIP.has(c.nodeName)) continue;
    const id = c.getAttribute?.("data-ir-id") ?? undefined, own = id ? known.get(id) : undefined, tag = RENAME[c.nodeName];
    if (own) add({ tag: own.tag, node: own, children: read(c, known) });
    else if (tag) { const href = c.getAttribute?.("href") ?? undefined; add({ tag, ...(tag === "a" && href && safeHref(href) && isSafeAttr("a", "href", href) && { href }), children: tag === "br" ? [] : read(c, known) }); }
    else for (const p of read(c, known)) add(p);
  }
  return out;
}
// the IR's children as the DOM shows them: adjacent #text merged, empty ones dropped
type Item = { text: string; nodes: IRNodeV2[] } | { node: IRNodeV2; children: Item[] };
function items(n: IRNodeV2): Item[] {
  const out: Item[] = [];
  for (const c of n.children) {
    if (c.tag === "#text") {
      const last = out.at(-1);
      if (last && "text" in last) { last.text += c.text ?? ""; last.nodes.push(c); } else out.push({ text: c.text ?? "", nodes: [c] });
    } else out.push({ node: c, children: items(c) });
  }
  return out.filter((i) => !("text" in i) || i.text);
}
const shapeOfIr = (is: Item[]): string => is.map((i) => ("text" in i ? "#" : `<${i.node.id}>${shapeOfIr(i.children)}</>`)).join("");
const shapeOf = (ps: Piece[]): string => ps.map((p) => ("text" in p ? "#" : p.node ? `<${p.node.id}>${shapeOf(p.children)}</>` : "?")).join("");
const groups = (is: Item[], out: { text: string; nodes: IRNodeV2[] }[] = []) => { for (const i of is) { if ("text" in i) out.push(i); else groups(i.children, out); } return out; };
const texts = (ps: Piece[], out: string[] = []): string[] => { for (const p of ps) { if ("text" in p) out.push(p.text); else texts(p.children, out); } return out; };
const allIds = (n: IRNodeV2, out = new Map<string, IRNodeV2>()) => { for (const c of n.children) { out.set(c.id, c); allIds(c, out); } return out; };
// a kept node keeps its styles, type and every attribute that is still safe (its original is deleted in the same batch)
const keptAttrs = (n: IRNodeV2) => Object.fromEntries(Object.entries(n.attrs).filter(([k, v]) => isSafeAttr(n.tag, k, v) && (k !== "href" || safeHref(v))));
const draft = (p: Piece): NodeDraft =>
  "text" in p ? { tag: "#text", text: p.text }
  : p.node ? { tag: p.tag, type: p.node.type, attrs: keptAttrs(p.node), styles: p.node.styles, ...(p.node.hidden && { hidden: true }), children: p.children.map(draft) }
  : { tag: p.tag, attrs: p.tag === "a" && p.href ? { href: p.href } : {}, children: p.children.map(draft) };
const simpleOnly = (ps: Piece[]): boolean =>
  ps.every((p) => "text" in p || (SIMPLE.has(p.tag) && !(p.node && (p.node.interactive || p.node.component || p.node.behavior)) && simpleOnly(p.children)));

export function textBatch(ir: IRNodeV2, el: DomLike): Batch {
  const known = allIds(ir);
  if (ir.id.startsWith(GENERATED) || [...known.keys()].some((id) => id.startsWith(GENERATED))) return { error: "Chữ này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach)." };
  const pieces = read(el, known), irItems = items(ir), tooMany = (n: number) => n > LIMITS.batch;
  const over = { error: `Đoạn chữ cần hơn ${LIMITS.batch} lệnh — sửa từng phần, hoặc Esc để huỷ.` };
  if (shapeOf(pieces) === shapeOfIr(irItems)) {
    const before = groups(irItems), after = texts(pieces);
    if (before.every((g, k) => g.text === after[k])) return { commands: [] };
    if (before.every((g) => g.nodes.length === 1)) {
      const commands = before.flatMap((g, k): EditorCommand[] => (g.text === after[k] ? [] : [{ op: "setText", id: g.nodes[0]!.id, text: after[k]! }]));
      return tooMany(commands.length) ? over : { commands };
    }
  }
  if (ir.component?.role === "instance") return { error: "Đổi định dạng trong instance: sửa ở main hoặc Tách khỏi component (Detach)." };
  if (!simpleOnly(pieces)) return { error: ESC };
  const commands: EditorCommand[] = [
    ...ir.children.map((c): EditorCommand => ({ op: "deleteNode", id: c.id })),
    ...pieces.map((p, i): EditorCommand => ({ op: "createNode", parentId: ir.id, index: i, draft: draft(p) })),
  ];
  return tooMany(commands.length) ? over : { commands };
}
