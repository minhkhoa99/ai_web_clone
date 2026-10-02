import type { Page } from "playwright";
import { withEvalTimeout } from "./browser";
import {
  hoverCandidatesInPage, listCarouselsInPage, observeCarouselsInPage, readCarouselConfigInPage, visibleInPage,
  type CarouselHit, type CarouselRead,
} from "./interactive-eval";

export type CapturedInteractive =
  | { kind: "carousel"; selector: string; source: CarouselHit["source"]; confidence: "config" | "observed" | "guessed"; read?: CarouselRead; autoplay?: boolean; interval?: number }
  | { kind: "dropdown"; selector: string; panel: string; openOn: "hover" };

// E2 §3 steps 1-2 on the live page (viewport 1440, right after the responsive snapshots). Bounded: one config evaluate
// (30 s), one observation window for every non-config carousel at once (<= 6 s each, <= 30 s per page), hover probes
// inside the same page budget. Never throws: a failure only lowers the confidence (config -> observed -> guessed).
export const INTERACTIVE_SCAN_LIMITS = { max: 50, configMs: 30_000, observeMs: 6_000, pageMs: 30_000, hoverMs: 2_000, stepMs: 100 };
const LIST_MS = 10_000; // the structure-only listings (same bound class as the DOM walks of capture-eval)
const SETTLE_MS = 150;

export function intervalOf(changes: number[]): number | undefined {
  if (!changes.length) return undefined;
  const gaps = changes.length === 1 ? [changes[0]!] : changes.slice(1).map((t, i) => t - changes[i]!);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  return Math.min(60_000, Math.max(1_000, Math.round(median / 100) * 100));
}

export async function scanInteractives(page: Page, opts: { limits?: Partial<typeof INTERACTIVE_SCAN_LIMITS> } = {}): Promise<CapturedInteractive[]> {
  const limits = { ...INTERACTIVE_SCAN_LIMITS, ...opts.limits };
  const deadline = Date.now() + limits.pageMs;
  const out: CapturedInteractive[] = [];
  try {
    const hits = await withEvalTimeout(page, "Carousel list", page.evaluate(listCarouselsInPage, { max: limits.max }), LIST_MS).catch((): CarouselHit[] => []);
    // §10: the one config evaluate per page, 30 s; a failure (or a timeout) reads nothing -> observed
    const reads = await withEvalTimeout(page, "Carousel config", page.evaluate(readCarouselConfigInPage, hits), limits.configMs).catch(() => hits.map(() => null));
    hits.forEach((h, i) => { const read = reads[i]; if (read) out.push({ kind: "carousel", selector: h.selector, source: h.source, confidence: "config", read }); });
    const rest = hits.filter((_, i) => !reads[i]);
    const window = Math.min(limits.observeMs, deadline - Date.now());
    const seen = window > 0 && rest.length
      ? await withEvalTimeout(page, "Carousel observation", page.evaluate(observeCarouselsInPage, { selectors: rest.map((h) => h.selector), durationMs: window, stepMs: limits.stepMs }), window + 5_000).catch(() => undefined)
      : undefined;
    for (const h of rest) {
      const changes = seen?.find((s) => s.selector === h.selector)?.changes;
      const interval = changes && intervalOf(changes);
      out.push(changes ? { kind: "carousel", selector: h.selector, source: h.source, confidence: "observed", autoplay: changes.length > 0, ...(interval && { interval }) }
        : { kind: "carousel", selector: h.selector, source: h.source, confidence: "guessed" }); // over budget / observation failed
    }
    // every hover step is clamped to what is left of the page budget (>= 1 ms: a Playwright timeout of 0 means none)
    const left = () => deadline - Date.now(), within = (ms: number) => Math.max(1, Math.min(ms, left()));
    const candidates = left() > 0 ? await withEvalTimeout(page, "Hover candidates", page.evaluate(hoverCandidatesInPage, { max: limits.max }), within(LIST_MS)).catch(() => []) : [];
    for (const c of candidates) {
      if (left() <= 0) break;
      const opened = await page.hover(c.trigger, { timeout: within(limits.hoverMs) })
        .then(() => page.waitForTimeout(within(SETTLE_MS)))
        .then(() => withEvalTimeout(page, "Hover panel", page.evaluate(visibleInPage, c.panel), within(limits.hoverMs)))
        .catch(() => false);
      await page.mouse.move(0, 0).catch(() => undefined);
      if (opened) out.push({ kind: "dropdown", selector: c.trigger, panel: c.panel, openOn: "hover" });
    }
    if (candidates.length) await withEvalTimeout(page, "Scroll reset", page.evaluate(() => scrollTo(0, 0)), within(SETTLE_MS * 10)).catch(() => undefined); // page.hover scrolled the triggers into view
  } catch {
    // E2 §11: capture never fails because of E2
  }
  return out;
}
