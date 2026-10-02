// Pure helpers for buildIR (ir.ts): capture tree -> Draft, section split, shell,
// trigger matching, components. No fs/network/db/Date/random.
import type { CaptureNode } from "./capture";
import { hash6, structuralHash, type Decl, type StyleSet, type StyledNode } from "./dedupe";
import type { LegacyIRNode as IRNode } from "./ir-legacy";

// zeroBox: 1440 bbox width or height is 0, not display:contents (kept only to skip it as a section root).
export type Draft = StyledNode & { text?: string; hidden?: boolean; zeroBox?: boolean; children: Draft[] };
export type Extras = Pick<IRNode, "states" | "behavior">;
export type Walk = { pageId: string; canvasAssets: Map<number, string>; canvasSeen: number };

const MAX_UNWRAP = 3;
const MIN_COMPONENT_SIBLINGS = 3;
const LANDMARK_TAGS = new Set(["header", "nav", "footer"]);
const LANDMARK_ROLES: Record<string, string> = { banner: "header", navigation: "nav", contentinfo: "footer" };
const NOISE_TAGS = new Set(["script", "style", "noscript", "template", "next-route-announcer"]);

const elements = (node: Draft) => node.children.filter((c) => c.tag !== "#text");

// Props that differ from base; a base prop absent at the breakpoint equals the UA default -> `revert`.
function diffDecl(base: Decl, at: Decl): Decl {
  const out: Decl = {};
  for (const [prop, value] of Object.entries(at)) if (base[prop] !== value) out[prop] = value;
  for (const prop of Object.keys(base)) if (!Object.hasOwn(at, prop)) out[prop] = "revert";
  return out;
}

// 1440 node + its 768/375 counterparts (same tree path) -> Draft with a merged StyleSet.
// Counterparts stop below any node whose tag or child count differs at that breakpoint.
export function toDraft(node: CaptureNode, path: string, at768: CaptureNode | undefined, at375: CaptureNode | undefined, walk: Walk): Draft {
  const id = `${walk.pageId}:${path}`;
  if (node.tag === "#text") return { id, tag: "#text", attrs: {}, text: node.text ?? "", style: { base: {} }, children: [] };

  const style: StyleSet = { base: node.style, media: {} };
  if (node.pseudo?.before) style.before = node.pseudo.before;
  if (node.pseudo?.after) style.after = node.pseudo.after;
  if (at768?.tag === node.tag) style.media!["768"] = diffDecl(node.style, at768.style);
  if (at375?.tag === node.tag) style.media!["375"] = diffDecl(node.style, at375.style);
  const draft: Draft = { id, tag: node.tag, attrs: node.attrs, style, children: [] };
  if (node.hidden) draft.hidden = true;
  // display:contents boxes are always 0x0 but their children render.
  if ((node.bbox[2] === 0 || node.bbox[3] === 0) && node.style.display !== "contents") draft.zeroBox = true;

  if (node.attrs["data-dynamic"] === "canvas") {
    const src = walk.canvasAssets.get(walk.canvasSeen++);
    if (src) {
      const [, , w, h] = node.bbox;
      return { ...draft, tag: "img", attrs: { src, "data-dynamic": "canvas", width: String(Math.round(w)), height: String(Math.round(h)) } };
    }
  }

  const a768 = alignChildren(node, at768), a375 = alignChildren(node, at375);
  draft.children = node.children.map((child, i) => {
    const d = toDraft(child, `${path}.${i}`, a768?.kids[i], a375?.kids[i], walk);
    // R7: keyed alignment and no counterpart -> the node does not exist at that breakpoint
    for (const [bp, a] of [["768", a768], ["375", a375]] as const) if (a?.keyed && !a.kids[i] && child.tag !== "#text") d.style.media = { ...d.style.media, [bp]: { display: "none" } };
    return d;
  });
  return draft;
}

const KEY_ATTRS = ["data-swiper-slide-index", "data-slick-index", "data-index", "id"];
const CLONE_CLASS = /(^|\s)(swiper-slide-duplicate|slick-cloned|splide__slide--clone)(\s|$)/;
type Keyed = { tag: string; attrs: Record<string, string>; children: Keyed[] };
const keyOf = (c: Keyed): string | undefined => {
  for (const a of KEY_ATTRS) if (c.attrs[a] !== undefined) return `${c.tag}|${a}=${c.attrs[a]}|${CLONE_CLASS.test(c.attrs.class ?? "") ? "clone" : ""}`;
  return undefined;
};
// The counterpart children at another breakpoint: by position when the counts match (as before), else by slide key
// when every element child on both sides has one (E2 §4 responsive); undefined when neither holds.
export function alignChildren<N extends Keyed>(node: N, other: N | undefined): { kids: (N | undefined)[]; keyed: boolean } | undefined {
  if (other?.tag !== node.tag) return undefined;
  if (other.children.length === node.children.length) return { kids: other.children as N[], keyed: false };
  const els = (list: N[]) => list.filter((c) => c.tag !== "#text");
  const mine = els(node.children as N[]), theirs = els(other.children as N[]);
  if (!mine.length || ![...mine, ...theirs].every((c) => keyOf(c) !== undefined)) return undefined;
  const byKey = new Map<string, N>();
  for (const c of theirs) if (!byKey.has(keyOf(c)!)) byKey.set(keyOf(c)!, c);
  return { kids: (node.children as N[]).map((c) => (c.tag === "#text" ? undefined : byKey.get(keyOf(c)!))), keyed: true };
}

function landmarkOf(node: Draft): string | undefined {
  if (LANDMARK_TAGS.has(node.tag)) return node.tag;
  return LANDMARK_ROLES[node.attrs.role ?? ""];
}

const isMain = (node: Draft) => node.tag === "main" || node.attrs.role === "main";
const isWrapper = (node: Draft) => !landmarkOf(node) && !isMain(node) && elements(node).length > 0;
const hasMainWithin = (node: Draft, depth: number): boolean =>
  elements(node).some((c) => isMain(c) || (depth > 1 && hasMainWithin(c, depth - 1)));
const isNoise = (node: Draft) =>
  NOISE_TAGS.has(node.tag) || !!node.zeroBox || node.style.base.display === "none" || node.style.base.visibility === "hidden";

// All-noise -> keep the unfiltered list (never zero sections for a non-empty body).
const withoutNoise = (nodes: Draft[]) => {
  const kept = nodes.filter((node) => !isNoise(node));
  return kept.length > 0 ? kept : nodes;
};

// Body element children -> sections, after unwrapping (up to MAX_UNWRAP times) a single
// non-landmark wrapper (noise siblings ignored), or the one wrapper among siblings that holds
// `main` (so header/footer beside main become sections); `main` contributes each element child.
// Noise (hidden, zero-size, script-like) is never a section root. Body, wrappers, main and
// noise stay in the shell.
export function splitSections(html: Draft): { role: string; root: Draft }[] {
  const body = html.children.find((c) => c.tag === "body");
  if (!body) return [];
  let candidates = elements(body);
  for (let depth = 0; depth < MAX_UNWRAP; depth++) {
    // Decide on non-noise candidates (noise siblings like next-route-announcer must not block the unwrap).
    const live = withoutNoise(candidates);
    const wrappers = live.length === 1 ? live.filter(isWrapper) : live.filter((c) => isWrapper(c) && hasMainWithin(c, MAX_UNWRAP));
    if (wrappers.length !== 1) break;
    const wrapper = wrappers[0]!;
    candidates = candidates.flatMap((c) => (c === wrapper ? elements(c) : [c]));
  }
  const all = candidates.flatMap((node) => {
    const kids = isMain(node) ? elements(node) : [];
    return kids.length > 0 ? kids : [node];
  });
  return withoutNoise(all).map((root) => ({ role: landmarkOf(root) ?? "block", root }));
}

// html minus head, with every section root swapped for its placeholder (keyed by root node id).
export function toShell(node: Draft, placeholders: Map<string, Draft>): Draft {
  const placeholder = placeholders.get(node.id);
  if (placeholder) return placeholder;
  const children = node.children.filter((c) => c.tag !== "head").map((c) => toShell(c, placeholders));
  return { ...node, children };
}

export function sectionPlaceholder(id: string, sectionId: string): Draft {
  return { id, tag: "#section", attrs: { "data-section": sectionId }, style: { base: {} }, children: [] };
}

type ContentNode = { tag: string; attrs: Record<string, string>; text?: string; children: ContentNode[] };

// Tag + attrs + text over the subtree (no styles, bbox or ids): equal only for identical content. Drafts and IR nodes alike.
export function contentHash(node: ContentNode): string {
  const content = (n: ContentNode): unknown => [n.tag, n.attrs, n.text ?? null, n.children.map(content)];
  return hash6(JSON.stringify(content(node)));
}

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, esc: string) =>
    /^[0-9a-fA-F]/.test(esc) ? String.fromCodePoint(parseInt(esc, 16)) : esc,
  );
}

const NTH_STEP = /^([a-zA-Z][\w-]*):nth-of-type\((\d+)\)$/;

// Matches only the selector forms interactions-eval generates: `#id` start and
// `tag:nth-of-type(n)` steps from <html>. nth-of-type counts same-tag siblings only,
// so tags the snapshot skips (script/style/...) never shift the count.
type Tree<N> = { tag: string; attrs: Record<string, string>; children: N[] };
export function findTrigger<N extends Tree<N>>(html: N, byId: Map<string, N>, trigger: string): N | undefined {
  let cur: N | undefined;
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

export function indexById<N extends Tree<N>>(node: N, out: Map<string, N>): Map<string, N> {
  const id = node.attrs.id;
  if (id !== undefined && !out.has(id)) out.set(id, node);
  for (const child of node.children) indexById(child, out);
  return out;
}

export function collectIds(node: Draft, out: Set<string>): void {
  out.add(node.id);
  for (const child of node.children) collectIds(child, out);
}

// ponytail: structuralHash is recomputed per level (O(nodes x depth)); fine under the 20k node cap.
export function collectComponents(node: Draft, out: Map<string, string[]>): void {
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

export function toIRNode(draft: Draft, classMap: Map<string, string[]>, extras: Map<string, Extras>): IRNode {
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
