// E3 §1/§5: what the visual editor reads for one page (the canvas document, the resolved page tree, fonts, effects,
// the page list) and the partial update after a step (the sections of that page a batch changed, R2–R4).
// Pure: compile + render, no I/O.
import { compileV2, EFFECT_PRESETS, pageFileNames, renderCanvasCss, renderCanvasPage, renderSectionsHtml, type CanvasUrls, type RenderOpts } from "./emit-html";
import { panelComponents, type PanelComponent } from "./interactive";
import { resolveComponents } from "./ir-component";
import type { LegacyIR } from "./ir-legacy";
import type { IRNodeV2, IRV2 } from "./ir-v2";

export const MAX_AFFECTED_SECTIONS = 20;
const MAX_FONTS = 50;
export type CanvasSection = { id: string; name: string; layoutId?: string; root: IRNodeV2 };
export type CanvasPage = { id: string; file: string; html: string; shell: IRNodeV2; sections: CanvasSection[] };
export type CanvasPayload = { pages: { id: string; path: string }[]; page: CanvasPage; css: string; fonts: string[]; effects: string[] };
export type Affected = { sections: { id: string; html: string; root: IRNodeV2 }[]; css: string; shellChanged: boolean; interactives: PanelComponent[] };

// The sections a page shows, in shell order (its placeholders), each once.
export function pageSectionIds(ir: Pick<IRV2, "pages">, pageId: string): string[] {
  const out: string[] = [];
  const visit = (n: IRNodeV2): void => {
    const ref = n.tag === "#section" ? n.attrs["data-section"] : undefined;
    if (ref && !out.includes(ref)) out.push(ref);
    n.children.forEach(visit);
  };
  const page = ir.pages.find((p) => p.id === pageId);
  if (page) visit(page.shell);
  return out;
}

const sectionsOf = (resolved: IRV2, pageId: string): CanvasSection[] => {
  const byId = new Map(resolved.sections.map((s) => [s.id, s]));
  return pageSectionIds(resolved, pageId).flatMap((sid) => {
    const s = byId.get(sid);
    return s ? [{ id: s.id, name: s.name, ...(s.layoutId !== undefined && { layoutId: s.layoutId }), root: s.root }] : [];
  });
};

export function canvasPayload(doc: IRV2, pageId: string, opts: RenderOpts, urls: (file: string) => CanvasUrls, view: LegacyIR = compileV2(doc)): CanvasPayload {
  const resolved = resolveComponents(doc);
  const page = resolved.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`canvas: unknown page ${pageId}`);
  const file = pageFileNames(doc.pages).get(pageId)!;
  return {
    pages: doc.pages.map((p) => ({ id: p.id, path: p.path })),
    page: { id: pageId, file, html: renderCanvasPage(view, pageId, opts, urls(file)), shell: page.shell, sections: sectionsOf(resolved, pageId) },
    css: renderCanvasCss(view, opts),
    fonts: pageFonts(doc),
    effects: pageEffects(view),
  };
}

// R4: a section changed when its compiled root differs. Compiled, not just resolved: compileV2 also writes roles from
// specs in other sections (a modal trigger, a dropdown panel) and class names that a hash collision elsewhere can
// widen. The page itself (shell, title, meta, section order) changing or more than 20 sections -> the client reloads.
export function affectedOf(before: IRV2, after: IRV2, pageId: string, opts: RenderOpts): Affected {
  const va = compileV2(before), vb = compileV2(after);
  const json = (x: unknown) => JSON.stringify(x);
  const interactives = panelComponents(after, pageId);
  const pa = va.pages.find((p) => p.id === pageId), pb = vb.pages.find((p) => p.id === pageId);
  const reload: Affected = { sections: [], css: "", shellChanged: true, interactives };
  if (!pa || !pb || json(pa) !== json(pb)) return reload;
  const rootIn = (view: LegacyIR, id: string) => view.sections.find((s) => s.id === id)?.root;
  const changed = pageSectionIds(after, pageId).filter((id) => json(rootIn(va, id)) !== json(rootIn(vb, id)));
  if (changed.length > MAX_AFFECTED_SECTIONS) return reload;
  const resolved = new Map(resolveComponents(after).sections.map((s) => [s.id, s.root]));
  const html = renderSectionsHtml(vb, changed, opts);
  return { sections: changed.map((id) => ({ id, html: html.get(id)!, root: resolved.get(id)! })), css: renderCanvasCss(vb, opts), shellChanged: false, interactives };
}

const FAMILY = /font-family\s*:\s*([^;}]+)/gi;
const firstFamily = (value: string) => value.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
// The font families the page knows (@font-face + node styles), for the Style Manager's typography (E3b). Bounded.
export function pageFonts(doc: IRV2): string[] {
  const out = new Set<string>();
  for (const rule of doc.cssom.fontFace) for (const m of rule.matchAll(FAMILY)) out.add(firstFamily(m[1]!));
  const visit = (n: IRNodeV2): void => {
    for (const d of [n.styles.base, ...Object.values(n.styles.bp)]) if (d?.["font-family"]) out.add(firstFamily(d["font-family"]));
    n.children.forEach(visit);
  };
  doc.sections.forEach((s) => visit(s.root));
  doc.pages.forEach((p) => visit(p.shell));
  return [...out].filter(Boolean).sort().slice(0, MAX_FONTS);
}
// captured @keyframes names + the editor presets (the Hiệu ứng tab)
export const pageEffects = (view: LegacyIR): string[] => [
  ...new Set([...view.cssom.keyframes.map((k) => /@keyframes\s+([^\s{]+)/.exec(k)?.[1]).filter((x) => x !== undefined), ...Object.keys(EFFECT_PRESETS)]),
];
