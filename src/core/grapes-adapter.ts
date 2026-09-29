// IR <-> GrapesJS editor JSON (spec §10, E1 §2). Pure, plain JSON shapes: no grapesjs import.
// irToGrapes: a page's body of the display view (compileV2 of the document: components resolved, classes derived),
// section placeholders replaced by the section roots, IR ids carried in attributes["data-ir-id"], attribute values
// shown as the emitter writes them (local assets). grapesToCommands: diffs what the editor sends back by those ids
// into E1 editor commands (moves keep IDs, display values mapped back to the raw IR ones), committed through the
// document store like every other edit. GrapesJS is a transitional adapter: E3 emits commands directly.
import type { Decl } from "./dedupe";
import { attrRewriter, compileV2, EFFECT_PRESETS, pageFileNames, renderStylesheet, type RenderOpts } from "./emit-html";
import { AppError, Codes } from "./errors";
import type { IR, IRNode } from "./ir";
import type { EditorCommand, NodeDraft, StyleTarget } from "./ir-command";
import { resolveComponents } from "./ir-component";
import type { IRNodeV2, IRV2, NodeStyles } from "./ir-v2";
import { attrsSchema, isSafeAttr, isSafeCss, isScriptValue, tagSchema } from "./safe-names";

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
// The editor's devices (editor-view widthMedia) write these media: the emitter's 768 / 375 breakpoints.
const MEDIA_TARGETS: Record<string, 768 | 375> = { "(max-width:1439.98px)": 768, "(max-width:767.98px)": 375 };
const STATE_TARGETS = new Set(["hover", "focus", "active"]);

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

function pageOf<P extends { id: string }>(ir: { pages: P[] }, pageId: string): P {
  const page = ir.pages.find((p) => p.id === pageId);
  if (!page) throw new AppError(Codes.IR_PATCH_INVALID, `unknown page: ${pageId}`, { pageId });
  return page;
}

// --- IR -> GrapesJS --------------------------------------------------------------------

// `ir`: the display view of the document, compileV2(doc).
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
  const presets = Object.keys(EFFECT_PRESETS);
  const captured = ir.cssom.keyframes.map((k) => /@keyframes\s+([^\s{]+)/.exec(k)?.[1]).filter((n) => n !== undefined);
  return {
    pageId,
    pageFile: pageFileNames(ir.pages).get(pageId)!,
    components: body.children.map((c) => toComponent(c, false, opts.pageUrls[pageId])).filter((c) => c !== null),
    styles: [renderStylesheet(ir, opts).replace(CSS_ASSET, "$1"), ...Object.values(EFFECT_PRESETS)].join("\n"),
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

// --- GrapesJS -> editor commands -------------------------------------------------------

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

// Component styles (selectorManager.componentFirst): `#<grapes id>` rules by target. A media the devices don't write,
// another state, or a state at a breakpoint has no IR target: listed in `skipped`, never guessed. A cleared
// property ("") is kept as a removal marker.
type Targeted = Map<StyleTarget, Record<string, string>>;
function rulesById(styles: unknown[], skipped: string[]): Map<string, Targeted> {
  const out = new Map<string, Targeted>();
  for (const raw of styles) {
    if (!isObject(raw)) continue;
    const rule = raw as Rule;
    if ((rule.atRuleType && rule.atRuleType !== "media") || rule.selectorsAdd || !Array.isArray(rule.selectors) || rule.selectors.length !== 1) continue;
    const sel: unknown = rule.selectors[0];
    const id = typeof sel === "string" ? (sel.startsWith("#") ? sel.slice(1) : "") : isObject(sel) && sel.type === 2 && typeof sel.name === "string" ? sel.name : "";
    if (!id || !isObject(rule.style)) continue;
    const media = typeof rule.mediaText === "string" ? rule.mediaText.replace(/\s+/g, "") : "";
    const state = typeof rule.state === "string" ? rule.state : "";
    const bp = media ? MEDIA_TARGETS[media] : "base";
    const target: StyleTarget | undefined = !bp ? undefined : !state ? bp : bp === "base" && STATE_TARGETS.has(state) ? (state as StyleTarget) : undefined;
    if (target === undefined) {
      if (Object.keys(rule.style).length) skipped.push(`#${id.slice(0, 40)}${state ? `:${state.slice(0, 40)}` : ""} ${media.slice(0, 80)}`.trim());
      continue;
    }
    const byTarget: Targeted = out.get(id) ?? new Map();
    const decl = byTarget.get(target) ?? {};
    for (const [prop, value] of Object.entries(rule.style)) if (value === "" || isSafeCss(prop, value)) decl[prop] = value as string;
    byTarget.set(target, decl);
    out.set(id, byTarget);
  }
  return out;
}
const styleAt = (styles: NodeStyles | undefined, t: StyleTarget): Decl =>
  (!styles ? undefined : t === "base" ? styles.base : t === 768 || t === 375 ? styles.bp[t] : t === "before" || t === "after" ? styles.pseudo[t] : styles.state[t]) ?? {};
function withStyleAt(styles: NodeStyles, t: StyleTarget, decl: Decl): void {
  if (t === "base") styles.base = decl;
  else if (t === 768 || t === 375) styles.bp[t] = decl;
  else if (t === "before" || t === "after") styles.pseudo[t] = decl;
  else styles.state[t] = decl;
}
// A copy of `styles` with only declarations the command core accepts.
function safeStyles(styles: NodeStyles | undefined): NodeStyles {
  const out: NodeStyles = { base: {}, bp: {}, state: {}, pseudo: {} };
  if (!styles) return out;
  const safe = (d: Decl) => Object.fromEntries(Object.entries(d).filter(([p, v]) => isSafeCss(p, v)));
  out.base = safe(styles.base);
  for (const group of ["bp", "state", "pseudo"] as const) {
    for (const [key, decl] of Object.entries(styles[group])) {
      const kept = safe(decl ?? {});
      if (Object.keys(kept).length) (out[group] as Record<string, Decl>)[key] = kept;
    }
  }
  return out;
}

// resolveComponents shows a main's node that an instance has no counterpart for under
// `instance:<root length>:<instance root id>:<main node id>`: not a document id. Edits on it go to that main node.
function mainIdOf(id: string): string | undefined {
  const m = /^instance:(\d+):/.exec(id);
  if (!m) return undefined;
  const end = m[0].length + Number(m[1]);
  return id[end] === ":" ? id.slice(end + 1) : undefined;
}

export type CommandOpts = RenderOpts & { skipped?: string[] }; // skipped: style rules with no IR target (shown to the user)

// `before`: the document at the revision the editor loaded. Commands only name document IDs (page nodes, section
// placeholders, component mains): never a generated instance ID, never replaceSubtree.
export function grapesToCommands(before: IRV2, pageId: string, json: GrapesJson, opts: CommandOpts): EditorCommand[] {
  pageOf(before, pageId);
  checkBounds(json.components);
  const view = compileV2(before); // what irToGrapes showed
  const rewrite = attrRewriter(view, opts);
  const rules = rulesById(json.styles ?? [], opts.skipped ?? []);

  // the display view: every node of every page (copy sources), with the base url irToGrapes rewrote its attrs against
  const viewAll = new Map<string, IRNode>();
  const baseOf = new Map<string, string | undefined>();
  const indexView = (n: IRNode, base: string | undefined): void => {
    viewAll.set(n.id, n);
    baseOf.set(n.id, base);
    n.children.forEach((c) => indexView(c, base));
  };
  view.sections.forEach((s) => indexView(s.root, opts.pageUrls[s.pageId]));
  view.pages.forEach((p) => indexView(p.shell, opts.pageUrls[p.id]));
  const resolved = new Map<string, IRNodeV2>(); // the same nodes resolved in v2: types, hidden and styles as shown
  const indexResolved = (n: IRNodeV2): void => {
    resolved.set(n.id, n);
    n.children.forEach(indexResolved);
  };
  const shownDoc = resolveComponents(before);
  shownDoc.sections.forEach((s) => indexResolved(s.root));
  shownDoc.pages.forEach((p) => indexResolved(p.shell));

  // the document: node, parent and tree (a node never changes tree: section root, page shell or component main)
  const docNode = new Map<string, IRNodeV2>();
  const docParent = new Map<string, string>();
  const docTree = new Map<string, string>();
  const indexDoc = (n: IRNodeV2, tree: string): void => {
    docNode.set(n.id, n);
    docTree.set(n.id, tree);
    for (const c of n.children) {
      docParent.set(c.id, n.id);
      indexDoc(c, tree);
    }
  };
  before.sections.forEach((s) => indexDoc(s.root, `section:${s.id}`));
  before.pages.forEach((p) => indexDoc(p.shell, `page:${p.id}`));
  before.components.forEach((c) => indexDoc(c.root, `component:${c.id}`));

  // this page as shown: section roots stand in for their placeholders (`slot`), generated nodes take their parent's tree
  const sections = new Map(view.sections.map((s) => [s.id, s]));
  const slot = new Map<string, string>(); // section root id -> its placeholder on this page
  const shownKids = (n: IRNode) =>
    n.children.filter(shown).map((c) => {
      if (c.tag !== "#section") return c;
      const root = sections.get(c.attrs["data-section"] ?? "")?.root;
      if (!root) throw new AppError(Codes.IR_PATCH_INVALID, `page ${pageId} references an unknown section (placeholder ${c.id})`);
      slot.set(root.id, c.id);
      return root;
    });
  const slotId = (id: string) => slot.get(id) ?? id;
  const onPage = new Map<string, IRNode>();
  const treeOf = new Map<string, string>(); // the tree a shown node's slot lives in
  const indexPage = (n: IRNode): void => {
    for (const c of shownKids(n)) {
      onPage.set(c.id, c);
      treeOf.set(c.id, docTree.get(slotId(c.id)) ?? treeOf.get(n.id)!);
      if (c.tag !== "#text") indexPage(c);
    }
  };
  const body = bodyOf(pageOf(view, pageId).shell);
  treeOf.set(body.id, `page:${pageId}`);
  indexPage(body);
  const ownTree = (id: string) => docTree.get(id) ?? treeOf.get(id); // the tree a node's children live in
  // property edits: a document node itself; a generated instance node -> its main node
  const targetId = (id: string): string => {
    if (docNode.has(id)) return id;
    const main = mainIdOf(id);
    if (main && docNode.has(main)) return main;
    throw new AppError(Codes.IR_PATCH_INVALID, `editor node ${id.slice(0, 200)} is not in the document`);
  };

  const out: EditorCommand[] = [];
  const claimed = new Set<string>(); // shown nodes this save keeps (the rest are deleted)
  // the document's children lists as the commands so far leave them (indices count unshown nodes: script, meta…)
  const simKids = new Map<string, string[]>();
  const simParent = new Map<string, string>();
  const kidsNow = (pid: string) => {
    let list = simKids.get(pid);
    if (!list) {
      list = (docNode.get(pid)?.children ?? []).map((c) => c.id).filter((c) => (simParent.get(c) ?? pid) === pid);
      simKids.set(pid, list);
      for (const c of list) simParent.set(c, pid);
    }
    return list;
  };
  const parentNow = (id: string) => simParent.get(id) ?? docParent.get(id)!;

  // The component's safe attrs; a value still equal to the canvas display of the source's attr maps back to the raw one.
  const attrsFrom = (c: Comp, src: IRNode | undefined, tag: string) => {
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(attrsOf(c))) {
      if (!safeAttr(tag, name, value)) continue;
      const raw = src && Object.hasOwn(src.attrs, name) ? src.attrs[name] : undefined;
      attrs[name] = src && raw !== undefined && rewrite(src, name, raw, baseOf.get(src.id)) === value ? raw : value;
    }
    return attrs;
  };
  const rulesOf = (c: Comp): Targeted => rules.get(attrsOf(c).id ?? "") ?? new Map();

  // A new subtree: a copy of a shown element keeps its raw attrs, type and resolved styles; IDs come from the server.
  const draftOf = (c: Comp): NodeDraft | null => {
    if (isTextnode(c)) return { tag: "#text", text: textOf(c) };
    const found = viewAll.get(idOf(c) ?? "");
    const src = found && found.tag[0] !== "#" && shown(found) ? found : undefined;
    const tag = src?.tag ?? tagOf(c);
    if (tag === "#text" || !tagSchema.safeParse(tag).success) return null;
    const source = src && resolved.get(src.id);
    const styles = safeStyles(source?.styles);
    for (const [t, decl] of rulesOf(c)) {
      const into = { ...styleAt(styles, t) };
      for (const [prop, value] of Object.entries(decl)) if (value === "") delete into[prop]; else into[prop] = value;
      withStyleAt(styles, t, into);
    }
    const attrs = Object.fromEntries(Object.entries(attrsFrom(c, src, tag)).filter(([n, v]) => isSafeAttr(tag, n, v)));
    const children = kidsOf(c).map(draftOf).filter((k) => k !== null);
    return { tag, ...(source && { type: source.type }), attrs, styles, children, ...(source?.hidden && { hidden: true }) };
  };

  // Children of a shown node `p`: kept (by data-ir-id, a #text by position) or created, put in order with moveNode /
  // createNode against the simulated lists. Deletes come last: a kept node may still have to leave a deleted parent.
  const diffKids = (p: IRNode, comps: Comp[]) => {
    const now = shownKids(p);
    const texts = now.filter((k) => k.tag === "#text");
    let t = 0;
    const items = comps.map((c): { keep?: IRNode; comp: Comp } => {
      if (isTextnode(c)) {
        const keep = texts[t++];
        if (keep) claimed.add(keep.id);
        return { keep, comp: c };
      }
      const v = onPage.get(idOf(c) ?? "");
      if (!v || v.tag === "#text" || claimed.has(v.id) || treeOf.get(v.id) !== ownTree(p.id)) return { comp: c }; // a copy
      claimed.add(v.id);
      return { keep: v, comp: c };
    });
    if (items.length !== now.length || items.some((it, i) => it.keep !== now[i])) {
      const doc = docNode.get(p.id);
      if (!doc || doc.component?.role === "instance") {
        throw new AppError(Codes.IR_PATCH_INVALID, `the structure inside component instance ${p.id.slice(0, 200)} can't be edited here: edit its content, or detach it first`);
      }
      if (docTree.get(p.id)!.startsWith("page:") && items.some((it) => !it.keep)) {
        throw new AppError(Codes.IR_PATCH_INVALID, "the page body only holds sections: drop new elements inside a section");
      }
      const wanted = new Set(items.flatMap((it) => (it.keep ? [slotId(it.keep.id)] : [])));
      let prev: string | undefined;
      const start = () => (prev === undefined ? 0 : kidsNow(p.id).indexOf(prev) + 1);
      for (const it of items) {
        if (!it.keep) {
          const draft = draftOf(it.comp);
          if (!draft) continue;
          const index = start();
          out.push({ op: "createNode", parentId: p.id, index, draft });
          prev = `\u0000new${out.length}`; // stands in for the id the server allocates
          kidsNow(p.id).splice(index, 0, prev);
          continue;
        }
        const x = slotId(it.keep.id);
        if (parentNow(x) === p.id) {
          const list = kidsNow(p.id), at = list.indexOf(x), from = start();
          if (at >= from && list.slice(from, at).every((id) => !wanted.has(id))) {
            prev = x; // already after the previous kept node: no move
            continue;
          }
        }
        const old = kidsNow(parentNow(x));
        old.splice(old.indexOf(x), 1); // moveNode's index counts after the node is lifted out
        const index = start();
        kidsNow(p.id).splice(index, 0, x);
        simParent.set(x, p.id);
        out.push({ op: "moveNode", id: x, parentId: p.id, index });
        prev = x;
      }
    }
    for (const it of items) {
      if (!it.keep) continue;
      if (it.keep.tag !== "#text") diffNode(it.keep, it.comp);
      else if (textOf(it.comp) !== (it.keep.text ?? "")) out.push({ op: "setText", id: targetId(it.keep.id), text: textOf(it.comp) });
    }
  };

  const diffNode = (v: IRNode, c: Comp) => {
    diffKids(v, kidsOf(c));
    const id = targetId(v.id);
    const attrs = attrsFrom(c, v, v.tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (v.attrs[name] !== value && isSafeAttr(v.tag, name, value)) out.push({ op: "setAttribute", id, name, value });
    }
    for (const [name, value] of Object.entries(v.attrs)) {
      if (safeAttr(v.tag, name, value) && !Object.hasOwn(attrs, name)) out.push({ op: "setAttribute", id, name, value: null });
    }
    const shownNode = resolved.get(v.id);
    for (const [target, decl] of rulesOf(c)) {
      const was = styleAt(shownNode?.styles, target);
      const changes: Record<string, string | null> = {};
      for (const [prop, value] of Object.entries(decl)) {
        if (value === "") {
          if (Object.hasOwn(was, prop)) changes[prop] = null;
        } else if (was[prop] !== value) changes[prop] = value;
      }
      if (Object.keys(changes).length) out.push({ op: "setStyle", id, target, changes });
      // the Layers eye writes display:none on the base rule: the node is hidden (the style keeps it hidden in the output)
      if (target === "base" && changes.display === "none" && !shownNode?.hidden) out.push({ op: "setHidden", id, hidden: true });
    }
  };

  // the body's children: sections (and shell nodes); stray id-less components are not part of the page
  diffKids(body, json.components.filter(isObject).filter((c: Comp) => isTextnode(c) || idOf(c) !== undefined));
  const deletes = (n: IRNode): void => {
    for (const k of shownKids(n)) {
      if (!claimed.has(k.id)) out.push({ op: "deleteNode", id: slotId(k.id) });
      else if (k.tag !== "#text") deletes(k);
    }
  };
  deletes(body);
  return out;
}
