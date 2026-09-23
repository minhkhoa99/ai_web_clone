import { createHash } from "node:crypto";
import type { Page, Route } from "playwright";
import { evalOrCrash } from "./capture";
import {
  findCandidatesInPage,
  readStyleInPage,
  markHiddenInPage,
  collectRevealedInPage,
  revealedHiddenInPage,
  type Candidate,
  type InteractionKind,
} from "./interactions-eval";

export type Interaction = {
  id: string;
  kind: InteractionKind;
  trigger: string;
  styleDelta?: Record<string, string>;
  subtreeHtml?: string;
  status: "captured" | "failed" | "skipped";
};

type ScanResult = Pick<Interaction, "status" | "styleDelta" | "subtreeHtml">;

// Spec §1: 300 interactions / page, 5s each, 5 min total. Overridable only
// so tests can exercise the caps without 300+ element fixtures.
export const INTERACTION_LIMITS = { max: 300, perInteractionMs: 5_000, totalMs: 300_000 };

const MAX_WALK = 20_000; // same bound as the DOM snapshot node cap
const MAX_ADDED_NODES = 1_000;
const ACTION_TIMEOUT_MS = 2_000;
const SETTLE_MS = 150;
const STICKY_SCROLL_Y = 600;
const CAROUSEL_MAX_STEPS = 10;

const settle = (page: Page) => page.waitForTimeout(SETTLE_MS);
const readStyle = (page: Page, selector: string) => page.evaluate(readStyleInPage, selector);

function styleDiff(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(after).filter(([prop, value]) => before[prop] !== value));
}

async function scrollAndSettle(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => window.scrollTo(0, top), y);
  await settle(page);
}

async function scanHover(page: Page, c: Candidate): Promise<ScanResult> {
  const before = await readStyle(page, c.trigger);
  await page.hover(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  const after = await readStyle(page, c.trigger);
  await page.mouse.move(0, 0);
  return { status: "captured", styleDelta: styleDiff(before, after) };
}

// Focus delta; subtreeHtml keeps the field's outerHTML so placeholder etc. are noted.
async function scanFocus(page: Page, c: Candidate): Promise<ScanResult> {
  const before = await readStyle(page, c.trigger);
  await page.focus(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  const after = await readStyle(page, c.trigger);
  const html = await page.evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    el.blur();
    return el.outerHTML;
  }, c.trigger);
  return { status: "captured", styleDelta: styleDiff(before, after), subtreeHtml: html };
}

async function scanSticky(page: Page, c: Candidate): Promise<ScanResult> {
  await scrollAndSettle(page, 0);
  const before = await readStyle(page, c.trigger);
  await scrollAndSettle(page, STICKY_SCROLL_Y);
  const after = await readStyle(page, c.trigger);
  await scrollAndSettle(page, 0);
  return { status: "captured", styleDelta: styleDiff(before, after) };
}

// Revert order: Escape → click the undo trigger → reload as last resort,
// stopping as soon as the revealed subtree is hidden again.
async function restore(page: Page, undo: string): Promise<void> {
  const isRestored = () => page.evaluate(revealedHiddenInPage);
  const steps = [() => page.keyboard.press("Escape"), () => page.click(undo, { timeout: ACTION_TIMEOUT_MS })];
  for (const step of steps) {
    if (await isRestored()) return;
    await step().catch(() => undefined); // a failed step just falls through to the next one
    await settle(page);
  }
  if (await isRestored()) return;
  await page.reload({ waitUntil: "load" });
}

// menu / tab / accordion / modal: click, capture the newly visible subtree, restore.
async function scanReveal(page: Page, c: Candidate): Promise<ScanResult> {
  await page.evaluate(markHiddenInPage, MAX_ADDED_NODES);
  await page.click(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  await settle(page);
  const html = await page.evaluate(collectRevealedInPage, c.panel ?? null);
  if (!html) return { status: "failed" };
  await restore(page, c.undo ?? c.trigger);
  return { status: "captured", subtreeHtml: html };
}

async function scanCarousel(page: Page, c: Candidate): Promise<ScanResult> {
  if (!c.next) return { status: "skipped" }; // no next control to drive it
  const position = () =>
    page.evaluate((selector) => {
      const el = document.querySelector(selector)!;
      return { scrollLeft: el.scrollLeft, key: `${el.scrollLeft}|${el.firstElementChild?.getBoundingClientRect().left}` };
    }, c.trigger);

  const start = await position();
  let last = start.key;
  let advanced = 0;
  for (let i = 0; i < CAROUSEL_MAX_STEPS; i++) {
    await page.click(c.next, { timeout: ACTION_TIMEOUT_MS });
    await settle(page);
    const { key } = await position();
    if (key === last) break;
    last = key;
    advanced++;
  }

  await page.evaluate(
    ({ selector, left }) => document.querySelector(selector)!.scrollTo({ left, behavior: "instant" }),
    { selector: c.trigger, left: start.scrollLeft },
  );
  if ((await position()).key !== start.key) await page.reload({ waitUntil: "load" });
  return { status: advanced > 0 ? "captured" : "failed" };
}

const SCANNERS: Record<InteractionKind, (page: Page, c: Candidate) => Promise<ScanResult>> = {
  hover: scanHover,
  form: scanFocus,
  sticky: scanSticky,
  carousel: scanCarousel,
  menu: scanReveal,
  tab: scanReveal,
  accordion: scanReveal,
  modal: scanReveal,
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`interaction timed out after ${ms}ms`)), ms);
  });
  // ponytail: a timed-out action keeps running in the background until its own
  // Playwright timeout; cancel via AbortSignal if overlap ever corrupts scans.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const stripHash = (url: string) => url.split("#")[0];

// Blocks main-frame navigation to any other URL (triggers may be anchors)
// and closes popups; returns the teardown.
async function blockNavigation(page: Page): Promise<() => Promise<void>> {
  const home = stripHash(page.url());
  const onRoute = (route: Route) => {
    const req = route.request();
    const leaving = req.isNavigationRequest() && req.frame() === page.mainFrame() && stripHash(req.url()) !== home;
    return leaving ? route.abort() : route.fallback();
  };
  const onPopup = (popup: Page) => void popup.close().catch(() => undefined);
  await page.route("**/*", onRoute);
  page.on("popup", onPopup);
  return async () => {
    page.off("popup", onPopup);
    await page.unroute("**/*", onRoute);
  };
}

const interactionId = (kind: string, trigger: string) =>
  createHash("sha256").update(`${kind}:${trigger}`).digest("hex").slice(0, 16);

// Scans hidden interactions at the page's current viewport. Sequential by
// design: every action mutates the one shared page. An interaction's error or
// timeout marks it `failed`; candidates past the total budget are `skipped`.
export async function scanInteractions(
  page: Page,
  opts: { stateSelectors?: string[]; limits?: Partial<typeof INTERACTION_LIMITS> } = {},
): Promise<Interaction[]> {
  const limits = { ...INTERACTION_LIMITS, ...opts.limits };
  const deadline = Date.now() + limits.totalMs;
  const raw = await evalOrCrash(page, "Interaction scan", () =>
    page.evaluate(findCandidatesInPage, { stateSelectors: opts.stateSelectors ?? [], maxWalk: MAX_WALK }),
  );
  const byId = new Map<string, Candidate>();
  for (const c of raw) {
    const id = interactionId(c.kind, c.trigger);
    if (!byId.has(id)) byId.set(id, c);
  }
  const candidates = [...byId].slice(0, limits.max);

  const unblock = await blockNavigation(page);
  try {
    const results: Interaction[] = [];
    for (const [id, c] of candidates) {
      const base = { id, kind: c.kind, trigger: c.trigger };
      if (Date.now() >= deadline) {
        results.push({ ...base, status: "skipped" });
        continue;
      }
      const result = await withTimeout(SCANNERS[c.kind](page, c), limits.perInteractionMs).catch(
        (): ScanResult => ({ status: "failed" }),
      );
      results.push({ ...base, ...result });
    }
    return results;
  } finally {
    await unblock();
  }
}
