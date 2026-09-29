// Editor command core over IR v2 (E1 spec §2). Pure: no random/Date/I/O. A batch applies in order or not at all,
// and returns the exact inverse (reverse order) plus the root IDs it created. New IDs come only from
// prepareCommands' server allocator, never from client/AI input.
import type { Decl } from "./dedupe";
import { AppError, Codes } from "./errors";
import { syncSections, type IR } from "./ir";
import { typeOf, type IRNodeV2, type IRV2, type NodeStyles, type NodeType } from "./ir-v2";
import { CSS_PROP, isSafeAttr, isSafeCss, tagSchema } from "./safe-names";

export const COMMAND_LIMITS = { commands: 50, nodes: 500, depth: 20, stepBytes: 8 * 1024 * 1024 } as const;

export type StyleTarget = "base" | 768 | 375 | "hover" | "focus" | "active" | "before" | "after";
export type NodeDraft = {
  tag: string;
  type?: NodeType;
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
  hidden?: boolean;
  styles?: Partial<NodeStyles>;
  children?: NodeDraft[];
};
type Edit =
  | { op: "setStyle"; id: string; target: StyleTarget; changes: Record<string, string | null> }
  | { op: "setText"; id: string; text: string }
  | { op: "setAttribute"; id: string; name: string; value: string | null }
  | { op: "moveNode"; id: string; parentId: string; index: number }
  | { op: "deleteNode"; id: string };
export type EditorCommand =
  | Edit
  | { op: "createNode"; parentId: string; index: number; draft: NodeDraft }
  | { op: "duplicateNode"; id: string; parentId: string; index: number };
export type NormalizedCommand =
  | Edit
  | { op: "createNode"; parentId: string; index: number; node: IRNodeV2 }
  | { op: "duplicateNode"; id: string; parentId: string; index: number; newIds: string[] }; // preorder of the copy

// Private inverse payloads: produced here, stored by History, never accepted by prepareCommands.
type NodeProps = Omit<IRNodeV2, "id" | "parentId" | "children">;
type Refs = { sectionIds: string[][]; layouts: IRV2["layouts"]; sections: { index: number; section: IRV2["sections"][number] }[] };
type Plain = NormalizedCommand | { op: "restoreProps"; id: string; props: NodeProps } | { op: "restoreNode"; parentId: string; index: number; node: IRNodeV2 };
export type HistoryCommand = Plain | { op: "restoreRefs"; command: Plain; refs: Refs };

type Fail = (message: string) => never;
type Tree = { kind: "sections" | "pages" | "components"; index: number };
type Found = { tree: Tree; node: IRNodeV2; parent: IRNodeV2 | undefined; index: number };
type Step = { ir: IRV2; inverse: HistoryCommand; created?: string };

const NODE_TYPES = new Set<NodeType>(["container", "text", "image", "link", "button", "input", "media", "svg", "component-root"]);
const NODE_KEYS = new Set(["id", "parentId", "tag", "type", "name", "attrs", "text", "hidden", "styles", "children"]);
const STYLE_GROUPS = { bp: ["768", "375"], state: ["hover", "focus", "active"], pseudo: ["before", "after"] } as const;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const failer = (i: number, command: unknown): Fail => (message) => {
  const op = isObject(command) && typeof command.op === "string" ? command.op.slice(0, 40) : "?";
  throw new AppError(Codes.IR_PATCH_INVALID, `command ${i} (${op}): ${message}`, { index: i, op });
};
const checkBatch = (commands: readonly unknown[]): void => {
  if (!Array.isArray(commands) || commands.length === 0) throw new AppError(Codes.IR_PATCH_INVALID, "empty command batch");
  if (commands.length > COMMAND_LIMITS.commands) throw new AppError(Codes.IR_PATCH_INVALID, `too many commands: ${commands.length} > ${COMMAND_LIMITS.commands}`);
};

// --- trees: every node lives in exactly one section root, page shell or component main ---
const treesOf = (ir: IRV2): Tree[] => [
  ...ir.sections.map((_, index) => ({ kind: "sections" as const, index })),
  ...ir.pages.map((_, index) => ({ kind: "pages" as const, index })),
  ...ir.components.map((_, index) => ({ kind: "components" as const, index })),
];
const rootOf = (ir: IRV2, t: Tree): IRNodeV2 => (t.kind === "pages" ? ir.pages[t.index]!.shell : ir[t.kind][t.index]!.root);
function withRoot(ir: IRV2, t: Tree, root: IRNodeV2): IRV2 {
  if (t.kind === "pages") { const pages = ir.pages.slice(); pages[t.index] = { ...pages[t.index]!, shell: root }; return { ...ir, pages }; }
  if (t.kind === "sections") { const sections = ir.sections.slice(); sections[t.index] = { ...sections[t.index]!, root }; return { ...ir, sections }; }
  const components = ir.components.slice();
  components[t.index] = { ...components[t.index]!, root };
  return { ...ir, components };
}
const sameTree = (a: Tree, b: Tree) => a.kind === b.kind && a.index === b.index;

function find(ir: IRV2, id: unknown): Found | undefined {
  if (typeof id !== "string") return undefined;
  const search = (node: IRNodeV2, parent: IRNodeV2 | undefined, index: number): Omit<Found, "tree"> | undefined => {
    if (node.id === id) return { node, parent, index };
    for (let i = 0; i < node.children.length; i++) {
      const hit = search(node.children[i]!, node, i);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const tree of treesOf(ir)) {
    const hit = search(rootOf(ir, tree), undefined, 0);
    if (hit) return { tree, ...hit };
  }
  return undefined;
}
const need = (ir: IRV2, id: unknown, fail: Fail, what = "node"): Found => find(ir, id) ?? fail(`${what} not found: ${String(id).slice(0, 200)}`);

const preorder = (node: IRNodeV2, out: IRNodeV2[] = []): IRNodeV2[] => { out.push(node); node.children.forEach((c) => preorder(c, out)); return out; };
const allIds = (ir: IRV2): Set<string> => new Set(treesOf(ir).flatMap((t) => preorder(rootOf(ir, t)).map((n) => n.id)));

// Path-copying replace of the node with `id`; undefined when not in this subtree.
function update(node: IRNodeV2, id: string, edit: (n: IRNodeV2) => IRNodeV2): IRNodeV2 | undefined {
  if (node.id === id) return edit(node);
  for (let i = 0; i < node.children.length; i++) {
    const child = update(node.children[i]!, id, edit);
    if (!child) continue;
    const children = node.children.slice();
    children[i] = child;
    return { ...node, children };
  }
  return undefined;
}
const splice = (list: IRNodeV2[], index: number, remove: number, ...add: IRNodeV2[]) => { const out = list.slice(); out.splice(index, remove, ...add); return out; };
const withParent = (node: IRNodeV2, parentId: string): IRNodeV2 => ({ ...node, parentId, children: node.children.map((c) => withParent(c, node.id)) });

// The subtree a command creates, moves, deletes, copies or restores (not its host tree): bounded and well-formed.
function checkSubtree(root: unknown, fail: Fail): void {
  let count = 0;
  const visit = (n: unknown, depth: number): void => {
    if (++count > COMMAND_LIMITS.nodes || depth > COMMAND_LIMITS.depth) fail(`subtree limit exceeded (${COMMAND_LIMITS.nodes} nodes, ${COMMAND_LIMITS.depth} levels)`);
    if (!isObject(n) || typeof n.id !== "string" || !n.id || typeof n.tag !== "string" || !isObject(n.attrs) ||
        !isObject(n.styles) || !Array.isArray(n.children)) fail("invalid node payload");
    (n as { children: unknown[] }).children.forEach((c) => visit(c, depth + 1));
  };
  visit(root, 1);
}
const SHELL_ONLY_PLACEHOLDERS = "a page shell only allows moving or deleting section placeholders";
const checkParent = (parent: IRNodeV2, fail: Fail) => {
  if (parent.tag === "#text" || parent.tag === "#section") fail(`parent cannot have children: ${parent.id}`);
};
const checkIndex = (index: unknown, length: number, fail: Fail) => {
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > length) fail(`index out of range 0..${length}`);
};
const checkFreshIds = (ir: IRV2, ids: unknown[], fail: Fail) => {
  const taken = allIds(ir), seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id || id.length > 200) fail("invalid new node id");
    if (taken.has(id as string) || seen.has(id as string)) fail(`duplicate node id: ${id as string}`);
    seen.add(id as string);
  }
};

// --- validation of new content ---
function checkDecl(decl: unknown, fail: Fail): void {
  if (!isObject(decl)) fail("style map must be an object");
  for (const [prop, value] of Object.entries(decl as object)) if (!isSafeCss(prop, value)) fail(`unsafe CSS declaration: ${prop.slice(0, 80)}`);
}
function checkStyles(styles: unknown, fail: Fail): void {
  if (!isObject(styles)) fail("styles must be an object");
  const s = styles as Record<string, unknown>;
  checkDecl(s.base, fail);
  for (const [group, keys] of Object.entries(STYLE_GROUPS)) {
    if (!isObject(s[group])) fail(`styles.${group} must be an object`);
    for (const [key, decl] of Object.entries(s[group] as object)) {
      if (!(keys as readonly string[]).includes(key)) fail(`invalid style target: ${group}.${key.slice(0, 20)}`);
      checkDecl(decl, fail);
    }
  }
  if (Object.keys(s).some((k) => k !== "base" && !(k in STYLE_GROUPS))) fail("unknown styles key");
}
// A created node (normalized, with IDs): safe tag/type/attrs/CSS, text only on #text, no component/box/behavior.
function checkNewNode(node: unknown, fail: Fail, depth = 1, count = { value: 0 }): void {
  if (++count.value > COMMAND_LIMITS.nodes || depth > COMMAND_LIMITS.depth) fail(`subtree limit exceeded (${COMMAND_LIMITS.nodes} nodes, ${COMMAND_LIMITS.depth} levels)`);
  if (!isObject(node)) fail("node must be an object");
  const n = node as Record<string, unknown>;
  const key = Object.keys(n).find((k) => !NODE_KEYS.has(k));
  if (key) fail(`field not allowed on a new node: ${key.slice(0, 40)}`);
  if (typeof n.tag !== "string" || !tagSchema.safeParse(n.tag).success) fail(`tag not allowed: ${String(n.tag).slice(0, 40)}`);
  if (!NODE_TYPES.has(n.type as NodeType)) fail(`invalid node type: ${String(n.type).slice(0, 40)}`);
  if (!isObject(n.attrs) || !Array.isArray(n.children)) fail("attrs and children are required");
  for (const [name, value] of Object.entries(n.attrs as object)) if (!isSafeAttr(n.tag as string, name, value)) fail(`attribute not allowed: ${name.slice(0, 80)}`);
  checkStyles(n.styles, fail);
  if (n.name !== undefined && typeof n.name !== "string") fail("name must be a string");
  if (n.hidden !== undefined && typeof n.hidden !== "boolean") fail("hidden must be a boolean");
  if (n.tag === "#text") {
    if (typeof n.text !== "string" || (n.children as unknown[]).length || Object.keys(n.attrs as object).length) fail("#text needs text and no attrs/children");
  } else if (n.text !== undefined) fail("text belongs in a #text child");
  for (const child of n.children as unknown[]) checkNewNode(child, fail, depth + 1, count);
}

// --- property commands ---
function styleTarget(target: unknown, fail: Fail): ["base"] | ["bp" | "state" | "pseudo", string] {
  if (target === "base") return ["base"];
  if (target === 768 || target === 375) return ["bp", String(target)];
  for (const group of ["state", "pseudo"] as const) if ((STYLE_GROUPS[group] as readonly unknown[]).includes(target)) return [group, target as string];
  return fail("invalid style target");
}
function setStyle(styles: NodeStyles, target: unknown, changes: unknown, fail: Fail): NodeStyles {
  const [group, key] = styleTarget(target, fail);
  if (!isObject(changes)) fail("changes must be an object");
  const slots = group === "base" ? undefined : (styles[group] as Record<string, Decl>);
  const decl: Decl = { ...(slots ? slots[key!] : styles.base) };
  for (const [prop, value] of Object.entries(changes as object)) {
    if (value === null && CSS_PROP.test(prop)) delete decl[prop];
    else if (isSafeCss(prop, value)) decl[prop] = value;
    else fail(`unsafe CSS declaration: ${prop.slice(0, 80)}`);
  }
  if (!slots) return { ...styles, base: decl };
  const next = { ...slots };
  if (Object.keys(decl).length) next[key!] = decl; else delete next[key!]; // an empty override is no override
  return { ...styles, [group]: next };
}
function applyProps(ir: IRV2, c: Extract<Plain, { op: "setStyle" | "setText" | "setAttribute" | "restoreProps" }>, fail: Fail): Step {
  const found = need(ir, c.id, fail);
  const { id, parentId, children, ...old } = found.node;
  let props: NodeProps;
  if (c.op === "restoreProps") props = c.props;
  else if (found.node.tag === "#section") return fail("section placeholders are edited through their section");
  else if (c.op === "setText") {
    if (found.node.tag !== "#text") fail("setText needs a #text node");
    if (typeof c.text !== "string") fail("text must be a string");
    props = { ...old, text: c.text };
  } else if (found.node.tag === "#text") return fail(`${c.op} on a #text node`);
  else if (c.op === "setAttribute") {
    const attrs = { ...found.node.attrs };
    if (typeof c.name !== "string") fail("attribute name must be a string");
    if (c.value === null) delete attrs[c.name]; // removal is always safe
    else if (isSafeAttr(found.node.tag, c.name, c.value)) attrs[c.name] = c.value;
    else fail(`attribute not allowed: ${c.name.slice(0, 80)}`);
    props = { ...old, attrs };
  } else props = { ...old, styles: setStyle(found.node.styles, c.target, c.changes, fail) };
  const node: IRNodeV2 = { ...props, id, children, ...(parentId !== undefined && { parentId }) };
  return { ir: withRoot(ir, found.tree, update(rootOf(ir, found.tree), id, () => node)!), inverse: { op: "restoreProps", id, props: old } };
}

// --- tree commands (one tree each: a node never changes owner) ---
function insert(ir: IRV2, parentId: unknown, index: unknown, node: IRNodeV2, fail: Fail): { ir: IRV2; tree: Tree } {
  const parent = need(ir, parentId, fail, "parent");
  checkParent(parent.node, fail);
  checkIndex(index, parent.node.children.length, fail);
  checkFreshIds(ir, preorder(node).map((n) => n.id), fail);
  const pid = parent.node.id;
  const root = update(rootOf(ir, parent.tree), pid, (p) => ({ ...p, children: splice(p.children, index as number, 0, withParent(node, pid)) }))!;
  return { ir: withRoot(ir, parent.tree, root), tree: parent.tree };
}
function applyTree(ir: IRV2, c: Extract<Plain, { op: "createNode" | "restoreNode" | "moveNode" | "deleteNode" | "duplicateNode" }>, fail: Fail): Step & { tree: Tree } {
  if (c.op === "createNode" || c.op === "restoreNode") {
    if (c.op === "createNode") checkNewNode(c.node, fail);
    else checkSubtree(c.node, fail);
    // restoreNode in a shell only undoes a placeholder delete
    if (find(ir, c.parentId)?.tree.kind === "pages" && (c.op === "createNode" || c.node.tag !== "#section")) fail(SHELL_ONLY_PLACEHOLDERS);
    const done = insert(ir, c.parentId, c.index, c.node, fail);
    return { ...done, inverse: { op: "deleteNode", id: c.node.id }, ...(c.op === "createNode" && { created: c.node.id }) };
  }
  const found = need(ir, c.id, fail);
  const { node, parent, tree } = found;
  if (!parent) return fail(`tree root is protected: ${node.id}`);
  if (tree.kind === "pages" && (c.op === "duplicateNode" || node.tag !== "#section")) fail(SHELL_ONLY_PLACEHOLDERS);
  checkSubtree(node, fail);
  if (c.op === "deleteNode") {
    const root = update(rootOf(ir, tree), parent.id, (p) => ({ ...p, children: splice(p.children, found.index, 1) }))!;
    return { ir: withRoot(ir, tree, root), tree, inverse: { op: "restoreNode", parentId: parent.id, index: found.index, node } };
  }
  const target = need(ir, c.parentId, fail, "parent");
  if (!sameTree(tree, target.tree)) fail("nodes cannot move across section/shell/main boundaries");
  checkParent(target.node, fail);
  if (c.op === "duplicateNode") {
    const source = preorder(node);
    if (source.some((n) => n.tag === "#section")) fail("section placeholders cannot be duplicated");
    if (source.some((n) => n.component)) fail("component nodes cannot be duplicated yet");
    if (!Array.isArray(c.newIds) || c.newIds.length !== source.length) fail("newIds must match the copied subtree");
    const next = c.newIds.values();
    // a copy was never captured: no box; parentIds are re-stamped by insert
    const copy = ({ box: _box, ...n }: IRNodeV2): IRNodeV2 => ({ ...n, id: next.next().value as string, children: n.children.map(copy) });
    const created = copy(node);
    return { ...insert(ir, c.parentId, c.index, created, fail), inverse: { op: "deleteNode", id: created.id }, created: created.id };
  }
  // moveNode: the index counts after the node is lifted out of its current parent.
  if (preorder(node).some((n) => n.id === target.node.id)) fail("cannot move a node into itself (cycle)");
  const lifted = update(rootOf(ir, tree), parent.id, (p) => ({ ...p, children: splice(p.children, found.index, 1) }))!;
  const length = target.node.id === parent.id ? parent.children.length - 1 : target.node.children.length;
  checkIndex(c.index, length, fail);
  const root = update(lifted, target.node.id, (p) => ({ ...p, children: splice(p.children, c.index, 0, { ...node, parentId: p.id }) }))!;
  return { ir: withRoot(ir, tree, root), tree, inverse: { op: "moveNode", id: node.id, parentId: parent.id, index: found.index } };
}

// --- section references (shell edits) ---
// syncSections only reads shells/sections/layouts, which IR v2 shares with v1.
const sync = (ir: IRV2): IRV2 => syncSections(ir as unknown as IR) as unknown as IRV2;
function refsBetween(before: IRV2, after: IRV2): Refs {
  const kept = new Set(after.sections.map((s) => s.id));
  return {
    sectionIds: before.pages.map((p) => p.sectionIds),
    layouts: before.layouts,
    sections: before.sections.map((section, index) => ({ index, section })).filter(({ section }) => !kept.has(section.id)),
  };
}
function withRefs(ir: IRV2, refs: Refs, fail: Fail): IRV2 {
  if (!isObject(refs) || !Array.isArray(refs.sectionIds) || refs.sectionIds.length !== ir.pages.length) return fail("invalid section references");
  const sections = ir.sections.slice();
  for (const { index, section } of refs.sections) {
    if (sections.some((s) => s.id === section.id)) fail(`section already exists: ${section.id}`);
    sections.splice(index, 0, section);
  }
  return { ...ir, sections, layouts: refs.layouts, pages: ir.pages.map((p, i) => ({ ...p, sectionIds: refs.sectionIds[i]! })) };
}

function applyOne(ir: IRV2, c: HistoryCommand, fail: Fail): Step {
  if (!isObject(c)) return fail("command must be an object");
  switch (c.op) {
    case "setStyle": case "setText": case "setAttribute": case "restoreProps":
      return applyProps(ir, c, fail);
    case "createNode": case "restoreNode": case "moveNode": case "deleteNode": case "duplicateNode": {
      const step = applyTree(ir, c, fail);
      if (step.tree.kind !== "pages") return step;
      const synced = sync(step.ir);
      return { ...step, ir: synced, inverse: { op: "restoreRefs", command: step.inverse as Plain, refs: refsBetween(ir, synced) } };
    }
    case "restoreRefs": {
      if (!isObject(c.command) || (c.command as { op: unknown }).op === "restoreRefs") return fail("invalid restore");
      const step = applyOne(ir, c.command, fail);
      const done = withRefs(step.ir, c.refs, fail);
      const inner = step.inverse.op === "restoreRefs" ? step.inverse.command : step.inverse;
      return { ...step, ir: done, inverse: { op: "restoreRefs", command: inner, refs: refsBetween(ir, done) } };
    }
    default:
      return fail("unknown command");
  }
}

// Server side: allocates every new node ID (create + duplicate), validating the batch against the evolving IR.
export function prepareCommands(ir: IRV2, commands: EditorCommand[], allocateId: () => string): NormalizedCommand[] {
  checkBatch(commands);
  let current = ir;
  return commands.map((command, i) => {
    const fail = failer(i, command);
    if (!isObject(command)) return fail("command must be an object");
    let normalized: NormalizedCommand;
    switch (command.op) {
      case "setStyle": normalized = { op: command.op, id: command.id, target: command.target, changes: command.changes }; break;
      case "setText": normalized = { op: command.op, id: command.id, text: command.text }; break;
      case "setAttribute": normalized = { op: command.op, id: command.id, name: command.name, value: command.value }; break;
      case "moveNode": normalized = { op: command.op, id: command.id, parentId: command.parentId, index: command.index }; break;
      case "deleteNode": normalized = { op: command.op, id: command.id }; break;
      case "createNode": normalized = { op: command.op, parentId: command.parentId, index: command.index, node: fromDraft(command.draft, allocateId, fail) }; break;
      case "duplicateNode": {
        const source = need(current, command.id, fail);
        normalized = { op: command.op, id: command.id, parentId: command.parentId, index: command.index, newIds: preorder(source.node).map(() => allocateId()) };
        break;
      }
      default: return fail("unknown command");
    }
    current = applyOne(current, normalized, fail).ir;
    return normalized;
  });
}
// Copies only the known draft fields (any client-sent id is dropped); checkNewNode validates the values.
function fromDraft(draft: unknown, allocateId: () => string, fail: Fail, depth = 1, count = { value: 0 }): IRNodeV2 {
  if (++count.value > COMMAND_LIMITS.nodes || depth > COMMAND_LIMITS.depth) fail(`subtree limit exceeded (${COMMAND_LIMITS.nodes} nodes, ${COMMAND_LIMITS.depth} levels)`);
  if (!isObject(draft) || typeof draft.tag !== "string") return fail("draft needs a tag");
  if (draft.children !== undefined && !Array.isArray(draft.children)) fail("draft children must be an array");
  if (draft.styles !== undefined && !isObject(draft.styles)) fail("draft styles must be an object");
  const { tag, type, name, attrs, text, hidden, styles, children, id: _id, parentId: _parent, ...rest } = draft as NodeDraft & { id?: unknown; parentId?: unknown };
  const s = styles ?? {};
  const node: IRNodeV2 = {
    ...(rest as object), // unknown fields (component/box/behavior…) are kept so checkNewNode refuses them
    id: allocateId(), tag, type: type ?? typeOf(tag), attrs: attrs ?? {},
    styles: { base: s.base ?? {}, bp: s.bp ?? {}, state: s.state ?? {}, pseudo: s.pseudo ?? {}, ...omit(s, ["base", "bp", "state", "pseudo"]) },
    children: [],
  };
  if (name !== undefined) node.name = name;
  if (text !== undefined) node.text = text;
  if (hidden !== undefined) node.hidden = hidden;
  node.children = (children ?? []).map((child) => ({ ...fromDraft(child, allocateId, fail, depth + 1, count), parentId: node.id }));
  return node;
}
const omit = (o: object, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export function applyCommands(ir: IRV2, commands: readonly HistoryCommand[]): { ir: IRV2; inverse: HistoryCommand[]; createdIds: string[] } {
  checkBatch(commands);
  let current = ir;
  const inverse: HistoryCommand[] = [], createdIds: string[] = [];
  commands.forEach((command, i) => {
    const step = applyOne(current, command, failer(i, command));
    current = step.ir;
    inverse.unshift(step.inverse);
    if (step.created) createdIds.push(step.created);
  });
  const bytes = new TextEncoder().encode(JSON.stringify(commands)).length + new TextEncoder().encode(JSON.stringify(inverse)).length;
  if (bytes > COMMAND_LIMITS.stepBytes) throw new AppError(Codes.IR_PATCH_INVALID, "history step exceeds 8 MB");
  return { ir: current, inverse, createdIds };
}
