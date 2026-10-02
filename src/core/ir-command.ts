// Editor command core over IR v2 (E1 spec §2). Pure: no random/Date/I/O. A batch applies in order or not at all,
// and returns the exact inverse (reverse order) plus the root IDs it created. New IDs come only from
// prepareCommands' server allocator, never from client/AI input.
import type { Decl } from "./dedupe";
import { AppError, Codes } from "./errors";
import { promoteLayout, syncSections } from "./ir";
import { checkInteractives, INTERACTIVE_LIMITS, itemsOf, patchSpec, roleIndex, specFromRoles, withItem, withItemMoved, withoutItem, type InteractiveKind, type InteractiveSpec, type Item, type Role } from "./interactive";
import { detachComponent, isOverridePath, overridingInstance, resetOverride } from "./ir-component";
import { typeOf, type IRNodeV2, type IRV2, type NodeStyles, type NodeType } from "./ir-v2";
import { MAX_CAPTURE_NODES, MAX_TREE_DEPTH } from "./limit";
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
  | { op: "setHidden"; id: string; hidden: boolean }
  | { op: "promoteLayout"; sectionIds: string[] }
  | { op: "resetOverride"; instanceId: string; path?: string }
  | { op: "detachComponent"; instanceId: string }
  | { op: "updateComponent"; id: string; patch: Record<string, unknown> }
  | { op: "convertToComponent"; id: string; kind: InteractiveKind; roles: Record<string, unknown> }
  | { op: "unwrapComponent"; id: string }
  | { op: "removeComponentItem"; id: string; itemId: string }
  | { op: "moveComponentItem"; id: string; itemId: string; index: number }
  | { op: "moveNode"; id: string; parentId: string; index: number }
  | { op: "deleteNode"; id: string };
export type EditorCommand =
  | Edit
  | { op: "createNode"; parentId: string; index: number; draft: NodeDraft }
  | { op: "duplicateNode"; id: string; parentId: string; index: number }
  | { op: "addComponentItem"; id: string; from?: string; index: number }
  // AI aliases (E2 §6), carousel only: normalized to updateComponent / addComponentItem / removeComponentItem
  | { op: "updateCarousel"; id: string; patch: Record<string, unknown> }
  | { op: "addCarouselSlide"; id: string; from?: string; index: number }
  | { op: "removeCarouselSlide"; id: string; itemId: string };
export type NormalizedCommand =
  | Edit
  | { op: "createNode"; parentId: string; index: number; node: IRNodeV2 }
  | { op: "duplicateNode"; id: string; parentId: string; index: number; newIds: string[] } // preorder of the copy
  | { op: "addComponentItem"; id: string; from?: string; index: number; newIds: string[] }; // preorder of the copied item nodes

// Private inverse payloads: produced here, stored by History, never accepted by prepareCommands.
type NodeProps = Omit<IRNodeV2, "id" | "parentId" | "children">;
type Refs = { sectionIds: string[][]; layouts: IRV2["layouts"]; sections: { index: number; section: IRV2["sections"][number] }[]; instanceIds: string[][] };
type ComponentEdit = Extract<Edit, { op: "resetOverride" | "detachComponent" }>;
type Plain = NormalizedCommand | { op: "restoreProps"; id: string; props: NodeProps } | { op: "restoreNode"; parentId: string; index: number; node: IRNodeV2 };
export type HistoryCommand =
  | Plain
  | { op: "restoreRefs"; command: Plain; refs: Refs }
  | { op: "restoreLayout"; sectionIds: string[]; layoutId?: string; placeholders: [string, string][]; refs: Refs } // placeholder id -> old section
  | { op: "restoreComponent"; command: ComponentEdit; node: IRNodeV2; instanceIds?: string[][] } // the subtree before (+ refs on detach)
  | { op: "restoreSpec"; id: string; interactive?: InteractiveSpec; overrides?: string[] } // the spec + instance overrides before
  // an item edit: drop `remove`, put `insert` back at its places, give `order` parents their child order, set the spec
  | { op: "restoreItems"; id: string; interactive: InteractiveSpec; remove: string[]; insert: { parentId: string; index: number; node: IRNodeV2 }[]; order: { parentId: string; ids: string[] }[] };

type Fail = (message: string) => never;
type Tree = { kind: "sections" | "pages" | "components"; index: number };
type Found = { tree: Tree; node: IRNodeV2; parent: IRNodeV2 | undefined; index: number; depth: number }; // root depth 1
type Step = { ir: IRV2; inverse: HistoryCommand; created?: string };

const NODE_TYPES = new Set<NodeType>(["container", "text", "image", "link", "button", "input", "media", "svg", "component-root"]);
const NODE_KEYS = new Set(["id", "parentId", "tag", "type", "name", "attrs", "text", "hidden", "styles", "children"]);
const STYLE_GROUPS = { bp: ["768", "375"], state: ["hover", "focus", "active"], pseudo: ["before", "after"] } as const;
const TREE_OPS = new Set(["createNode", "restoreNode", "moveNode", "deleteNode", "duplicateNode"]);
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
  const search = (node: IRNodeV2, parent: IRNodeV2 | undefined, index: number, depth: number): Omit<Found, "tree"> | undefined => {
    if (node.id === id) return { node, parent, index, depth };
    for (let i = 0; i < node.children.length; i++) {
      const hit = search(node.children[i]!, node, i, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const tree of treesOf(ir)) {
    const hit = search(rootOf(ir, tree), undefined, 0, 1);
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
  // an instance's structure comes from its main (Figma-style): its children are not edited in place
  if (parent.component?.role === "instance") fail(`structural edit inside component instance ${parent.id}: edit the main or detach first`);
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
function applyProps(ir: IRV2, c: Extract<Plain, { op: "setStyle" | "setText" | "setAttribute" | "setHidden" | "restoreProps" }>, fail: Fail): Step {
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
  else if (c.op === "setHidden") {
    if (typeof c.hidden !== "boolean") fail("hidden must be a boolean");
    if (found.tree.kind === "pages" && (found.node.tag === "html" || found.node.tag === "body")) fail(`the page ${found.node.tag} cannot be hidden`);
    const { hidden: _hidden, ...shown } = old;
    props = c.hidden ? { ...shown, hidden: true } : shown;
  }
  else if (c.op === "setAttribute") {
    const attrs = { ...found.node.attrs };
    if (typeof c.name !== "string" || !c.name) fail("attribute name must be a non-empty string");
    if (c.value === null) delete attrs[c.name]; // removal is always safe
    else if (isSafeAttr(found.node.tag, c.name, c.value)) attrs[c.name] = c.value;
    else fail(`attribute not allowed: ${c.name.slice(0, 80)}`);
    props = { ...old, attrs };
  } else props = { ...old, styles: setStyle(found.node.styles, c.target, c.changes, fail) };
  if (c.op !== "restoreProps" && old.component?.role === "instance") props = { ...props, component: overridden(ir, found.node, c, fail) };
  const node: IRNodeV2 = { ...props, id, children, ...(parentId !== undefined && { parentId }) };
  return { ir: withRoot(ir, found.tree, update(rootOf(ir, found.tree), id, () => node)!), inverse: { op: "restoreProps", id, props: old } };
}

// An instance edit marks the paths it sets, so resolveComponents keeps them over the main; a main edit needs nothing,
// the resolver already takes every non-overridden path from the main.
function overridden(ir: IRV2, node: IRNodeV2, c: Extract<Edit, { op: "setStyle" | "setText" | "setAttribute" | "setHidden" }>, fail: Fail): NonNullable<IRNodeV2["component"]> {
  const ref = node.component!;
  const main = ir.components.find((m) => m.id === ref.id);
  if (!main || !preorder(main.root).some((n) => n.id === ref.sourceId)) fail(`instance node ${node.id} has no main source: edit the main or detach it`);
  let paths: string[];
  if (c.op === "setText") paths = ["text"];
  else if (c.op === "setHidden") paths = ["hidden"];
  else if (c.op === "setAttribute") paths = [`attrs.${c.name}`];
  else {
    const [group, key] = styleTarget(c.target, fail);
    paths = Object.keys(c.changes).map((prop) => `styles.${group === "base" ? "base" : `${group}.${key!}`}.${prop}`);
  }
  if (!paths.every(isOverridePath)) fail("invalid component override path");
  return { ...ref, overrides: [...new Set([...(ref.overrides ?? []), ...paths])] };
}

// --- tree commands (one tree each: a node never changes owner) ---
function insert(ir: IRV2, parentId: unknown, index: unknown, node: IRNodeV2, fail: Fail): { ir: IRV2; tree: Tree } {
  const parent = need(ir, parentId, fail, "parent");
  checkParent(parent.node, fail);
  checkIndex(index, parent.node.children.length, fail);
  checkFreshIds(ir, preorder(node).map((n) => n.id), fail);
  checkDepth(parent, node, fail);
  const pid = parent.node.id;
  const root = update(rootOf(ir, parent.tree), pid, (p) => ({ ...p, children: splice(p.children, index as number, 0, withParent(node, pid)) }))!;
  const next = withRoot(ir, parent.tree, root);
  // the whole document stays loadable by migrateIR: nodes per page (shell + its sections) or across component mains
  const host = parent.tree.kind === "components" ? next.components.map((c) => c.root) : pageTrees(next, parent.tree);
  if (host.reduce((sum, r) => sum + preorder(r).length, 0) > MAX_CAPTURE_NODES) fail(`page node limit exceeded (${MAX_CAPTURE_NODES})`);
  return { ir: next, tree: parent.tree };
}
const height = (n: IRNodeV2): number => 1 + Math.max(0, ...n.children.map(height));
const checkDepth = (parent: Found, node: IRNodeV2, fail: Fail) => {
  if (parent.depth + height(node) > MAX_TREE_DEPTH) fail(`tree depth limit exceeded (${MAX_TREE_DEPTH})`);
};
function pageTrees(ir: IRV2, t: Tree): IRNodeV2[] {
  const pageId = t.kind === "pages" ? ir.pages[t.index]!.id : ir.sections[t.index]!.pageId;
  return [...ir.pages.filter((p) => p.id === pageId).map((p) => p.shell), ...ir.sections.filter((s) => s.pageId === pageId).map((s) => s.root)];
}
function applyTree(ir: IRV2, c: Extract<Plain, { op: "createNode" | "restoreNode" | "moveNode" | "deleteNode" | "duplicateNode" }>, fail: Fail): Step & { tree: Tree } {
  if (c.op !== "restoreNode") guardRoles(ir, c, fail); // an Undo of a delete puts the node back where it was
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
  if (c.op !== "duplicateNode") checkParent(parent, fail);
  if (tree.kind === "components" && c.op !== "duplicateNode") {
    const hit = overridingInstance(ir, ir.components[tree.index]!.id, new Set(preorder(node).map((n) => n.id)), parent.id);
    if (hit) fail(`main node ${node.id} is overridden in instance ${hit}: reset or detach that instance first`);
  }
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
    // a copy was never captured: no box; R12: a copy is static (no interactive); parentIds are re-stamped by insert
    const copy = ({ box: _box, interactive: _interactive, ...n }: IRNodeV2): IRNodeV2 => ({ ...n, id: next.next().value as string, children: n.children.map(copy) });
    const created = copy(node);
    return { ...insert(ir, c.parentId, c.index, created, fail), inverse: { op: "deleteNode", id: created.id }, created: created.id };
  }
  // moveNode: the index counts after the node is lifted out of its current parent.
  if (preorder(node).some((n) => n.id === target.node.id)) fail("cannot move a node into itself (cycle)");
  const lifted = update(rootOf(ir, tree), parent.id, (p) => ({ ...p, children: splice(p.children, found.index, 1) }))!;
  const length = target.node.id === parent.id ? parent.children.length - 1 : target.node.children.length;
  checkIndex(c.index, length, fail);
  checkDepth(target, node, fail);
  const root = update(lifted, target.node.id, (p) => ({ ...p, children: splice(p.children, c.index, 0, { ...node, parentId: p.id }) }))!;
  return { ir: withRoot(ir, tree, root), tree, inverse: { op: "moveNode", id: node.id, parentId: parent.id, index: found.index } };
}

// --- section references (shell edits) ---
function refsBetween(before: IRV2, after: IRV2): Refs {
  const kept = new Set(after.sections.map((s) => s.id));
  return {
    sectionIds: before.pages.map((p) => p.sectionIds),
    layouts: before.layouts,
    sections: before.sections.map((section, index) => ({ index, section })).filter(({ section }) => !kept.has(section.id)),
    instanceIds: before.components.map((c) => c.instanceIds),
  };
}
function withRefs(ir: IRV2, refs: Refs, fail: Fail): IRV2 {
  if (!isObject(refs) || !Array.isArray(refs.sectionIds) || refs.sectionIds.length !== ir.pages.length ||
      !Array.isArray(refs.instanceIds) || refs.instanceIds.length !== ir.components.length) return fail("invalid section references");
  const sections = ir.sections.slice();
  for (const { index, section } of refs.sections) {
    if (sections.some((s) => s.id === section.id)) fail(`section already exists: ${section.id}`);
    sections.splice(index, 0, section);
  }
  return {
    ...ir, sections, layouts: refs.layouts, pages: ir.pages.map((p, i) => ({ ...p, sectionIds: refs.sectionIds[i]! })),
    components: ir.components.map((c, i) => ({ ...c, instanceIds: refs.instanceIds[i]! })),
  };
}
// A deleted instance root (or a dropped section holding instances) leaves its component's instanceIds; the main stays.
function pruneInstances(ir: IRV2): IRV2 {
  if (!ir.components.length) return ir;
  const present = allIds(ir);
  if (ir.components.every((c) => c.instanceIds.every((id) => present.has(id)))) return ir;
  return { ...ir, components: ir.components.map((c) => ({ ...c, instanceIds: c.instanceIds.filter((id) => present.has(id)) })) };
}

// --- layout: shares ir.ts promoteLayout and restores what it repoints/drops ---
function applyLayout(ir: IRV2, c: Extract<Edit, { op: "promoteLayout" }>, fail: Fail): Step {
  if (!Array.isArray(c.sectionIds) || c.sectionIds.some((id) => typeof id !== "string")) return fail("sectionIds must be a list of section IDs");
  const next = pruneInstances(guard(() => promoteLayout(ir, c.sectionIds), fail));
  const dropped = new Set(c.sectionIds.slice(1)), first = ir.sections.find((s) => s.id === c.sectionIds[0])!;
  const placeholders = ir.pages.flatMap((p) => preorder(p.shell))
    .filter((n) => n.tag === "#section" && dropped.has(n.attrs["data-section"] ?? ""))
    .map((n): [string, string] => [n.id, n.attrs["data-section"]!]);
  return { ir: next, inverse: { op: "restoreLayout", sectionIds: [...c.sectionIds], ...(first.layoutId !== undefined && { layoutId: first.layoutId }), placeholders, refs: refsBetween(ir, next) } };
}
function restoreLayout(ir: IRV2, c: Extract<HistoryCommand, { op: "restoreLayout" }>, fail: Fail): Step {
  if (!Array.isArray(c.sectionIds) || !Array.isArray(c.placeholders) || (c.layoutId !== undefined && typeof c.layoutId !== "string")) return fail("invalid layout restore");
  let next = ir;
  for (const entry of c.placeholders) {
    const found = Array.isArray(entry) ? find(next, entry[0]) : undefined;
    if (found?.tree.kind !== "pages" || found.node.tag !== "#section" || typeof entry[1] !== "string") return fail("invalid layout restore");
    next = withRoot(next, found.tree, update(rootOf(next, found.tree), found.node.id, (n) => ({ ...n, attrs: { ...n.attrs, "data-section": entry[1] } }))!);
  }
  next = withRefs(next, c.refs, fail);
  const sections = next.sections.map((s) => {
    if (s.id !== c.sectionIds[0]) return s;
    const { layoutId: _layout, ...rest } = s;
    return c.layoutId === undefined ? rest : { ...rest, layoutId: c.layoutId };
  });
  return { ir: { ...next, sections }, inverse: { op: "promoteLayout", sectionIds: c.sectionIds } };
}

// --- components: ir-component owns the semantics; only the target's subtree is taken over (and kept for Undo) ---
// The subtree a reset/detach rewrites: the instance node, or its instance parent when a detach gives that parent its
// own children.
function componentEditRoot(found: Found, c: ComponentEdit): IRNodeV2 {
  return c.op === "detachComponent" && found.parent?.component?.role === "instance" ? found.parent : found.node;
}
function applyComponent(ir: IRV2, c: ComponentEdit, fail: Fail): Step {
  const found = need(ir, c.instanceId, fail, "instance");
  const ref = found.node.component;
  if (ref?.role !== "instance" || found.tree.kind === "components") return fail(`not a component instance on a page: ${found.node.id}`);
  if (c.op === "resetOverride" && c.path !== undefined && (typeof c.path !== "string" || !(ref.overrides ?? []).includes(c.path))) fail("no override at that path");
  const resolved = guard(() => (c.op === "resetOverride" ? resetOverride(ir, c.instanceId, c.path) : detachComponent(ir, c.instanceId)), fail);
  const old = componentEditRoot(found, c), fresh = need(resolved, old.id, fail).node;
  const next = withRoot(ir, found.tree, update(rootOf(ir, found.tree), old.id, () => fresh)!);
  const command: ComponentEdit = c.op === "detachComponent" ? { op: c.op, instanceId: c.instanceId } : { op: c.op, instanceId: c.instanceId, ...(c.path !== undefined && { path: c.path }) };
  if (c.op === "resetOverride") return { ir: next, inverse: { op: "restoreComponent", command, node: old } };
  const components = ir.components.map((m, i) => ({ ...m, instanceIds: resolved.components[i]!.instanceIds }));
  return { ir: { ...next, components }, inverse: { op: "restoreComponent", command, node: old, instanceIds: ir.components.map((m) => m.instanceIds) } };
}
function restoreComponent(ir: IRV2, c: Extract<HistoryCommand, { op: "restoreComponent" }>, fail: Fail): Step {
  const bad = () => fail("invalid component restore");
  if (!isObject(c.command) || (c.command.op !== "resetOverride" && c.command.op !== "detachComponent") || !isObject(c.node)) return bad();
  if (c.instanceIds !== undefined && (!Array.isArray(c.instanceIds) || c.instanceIds.length !== ir.components.length)) return bad();
  const found = find(ir, c.node.id);
  if (!found || found.tree.kind === "components" || found.node.parentId !== c.node.parentId) return bad();
  let next = withRoot(ir, found.tree, update(rootOf(ir, found.tree), found.node.id, () => c.node)!);
  if (c.instanceIds) next = { ...next, components: next.components.map((m, i) => ({ ...m, instanceIds: c.instanceIds![i]! })) };
  return { ir: next, inverse: c.command };
}
// --- interactive components (E2 §6): the spec on a page node; ids never change here (item commands do that) ---
type SpecEdit = Extract<Edit, { op: "updateComponent" | "convertToComponent" | "unwrapComponent" }>;
function applySpec(ir: IRV2, c: SpecEdit | Extract<HistoryCommand, { op: "restoreSpec" }>, fail: Fail): Step {
  const found = need(ir, c.id, fail);
  if (found.tree.kind === "components") fail(`${c.op} on a component main: edit a page node (main components are not supported in E2)`);
  const old = found.node, ref = old.component;
  let interactive: InteractiveSpec | undefined, overrides = ref?.overrides;
  if (c.op === "restoreSpec") {
    if (c.overrides !== undefined && (!Array.isArray(c.overrides) || !c.overrides.every((p) => typeof p === "string" && isOverridePath(p)))) fail("invalid spec restore");
    interactive = c.interactive; overrides = c.overrides; // checkInteractives validates the restored spec
  } else if (c.op === "updateComponent") {
    if (!old.interactive) return fail(`node ${old.id} has no interactive`);
    interactive = guard(() => patchSpec(old.interactive!, c.patch), fail);
    if (ref?.role === "instance") overrides = [...new Set([...(ref.overrides ?? []), ...Object.keys(c.patch).map((k) => `interactive.${k}`)])];
  } else if (c.op === "convertToComponent") {
    if (old.interactive) return fail(`node ${old.id} already holds a ${old.interactive.kind}`);
    if (old.tag === "#text" || old.tag === "#section") fail(`a ${old.tag} node cannot hold a component`);
    interactive = guard(() => specFromRoles(c.kind, c.roles), fail);
    if (ref?.role === "instance") overrides = [...new Set([...(ref.overrides ?? []), "interactive"])];
  } else {
    if (!old.interactive) return fail(`node ${old.id} has no interactive`);
    overrides = ref?.overrides?.filter((p) => p !== "interactive" && !p.startsWith("interactive."));
  }
  const { interactive: _was, component: _ref, ...rest } = old;
  const component = ref && (({ overrides: _o, ...r }: NonNullable<IRNodeV2["component"]>) => (overrides ? { ...r, overrides } : r))(ref);
  const node: IRNodeV2 = { ...rest, ...(interactive && { interactive }), ...(component && { component }) };
  const inverse: HistoryCommand = { op: "restoreSpec", id: old.id, ...(old.interactive && { interactive: old.interactive }), ...(ref?.overrides && { overrides: ref.overrides }) };
  return { ir: withRoot(ir, found.tree, update(rootOf(ir, found.tree), old.id, () => node)!), inverse };
}

// E2 §2: a node holding a role (slide, trigger, panel…) leaves only with its component (removeComponentItem /
// unwrapComponent); the whole component (its root inside the subtree) may go. A new child of a track would be a
// slide the spec does not know: addComponentItem.
const ROLE_LABEL: Record<Role, string> = { viewport: "viewport", track: "track", slide: "slide", prev: "nút prev", next: "nút next", pagination: "pagination", tab: "tab", panel: "panel", trigger: "trigger", dialog: "dialog", close: "nút đóng", video: "video" };
function guardRoles(ir: IRV2, c: Extract<Plain, { op: "createNode" | "moveNode" | "deleteNode" | "duplicateNode" }>, fail: Fail): void {
  const members = roleIndex(ir);
  if (!members.size) return;
  if (c.op === "createNode" || c.op === "duplicateNode") {
    const track = (members.get(c.parentId) ?? []).find((m) => m.role === "track");
    if (track) fail(`node ${c.parentId} là track của carousel ${track.root}: dùng addComponentItem`);
    return; // a duplicate leaves its source in place; the copy is static (R12)
  }
  const subtree = new Set(preorder(need(ir, c.id, fail).node).map((x) => x.id));
  for (const id of subtree) for (const m of members.get(id) ?? []) {
    if (subtree.has(m.root)) continue;
    fail(`node ${id} đang là ${ROLE_LABEL[m.role]} của ${m.spec.kind} ${m.root}: dùng ${c.op === "moveNode" ? "moveComponentItem" : "removeComponentItem hoặc unwrapComponent"}`);
  }
}
const holdsInteractive = (n: IRNodeV2): boolean => n.interactive !== undefined || n.children.some(holdsInteractive);

// --- component items (E2 §6): spec order and DOM order change together; added node ids come from prepareCommands ---
const STRIP_ON_COPY = new Set(["id", "aria-controls", "aria-labelledby", "for"]); // R12: no duplicate html ids
type ItemCommand = Extract<NormalizedCommand, { op: "addComponentItem" | "removeComponentItem" | "moveComponentItem" }>;
function itemsAt(ir: IRV2, id: unknown, op: string, fail: Fail) {
  const found = need(ir, id, fail), spec = found.node.interactive;
  if (!spec) return fail(`node ${found.node.id} has no interactive`);
  if (found.node.component?.role === "instance") fail(`${op} on component instance ${found.node.id}: sửa ở main hoặc detach trước`);
  const parents = new Map<string, string>(); // every item node lives inside the root
  for (const n of preorder(found.node)) {
    if (n.tag === "#section") fail(`component ${found.node.id} holds section placeholders`);
    for (const ch of n.children) parents.set(ch.id, n.id);
  }
  const parentOf = (x: string) => parents.get(x);
  const items = itemsOf(spec, parentOf, found.node.id);
  if (!items.length) fail(`${spec.kind} has no items`);
  return { found, spec, items, parentOf };
}
// an add copies `from`'s item (a duplicate) or the first item emptied (E2 §6)
const sourceItem = (items: Item[], from: unknown, id: string, fail: Fail): Item =>
  from === undefined ? items[0]! : items.find((x) => x.id === from) ?? fail(`item ${String(from).slice(0, 200)} is not in ${id}`);
function copyItem(nodes: IRNodeV2[], newIds: Iterator<string>, blank: boolean): IRNodeV2[] {
  // never captured (no box), static inside (R12: no interactive), not an instance; parentIds are re-stamped by insert
  const copy = ({ box: _b, interactive: _i, component: _c, ...x }: IRNodeV2): IRNodeV2 => ({
    ...x, id: newIds.next().value as string,
    attrs: Object.fromEntries(Object.entries(x.attrs).filter(([k]) => !STRIP_ON_COPY.has(k) && !(blank && (k === "src" || k === "srcset")))),
    ...(x.tag === "#text" && { text: blank ? "" : x.text ?? "" }),
    children: x.children.map(copy),
  });
  return nodes.map(copy);
}
function applyItems(ir: IRV2, c: ItemCommand, fail: Fail): Step {
  const { found, spec, items, parentOf } = itemsAt(ir, c.id, c.op, fail);
  const id = found.node.id;
  if (c.op === "removeComponentItem") {
    const item = items.find((x) => x.id === c.itemId) ?? fail(`item ${String(c.itemId).slice(0, 200)} is not in ${id}`);
    const next = guard(() => withoutItem(spec, item.id), fail);
    const insert = item.nodes.map((n) => { const f = need(ir, n, fail); return { parentId: f.parent!.id, index: f.index, node: f.node }; });
    let out = ir;
    for (const n of item.nodes) out = removeNode(out, n, fail);
    return { ir: setSpec(out, id, next, fail), inverse: { op: "restoreItems", id, interactive: spec, remove: [], insert, order: [] } };
  }
  if (c.op === "moveComponentItem") {
    const next = guard(() => withItemMoved(spec, c.itemId, c.index), fail);
    const after = itemsOf(next, parentOf, id);
    const order = [...new Set(items.flatMap((x) => x.nodes.map((n) => parentOf(n)!)))].map((pid) => ({ parentId: pid, ids: need(ir, pid, fail).node.children.map((x) => x.id) }));
    let out = ir;
    // the k-th nodes (slides / triggers, then panels) take the slots the k-th nodes hold now, per parent
    for (let k = 0; k < Math.max(...after.map((x) => x.nodes.length)); k++) {
      const column = after.flatMap((x) => (x.nodes[k] === undefined ? [] : [x.nodes[k]!]));
      for (const pid of new Set(column.map((n) => parentOf(n)!))) out = reorderSlots(out, pid, column.filter((n) => parentOf(n) === pid), fail);
    }
    return { ir: setSpec(out, id, next, fail), inverse: { op: "restoreItems", id, interactive: spec, remove: [], insert: [], order } };
  }
  if (items.length >= INTERACTIVE_LIMITS.items) fail(`${spec.kind} already has ${INTERACTIVE_LIMITS.items} items`);
  checkIndex(c.index, items.length, fail);
  const source = sourceItem(items, c.from, id, fail), anchor = items[c.index] ?? items[items.length - 1]!;
  if (anchor.nodes.length !== source.nodes.length) fail(`items of ${id} differ in shape: add next to a matching item`);
  const originals = source.nodes.map((n) => need(ir, n, fail).node);
  originals.forEach((x) => checkSubtree(x, fail));
  const from = originals.flatMap((x) => preorder(x)).map((x) => x.id);
  if (new Set(from).size !== from.length) fail(`trigger and panel of ${source.id} are nested`);
  if (!Array.isArray(c.newIds) || c.newIds.length !== from.length) fail("newIds must match the copied item");
  const copies = copyItem(originals, c.newIds.values(), c.from === undefined);
  let out = ir;
  // each copy goes before the matching node of the item at `index` (same parent), or after the last item's
  for (const [k, copy] of copies.entries()) {
    const f = need(out, anchor.nodes[k], fail);
    out = insert(out, f.parent!.id, c.index < items.length ? f.index : f.index + 1, copy, fail).ir;
  }
  // the copy's trigger/panel sit at the preorder positions of the originals (a <details> container copies as one)
  const at = (ref: string) => c.newIds[from.indexOf(ref)]!;
  const pair = spec.kind === "tabs" ? spec.tabs.find((x) => x.trigger === source.id) : spec.kind === "accordion" ? spec.items.find((x) => x.trigger === source.id) : undefined;
  const next = guard(() => withItem(spec, c.index, { trigger: at(source.id), ...(pair && { panel: at(pair.panel) }) }), fail);
  return { ir: setSpec(out, id, next, fail), inverse: { op: "restoreItems", id, interactive: spec, remove: copies.map((x) => x.id), insert: [], order: [] }, created: copies[0]!.id };
}
const removeNode = (ir: IRV2, id: string, fail: Fail): IRV2 => {
  const f = need(ir, id, fail);
  if (!f.parent) return fail(`tree root is protected: ${id}`);
  checkParent(f.parent, fail);
  return withRoot(ir, f.tree, update(rootOf(ir, f.tree), f.parent.id, (p) => ({ ...p, children: splice(p.children, f.index, 1) }))!);
};
const setSpec = (ir: IRV2, id: string, spec: InteractiveSpec, fail: Fail): IRV2 => {
  const f = need(ir, id, fail);
  return withRoot(ir, f.tree, update(rootOf(ir, f.tree), id, (n) => ({ ...n, interactive: spec }))!);
};
// `ids` take the slots those ids hold now, in the given order; every other child (loop clone, text) keeps its slot
function reorderSlots(ir: IRV2, parentId: string, ids: string[], fail: Fail): IRV2 {
  const p = need(ir, parentId, fail), want = new Set(ids), queue = ids.values();
  checkParent(p.node, fail);
  const byId = new Map(p.node.children.map((ch) => [ch.id, ch]));
  const children = p.node.children.map((ch) => (want.has(ch.id) ? byId.get(queue.next().value as string)! : ch));
  return withRoot(ir, p.tree, update(rootOf(ir, p.tree), parentId, (n) => ({ ...n, children }))!);
}
function restoreItems(ir: IRV2, c: Extract<HistoryCommand, { op: "restoreItems" }>, fail: Fail): Step {
  const bad = () => fail("invalid item restore");
  if (!Array.isArray(c.remove) || !Array.isArray(c.insert) || !Array.isArray(c.order) || !isObject(c.interactive) ||
      !c.insert.every(isObject) || !c.order.every((x) => isObject(x) && Array.isArray(x.ids))) return bad();
  const old = need(ir, c.id, fail).node.interactive ?? bad();
  const removed = c.remove.map((id) => { const f = need(ir, id, fail); return { parentId: f.parent?.id ?? bad(), index: f.index, node: f.node }; });
  const order = c.order.map(({ parentId }) => ({ parentId, ids: need(ir, parentId, fail).node.children.map((x) => x.id) }));
  let out = ir;
  for (const id of c.remove) out = removeNode(out, id, fail);
  for (const x of [...c.insert].sort((a, b) => a.index - b.index)) { checkSubtree(x.node, fail); out = insert(out, x.parentId, x.index, x.node, fail).ir; }
  for (const { parentId, ids } of c.order) {
    const now = need(out, parentId, fail).node.children.map((x) => x.id);
    if (now.length !== ids.length || [...now].sort().join("\u0000") !== [...ids].sort().join("\u0000")) bad();
    out = reorderSlots(out, parentId, ids, fail);
  }
  return { ir: setSpec(out, c.id, c.interactive, fail), inverse: { op: "restoreItems", id: c.id, interactive: old, remove: c.insert.map((x) => x.node.id), insert: removed, order } };
}

const guard = <T>(run: () => T, fail: Fail): T => {
  try { return run(); } catch (e) { if (e instanceof AppError) return fail(e.message); throw e; }
};

function applyOne(ir: IRV2, c: HistoryCommand, fail: Fail): Step {
  if (!isObject(c)) return fail("command must be an object");
  switch (c.op) {
    case "setStyle": case "setText": case "setAttribute": case "setHidden": case "restoreProps":
      return applyProps(ir, c, fail);
    case "promoteLayout": return applyLayout(ir, c, fail);
    case "restoreLayout": return restoreLayout(ir, c, fail);
    case "resetOverride": case "detachComponent": return applyComponent(ir, c, fail);
    case "restoreComponent": return restoreComponent(ir, c, fail);
    case "updateComponent": case "convertToComponent": case "unwrapComponent": case "restoreSpec": return applySpec(ir, c, fail);
    case "addComponentItem": case "removeComponentItem": case "moveComponentItem": return applyItems(ir, c, fail);
    case "restoreItems": return restoreItems(ir, c, fail);
    case "createNode": case "restoreNode": case "moveNode": case "deleteNode": case "duplicateNode": {
      const step = applyTree(ir, c, fail);
      const shell = step.tree.kind === "pages" ? syncSections(step.ir) : step.ir;
      const synced = c.op === "deleteNode" ? pruneInstances(shell) : shell;
      if (synced === step.ir) return step;
      return { ...step, ir: synced, inverse: { op: "restoreRefs", command: step.inverse as Plain, refs: refsBetween(ir, synced) } };
    }
    case "restoreRefs": {
      // it only ever wraps a tree edit (the inverse of a shell edit or of an instance delete)
      if (!isObject(c.command) || !TREE_OPS.has((c.command as { op: unknown }).op as string)) return fail("invalid restore");
      const step = applyOne(ir, c.command, fail);
      const done = withRefs(step.ir, c.refs, fail);
      const inner = (step.inverse.op === "restoreRefs" ? step.inverse.command : step.inverse) as Plain;
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
  return commands.map((raw, i) => {
    const fail = failer(i, raw);
    if (!isObject(raw)) return fail("command must be an object");
    const command = unalias(current, raw, fail);
    let normalized: NormalizedCommand;
    switch (command.op) {
      case "setStyle": normalized = { op: command.op, id: command.id, target: command.target, changes: command.changes }; break;
      case "setText": normalized = { op: command.op, id: command.id, text: command.text }; break;
      case "setAttribute": normalized = { op: command.op, id: command.id, name: command.name, value: command.value }; break;
      case "setHidden": normalized = { op: command.op, id: command.id, hidden: command.hidden }; break;
      case "promoteLayout": normalized = { op: command.op, sectionIds: Array.isArray(command.sectionIds) ? [...command.sectionIds] : command.sectionIds }; break;
      case "resetOverride": normalized = { op: command.op, instanceId: command.instanceId, ...(command.path !== undefined && { path: command.path }) }; break;
      case "detachComponent": normalized = { op: command.op, instanceId: command.instanceId }; break;
      case "updateComponent": normalized = { op: command.op, id: command.id, patch: isObject(command.patch) ? { ...command.patch } : command.patch }; break;
      case "convertToComponent": normalized = { op: command.op, id: command.id, kind: command.kind, roles: isObject(command.roles) ? { ...command.roles } : command.roles }; break;
      case "unwrapComponent": normalized = { op: command.op, id: command.id }; break;
      case "removeComponentItem": normalized = { op: command.op, id: command.id, itemId: command.itemId }; break;
      case "moveComponentItem": normalized = { op: command.op, id: command.id, itemId: command.itemId, index: command.index }; break;
      case "addComponentItem": {
        const source = sourceItem(itemsAt(current, command.id, command.op, fail).items, command.from, String(command.id), fail);
        const newIds = source.nodes.flatMap((n) => preorder(need(current, n, fail).node)).map(() => allocateId());
        normalized = { op: command.op, id: command.id, ...(command.from !== undefined && { from: command.from }), index: command.index, newIds };
        break;
      }
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
// E2 §6 AI aliases: the same normalized command, only on a carousel.
const ALIASES = { updateCarousel: "updateComponent", addCarouselSlide: "addComponentItem", removeCarouselSlide: "removeComponentItem" } as const;
type Unaliased = Exclude<EditorCommand, { op: keyof typeof ALIASES }>;
function unalias(ir: IRV2, c: EditorCommand, fail: Fail): Unaliased {
  if (!Object.hasOwn(ALIASES, c.op)) return c as Unaliased;
  if (find(ir, (c as { id?: unknown }).id)?.node.interactive?.kind !== "carousel") fail(`${c.op} needs a carousel`);
  return { ...c, op: ALIASES[c.op as keyof typeof ALIASES] } as Unaliased;
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
    const fail = failer(i, command);
    const step = applyOne(current, command, fail);
    current = step.ir;
    // E2 §2: validated after every command, so no step (tree, prop, layout or History payload) leaves a broken component
    if (treesOf(current).some((t) => holdsInteractive(rootOf(current, t)))) guard(() => checkInteractives(current), fail);
    inverse.unshift(step.inverse);
    if (step.created) createdIds.push(step.created);
  });
  const bytes = new TextEncoder().encode(JSON.stringify(commands)).length + new TextEncoder().encode(JSON.stringify(inverse)).length;
  if (bytes > COMMAND_LIMITS.stepBytes) throw new AppError(Codes.IR_PATCH_INVALID, "history step exceeds 8 MB");
  return { ir: current, inverse, createdIds };
}
