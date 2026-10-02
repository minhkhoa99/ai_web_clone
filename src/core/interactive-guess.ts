// E2 §3 step 3 + §9: structure-only inference over IR v2 page trees, and the one-time v1 behavior migration. Pure.
import { capFidelity, COMPONENT_NOTE } from "./fidelity";
import { checkInteractives, INTERACTIVE_LIMITS, parseSpec, rolesOf, specViolation, type Bp, type CarouselSpec, type InteractiveSpec } from "./interactive";
import type { FidelityItem, IRNodeV2, IRV2 } from "./ir-v2";

export type PageNodes = { pageId: string; byId: Map<string, IRNodeV2>; parent: Map<string, string>; tree: Map<string, string>; htmlId: Map<string, string>; order: string[] };
// notes: partial Fidelity notes (guessed/defaulted fields); info: supported notes (e.g. "Bỏ 4 slide clone do loop");
// hide: loop clones to mark hidden; snapshotActive: `active` came from an active class in the 1440 snapshot;
// over: the item count when it exceeds INTERACTIVE_LIMITS.items (not placed, noted unsupported; never truncated)
export type Guess = { root: string; spec: InteractiveSpec; notes: string[]; info?: string[]; hide?: string[]; snapshotActive?: true; over?: number };
type Hint = "carousel" | "tab" | "accordion" | "modal" | "menu";

const BPS = [1440, 768, 375] as const;
const classes = (n: IRNodeV2) => new Set((n.attrs.class ?? "").split(/\s+/).filter(Boolean));
const elementKids = (n: IRNodeV2) => n.children.filter((c) => c.tag !== "#text");
const CLONE = /(^|\s)(swiper-slide-duplicate|slick-cloned|splide__slide--clone)(\s|$)/;

export function pageNodes(ir: IRV2, pageId: string): PageNodes {
  const p: PageNodes = { pageId, byId: new Map(), parent: new Map(), tree: new Map(), htmlId: new Map(), order: [] };
  const trees: [string, IRNodeV2][] = [[`page:${pageId}`, ir.pages.find((x) => x.id === pageId)!.shell], ...ir.sections.filter((s) => s.pageId === pageId).map((s): [string, IRNodeV2] => [`section:${s.id}`, s.root])];
  for (const [tree, root] of trees) {
    const visit = (node: IRNodeV2): void => {
      p.byId.set(node.id, node); p.tree.set(node.id, tree); p.order.push(node.id);
      if (node.attrs.id && !p.htmlId.has(node.attrs.id)) p.htmlId.set(node.attrs.id, node.id);
      for (const c of node.children) { p.parent.set(c.id, node.id); visit(c); }
    };
    visit(root);
  }
  return p;
}
const chain = (p: PageNodes, id: string) => { const out = [id]; for (let c = p.parent.get(id); c; c = p.parent.get(c)) out.push(c); return out; };
// lowest common ancestor inside one section/shell tree; never html/body
function lca(p: PageNodes, ids: string[]): string | undefined {
  if (new Set(ids.map((id) => p.tree.get(id))).size !== 1) return undefined;
  const chains = ids.map((id) => chain(p, id));
  const hit = chains[0]!.find((a) => chains.every((c) => c.includes(a)));
  const tag = hit && p.byId.get(hit)!.tag;
  return tag === "html" || tag === "body" ? undefined : hit;
}
const target = (p: PageNodes, ref: string | undefined) => (ref ? p.htmlId.get(ref.replace(/^#/, "")) : undefined);
const nextElement = (p: PageNodes, id: string) => {
  const kids = p.byId.get(p.parent.get(id) ?? "")?.children ?? [];
  return kids.slice(kids.findIndex((c) => c.id === id) + 1).find((c) => c.tag !== "#text")?.id;
};

function guessTabs(p: PageNodes, tablist: IRNodeV2): Guess | undefined {
  const tabs: IRNodeV2[] = [];
  const visit = (x: IRNodeV2) => { if (x.attrs.role === "tab") tabs.push(x); else x.children.forEach(visit); };
  tablist.children.forEach(visit);
  const pairs = tabs.flatMap((t) => { const panel = target(p, t.attrs["aria-controls"]); return panel ? [{ trigger: t.id, panel }] : []; });
  if (!pairs.length || pairs.length !== tabs.length) return undefined;
  const root = lca(p, [tablist.id, ...pairs.map((x) => x.panel)]);
  return root ? { root, spec: { kind: "tabs", source: "aria", confidence: "guessed", tabs: pairs, active: Math.max(0, tabs.findIndex((t) => t.attrs["aria-selected"] === "true")) }, notes: [], ...over(pairs.length) } : undefined;
}
const DEFAULTED = (fields: string[]) => `${fields.join(", ")}: giá trị mặc định`;
const over = (count: number) => (count > INTERACTIVE_LIMITS.items ? { over: count } : {});
function firstBelow(from: IRNodeV2, hit: (x: IRNodeV2) => boolean): IRNodeV2 | undefined {
  let found: IRNodeV2 | undefined;
  const visit = (x: IRNodeV2) => { if (found) return; if (hit(x)) found = x; else x.children.forEach(visit); };
  from.children.forEach(visit);
  return found;
}

function guessModal(p: PageNodes, trigger: IRNodeV2): Guess | undefined {
  const ref = (t: IRNodeV2) => target(p, t.attrs["aria-controls"] ?? t.attrs["data-modal"] ?? t.attrs["data-target"]);
  const dialog = p.byId.get(ref(trigger) ?? "");
  if (!dialog) return undefined;
  const all = p.order.filter((id) => id !== dialog.id && ref(p.byId.get(id)!) === dialog.id), triggers = all.slice(0, INTERACTIVE_LIMITS.items);
  const extra = all.length - triggers.length; // the dialog still opens from the first 100; the rest is noted, not hidden
  const close = firstBelow(dialog, (x) => x.attrs["data-close"] !== undefined || /close|đóng/i.test(`${x.attrs["aria-label"] ?? ""} ${x.attrs.class ?? ""}`))?.id;
  return { root: dialog.id, notes: [DEFAULTED(["closeOn"]), ...(extra > 0 ? [`vượt giới hạn ${INTERACTIVE_LIMITS.items} item: ${extra} trigger khác không mở dialog`] : [])], spec: { kind: "modal", source: "aria", confidence: "guessed", triggers, dialog: dialog.id,
    closeOn: ["esc", "backdrop", ...(close ? (["button"] as const) : [])], ...(close && { closeButton: close }) } };
}

function guessToggle(p: PageNodes, t: IRNodeV2, hint: "menu" | "accordion"): Guess | undefined {
  const panel = p.byId.get(target(p, t.attrs["aria-controls"]) ?? nextElement(p, t.id) ?? "");
  const root = panel && lca(p, [t.id, panel.id]);
  if (!panel || !root) return undefined;
  const list = ["nav", "ul", "ol"].includes(panel.tag) || panel.attrs.role === "menu";
  const menuish = list || t.attrs["aria-haspopup"] !== undefined || chain(p, t.id).some((a) => ["nav", "header"].includes(p.byId.get(a)!.tag));
  if (hint === "accordion" && !menuish) return { root, notes: [DEFAULTED(["multiple"])], spec: { kind: "accordion", source: "aria", confidence: "guessed", multiple: true, items: [{ trigger: t.id, panel: panel.id, open: t.attrs["aria-expanded"] === "true" }] } };
  return { root, notes: [DEFAULTED(["openOn"])], spec: { kind: list ? "menu" : "dropdown", source: "aria", confidence: "guessed", trigger: t.id, panel: panel.id, openOn: "click" } };
}

// The <details> siblings under one parent form one accordion rooted at that parent; under html/body (or as a section
// root) a <details> is its own root.
function guessDetails(p: PageNodes, det: IRNodeV2): Guess | undefined {
  const parent = p.byId.get(p.parent.get(det.id) ?? "");
  const own = !parent || ["html", "body"].includes(parent.tag);
  const dets = own ? [det] : elementKids(parent).filter((c) => c.tag === "details");
  const items = dets.flatMap((d) => { const [s, panel] = elementKids(d); return s?.tag === "summary" && panel ? [{ trigger: s.id, panel: panel.id, open: d.attrs.open !== undefined }] : []; });
  if (!items.length) return undefined;
  return { root: own ? det.id : parent.id, notes: [], spec: { kind: "accordion", source: "details", confidence: "guessed", multiple: true, items }, ...over(items.length) }; // native <details> are independent
}

function guessVideo(n: IRNodeV2): Guess | undefined {
  const has = (k: string) => n.attrs[k] !== undefined;
  if (n.tag === "video") return { root: n.id, notes: [], spec: { kind: "video", source: "native", confidence: "guessed", node: n.id, mode: "native",
    autoplay: has("autoplay"), muted: has("muted") || has("autoplay"), loop: has("loop"), controls: has("controls"), ...(n.attrs.poster && { poster: n.attrs.poster }) } };
  if (n.tag !== "iframe" || !URL.canParse(n.attrs.src ?? "")) return undefined;
  const u = new URL(n.attrs.src!), on = (k: string) => u.searchParams.get(k) === "1";
  if (!/^((www\.|m\.)?youtube(-nocookie)?\.com|player\.vimeo\.com)$/.test(u.hostname)) return undefined; // §11 allowlist
  const autoplay = on("autoplay");
  return { root: n.id, notes: ["Video nhúng: chỉ giữ iframe trên host được phép, phát do trang nhúng"], spec: { kind: "video", source: "native", confidence: "guessed", node: n.id, mode: "embed",
    autoplay, muted: autoplay || on("mute") || on("muted"), loop: on("loop"), controls: u.searchParams.get("controls") !== "0" } };
}

// [root class, source, track class, pagination class, prev class, next class]
const LIBS = [
  ["swiper", "swiper", "swiper-wrapper", "swiper-pagination", "swiper-button-prev", "swiper-button-next"],
  ["slick-slider", "slick", "slick-track", "slick-dots", "slick-prev", "slick-next"],
  ["splide", "splide", "splide__list", "splide__pagination", "splide__arrow--prev", "splide__arrow--next"],
] as const;
const ACTIVE = /(^|\s)(swiper-slide-active|slick-current|is-active)(\s|$)/;
const slideKey = (n: IRNodeV2): string => JSON.stringify([n.tag, n.text ?? null, n.attrs.src ?? null, n.attrs.href ?? null, n.children.map(slideKey)]);
// [last k | real … | first k]: the loop clones of a library-less track (same content at both ends)
function endClones(kids: IRNodeV2[]): string[] {
  const key = kids.map(slideKey), n = kids.length;
  for (let k = Math.floor(n / 3); k >= 1; k--) {
    if (key.slice(0, k).every((x, i) => x === key[n - 2 * k + i]) && key.slice(n - k).every((x, i) => x === key[k + i])) return [...kids.slice(0, k), ...kids.slice(n - k)].map((c) => c.id);
  }
  return [];
}
function guessCarousel(p: PageNodes, node: IRNodeV2): Guess | undefined {
  const cls = classes(node), lib = LIBS.find(([c]) => cls.has(c) || (c === "swiper" && cls.has("swiper-container")));
  const byClass = (c: string) => firstBelow(node, (x) => classes(x).has(c));
  const track = lib ? byClass(lib[2]) : node;
  if (!track) return undefined;
  const viewport = lib?.[1] === "slick" ? byClass("slick-list") ?? node : lib?.[1] === "splide" ? byClass("splide__track") ?? node : node;
  const kids = elementKids(track), marked = kids.filter((c) => CLONE.test(c.attrs.class ?? ""));
  const hide = marked.length ? marked.map((c) => c.id) : endClones(kids);
  const real = kids.filter((c) => !hide.includes(c.id));
  if (!real.length) return undefined;
  // arrows: library classes, else /next/ /prev|previous|back/ in aria-label or class, within 3 ancestor levels (like the scan)
  const arrow = (re: RegExp, c?: string) => {
    for (let s: string | undefined = node.id, d = 0; s && d < 3; s = p.parent.get(s), d++) {
      const hit = firstBelow(p.byId.get(s)!, (x) => (c !== undefined && classes(x).has(c)) || ((["button", "a"].includes(x.tag) || x.attrs.role === "button") && re.test(`${x.attrs["aria-label"] ?? ""} ${x.attrs.class ?? ""}`)));
      if (hit) return hit.id;
    }
    return undefined;
  };
  const prev = arrow(/prev|previous|back/i, lib?.[4]), next = arrow(/next/i, lib?.[5]);
  const dots = lib ? byClass(lib[3]) : undefined;
  const measured = measureCarousel(p, viewport.id, real.map((s) => s.id));
  const at = real.findIndex((s) => ACTIVE.test(s.attrs.class ?? "") || s.attrs["aria-current"] === "true");
  const root = lca(p, [viewport.id, track.id, ...[prev, next, dots?.id].filter((x): x is string => !!x)]) ?? node.id;
  const spec: CarouselSpec = {
    kind: "carousel", source: lib ? lib[1] : node.styles.base["scroll-snap-type"] && node.styles.base["scroll-snap-type"] !== "none" ? "scroll-snap" : "generic", confidence: "guessed",
    viewport: viewport.id, track: track.id, slides: real.map((s) => s.id), active: Math.max(0, at),
    autoplay: false, interval: 5000, loop: hide.length > 0, direction: measured?.direction ?? "horizontal", transition: "slide", speed: 300,
    slidesPerView: measured?.slidesPerView ?? { "1440": 1 }, gap: measured?.gap ?? { "1440": 0 },
    ...((prev || next) && { arrows: { ...(prev && { prev }), ...(next && { next }) } }),
    ...(dots && { pagination: { container: dots.id, kind: classes(dots).has("swiper-pagination-fraction") ? "fraction" : "bullets" } }),
  };
  const defaulted = ["autoplay", "interval", "speed", ...(hide.length ? [] : ["loop"]), ...(measured ? [] : ["slidesPerView", "gap"])];
  return { root, spec, notes: [DEFAULTED(defaulted)], ...(hide.length && { hide, info: [`Bỏ ${hide.length} slide clone do loop`] }), ...(at >= 0 && { snapshotActive: true as const }), ...over(real.length) };
}

export function guessAt(p: PageNodes, nodeId: string, hint: Hint): Guess | undefined {
  const node = p.byId.get(nodeId);
  if (!node) return undefined;
  if (hint === "carousel") return guessCarousel(p, node);
  if (hint === "modal") return guessModal(p, node);
  if (hint === "tab") {
    const list = chain(p, nodeId).map((id) => p.byId.get(id)!).find((x) => x.attrs.role === "tablist");
    return list && guessTabs(p, list);
  }
  const details = node.tag === "summary" ? p.byId.get(p.parent.get(nodeId) ?? "") : undefined;
  if (details?.tag === "details") return guessDetails(p, details);
  return guessToggle(p, node, hint === "accordion" ? "accordion" : "menu");
}

// §3 step 3 over the whole page (structure only), in document order.
export function guessAll(p: PageNodes): Guess[] {
  const out: Guess[] = [], detailRoots = new Set<string>();
  for (const id of p.order) {
    const n = p.byId.get(id)!;
    let g: Guess | undefined;
    if (n.attrs.role === "tablist") g = guessTabs(p, n);
    else if (n.tag === "details") { g = guessDetails(p, n); if (g && detailRoots.has(g.root)) g = undefined; else if (g) detailRoots.add(g.root); }
    else if (n.attrs["aria-haspopup"] === "dialog" || n.attrs["data-modal"] !== undefined) g = guessModal(p, n);
    else if (n.attrs.role !== "tab" && (n.attrs["aria-haspopup"] !== undefined || n.attrs["aria-expanded"] !== undefined))
      g = guessToggle(p, n, n.attrs["aria-controls"] !== undefined && n.attrs["aria-haspopup"] === undefined ? "accordion" : "menu");
    else g = guessVideo(n);
    if (g) out.push(g);
  }
  return out;
}

export function measureCarousel(p: PageNodes, viewport: string, slides: string[]) {
  const vp = p.byId.get(viewport), real = slides.map((s) => p.byId.get(s)!).filter(Boolean);
  if (!vp || real.length === 0) return undefined;
  const spv: Partial<Record<Bp, number>> = {}, gap: Partial<Record<Bp, number>> = {};
  const a = real[0]!.box?.[1440], b = real[1]?.box?.[1440];
  const direction = a && b && Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? "vertical" : "horizontal";
  const along = direction === "vertical" ? [1, 3] as const : [0, 2] as const;
  for (const bp of BPS) {
    const box = vp.box?.[bp], sizes = real.map((s) => s.box?.[bp]).filter((x): x is [number, number, number, number] => !!x);
    if (!box || !sizes.length) continue;
    const size = [...sizes.map((s) => s[along[1]])].sort((x, y) => x - y)[Math.floor(sizes.length / 2)]!;
    const gaps = sizes.slice(1).map((s, k) => s[along[0]] - (sizes[k]![along[0]] + sizes[k]![along[1]])).filter((g) => g >= 0);
    const g = Math.min(200, Math.round(gaps.length ? [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)]! : 0));
    if (size <= 0) continue;
    spv[String(bp) as Bp] = Math.min(10, Math.max(1, Math.round(((box[along[1]] + g) / (size + g)) * 100) / 100));
    gap[String(bp) as Bp] = g;
  }
  return Object.keys(spv).length ? { slidesPerView: spv, gap, direction } as const : undefined;
}

// The checkInteractives rules (specViolation) for one spec at `root`: a guess that breaks one is not placed, so a load
// never fails over a guess.
const fits = (p: PageNodes, root: string, spec: InteractiveSpec) =>
  !specViolation(spec, root, p.pageId, { inside: (ref) => p.byId.has(ref) && chain(p, ref).includes(root), onPage: (ref) => p.byId.has(ref), parent: (ref) => p.parent.get(ref) });

// Places guesses (page order) on a clone it owns: a taken root or member is skipped (R2: a dropdown/menu whose LCA is
// taken falls back to its trigger as root), at most 50 per page; notes -> Fidelity `component-note` items.
export function placeGuesses(ir: IRV2, pageId: string, guesses: Guess[], origin: string): IRV2 {
  const out = structuredClone(ir), p = pageNodes(out, pageId);
  const members = new Set<string>(), notes: FidelityItem[] = [];
  let count = 0;
  for (const n of p.byId.values()) if (n.interactive) { count++; for (const [ref] of rolesOf(n.interactive)) members.add(ref); }
  const skip = (g: Guess, reason: string) => notes.push({ pageId, feature: COMPONENT_NOTE, status: "unsupported", sourceRef: g.root, note: `${origin}: ${g.spec.kind}: ${reason}`.slice(0, 300) });
  for (const g of guesses) {
    let root = g.root;
    if (p.byId.get(root)?.interactive && (g.spec.kind === "dropdown" || g.spec.kind === "menu")) root = g.spec.trigger; // R2
    const node = p.byId.get(root);
    if (!node || node.interactive || rolesOf(g.spec).some(([ref]) => members.has(ref))) { skip(g, "trùng node gốc với component khác"); continue; }
    if (g.over) { skip(g, `vượt giới hạn ${INTERACTIVE_LIMITS.items} item (có ${g.over})`); continue; }
    if (count >= INTERACTIVE_LIMITS.perPage) { skip(g, `vượt giới hạn ${INTERACTIVE_LIMITS.perPage} component/trang`); continue; }
    let spec: InteractiveSpec;
    try { spec = parseSpec(g.spec); } catch { skip(g, "không dựng được spec"); continue; }
    if (!fits(p, root, spec)) { skip(g, "không dựng được spec"); continue; }
    node.interactive = spec;
    count++;
    for (const [ref] of rolesOf(spec)) members.add(ref);
    if (node.component?.role === "instance") node.component.overrides = [...new Set([...(node.component.overrides ?? []), "interactive"])]; // R12
    for (const id of g.hide ?? []) {
      const c = p.byId.get(id);
      if (!c) continue;
      c.hidden = true;
      if (c.component?.role === "instance") c.component.overrides = [...new Set([...(c.component.overrides ?? []), "hidden"])];
    }
    if (g.notes.length) notes.push({ pageId, feature: COMPONENT_NOTE, status: "partial", nodeId: root, sourceRef: root, note: `${origin}: ${g.notes.join("; ")}`.slice(0, 300) });
    for (const line of g.info ?? []) notes.push({ pageId, feature: COMPONENT_NOTE, status: "supported", nodeId: root, sourceRef: root, note: line.slice(0, 300) });
  }
  out.fidelity = capFidelity([...(out.fidelity ?? []), ...notes]);
  return out;
}

const HINTS = new Set<string>(["carousel", "tab", "accordion", "modal", "menu"]);
const MIGRATED = "Chuyển từ hành vi cũ (v1)";

// §9: every v1 `behavior` is dropped; one bound to a captured carousel/tab/accordion/modal/menu interaction becomes a
// `guessed` interactive where the structure allows. No behavior anywhere -> the same object (idempotent, no History).
export function migrateBehaviors(ir: IRV2): IRV2 {
  const trees = [...ir.pages.map((p) => p.shell), ...ir.sections.map((s) => s.root), ...ir.components.map((c) => c.root)];
  const any = (n: IRNodeV2): boolean => n.behavior !== undefined || n.children.some(any);
  if (!trees.some(any)) return ir;
  let out = structuredClone(ir);
  const bound = new Map<string, string>();
  const strip = (n: IRNodeV2): void => {
    if (n.behavior !== undefined) bound.set(n.id, n.behavior);
    delete n.behavior;
    if (n.component?.overrides) n.component.overrides = n.component.overrides.filter((x) => x !== "behavior");
    n.children.forEach(strip);
  };
  [...out.pages.map((p) => p.shell), ...out.sections.map((s) => s.root), ...out.components.map((c) => c.root)].forEach(strip);
  const kinds = new Map(ir.interactions.filter((x) => x.status === "captured" && HINTS.has(x.kind)).map((x) => [x.id, x.kind as Hint]));
  for (const page of out.pages) {
    const p = pageNodes(out, page.id), seen = new Set<string>(), guesses: Guess[] = [];
    for (const id of p.order) {
      const hint = kinds.get(bound.get(id) ?? "");
      const g = hint && guessAt(p, id, hint);
      const key = g && JSON.stringify([g.root, g.spec]); // every tab of one tablist guesses the same tabs
      if (g && !seen.has(key!)) { seen.add(key!); guesses.push(g); }
    }
    if (guesses.length) out = placeGuesses(out, page.id, guesses, MIGRATED);
  }
  return out;
}

export function upgradeDocument(ir: IRV2): IRV2 {
  const out = migrateBehaviors(ir);
  checkInteractives(out);
  return out;
}
