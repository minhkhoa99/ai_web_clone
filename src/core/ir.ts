// Pure: PageCapture[] -> IR, and immutable patches over it. No fs/network/db/Date/random.
import type { CaptureNode, PageCapture } from "./capture";
import type { Interaction } from "./interactions";
import { dedupeStyles, extractTokens, structuralHash, type Decl, type StyleSet, type StyledNode } from "./dedupe";
import { AppError, Codes } from "./errors";

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
export type Page = { id: string; path: string; title: string; meta: Record<string, string>; sectionIds: string[] };
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

type Draft = StyledNode & { text?: string; hidden?: boolean; children: Draft[] };
type DraftSection = Omit<Section, "root"> & { root: Draft };
type Extras = Pick<IRNode, "states" | "behavior">;

const MAX_UNWRAP = 3;
const MIN_COMPONENT_SIBLINGS = 3;
const LANDMARK_TAGS = new Set(["header", "nav", "footer"]);
const LANDMARK_ROLES: Record<string, string> = { banner: "header", navigation: "nav", contentinfo: "footer" };
const BEHAVIOR_KINDS = new Set<Interaction["kind"]>(["menu", "tab", "accordion", "modal", "carousel", "sticky"]);

const elements = (node: Draft) => node.children.filter((c) => c.tag !== "#text");

// Props that differ from base; a base prop absent at the breakpoint equals the UA default -> `revert`.
function diffDecl(base: Decl, at: Decl): Decl {
  const out: Decl = {};
  for (const [prop, value] of Object.entries(at)) if (base[prop] !== value) out[prop] = value;
  for (const prop of Object.keys(base)) if (!Object.hasOwn(at, prop)) out[prop] = "revert";
  return out;
}

type Walk = { pageId: string; canvasAssets: Map<number, string>; canvasSeen: number };

// 1440 node + its 768/375 counterparts (same tree path) -> Draft with a merged StyleSet.
// Counterparts stop below any node whose tag or child count differs at that breakpoint.
function toDraft(node: CaptureNode, path: string, at768: CaptureNode | undefined, at375: CaptureNode | undefined, walk: Walk): Draft {
  const id = `${walk.pageId}:${path}`;
  if (node.tag === "#text") return { id, tag: "#text", attrs: {}, text: node.text ?? "", style: { base: {} }, children: [] };

  const style: StyleSet = { base: node.style, media: {} };
  if (node.pseudo?.before) style.before = node.pseudo.before;
  if (node.pseudo?.after) style.after = node.pseudo.after;
  if (at768?.tag === node.tag) style.media!["768"] = diffDecl(node.style, at768.style);
  if (at375?.tag === node.tag) style.media!["375"] = diffDecl(node.style, at375.style);
  const draft: Draft = { id, tag: node.tag, attrs: node.attrs, style, children: [] };
  if (node.hidden) draft.hidden = true;

  if (node.attrs["data-dynamic"] === "canvas") {
    const src = walk.canvasAssets.get(walk.canvasSeen++);
    if (src) {
      const [, , w, h] = node.bbox;
      return { ...draft, tag: "img", attrs: { src, "data-dynamic": "canvas", width: String(Math.round(w)), height: String(Math.round(h)) } };
    }
  }

  const aligned = (other: CaptureNode | undefined) =>
    other?.tag === node.tag && other.children.length === node.children.length ? other.children : undefined;
  const kids768 = aligned(at768);
  const kids375 = aligned(at375);
  draft.children = node.children.map((child, i) => toDraft(child, `${path}.${i}`, kids768?.[i], kids375?.[i], walk));
  return draft;
}

function landmarkOf(node: Draft): string | undefined {
  if (LANDMARK_TAGS.has(node.tag)) return node.tag;
  return LANDMARK_ROLES[node.attrs.role ?? ""];
}

const isMain = (node: Draft) => node.tag === "main" || node.attrs.role === "main";

// Body element children (after unwrapping single non-landmark wrappers) -> sections;
// `main` contributes each element child. Nodes dropped by unwrapping/splitting lose their own styles.
function splitSections(html: Draft): { role: string; root: Draft }[] {
  const body = html.children.find((c) => c.tag === "body");
  if (!body) return [];
  let candidates = elements(body);
  for (let depth = 0; depth < MAX_UNWRAP && candidates.length === 1; depth++) {
    const only = candidates[0]!;
    const inner = elements(only);
    if (landmarkOf(only) || isMain(only) || inner.length === 0) break;
    candidates = inner;
  }
  return candidates.flatMap((node) => {
    const kids = isMain(node) ? elements(node) : [];
    const roots = kids.length > 0 ? kids : [node];
    return roots.map((root) => ({ role: landmarkOf(root) ?? "block", root }));
  });
}

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, esc: string) =>
    /^[0-9a-fA-F]/.test(esc) ? String.fromCodePoint(parseInt(esc, 16)) : esc,
  );
}

const NTH_STEP = /^([a-zA-Z][\w-]*):nth-of-type\((\d+)\)$/;

// Matches only the selector forms interactions-eval generates: `#id` start and
// `tag:nth-of-type(n)` steps from <html>.
// ponytail: nth-of-type counts script/style siblings the snapshot skipped, so paths
// past such siblings may miss (interaction stays unmapped); fix by recording the DOM index.
function findTrigger(html: Draft, byId: Map<string, Draft>, trigger: string): Draft | undefined {
  let cur: Draft | undefined;
  for (const [i, part] of trigger.split(" > ").entries()) {
    if (i === 0 && part.startsWith("#")) {
      cur = byId.get(unescapeCss(part.slice(1)));
    } else {
      const m = NTH_STEP.exec(part);
      if (!m) return undefined;
      const pool = cur ? cur.children : [html];
      cur = pool.filter((c) => c.tag === m[1])[Number(m[2]) - 1];
    }
    if (!cur) return undefined;
  }
  return cur;
}

function indexById(node: Draft, out: Map<string, Draft>): Map<string, Draft> {
  const id = node.attrs.id;
  if (id !== undefined && !out.has(id)) out.set(id, node);
  for (const child of node.children) indexById(child, out);
  return out;
}

function collectIds(node: Draft, out: Set<string>): void {
  out.add(node.id);
  for (const child of node.children) collectIds(child, out);
}

// ponytail: structuralHash is recomputed per level (O(nodes x depth)); fine under the 20k node cap.
function collectComponents(node: Draft, out: Map<string, string[]>): void {
  const groups = new Map<string, string[]>();
  for (const child of elements(node)) {
    if (elements(child).length === 0) continue;
    const hash = structuralHash(child);
    groups.set(hash, [...(groups.get(hash) ?? []), child.id]);
  }
  for (const [hash, ids] of groups) {
    if (ids.length >= MIN_COMPONENT_SIBLINGS) out.set(hash, [...(out.get(hash) ?? []), ...ids]);
  }
  for (const child of node.children) collectComponents(child, out);
}

function toIRNode(draft: Draft, classMap: Map<string, string[]>, extras: Map<string, Extras>): IRNode {
  const node: IRNode = {
    id: draft.id,
    tag: draft.tag,
    attrs: draft.attrs,
    cls: classMap.get(draft.id) ?? [],
    children: draft.children.map((c) => toIRNode(c, classMap, extras)),
  };
  if (draft.text !== undefined) node.text = draft.text;
  if (draft.hidden) node.hidden = true;
  return { ...node, ...extras.get(draft.id) };
}

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
      origin: "capture",
      root,
    }));
    return { capture, html, sections };
  });

  // Layouts: a section hash on >=2 pages is stored once (first page's copy).
  const byHash = new Map<string, { first: DraftSection; pageIds: Set<string> }>();
  for (const { sections } of parsed) {
    for (const s of sections) {
      const entry = byHash.get(s.hash) ?? { first: s, pageIds: new Set<string>() };
      entry.pageIds.add(s.pageId);
      byHash.set(s.hash, entry);
    }
  }
  const layouts: Layout[] = [];
  for (const [hash, { first, pageIds }] of byHash) {
    if (pageIds.size < 2) continue;
    first.layoutId = `layout-${hash}`;
    layouts.push({ id: first.layoutId, hash, sectionId: first.id, pageIds: [...pageIds] });
  }
  const sharedFrom = (s: DraftSection) => {
    const { first, pageIds } = byHash.get(s.hash)!;
    return pageIds.size >= 2 && first.pageId !== s.pageId ? first : undefined;
  };

  const pages: Page[] = [];
  const kept: DraftSection[] = [];
  for (const { capture, sections } of parsed) {
    pages.push({
      id: capture.pageId,
      path: pagePath(capture.url),
      title: capture.title,
      meta: capture.meta,
      sectionIds: sections.map((s) => sharedFrom(s)?.id ?? s.id),
    });
    kept.push(...sections.filter((s) => !sharedFrom(s)));
  }
  const keptRoots = kept.map((s) => s.root);
  const keptIds = new Set<string>();
  for (const root of keptRoots) collectIds(root, keptIds);

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

  const { classMap, classes } = dedupeStyles([...keptRoots, ...hoverRoots]);
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
    pages,
    sections: kept.map((s) => ({ ...s, root: toIRNode(s.root, classMap, extras) })),
    layouts,
    components: [...componentIds].map(([hash, instanceIds]) => ({ id: `cmp-${hash}`, hash, instanceIds })),
    classes,
    tokens: extractTokens(keptRoots),
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

function styleClass(ir: IR, op: Extract<PatchOp, { op: "setStyle" }>): { cls: string[]; classes: IR["classes"] } {
  const { classMap, classes: added } = dedupeStyles([{ id: op.id, tag: "div", attrs: {}, style: { base: op.style }, children: [] }]);
  const cls = classMap.get(op.id) ?? [];
  const name = cls[0];
  if (!name || !ir.classes[name]) return { cls, classes: name ? { ...ir.classes, ...added } : ir.classes };
  if (JSON.stringify(ir.classes[name]) !== JSON.stringify(added[name])) {
    throw new AppError(Codes.IR_PATCH_INVALID, `class name collision: ${name}`, { op: op.op, id: op.id });
  }
  return { cls, classes: ir.classes };
}

function applyOp(ir: IR, op: PatchOp): IR {
  let classes = ir.classes;
  let edit: (n: IRNode) => IRNode;
  switch (op.op) {
    case "setStyle": {
      const styled = styleClass(ir, op);
      classes = styled.classes;
      edit = (n) => ({ ...n, cls: styled.cls });
      break;
    }
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
