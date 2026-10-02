// E2 §3 -> IR: capture records (config / observed / hover) become specs on the node their selector names (the 1440
// capture path is the IR id), then structural guesses fill the rest. Pure: no fs/network/db/Date/random/DOM.
import type { CaptureNode, PageCapture } from "./capture";
import { COMPONENT_FEATURE, COMPONENT_NOTE, refreshFidelity } from "./fidelity";
import { rolesOf, type CarouselSpec, type InteractiveSpec } from "./interactive";
import { guessAll, guessAt, pageNodes, placeGuesses, type Guess, type PageNodes } from "./interactive-guess";
import type { CapturedInteractive } from "./interactive-scan";
import { findTrigger, indexById } from "./ir-build";
import type { FidelityItem, IRV2 } from "./ir-v2";

const ORIGIN = "Nhận diện khi clone";
const UNREPRODUCIBLE = new Set(["coverflow", "cube", "flip", "cards", "creative"]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
type CarouselRecord = Extract<CapturedInteractive, { kind: "carousel" }>;

export function attachInteractives(ir: IRV2, captures: PageCapture[]): IRV2 {
  let out = ir;
  const failed: FidelityItem[] = []; // detected but no spec could be built (§3: unsupported)
  for (const capture of captures) {
    const dom = capture.breakpoints.find((b) => b.bp === 1440)?.dom ?? capture.breakpoints[0]?.dom;
    if (!dom || !out.pages.some((p) => p.id === capture.pageId)) continue;
    const paths = new Map<CaptureNode, string>();
    const index = (n: CaptureNode, path: string): void => { paths.set(n, path); n.children.forEach((c, i) => index(c, `${path}.${i}`)); };
    index(dom, "0");
    const byId = indexById(dom, new Map());
    const idOf = (selector: string) => { const hit = findTrigger(dom, byId, selector); return hit ? `${capture.pageId}:${paths.get(hit)}` : undefined; };
    const p = pageNodes(out, capture.pageId);
    const records: Guess[] = [];
    for (const rec of capture.interactives ?? []) {
      const id = idOf(rec.selector);
      if (!id || !p.byId.has(id)) continue; // not in the clone (e.g. inside a layout section stored from another page)
      if (rec.kind === "carousel") {
        const g = fromRecord(p, id, rec);
        if (g) records.push(g);
        else failed.push({ pageId: capture.pageId, feature: COMPONENT_NOTE, status: "unsupported", nodeId: id, sourceRef: id, note: `${ORIGIN}: Carousel ${rec.source} không dựng được spec (không thấy track hoặc slide)` });
        continue;
      }
      const g = guessAt(p, id, "menu");
      if (g && (g.spec.kind === "dropdown" || g.spec.kind === "menu")) records.push({ ...g, spec: { ...g.spec, openOn: "hover", confidence: "observed" }, notes: [] });
    }
    // a record replaces the carousel / dropdown a v1 behavior migration put on the same track / trigger
    if (records.length) out = placeGuesses(dropReplaced(out, capture.pageId, records), capture.pageId, records, ORIGIN);
    // structural guesses never overwrite: a guess sharing a node with a placed component is that component again
    const after = pageNodes(out, capture.pageId), taken = new Set<string>();
    for (const n of after.byId.values()) if (n.interactive) for (const [ref] of rolesOf(n.interactive)) taken.add(ref);
    const fresh = guessAll(after).filter((g) => {
      const refs = rolesOf(g.spec).map(([ref]) => ref);
      if (refs.some((ref) => taken.has(ref))) return false;
      refs.forEach((ref) => taken.add(ref));
      return true;
    });
    if (fresh.length) out = placeGuesses(out, capture.pageId, fresh, ORIGIN);
  }
  if (out === ir && !failed.length) return ir;
  // the capture items are re-derived against the components (an interaction a component covers has no own item)
  return { ...out, fidelity: refreshFidelity([...out.fidelity.filter((x) => x.feature !== COMPONENT_FEATURE), ...failed], out, captures) };
}

// structure from the IR (guessCarousel: track, real slides, clones, arrows, pagination, bbox measure), values from the record
function fromRecord(p: PageNodes, id: string, rec: CarouselRecord): Guess | undefined {
  const g = guessAt(p, id, "carousel");
  if (!g || g.spec.kind !== "carousel") return undefined;
  const spec: CarouselSpec = { ...g.spec, source: rec.source, confidence: rec.confidence };
  const notes: string[] = [];
  const r = rec.read;
  if (r) {
    for (const bp of ["1440", "768", "375"] as const) {
      const v = r.perBp[bp];
      if (v?.spv !== undefined) spec.slidesPerView = { ...spec.slidesPerView, [bp]: clamp(Math.round(v.spv * 100) / 100, 1, 10) }; // R1
      if (v?.gap !== undefined) spec.gap = { ...spec.gap, [bp]: clamp(Math.round(v.gap), 0, 200) };
    }
    if (r.loop !== undefined) spec.loop = r.loop;
    if (r.autoplay !== undefined) spec.autoplay = r.autoplay;
    if (r.interval !== undefined) spec.interval = clamp(Math.round(r.interval), 1000, 60000);
    if (r.speed !== undefined) spec.speed = clamp(Math.round(r.speed), 0, 5000);
    if (r.direction) spec.direction = r.direction;
    if (r.effect) spec.transition = r.effect === "fade" ? "fade" : "slide";
    if (r.effect && UNREPRODUCIBLE.has(r.effect)) notes.push(`hiệu ứng ${r.effect} không tái tạo; dùng trượt`);
    if (r.active !== undefined && !g.snapshotActive) spec.active = clamp(Math.round(r.active), 0, spec.slides.length - 1); // the snapshot's own active slide matches its pixels
  } else if (rec.confidence === "observed") {
    spec.autoplay = rec.autoplay ?? false;
    if (rec.interval !== undefined) spec.interval = rec.interval;
    notes.push("loop, speed, slidesPerView, gap suy từ cấu trúc và bbox; autoplay/interval quan sát trên trang gốc");
  } else notes.push(...g.notes);
  return { ...g, spec, notes };
}

// A record's carousel (same track) or hover dropdown (same trigger) replaces what a migration placed there, with its notes.
function dropReplaced(ir: IRV2, pageId: string, records: Guess[]): IRV2 {
  const keyOf = (s: InteractiveSpec) => (s.kind === "carousel" ? `t|${s.track}` : s.kind === "dropdown" || s.kind === "menu" ? `d|${s.trigger}` : "-");
  const keys = new Set(records.map((g) => keyOf(g.spec)));
  const hits = [...pageNodes(ir, pageId).byId.values()].filter((n) => n.interactive && keys.has(keyOf(n.interactive)));
  if (!hits.length) return ir;
  const out = structuredClone(ir), p = pageNodes(out, pageId), dropped = new Set(hits.map((n) => n.id));
  for (const id of dropped) {
    const node = p.byId.get(id)!;
    delete node.interactive;
    if (node.component?.overrides) node.component.overrides = node.component.overrides.filter((x) => x !== "interactive");
  }
  out.fidelity = out.fidelity.filter((x) => !(x.pageId === pageId && x.feature === COMPONENT_NOTE && x.nodeId && dropped.has(x.nodeId)));
  return out;
}
