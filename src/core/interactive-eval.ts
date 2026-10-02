// Page functions for interactive-scan.ts (E2 §3). Each runs inside the page via page.evaluate and must stay
// self-contained: evaluate serializes only the function's own source. Read-only: library config is read as
// numbers, booleans and enums only (never functions or free strings); nothing on the page is changed.

export type CarouselRead = {
  perBp: Partial<Record<"1440" | "768" | "375", { spv?: number; gap?: number }>>;
  loop?: boolean; autoplay?: boolean; interval?: number; effect?: string; speed?: number; direction?: "horizontal" | "vertical"; active?: number;
};
export type CarouselHit = { selector: string; source: "swiper" | "slick" | "splide" | "scroll-snap" };

// Structure only (classes, computed scroll-snap), no instance read. selectorFor = interactions-eval.ts (findTrigger match).
export function listCarouselsInPage(arg: { max: number }): CarouselHit[] {
  const isUniqueId = (id: string) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && isUniqueId(cur.id)) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
    }
    return parts.join(" > ");
  };
  const out: CarouselHit[] = [], seen = new Set<Element>();
  const add = (el: Element, source: CarouselHit["source"]) => { if (!seen.has(el) && out.length < arg.max) { seen.add(el); out.push({ selector: selectorFor(el), source }); } };
  document.querySelectorAll(".swiper, .swiper-container").forEach((el) => add(el, "swiper"));
  document.querySelectorAll(".slick-slider, [data-slick]").forEach((el) => add(el, "slick"));
  document.querySelectorAll(".splide").forEach((el) => add(el, "splide"));
  for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 20_000)) {
    const cs = getComputedStyle(el);
    if (cs.scrollSnapType !== "none" && /auto|scroll/.test(cs.overflowX + cs.overflowY) && el.getBoundingClientRect().width > 0) add(el, "scroll-snap");
  }
  return out;
}

// The one config evaluate per page (§10, 30 s). null = nothing readable -> observed (Review Focus 2: no el.swiper).
export function readCarouselConfigInPage(hits: CarouselHit[]): (CarouselRead | null)[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const px = (v: unknown) => num(v) ?? (typeof v === "string" && /^\d+(\.\d+)?(px)?$/.test(v.trim()) ? parseFloat(v) : undefined);
  const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T; // a breakpoint without a field keeps the base value
  const EFFECTS = ["slide", "fade", "cube", "coverflow", "flip", "cards", "creative"];
  const WIDTHS = [["1440", 1440], ["768", 768], ["375", 375]] as const;
  // min-width breakpoints (Swiper, Slick mobileFirst): every key <= width applies in order; max-width (Slick, Splide): the smallest key >= width wins
  const perBp = (base: { spv?: number; gap?: number }, table: Record<string, { spv?: number; gap?: number }>, max: boolean) =>
    Object.fromEntries(WIDTHS.map(([bp, w]) => {
      const keys = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const hit = max ? keys.filter((k) => k >= w).slice(0, 1) : keys.filter((k) => k <= w);
      return [bp, Object.assign({}, defined(base), ...hit.map((k) => defined(table[String(k)]!)))];
    }));
  return hits.map(({ selector, source }): CarouselRead | null => {
    try { // a throwing getter / proxy only costs its own carousel
      const el = document.querySelector(selector) as any;
      if (!el) return null;
      if (source === "swiper") {
        const p = el.swiper?.originalParams ?? el.swiper?.params; // real Swiper merges the current breakpoint into params
        if (!p) return null; // bundled build without el.swiper: observed instead (Review Focus 2)
        const table = Object.fromEntries(Object.entries(p.breakpoints ?? {}).map(([k, v]: [string, any]) => [k, { spv: num(v?.slidesPerView), gap: px(v?.spaceBetween) }]));
        const effect = p.effect; // read once: a getter must not pass the check with one value and return another
        return { perBp: perBp({ spv: num(p.slidesPerView), gap: px(p.spaceBetween) }, table, false), loop: !!p.loop, autoplay: !!(p.autoplay && (p.autoplay.enabled ?? true)),
          interval: num(p.autoplay?.delay), effect: EFFECTS.includes(effect) ? effect : undefined, speed: num(p.speed),
          direction: p.direction === "vertical" ? "vertical" : "horizontal", active: num(el.swiper.realIndex) };
      }
      if (source === "slick") {
        let o: any = (window as any).jQuery?.(el)?.slick?.("getSlick")?.options;
        if (!o) try { o = JSON.parse(el.getAttribute("data-slick") ?? "null"); } catch { o = null; }
        if (!o) return null;
        const table = Object.fromEntries((Array.isArray(o.responsive) ? o.responsive : []).map((r: any) => [String(num(r?.breakpoint)), { spv: num(r?.settings?.slidesToShow) }]));
        return { perBp: perBp({ spv: num(o.slidesToShow) }, table, !o.mobileFirst), loop: o.infinite !== false, autoplay: !!o.autoplay, interval: num(o.autoplaySpeed),
          effect: o.fade ? "fade" : "slide", speed: num(o.speed), direction: o.vertical ? "vertical" : "horizontal" };
      }
      if (source === "splide") {
        const o = el.splide?.options;
        if (!o) return null;
        const table = Object.fromEntries(Object.entries(o.breakpoints ?? {}).map(([k, v]: [string, any]) => [k, { spv: num(v?.perPage), gap: px(v?.gap) }]));
        return { perBp: perBp({ spv: num(o.perPage), gap: px(o.gap) }, table, true), loop: o.type === "loop", autoplay: !!o.autoplay, interval: num(o.interval),
          effect: o.type === "fade" ? "fade" : "slide", speed: num(o.speed), direction: o.direction === "ttb" ? "vertical" : "horizontal" };
      }
      return null; // scroll-snap: no library config
    } catch {
      return null;
    }
  });
}

// Polls every carousel at once: a change of the track transform, scroll position or active child is one timestamp.
export function observeCarouselsInPage(arg: { selectors: string[]; durationMs: number; stepMs: number }): Promise<{ selector: string; changes: number[] }[]> {
  const els = arg.selectors.map((s) => document.querySelector(s));
  const keyOf = (el: Element | null) => {
    if (!el) return "";
    const track = (el.querySelector(".swiper-wrapper, .slick-track, .splide__list") ?? el) as HTMLElement;
    const kids = Array.from(track.children);
    const active = kids.findIndex((k) => /active|current/.test(k.getAttribute("class") ?? "") || k.getAttribute("aria-current") === "true");
    return `${getComputedStyle(track).transform}|${(el as HTMLElement).scrollLeft}|${(el as HTMLElement).scrollTop}|${active}`;
  };
  const last = els.map(keyOf), changes = els.map((): number[] => []), start = performance.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const t = Math.round(performance.now() - start);
      els.forEach((el, i) => { const k = keyOf(el); if (k !== last[i]) { last[i] = k; changes[i]!.push(t); } });
      if (t >= arg.durationMs) { clearInterval(timer); resolve(arg.selectors.map((selector, i) => ({ selector, changes: changes[i]! }))); }
    }, arg.stepMs);
  });
}

// Visible menu triggers whose panel (aria-controls, else the next element sibling) is hidden now.
export function hoverCandidatesInPage(arg: { max: number }): { trigger: string; panel: string }[] {
  const isUniqueId = (id: string) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && isUniqueId(cur.id)) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
    }
    return parts.join(" > ");
  };
  const visible = (el: Element) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const out: { trigger: string; panel: string }[] = [];
  for (const t of Array.from(document.querySelectorAll("[aria-haspopup]:not([aria-haspopup=dialog]), [aria-expanded]"))) {
    if (out.length >= arg.max || !visible(t) || t.getAttribute("role") === "tab") continue;
    const id = t.getAttribute("aria-controls");
    const panel = (id && document.getElementById(id)) || t.nextElementSibling;
    if (panel && !visible(panel)) out.push({ trigger: selectorFor(t), panel: selectorFor(panel) });
  }
  return out;
}

export function visibleInPage(selector: string): boolean {
  const el = document.querySelector(selector);
  return !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
}
