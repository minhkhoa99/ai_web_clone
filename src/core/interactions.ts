import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { evalOrCrash } from "./capture";
import { blockNavigationAway } from "./browser";
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
const NAV_TIMEOUT_MS = 30_000; // spec §1 navigation timeout
const SETTLE_MS = 150;
const STICKY_SCROLL_Y = 600;
const CAROUSEL_MAX_STEPS = 10;
const FAILED: ScanResult = { status: "failed" };

// One scan's handle on the page. Every page access goes through pageOf(),
// so once the scan times out (`cancelled`) its next step throws instead of
// touching the page under the following scan.
type Scan = { page: Page; cancelled: boolean };

function pageOf(s: Scan): Page {
  if (s.cancelled) throw new Error("interaction cancelled after timeout");
  return s.page;
}

const settle = (s: Scan) => pageOf(s).waitForTimeout(SETTLE_MS);
const readStyle = (s: Scan, selector: string) => pageOf(s).evaluate(readStyleInPage, selector);
const reload = (s: Scan) => pageOf(s).reload({ waitUntil: "load", timeout: NAV_TIMEOUT_MS });

function styleDiff(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(after).filter(([prop, value]) => before[prop] !== value));
}

async function scrollAndSettle(s: Scan, y: number): Promise<void> {
  await pageOf(s).evaluate((top) => window.scrollTo(0, top), y);
  await settle(s);
}

async function scanHover(s: Scan, c: Candidate): Promise<ScanResult> {
  const before = await readStyle(s, c.trigger);
  await pageOf(s).hover(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  const after = await readStyle(s, c.trigger);
  await pageOf(s).mouse.move(0, 0);
  return { status: "captured", styleDelta: styleDiff(before, after) };
}

// Focus delta; subtreeHtml keeps the field's outerHTML so placeholder etc. are noted.
async function scanFocus(s: Scan, c: Candidate): Promise<ScanResult> {
  const before = await readStyle(s, c.trigger);
  await pageOf(s).focus(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  const after = await readStyle(s, c.trigger);
  const html = await pageOf(s).evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    el.blur();
    return el.outerHTML;
  }, c.trigger);
  return { status: "captured", styleDelta: styleDiff(before, after), subtreeHtml: html };
}

async function scanSticky(s: Scan, c: Candidate): Promise<ScanResult> {
  await scrollAndSettle(s, 0);
  const before = await readStyle(s, c.trigger);
  await scrollAndSettle(s, STICKY_SCROLL_Y);
  const after = await readStyle(s, c.trigger);
  await scrollAndSettle(s, 0);
  return { status: "captured", styleDelta: styleDiff(before, after) };
}

// Revert order: Escape → click the undo trigger → reload as last resort.
// With a revealed subtree, stops as soon as it is hidden again. With nothing
// revealed there is nothing to verify, so both steps always run (no reload).
async function restore(s: Scan, undo: string, revealed: boolean): Promise<void> {
  const isRestored = async () => revealed && (await pageOf(s).evaluate(revealedHiddenInPage));
  const steps = [
    () => pageOf(s).keyboard.press("Escape"),
    () => pageOf(s).click(undo, { timeout: ACTION_TIMEOUT_MS }),
  ];
  for (const step of steps) {
    if (await isRestored()) return;
    await step().catch((err) => {
      if (s.cancelled) throw err; // a failed step just falls through to the next one
    });
    await settle(s);
  }
  if (!revealed || (await isRestored())) return;
  await reload(s);
}

// menu / tab / accordion / modal: click, capture the newly visible subtree, restore.
async function scanReveal(s: Scan, c: Candidate): Promise<ScanResult> {
  await pageOf(s).evaluate(markHiddenInPage, MAX_ADDED_NODES);
  await pageOf(s).click(c.trigger, { timeout: ACTION_TIMEOUT_MS });
  await settle(s);
  const { html, revealed } = await pageOf(s).evaluate(collectRevealedInPage, c.panel ?? null);
  await restore(s, c.undo ?? c.trigger, revealed);
  return html ? { status: "captured", subtreeHtml: html } : FAILED;
}

async function scanCarousel(s: Scan, c: Candidate): Promise<ScanResult> {
  if (!c.next) return FAILED; // no next control to drive it
  const next = c.next;
  const position = () =>
    pageOf(s).evaluate((selector) => {
      const el = document.querySelector(selector)!;
      return { scrollLeft: el.scrollLeft, key: `${el.scrollLeft}|${el.firstElementChild?.getBoundingClientRect().left}` };
    }, c.trigger);

  const start = await position();
  let last = start.key;
  let advanced = 0;
  for (let i = 0; i < CAROUSEL_MAX_STEPS; i++) {
    await pageOf(s).click(next, { timeout: ACTION_TIMEOUT_MS });
    await settle(s);
    const { key } = await position();
    if (key === last) break;
    last = key;
    advanced++;
  }

  await pageOf(s).evaluate(
    ({ selector, left }) => document.querySelector(selector)!.scrollTo({ left, behavior: "instant" }),
    { selector: c.trigger, left: start.scrollLeft },
  );
  if ((await position()).key !== start.key) await reload(s);
  return advanced > 0 ? { status: "captured" } : FAILED;
}

const SCANNERS: Record<InteractionKind, (s: Scan, c: Candidate) => Promise<ScanResult>> = {
  hover: scanHover,
  form: scanFocus,
  sticky: scanSticky,
  carousel: scanCarousel,
  menu: scanReveal,
  tab: scanReveal,
  accordion: scanReveal,
  modal: scanReveal,
};

// Runs one scanner under a timeout. On timeout the scan is cancelled, then
// awaited so it never overlaps the next one — it stops at its next pageOf()
// check, so the wait is bounded by the in-flight action's own timeout — and
// the page is reloaded so the next scan starts clean.
async function runScanner(page: Page, c: Candidate, timeoutMs: number): Promise<ScanResult> {
  const s: Scan = { page, cancelled: false };
  const work = SCANNERS[c.kind](s, c);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([work, timeout])
    .catch((): ScanResult => FAILED)
    .finally(() => clearTimeout(timer));
  if (outcome !== "timeout") return outcome;

  s.cancelled = true;
  await work.catch(() => undefined);
  await page.reload({ waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => undefined); // next scan still runs; its own steps fail if the page is gone
  return FAILED;
}

// Blocks main-frame navigation away from the current page (triggers may be
// anchors) and closes popups; returns the teardown.
async function blockNavigation(page: Page): Promise<() => Promise<void>> {
  const unblockNav = await blockNavigationAway(page, page.url());
  const onPopup = (popup: Page) => void popup.close().catch(() => undefined);
  page.on("popup", onPopup);
  return async () => {
    page.off("popup", onPopup);
    await unblockNav();
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
      const result = await runScanner(page, c, limits.perInteractionMs);
      results.push({ ...base, ...result });
    }
    return results;
  } finally {
    await unblock();
  }
}
