import type { CaptureNode, PageCapture } from "./capture";
import type { Decl, StyleSet } from "./dedupe";
import { AppError, Codes } from "./errors";
import { buildFidelity, capFidelity } from "./fidelity";
import { alignChildren, isLoopClone } from "./ir-build";
import type { InteractiveSpec } from "./interactive";
import type { LegacyIR, LegacyIRNode, LegacyPage, LegacySection } from "./ir-legacy";

export type NodeStyles = {
  base: Decl;
  bp: Partial<Record<768 | 375, Decl>>;
  state: Partial<Record<"hover" | "focus" | "active", Decl>>;
  pseudo: Partial<Record<"before" | "after", Decl>>;
};
export type NodeType = "container" | "text" | "image" | "link" | "button" | "input" | "media" | "svg" | "component-root";
export type IRNodeV2 = {
  id: string;
  parentId?: string;
  tag: string;
  type: NodeType;
  name?: string;
  attrs: Record<string, string>;
  text?: string;
  children: IRNodeV2[];
  hidden?: boolean;
  styles: NodeStyles;
  box?: Partial<Record<1440 | 768 | 375, [number, number, number, number]>>;
  component?: { id: string; role: "main" | "instance"; sourceId?: string; overrides?: string[] };
  behavior?: string;
  interactive?: InteractiveSpec;
};
export type FidelityItem = {
  pageId: string;
  feature: string;
  status: "supported" | "partial" | "unsupported";
  nodeId?: string;
  breakpoint?: 1440 | 768 | 375;
  sourceRef?: string;
  note: string;
};
export type IRV2 = Omit<LegacyIR, "pages" | "sections" | "classes" | "components"> & {
  version: 2;
  revision: number;
  pages: (Omit<LegacyPage, "shell"> & { shell: IRNodeV2 })[];
  sections: (Omit<LegacySection, "root"> & { root: IRNodeV2 })[];
  components: { id: string; root: IRNodeV2; instanceIds: string[] }[];
  fidelity: FidelityItem[];
};

const TYPES: Record<string, NodeType> = {
  "#text": "text", img: "image", picture: "image", a: "link", button: "button",
  h1: "text", h2: "text", h3: "text", h4: "text", h5: "text", h6: "text",
  p: "text", span: "text", strong: "text", em: "text", small: "text",
  label: "text", blockquote: "text", code: "text", pre: "text",
  input: "input", textarea: "input", select: "input", option: "input",
  video: "media", audio: "media", canvas: "media", iframe: "media", svg: "svg",
};
export const typeOf = (tag: string): NodeType => TYPES[tag.toLowerCase()] ?? "container";

type Boxes = Map<string, Partial<Record<1440 | 768 | 375, { tag: string; bbox: CaptureNode["bbox"] }>>>;

export function toV2(legacy: LegacyIR, captures: PageCapture[]): IRV2 {
  const boxes: Boxes = new Map();
  const quiet = new Set<string>(); // "id|bp": a loop clone / text node a keyed parent left without counterpart (no box note)
  const available = new Map(captures.map((capture) => [capture.pageId, new Set(capture.breakpoints.map((entry) => entry.bp))]));
  // Boxes follow the IR's own breakpoint alignment (alignChildren: by slide key where toDraft keyed the children,
  // else by path), so a slide's 768/375 box is its own even when the duplicate counts differ.
  for (const capture of captures) {
    const primary = capture.breakpoints.find((b) => b.bp === 1440) ?? capture.breakpoints[0];
    if (!primary) continue;
    type At = [bp: number, node: CaptureNode | undefined];
    const visit = (node: CaptureNode, path: string, at: At[]): void => {
      const id = `${capture.pageId}:${path}`;
      const entry = boxes.get(id) ?? {};
      for (const [bp, n] of [[primary.bp, node] as At, ...at]) if (n && (bp === 1440 || bp === 768 || bp === 375)) entry[bp] = { tag: n.tag, bbox: n.bbox };
      boxes.set(id, entry);
      const kids = at.map(([bp, o]): [number, (CaptureNode | undefined)[] | undefined] => {
        const a = o && alignChildren(node, o);
        if (a?.keyed) node.children.forEach((c, i) => { if (!a.kids[i] && (c.tag === "#text" || isLoopClone(c))) quiet.add(`${capture.pageId}:${path}.${i}|${bp}`); });
        return [bp, o && (a?.kids ?? o.children)];
      });
      node.children.forEach((child, i) => visit(child, `${path}.${i}`, kids.map(([bp, k]): At => [bp, k?.[i]])));
    };
    visit(primary.dom, "0", capture.breakpoints.filter((b) => b !== primary).map((b): At => [b.bp, b.dom]));
  }

  const classOf = (name: string): StyleSet => {
    const style = legacy.classes[name];
    if (!style) throw new AppError(Codes.IR_PATCH_INVALID, `missing class: ${name}`);
    return style;
  };
  const convert = (node: LegacyIRNode, parentId?: string): IRNodeV2 => {
    const styles: NodeStyles = { base: {}, bp: {}, state: {}, pseudo: {} };
    for (const name of node.cls) {
      const style = classOf(name);
      Object.assign(styles.base, style.base);
      for (const bp of [768, 375] as const) if (style.media?.[bp]) styles.bp[bp] = { ...styles.bp[bp], ...style.media[bp] };
      for (const pseudo of ["before", "after"] as const) if (style[pseudo]) styles.pseudo[pseudo] = { ...styles.pseudo[pseudo], ...style[pseudo] };
    }
    for (const state of ["hover", "focus", "active"] as const) {
      const name = node.states?.[state];
      if (name) styles.state[state] = { ...classOf(name).base };
    }
    const out: IRNodeV2 = {
      id: node.id, tag: node.tag, type: typeOf(node.tag), attrs: { ...node.attrs }, styles,
      children: node.children.map((child) => convert(child, node.id)),
    };
    if (parentId !== undefined) out.parentId = parentId;
    if (node.text !== undefined) out.text = node.text;
    if (node.hidden !== undefined) out.hidden = node.hidden;
    if (node.behavior !== undefined) out.behavior = node.behavior;
    const matches = boxes.get(node.id);
    if (matches) {
      const box: NonNullable<IRNodeV2["box"]> = {};
      for (const bp of [1440, 768, 375] as const) if (matches[bp]?.tag === node.tag) box[bp] = [...matches[bp].bbox];
      if (Object.keys(box).length) out.box = box;
    }
    return out;
  };
  const result: IRV2 = {
    version: 2, revision: 0,
    pages: legacy.pages.map((page) => ({ ...page, shell: convert(page.shell) })),
    sections: legacy.sections.map((section) => ({ ...section, root: convert(section.root) })),
    layouts: legacy.layouts.map((layout) => ({ ...layout })),
    components: [], tokens: { ...legacy.tokens },
    cssom: { keyframes: [...legacy.cssom.keyframes], fontFace: [...legacy.cssom.fontFace], vars: { ...legacy.cssom.vars } },
    interactions: legacy.interactions.map((interaction) => ({ ...interaction })), fidelity: [],
  };
  for (const page of result.pages) {
    const breakpoints = available.get(page.id);
    for (const bp of [1440, 768, 375] as const) {
      if (breakpoints?.has(bp)) continue;
      result.fidelity.push({ pageId: page.id, feature: "capture-box", status: "partial", breakpoint: bp, note: `missing capture at ${bp}` });
    }
  }
  const check = (node: IRNodeV2, pageId: string, skip: ReadonlySet<number> = new Set()): void => {
    const matches = boxes.get(node.id);
    const mute = new Set([...skip, ...([768, 375] as const).filter((bp) => quiet.has(`${node.id}|${bp}`))]); // and its subtree
    for (const bp of [1440, 768, 375] as const) {
      if (!available.get(pageId)?.has(bp) || node.tag === "#section" || mute.has(bp)) continue;
      if (matches?.[bp]?.tag === node.tag) continue;
      result.fidelity.push({ pageId, feature: "capture-box", status: "partial", nodeId: node.id, breakpoint: bp, sourceRef: node.id, note: `capture path or tag mismatch at ${bp}` });
    }
    for (const child of node.children) check(child, pageId, mute);
  };
  for (const page of result.pages) check(page.shell, page.id);
  for (const section of result.sections) check(section.root, section.pageId);
  result.fidelity = capFidelity([...result.fidelity, ...buildFidelity(captures, result)]);
  return result;
}
