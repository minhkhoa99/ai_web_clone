// IR <-> GrapesJS editor JSON (spec §10). Pure, plain JSON shapes: no grapesjs import.
// irToGrapes: a page's body (section placeholders replaced by the section roots), IR ids carried in
// attributes["data-ir-id"], attribute values shown as the emitter writes them (local assets). grapesToPatch:
// diffs what the editor sends back by those ids into PatchOps (display values mapped back to the raw IR ones),
// applied with the same applyPatch as the fix loop (applyGrapesSave).
import type { Decl } from "./dedupe";
import { attrRewriter, isScriptValue, pageFileNames, renderStylesheet, type RenderOpts } from "./emit-html";
import { AppError, Codes } from "./errors";
import { applyPatch, syncSections, type IR, type IRNode, type PatchOp } from "./ir";
import { attrsSchema, tagSchema } from "./safe-names";

export type GrapesComponent = {
  tagName?: string;
  type?: string; // "textnode" | "text" (editable) | "svg" / "svg-in" (SVG namespace)
  attributes: Record<string, string>;
  classes: string[];
  components?: GrapesComponent[];
  content?: string;
  name?: string; // layer name: the section name, "Layout chung · …" for a shared layout
};
export type GrapesProject = {
  pageId: string;
  pageFile: string; // the page's out/ file: the canvas is based on it, like the emitted page
  components: GrapesComponent[];
  styles: string; // the clone's stylesheet + effect presets, for the canvas
  bodyClasses: string[];
  pages: { id: string; path: string }[];
  sections: { id: string; pageId: string; name: string; layoutId?: string; component: GrapesComponent }[]; // blocks
  effects: string[]; // captured @keyframes names + presets
};
// What the editor sends back, as GrapesJS serializes it: its components and its CSS rules. Untrusted.
export type GrapesJson = { components: unknown[]; styles?: unknown[] };

const ID = "data-ir-id";
// Not diffed / not shown: our id, GrapesJS-owned class/style/id, and markup the emitter drops anyway.
const SKIP_ATTRS = new Set([ID, "class", "style", "id", "srcdoc"]);
const PRESETS: Record<string, string> = {
  "sp1-fade-in": "@keyframes sp1-fade-in{from{opacity:0}to{opacity:1}}",
  "sp1-slide-up": "@keyframes sp1-slide-up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}",
};
const CSS_PROP = /^-?[a-z][a-z0-9-]*$/;
const CSS_BREAKOUT = /[{};<]/;
const MAX_NODES = 60_000; // 3x the capture node limit: room for edits, bounded work
const MAX_DEPTH = 400;
// GrapesJS omits a tagName equal to its type's default
const TYPE_TAGS: Record<string, string> = {
  link: "a",
  image: "img",
  video: "video",
  iframe: "iframe",
  map: "iframe",
  label: "label",
  script: "script",
  svg: "svg",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tfoot: "tfoot",
  row: "tr",
  cell: "td",
};
// renderStylesheet writes asset urls relative to out/css/; the canvas stylesheet sits beside the page in out/
const CSS_ASSET = /\.\.\/(assets\/[0-9a-f]{64}\.[a-z0-9]{1,8})/g;

type Comp = { tagName?: unknown; type?: unknown; attributes?: unknown; classes?: unknown; components?: unknown; content?: unknown };
type Rule = { selectors?: unknown; style?: unknown; mediaText?: unknown; state?: unknown; atRuleType?: unknown; selectorsAdd?: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeAttr = (tag: string, name: string, value: string) =>
  !SKIP_ATTRS.has(name) && !isScriptValue(tag, name, value) && attrsSchema.safeParse({ [name]: value }).success;
// The emitter's rule (an unsafe tag name or a script is never written), plus no <meta>/<base> in the canvas:
// they would redirect or re-base the editor frame.
const HIDDEN_TAGS = new Set(["script", "meta", "base"]);
const shown = (n: IRNode) => n.tag === "#text" || n.tag === "#section" || (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(n.tag) && !HIDDEN_TAGS.has(n.tag.toLowerCase()));
const bodyOf = (shell: IRNode) => shell.children.find((c) => c.tag === "body") ?? shell;

function pageOf(ir: IR, pageId: string) {
  const page = ir.pages.find((p) => p.id === pageId);
  if (!page) throw new AppError(Codes.IR_PATCH_INVALID, `unknown page: ${pageId}`, { pageId });
  return page;
}

// --- IR -> GrapesJS --------------------------------------------------------------------

export function irToGrapes(ir: IR, pageId: string, opts: RenderOpts): GrapesProject {
  const page = pageOf(ir, pageId);
  const sections = new Map(ir.sections.map((s) => [s.id, s]));
  const rewrite = attrRewriter(ir, opts);
  // base: the url the node's relative urls resolve against (its section's page, else this page), as in the emitter
  const toComponent = (node: IRNode, inSvg: boolean, base: string | undefined): GrapesComponent | null => {
    if (node.tag === "#text") return { type: "textnode", content: node.text ?? "", attributes: {}, classes: [] };
    if (node.tag === "#section") {
      const section = sections.get(node.attrs["data-section"] ?? "");
      if (!section) throw new Error(`grapes: page ${pageId} references unknown section (placeholder ${node.id})`);
      const root = toComponent(section.root, false, opts.pageUrls[section.pageId]);
      return root && { ...root, name: section.layoutId ? `Layout chung · ${section.name}` : section.name };
    }
    if (!shown(node)) return null;
    const attributes: Record<string, string> = { [ID]: node.id };
    for (const [name, value] of Object.entries(node.attrs)) if (safeAttr(node.tag, name, value)) attributes[name] = rewrite(node, name, value, base);
    const svg = inSvg || node.tag === "svg";
    const components = node.children.map((c) => toComponent(c, svg, base)).filter((c) => c !== null);
    const isText = node.children.length > 0 && node.children.every((c) => c.tag === "#text");
    const type = inSvg ? "svg-in" : node.tag === "svg" ? "svg" : isText ? "text" : undefined;
    const classes = [...node.cls, ...Object.values(node.states ?? {}).map((c) => `st-${c}`)];
    return { tagName: node.tag, ...(type ? { type } : {}), attributes, classes, components };
  };
  const body = bodyOf(page.shell);
  const presets = Object.keys(PRESETS);
  const captured = ir.cssom.keyframes.map((k) => /@keyframes\s+([^\s{]+)/.exec(k)?.[1]).filter((n) => n !== undefined);
  return {
    pageId,
    pageFile: pageFileNames(ir.pages).get(pageId)!,
    components: body.children.map((c) => toComponent(c, false, opts.pageUrls[pageId])).filter((c) => c !== null),
    styles: [renderStylesheet(ir, opts).replace(CSS_ASSET, "$1"), ...Object.values(PRESETS)].join("\n"),
    bodyClasses: body.cls,
    pages: ir.pages.map((p) => ({ id: p.id, path: p.path })),
    sections: ir.sections.map((s) => ({
      id: s.id,
      pageId: s.pageId,
      name: s.name,
      ...(s.layoutId ? { layoutId: s.layoutId } : {}),
      component: toComponent(s.root, false, opts.pageUrls[s.pageId])!,
    })),
    effects: [...new Set([...captured, ...presets])],
  };
}

// --- GrapesJS -> PatchOps ---------------------------------------------------------------

// Iterative (no recursion on untrusted input): too many nodes or too deep -> IR_PATCH_INVALID.
function checkBounds(components: unknown[]): void {
  const stack: [unknown, number][] = components.map((c) => [c, 1]);
  let count = 0;
  while (stack.length > 0) {
    const [c, depth] = stack.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) {
      throw new AppError(Codes.IR_PATCH_INVALID, `editor JSON exceeds ${MAX_NODES} nodes or depth ${MAX_DEPTH}`, { count, depth });
    }
    const kids = isObject(c) ? c.components : undefined;
    if (Array.isArray(kids)) for (const k of kids) stack.push([k, depth + 1]);
  }
}

const isTextnode = (c: Comp) => c.type === "textnode";
const textOf = (c: Comp) => (typeof c.content === "string" ? c.content : "");
const tagOf = (c: Comp) =>
  typeof c.tagName === "string" && c.tagName ? c.tagName.toLowerCase() : ((typeof c.type === "string" && Object.hasOwn(TYPE_TAGS, c.type) && TYPE_TAGS[c.type]) || "div");
const kidsOf = (c: Comp): Comp[] =>
  Array.isArray(c.components) ? c.components.filter(isObject) : textOf(c) ? [{ type: "textnode", content: c.content }] : [];
const classesOf = (c: Comp) =>
  (Array.isArray(c.classes) ? c.classes : []).map((k) => (typeof k === "string" ? k : isObject(k) && typeof k.name === "string" ? k.name : "")).filter(Boolean);

function attrsOf(c: Comp): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(c.attributes)) return out;
  for (const [name, raw] of Object.entries(c.attributes)) {
    const value = raw === true ? "" : typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
    if (value !== undefined) out[name] = value;
  }
  return out;
}
const idOf = (c: Comp) => attrsOf(c)[ID];

// Component styles (selectorManager.componentFirst): plain `#<grapes id>` rules, no media/state.
function rulesById(styles: unknown[]): Map<string, Decl> {
  const out = new Map<string, Decl>();
  for (const raw of styles) {
    if (!isObject(raw)) continue;
    const rule = raw as Rule;
    if (rule.mediaText || rule.state || rule.atRuleType || rule.selectorsAdd || !Array.isArray(rule.selectors) || rule.selectors.length !== 1) continue;
    const sel: unknown = rule.selectors[0];
    const id = typeof sel === "string" ? (sel.startsWith("#") ? sel.slice(1) : "") : isObject(sel) && sel.type === 2 && typeof sel.name === "string" ? sel.name : "";
    if (!id || !isObject(rule.style)) continue;
    const decl = out.get(id) ?? {};
    for (const [prop, value] of Object.entries(rule.style)) {
      if (CSS_PROP.test(prop) && typeof value === "string" && value && !CSS_BREAKOUT.test(value)) decl[prop] = value;
    }
    out.set(id, decl);
  }
  return out;
}

export function grapesToPatch(before: IR, pageId: string, json: GrapesJson, opts: RenderOpts): { ops: PatchOp[]; keyframes: string[] } {
  const page = pageOf(before, pageId);
  checkBounds(json.components);
  const index = new Map<string, IRNode>();
  const baseOf = new Map<string, string | undefined>(); // node id -> base url, as irToGrapes rewrote its attrs
  const indexTree = (n: IRNode, base: string | undefined): void => {
    index.set(n.id, n);
    baseOf.set(n.id, base);
    for (const c of n.children) indexTree(c, base);
  };
  for (const s of before.sections) indexTree(s.root, opts.pageUrls[s.pageId]);
  for (const p of before.pages) indexTree(p.shell, opts.pageUrls[p.id]);
  const rewrite = attrRewriter(before, opts);
  // The component's safe attrs; a value still equal to the canvas display of the source's attr maps back to the raw one.
  const attrsFrom = (c: Comp, src: IRNode | undefined, tag: string) => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(attrsOf(c))) {
      if (!safeAttr(tag, name, value)) continue;
      const raw = src && Object.hasOwn(src.attrs, name) ? src.attrs[name] : undefined;
      out[name] = src && raw !== undefined && rewrite(src, name, raw, baseOf.get(src.id)) === value ? raw : value;
    }
    return out;
  };
  const sections = new Map(before.sections.map((s) => [s.id, s]));
  // this page's section roots -> the shell placeholder that shows them
  const placeholderOf = new Map<string, IRNode>();
  const findSlots = (n: IRNode): void => {
    if (n.tag === "#section") {
      const root = sections.get(n.attrs["data-section"] ?? "")?.root;
      if (root) placeholderOf.set(root.id, n);
    }
    n.children.forEach(findSlots);
  };
  findSlots(page.shell);
  const rules = rulesById(json.styles ?? []);

  const ops: PatchOp[] = [];
  const styleOps: PatchOp[] = []; // after the structural ops: they may target nodes a replaceSubtree creates
  const keyframes = new Set<string>();
  const taken = new Set(index.keys());
  const counters = new Map<string, number>();
  const fresh = (parentId: string) => {
    let n = counters.get(parentId) ?? 1;
    while (taken.has(`${parentId}~${n}`)) n++;
    counters.set(parentId, n + 1);
    taken.add(`${parentId}~${n}`);
    return `${parentId}~${n}`;
  };

  const styleFor = (id: string, cls: string[], c: Comp) => {
    const grapesId = attrsOf(c).id;
    const decl = grapesId ? rules.get(grapesId) : undefined;
    if (!decl) return;
    const current = before.classes[cls[0] ?? ""]?.base ?? {};
    const style = Object.fromEntries(Object.entries(decl).filter(([p, v]) => current[p] !== v));
    if (Object.keys(style).length === 0) return;
    styleOps.push({ op: "setStyle", id, style });
    const animation = `${style.animation ?? ""} ${style["animation-name"] ?? ""}`;
    for (const [name, css] of Object.entries(PRESETS)) if (animation.includes(name)) keyframes.add(css);
  };

  // What the editor shows under `node`: renderable children, placeholders swapped for section roots.
  const viewKids = (node: IRNode) =>
    node.children.filter(shown).map((c) => (c.tag === "#section" ? sections.get(c.attrs["data-section"] ?? "")?.root ?? c : c));
  const matches = (n: IRNode, c: Comp) => (n.tag === "#text" ? isTextnode(c) : !isTextnode(c) && idOf(c) === n.id);

  // Same children (by id, text nodes by position) -> recurse; otherwise one replaceSubtree of `node`.
  const diffKids = (node: IRNode, comps: Comp[], inShell: boolean) => {
    const kids = viewKids(node);
    if (kids.length !== comps.length || !kids.every((k, i) => matches(k, comps[i]!))) {
      ops.push({ op: "replaceSubtree", id: node.id, node: { ...node, children: rebuild(node, comps, inShell) } });
      return;
    }
    kids.forEach((k, i) => {
      const c = comps[i]!;
      if (k.tag !== "#text") return diffNode(k, c, inShell && !placeholderOf.has(k.id));
      if (textOf(c) !== (k.text ?? "")) ops.push({ op: "setText", id: k.id, text: textOf(c) });
    });
  };
  const diffNode = (node: IRNode, c: Comp, inShell: boolean) => {
    diffKids(node, kidsOf(c), inShell);
    const attrs = Object.fromEntries(Object.entries(attrsFrom(c, node, node.tag)).filter(([n, v]) => node.attrs[n] !== v));
    if (Object.keys(attrs).length > 0) ops.push({ op: "setAttr", id: node.id, attrs });
    styleFor(node.id, node.cls, c);
  };

  // New children of `parent`: an IR id is kept only for a node that was already under it (applyPatch's
  // duplicate-id rule); moved/copied/new nodes get fresh ids. A section root in the shell becomes its
  // placeholder again and is diffed as the section.
  const rebuild = (parent: IRNode, comps: Comp[], inShell: boolean): IRNode[] => {
    const own = new Set<string>(); // ids of parent's stored subtree (a shell's placeholders, not the sections)
    const collect = (n: IRNode): void => {
      own.add(n.id);
      n.children.forEach(collect);
    };
    collect(parent);
    const used = new Set([parent.id]);
    const convert = (c: Comp, parentId: string): IRNode | null => {
      if (isTextnode(c)) return { id: fresh(parentId), tag: "#text", attrs: {}, text: textOf(c), cls: [], children: [] };
      // the source must be an element the editor showed (not a text/placeholder/script id pasted onto a component)
      const found = index.get(idOf(c) ?? "");
      const src = found && found.tag[0] !== "#" && shown(found) ? found : undefined;
      const slot = src && inShell ? placeholderOf.get(src.id) : undefined;
      if (src && slot && own.has(slot.id) && !used.has(slot.id)) {
        used.add(slot.id);
        diffNode(src, c, false);
        return slot;
      }
      const tag = src?.tag ?? tagOf(c);
      if (!src && !tagSchema.safeParse(tag).success) return null;
      const keep = src !== undefined && own.has(src.id) && !used.has(src.id);
      const id = keep ? src.id : fresh(parentId);
      used.add(id);
      const cls = src?.cls ?? classesOf(c).filter((k) => Object.hasOwn(before.classes, k));
      const node: IRNode = { id, tag, attrs: { ...src?.attrs, ...attrsFrom(c, src, tag) }, cls, children: [] };
      if (src?.states) node.states = src.states;
      if (src?.behavior) node.behavior = src.behavior;
      if (src?.hidden) node.hidden = src.hidden;
      node.children = kidsOf(c)
        .map((k) => convert(k, id))
        .filter((k) => k !== null);
      styleFor(id, cls, c);
      return node;
    };
    return comps.map((c) => convert(c, parent.id)).filter((k) => k !== null);
  };

  const body = bodyOf(page.shell);
  const top = json.components.filter(isObject).filter((c: Comp) => isTextnode(c) || idOf(c) !== undefined);
  diffKids(body, top, true);
  return { ops: [...ops, ...styleOps], keyframes: [...keyframes] };
}

// Save: patch, merge the referenced effect keyframes (deduped), then drop the section references the edit removed.
export function applyGrapesSave(before: IR, pageId: string, json: GrapesJson, opts: RenderOpts): { ir: IR; ops: number } {
  const { ops, keyframes } = grapesToPatch(before, pageId, json, opts);
  const patched = applyPatch(before, ops);
  const ir = { ...patched, cssom: { ...patched.cssom, keyframes: [...new Set([...patched.cssom.keyframes, ...keyframes])] } };
  return { ir: syncSections(ir), ops: ops.length };
}
