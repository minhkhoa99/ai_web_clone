// E3 §2 inline text editing (pure, R12): the edited element's DOM, read through a minimal node interface (unit-tested
// without a browser), becomes the smallest batch — setText per changed #text when the inline structure is unchanged,
// else the element's children replaced by text + b / i / a / br in one batch (one Undo). Anything else is refused.
import type { EditorCommand, NodeDraft } from "@/core/ir-command";
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeAttr } from "@/core/safe-names";
import { GENERATED, LIMITS, type Batch } from "./model";

export type DomLike = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomLike>; getAttribute?(name: string): string | null };
type Inline = "b" | "i" | "a" | "br";
type Piece = { text: string } | { tag: string; id?: string; href?: string; children: Piece[] };
const RENAME: Record<string, Inline> = { B: "b", STRONG: "b", I: "i", EM: "i", A: "a", BR: "br" };
const SIMPLE = new Set<string>(["b", "i", "a", "br"]);

// texts merged; b/strong -> b, i/em -> i, a (safe href), br; an element the IR has (data-ir-id) kept with its own tag;
// any other element unwrapped: pasted or browser-inserted markup never reaches the document
function read(el: DomLike, known: ReadonlyMap<string, IRNodeV2>): Piece[] {
  const out: Piece[] = [];
  const add = (p: Piece) => {
    const last = out.at(-1);
    if ("text" in p && last && "text" in last) last.text += p.text;
    else if (!("text" in p) || p.text) out.push(p);
  };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) { add({ text: c.textContent ?? "" }); continue; }
    if (c.nodeType !== 1) continue;
    const id = c.getAttribute?.("data-ir-id") ?? undefined, own = id ? known.get(id) : undefined, tag = RENAME[c.nodeName];
    if (own) add({ tag: own.tag, id: own.id, ...(own.attrs.href !== undefined && { href: own.attrs.href }), children: read(c, known) });
    else if (tag) { const href = c.getAttribute?.("href") ?? undefined; add({ tag, ...(tag === "a" && href && isSafeAttr("a", "href", href) && { href }), children: tag === "br" ? [] : read(c, known) }); }
    else for (const p of read(c, known)) add(p);
  }
  return out;
}
const shapeOfIr = (n: IRNodeV2): string => n.children.map((c) => (c.tag === "#text" ? "#" : `<${c.id}>${shapeOfIr(c)}</>`)).join("");
const shapeOf = (ps: Piece[]): string => ps.map((p) => ("text" in p ? "#" : p.id ? `<${p.id}>${shapeOf(p.children)}</>` : "?")).join("");
const irTexts = (n: IRNodeV2, out: IRNodeV2[] = []): IRNodeV2[] => { for (const c of n.children) { if (c.tag === "#text") out.push(c); else irTexts(c, out); } return out; };
const texts = (ps: Piece[], out: string[] = []): string[] => { for (const p of ps) { if ("text" in p) out.push(p.text); else texts(p.children, out); } return out; };
const allIds = (n: IRNodeV2, out = new Map<string, IRNodeV2>()) => { for (const c of n.children) { out.set(c.id, c); allIds(c, out); } return out; };
const draft = (p: Piece): NodeDraft => ("text" in p ? { tag: "#text", text: p.text } : { tag: p.tag, attrs: p.tag === "a" && p.href ? { href: p.href } : {}, children: p.children.map(draft) });
const simpleOnly = (ps: Piece[]): boolean => ps.every((p) => "text" in p || (SIMPLE.has(p.tag) && simpleOnly(p.children)));

export function textBatch(ir: IRNodeV2, el: DomLike): Batch {
  const known = allIds(ir);
  if (ir.id.startsWith(GENERATED) || [...known.keys()].some((id) => id.startsWith(GENERATED))) return { error: "Chữ này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach)." };
  const pieces = read(el, known);
  if (shapeOf(pieces) === shapeOfIr(ir)) {
    const before = irTexts(ir), after = texts(pieces);
    return { commands: before.flatMap((node, k): EditorCommand[] => (node.text === after[k] ? [] : [{ op: "setText", id: node.id, text: after[k]! }])) };
  }
  if (ir.component?.role === "instance") return { error: "Đổi định dạng trong instance: sửa ở main hoặc Tách khỏi component (Detach)." };
  if (!simpleOnly(pieces)) return { error: "Không giữ được định dạng của đoạn này — chỉ sửa chữ, hoặc Esc để huỷ." };
  const commands: EditorCommand[] = [
    ...ir.children.map((c): EditorCommand => ({ op: "deleteNode", id: c.id })),
    ...pieces.map((p, i): EditorCommand => ({ op: "createNode", parentId: ir.id, index: i, draft: draft(p) })),
  ];
  return commands.length > LIMITS.batch ? { error: `Đoạn chữ cần hơn ${LIMITS.batch} lệnh — sửa từng phần, hoặc Esc để huỷ.` } : { commands };
}
