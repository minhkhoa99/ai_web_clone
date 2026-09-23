// Pure helpers for buildIR (ir.ts): capture tree -> Draft, section split, shell,
// trigger matching, components. No fs/network/db/Date/random.
import type { CaptureNode } from "./capture";
import { hash6, structuralHash, type Decl, type StyleSet, type StyledNode } from "./dedupe";
import type { IRNode } from "./ir";

export type Draft = StyledNode & { text?: string; hidden?: boolean; children: Draft[] };
export type Extras = Pick<IRNode, "states" | "behavior">;
export type Walk = { pageId: string; canvasAssets: Map<number, string>; canvasSeen: number };

const MAX_UNWRAP = 3;
const MIN_COMPONENT_SIBLINGS = 3;
const LANDMARK_TAGS = new Set(["header", "nav", "footer"]);
const LANDMARK_ROLES: Record<string, string> = { banner: "header", navigation: "nav", contentinfo: "footer" };

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
// `main` contributes each element child. Body, wrappers and main stay in the page shell.
export function splitSections(html: Draft): { role: string; root: Draft }[] {
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
export function findTrigger(html: Draft, byId: Map<string, Draft>, trigger: string): Draft | undefined {
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

export function indexById(node: Draft, out: Map<string, Draft>): Map<string, Draft> {
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
