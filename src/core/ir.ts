// Pure: PageCapture[] -> IR, and immutable patches over it. No fs/network/db/Date/random.
import type { PageCapture } from "./capture";
import type { Interaction } from "./interactions";
import { dedupeStyles, extractTokens, structuralHash, type Decl, type StyleSet, type StyledNode } from "./dedupe";
import { AppError, Codes } from "./errors";
import {
  collectComponents,
  collectIds,
  contentHash,
  findTrigger,
  indexById,
  sectionPlaceholder,
  splitSections,
  toDraft,
  toIRNode,
  toShell,
  type Draft,
  type Extras,
  type Walk,
} from "./ir-build";

export type IRNode = {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  cls: string[];
  hidden?: boolean;
  states?: { hover?: string; focus?: string; active?: string };
  behavior?: string; // Interaction id, or 'unresolved'
  children: IRNode[];
};
export type Section = {
  id: string;
  pageId: string;
  name: string;
  role: string;
  hash: string;
  origin: "capture" | "ai";
  root: IRNode;
  layoutId?: string;
};
// shell = html (no head) > body > wrappers/main, each section's slot a `#section` placeholder node.
export type Page = { id: string; path: string; title: string; meta: Record<string, string>; sectionIds: string[]; shell: IRNode };
export type Layout = { id: string; hash: string; sectionId: string; pageIds: string[] };
export type Component = { id: string; hash: string; instanceIds: string[] };
export type IR = {
  pages: Page[];
  sections: Section[];
  layouts: Layout[];
  components: Component[];
  classes: Record<string, StyleSet>;
  tokens: Record<string, string>;
  cssom: { keyframes: string[]; fontFace: string[]; vars: Record<string, string> };
  interactions: (Interaction & { pageId: string })[];
};
export type PatchOp =
  | { op: "setStyle"; id: string; style: Decl }
  | { op: "setAttr"; id: string; attrs: Record<string, string> }
  | { op: "setText"; id: string; text: string }
  | { op: "replaceSubtree"; id: string; node: IRNode }
  | { op: "setBehavior"; id: string; behavior: string };

type DraftSection = Omit<Section, "root"> & { root: Draft; content: string };

const BEHAVIOR_KINDS = new Set<Interaction["kind"]>(["menu", "tab", "accordion", "modal", "carousel", "sticky"]);

function pagePath(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export function buildIR(captures: PageCapture[]): IR {
  const parsed = captures.map((capture) => {
    const dom = (bp: number) => capture.breakpoints.find((b) => b.bp === bp)?.dom;
    const walk: Walk = { pageId: capture.pageId, canvasAssets: new Map(capture.dynamic.map((d) => [d.order, d.asset])), canvasSeen: 0 };
    const html = toDraft(dom(1440) ?? capture.breakpoints[0]!.dom, "0", dom(768), dom(375), walk);
    const sections: DraftSection[] = splitSections(html).map(({ role, root }, i) => ({
      id: `${capture.pageId}-s${i + 1}`,
      pageId: capture.pageId,
      name: `section-${i + 1}`,
      role,
      hash: structuralHash(root),
      content: contentHash(root),
      origin: "capture",
      root,
    }));
    return { capture, html, sections };
  });

  // Layouts: same structure AND same content on >=2 pages -> stored once (first page's copy).
  const layoutKey = (s: DraftSection) => `${s.hash}:${s.content}`;
  const byKey = new Map<string, { first: DraftSection; pageIds: Set<string> }>();
  for (const { sections } of parsed) {
    for (const s of sections) {
      const entry = byKey.get(layoutKey(s)) ?? { first: s, pageIds: new Set<string>() };
      entry.pageIds.add(s.pageId);
      byKey.set(layoutKey(s), entry);
    }
  }
  const layouts: Layout[] = [];
  for (const { first, pageIds } of byKey.values()) {
    if (pageIds.size < 2) continue;
    first.layoutId = `layout-${first.content}`;
    layouts.push({ id: first.layoutId, hash: first.hash, sectionId: first.id, pageIds: [...pageIds] });
  }
  const sharedFrom = (s: DraftSection) => {
    const { first, pageIds } = byKey.get(layoutKey(s))!;
    return pageIds.size >= 2 && first.pageId !== s.pageId ? first : undefined;
  };

  const kept: DraftSection[] = [];
  const shells = parsed.map(({ html, sections }) => {
    const placeholders = new Map<string, Draft>();
    for (const s of sections) placeholders.set(s.root.id, sectionPlaceholder(s.id, sharedFrom(s)?.id ?? s.id));
    kept.push(...sections.filter((s) => !sharedFrom(s)));
    return toShell(html, placeholders);
  });
  const keptRoots = kept.map((s) => s.root);
  const styledRoots = [...keptRoots, ...shells];
  const keptIds = new Set<string>();
  for (const root of styledRoots) collectIds(root, keptIds);

  // Interactions -> behavior now, hover deltas -> synthetic nodes deduped with the page styles.
  const extras = new Map<string, Extras>();
  const hoverRoots: StyledNode[] = [];
  for (const { capture, html } of parsed) {
    const byId = indexById(html, new Map());
    for (const it of capture.interactions) {
      const target = findTrigger(html, byId, it.trigger);
      if (!target || !keptIds.has(target.id)) continue;
      const extra = extras.get(target.id) ?? {};
      extras.set(target.id, extra);
      if (it.kind === "hover" && it.styleDelta && Object.keys(it.styleDelta).length > 0) {
        hoverRoots.push({ id: `hover|${target.id}`, tag: "div", attrs: {}, style: { base: it.styleDelta }, children: [] });
      } else if (BEHAVIOR_KINDS.has(it.kind) && it.status !== "skipped") {
        extra.behavior = it.status === "captured" ? it.id : "unresolved";
      }
    }
  }

  const { classMap, classes } = dedupeStyles([...styledRoots, ...hoverRoots]);
  for (const hover of hoverRoots) {
    const nodeId = hover.id.slice("hover|".length);
    const extra = extras.get(nodeId)!;
    extra.states = { ...extra.states, hover: classMap.get(hover.id)![0]! };
  }

  const componentIds = new Map<string, string[]>();
  for (const root of keptRoots) collectComponents(root, componentIds);

  const keyframes = new Set<string>();
  const fontFace = new Set<string>();
  const vars: Record<string, string> = {};
  for (const { cssom } of captures) {
    cssom.keyframes.forEach((k) => keyframes.add(k));
    cssom.fontFace.forEach((f) => fontFace.add(f));
    for (const [name, value] of Object.entries(cssom.vars)) if (!Object.hasOwn(vars, name)) vars[name] = value;
  }

  return {
    pages: parsed.map(({ capture, sections }, i) => ({
      id: capture.pageId,
      path: pagePath(capture.url),
      title: capture.title,
      meta: capture.meta,
      sectionIds: sections.map((s) => sharedFrom(s)?.id ?? s.id),
      shell: toIRNode(shells[i]!, classMap, extras),
    })),
    sections: kept.map(({ content: _content, ...s }) => ({ ...s, root: toIRNode(s.root, classMap, extras) })),
    layouts,
    components: [...componentIds].map(([hash, instanceIds]) => ({ id: `cmp-${hash}`, hash, instanceIds })),
    classes,
    tokens: extractTokens(styledRoots),
    cssom: { keyframes: [...keyframes], fontFace: [...fontFace], vars },
    interactions: captures.flatMap((c) => c.interactions.map((it) => ({ ...it, pageId: c.pageId }))),
  };
}

// Path-copying replace of the node with `id`; undefined when not in this subtree.
function replaceNode(node: IRNode, id: string, edit: (n: IRNode) => IRNode): IRNode | undefined {
  if (node.id === id) return edit(node);
  for (let i = 0; i < node.children.length; i++) {
    const child = replaceNode(node.children[i]!, id, edit);
    if (!child) continue;
    const children = node.children.slice();
    children[i] = child;
    return { ...node, children };
  }
  return undefined;
}

// Merges the patch into the node's current class base (media/pseudo kept) and dedupes the result.
function styleClass(ir: IR, node: IRNode, style: Decl): { cls: string[]; classes: IR["classes"] } {
  const current: StyleSet = ir.classes[node.cls[0] ?? ""] ?? { base: {} };
  const merged: StyleSet = { ...current, base: { ...current.base, ...style } };
  const { classMap, classes: added } = dedupeStyles([{ id: node.id, tag: "div", attrs: {}, style: merged, children: [] }]);
  const cls = classMap.get(node.id) ?? [];
  const name = cls[0];
  if (!name || !ir.classes[name]) return { cls, classes: name ? { ...ir.classes, ...added } : ir.classes };
  if (JSON.stringify(ir.classes[name]) !== JSON.stringify(added[name])) {
    throw new AppError(Codes.IR_PATCH_INVALID, `class name collision: ${name}`, { op: "setStyle", id: node.id });
  }
  return { cls, classes: ir.classes };
}

function applyOp(ir: IR, op: PatchOp): IR {
  let classes = ir.classes;
  let edit: (n: IRNode) => IRNode;
  switch (op.op) {
    case "setStyle":
      edit = (n) => {
        const styled = styleClass(ir, n, op.style);
        classes = styled.classes;
        return { ...n, cls: styled.cls };
      };
      break;
    case "setAttr":
      edit = (n) => ({ ...n, attrs: { ...n.attrs, ...op.attrs } });
      break;
    case "setText":
      edit = (n) =>
        n.tag === "#text"
          ? { ...n, text: op.text }
          : { ...n, children: [{ id: `${n.id}.0`, tag: "#text", attrs: {}, text: op.text, cls: [], children: [] }] };
      break;
    case "replaceSubtree":
      edit = () => ({ ...op.node, id: op.id });
      break;
    case "setBehavior":
      edit = (n) => ({ ...n, behavior: op.behavior });
      break;
  }

  for (let i = 0; i < ir.sections.length; i++) {
    const section = ir.sections[i]!;
    const root = replaceNode(section.root, op.id, edit);
    if (!root) continue;
    const sections = ir.sections.slice();
    sections[i] = { ...section, root };
    return { ...ir, sections, classes };
  }
  throw new AppError(Codes.IR_PATCH_INVALID, `patch target not found: ${op.id}`, { op: op.op, id: op.id });
}

export function applyPatch(ir: IR, ops: PatchOp[]): IR {
  return ops.reduce(applyOp, ir);
}
