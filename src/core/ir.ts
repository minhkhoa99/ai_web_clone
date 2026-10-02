// Pure: PageCapture[] -> IR v2 (E1 §1), and the section/layout reference helpers. No fs/network/db/Date/random.
import type { PageCapture } from "./capture";
import type { Interaction } from "./interactions";
import type { LegacyIR, LegacyLayout, LegacySection } from "./ir-legacy";
import { attachInteractives } from "./interactive-build";
import { migrateIR } from "./ir-migrate";
import type { IRNodeV2, IRV2 } from "./ir-v2";
import { dedupeStyles, extractTokens, structuralHash, type StyledNode } from "./dedupe";
import { AppError, Codes } from "./errors";
import {
  collectComponents,
  collectIds,
  contentHash,
  findTrigger,
  indexById,
  sectionPlaceholder,
  selectorIds,
  splitSections,
  toDraft,
  toIRNode,
  toShell,
  type Draft,
  type Extras,
  type Walk,
} from "./ir-build";

// The document is IR v2 everywhere (E1 §1); v1 (ir-legacy.ts) is only the builder's output and the migration input.
export type IR = IRV2;
export type IRNode = IRNodeV2;
export type Section = IRV2["sections"][number];
export type Page = IRV2["pages"][number];
export type Layout = LegacyLayout;

type DraftSection = Omit<LegacySection, "root"> & { root: Draft; content: string };

const BEHAVIOR_KINDS = new Set<Interaction["kind"]>(["menu", "tab", "accordion", "modal", "carousel", "sticky"]);

function pagePath(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

// The capture -> class-based v1 IR builder: kept only as buildIR's first step (and the migration tests' fixture).
export function buildLegacyIR(captures: PageCapture[]): LegacyIR {
  const parsed = captures.map((capture) => {
    const dom = (bp: number) => capture.breakpoints.find((b) => b.bp === bp)?.dom;
    const walk: Walk = { pageId: capture.pageId, canvasAssets: new Map(capture.dynamic.map((d) => [d.order, d.asset])), canvasSeen: 0 };
    const primary = dom(1440) ?? capture.breakpoints[0]!.dom;
    const html = toDraft(primary, "0", dom(768), dom(375), walk);
    const idOf = selectorIds(primary, capture.pageId);
    const carousels = new Set((capture.interactives ?? []).flatMap((r) => (r.kind === "carousel" ? [idOf(r.selector) ?? ""] : [])));
    const sections: DraftSection[] = splitSections(html, carousels).map(({ role, root }, i) => ({
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
  const layouts: LegacyLayout[] = [];
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

// IR v2 with the class-based builder's output migrated in memory (E1 §6): same section/layout/node IDs as v1; capture
// records and structural guesses become components (E2 §3).
export function buildIR(captures: PageCapture[]): IR {
  return attachInteractives(migrateIR(buildLegacyIR(captures), captures), captures);
}

// The section/layout references IR v2 shares with the renderer's v1 view (compileV2), which the editor adapter also
// edits: both helpers take either and return the same shape.
type RefNode = { tag: string; attrs: Record<string, string>; text?: string; children: RefNode[] };
type Refs = { pages: { id: string; sectionIds: string[]; shell: RefNode }[]; sections: { id: string; hash: string; root: RefNode; layoutId?: string }[]; layouts: LegacyLayout[] };

// "Gộp thành layout" (spec §10): the first selected section becomes a shared layout (stored once, like
// buildIR's layouts); every other selected section, one per page, is dropped and the placeholders that
// showed it now show the layout.
export function promoteLayout<T extends Refs>(ir: T, sectionIds: string[]): T {
  const invalid = (message: string) => new AppError(Codes.IR_PATCH_INVALID, message, { sectionIds });
  const byId = new Map(ir.sections.map((s) => [s.id, s]));
  const selected = sectionIds.map((id) => {
    const section = byId.get(id);
    if (!section) throw invalid(`unknown section: ${id}`);
    return section;
  });
  if (selected.length < 2) throw invalid("a layout needs at least 2 sections");
  // a layout section is shown on every page of its layout: no page may show two of the selected sections
  const seen = new Set<string>();
  for (const s of selected) {
    for (const page of ir.pages) {
      if (!page.sectionIds.includes(s.id)) continue;
      if (seen.has(page.id)) throw invalid(`selected sections must be on different pages (page ${page.id} shows two)`);
      seen.add(page.id);
    }
  }
  const [first, ...rest] = selected as [Refs["sections"][number], ...Refs["sections"]];
  const dropped = new Set(rest.map((s) => s.id));
  const layoutId = `layout-${contentHash(first.root)}`;
  const layouts = ir.layouts.filter((l) => l.sectionId !== first.id && !dropped.has(l.sectionId));
  if (layouts.some((l) => l.id === layoutId)) throw invalid(`layout id already used: ${layoutId}`);

  const repoint = (node: RefNode): RefNode =>
    node.tag === "#section" && dropped.has(node.attrs["data-section"] ?? "")
      ? { ...node, attrs: { ...node.attrs, "data-section": first.id } }
      : { ...node, children: node.children.map(repoint) };
  const pages = ir.pages.map((p) => ({ ...p, sectionIds: p.sectionIds.map((id) => (dropped.has(id) ? first.id : id)), shell: repoint(p.shell) }));
  const pageIds = pages.filter((p) => p.sectionIds.includes(first.id)).map((p) => p.id);
  return {
    ...ir,
    pages,
    sections: ir.sections.filter((s) => !dropped.has(s.id)).map((s) => (s === first ? { ...s, layoutId } : s)),
    layouts: [...layouts, { id: layoutId, hash: first.hash, sectionId: first.id, pageIds }],
  } as T; // repoint copies each node with only data-section changed: the node type is kept
}

// Pure. Section references follow the page shells after an editor save: a page's sectionIds are its placeholders
// (shell order), a layout's pageIds the pages still showing it; a section no page shows is dropped with its layout.
export function syncSections<T extends Refs>(ir: T): T {
  const known = new Set(ir.sections.map((s) => s.id));
  const slots = (node: RefNode, out: Set<string>): Set<string> => {
    const id = node.attrs["data-section"] ?? "";
    if (node.tag === "#section" && known.has(id)) out.add(id);
    for (const child of node.children) slots(child, out);
    return out;
  };
  const pages = ir.pages.map((p) => ({ ...p, sectionIds: [...slots(p.shell, new Set())] }));
  const shownOn = (sectionId: string) => pages.filter((p) => p.sectionIds.includes(sectionId)).map((p) => p.id);
  const shown = new Set(pages.flatMap((p) => p.sectionIds));
  return {
    ...ir,
    pages,
    sections: ir.sections.filter((s) => shown.has(s.id)),
    layouts: ir.layouts.filter((l) => shown.has(l.sectionId)).map((l) => ({ ...l, pageIds: shownOn(l.sectionId) })),
  };
}
