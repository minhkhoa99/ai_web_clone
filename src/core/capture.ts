import type { Page } from "playwright";
import { AppError, Codes } from "./errors";
import { mapLimit } from "./limit";
import { snapshotInPage, lazyLoadInPage, readCssomInPage, parseCssTextInPage, readCssomVarsInPage } from "./capture-eval";

// Runs `run` (a page.evaluate call) and rethrows any failure (crashed page,
// detached frame, throw inside the page) as AppError(BROWSER_CRASH, …) with
// url context — the same wrapping every evaluate call in this file needs.
async function evalOrCrash<R>(page: Page, what: string, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (err) {
    throw new AppError(Codes.BROWSER_CRASH, `${what} failed: ${String(err)}`, { url: page.url(), cause: err });
  }
}

export type CaptureNode = {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  bbox: [number, number, number, number];
  style: Record<string, string>;
  pseudo?: { before?: Record<string, string>; after?: Record<string, string> };
  hidden?: boolean;
  children: CaptureNode[];
};

const MAX_NODES = 20_000;

// One page.evaluate walks the whole tree; styles are diffed against per-tag defaults.
export async function snapshotDom(page: Page): Promise<CaptureNode> {
  const result = await evalOrCrash(page, "DOM snapshot", () => page.evaluate(snapshotInPage, MAX_NODES));
  if ("limitExceeded" in result) {
    throw new AppError(Codes.NODE_LIMIT, `DOM exceeds ${MAX_NODES} nodes`, { url: page.url(), limit: MAX_NODES });
  }
  return result.root;
}

const MAX_SCROLL_STEPS = 50;
const MAX_SCROLL_PX = 30_000;
const SCROLL_SETTLE_MS = 100;
const IMG_DECODE_TIMEOUT_MS = 2_000;

// Scrolls to the bottom in bounded steps to trigger lazy-loaded content,
// decodes images, then scrolls back to the top. `truncated: true` means an
// infinite-scroll page hit the step/px cap before reaching its real bottom.
export async function lazyLoadScroll(page: Page): Promise<{ truncated: boolean }> {
  return evalOrCrash(page, "Lazy-load scroll", () =>
    page.evaluate(lazyLoadInPage, {
      maxSteps: MAX_SCROLL_STEPS,
      maxPx: MAX_SCROLL_PX,
      stepDelayMs: SCROLL_SETTLE_MS,
      decodeTimeoutMs: IMG_DECODE_TIMEOUT_MS,
    }),
  );
}

const BREAKPOINTS = [375, 768, 1440] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

export type ResponsiveCapture = { bp: Breakpoint; dom: CaptureNode; shot: Buffer; truncated: boolean };

// Caller has already navigated the page. Loops the 3 breakpoints in order
// (sequential: same page, viewport resize can't overlap), each time resizing
// the viewport, running the lazy-load pass, then taking a DOM snapshot and a
// full-page screenshot.
export async function captureResponsive(page: Page): Promise<ResponsiveCapture[]> {
  const results: ResponsiveCapture[] = [];
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp, height: 900 });
    const { truncated } = await lazyLoadScroll(page);
    const dom = await snapshotDom(page);
    const shot = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
    results.push({ bp, dom, shot, truncated });
  }
  return results;
}

const CROSS_ORIGIN_FETCH_LIMIT = 6;
const CROSS_ORIGIN_FETCH_TIMEOUT_MS = 30_000;

export type CssomResult = {
  keyframes: string[];
  fontFace: string[];
  media: string[];
  vars: Record<string, string>;
  stateSelectors: string[];
};

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Reads every stylesheet the page can see. Same-origin sheets are read
// directly; cross-origin sheets (which throw on .cssRules) are fetched as
// text in Node (bounded concurrency, per-fetch timeout, failures skipped)
// and parsed in a second evaluate via a constructable stylesheet.
export async function readCssom(page: Page): Promise<CssomResult> {
  const main = await evalOrCrash(page, "CSSOM read", () => page.evaluate(readCssomInPage));

  const fetched = await mapLimit(main.crossOriginHrefs, CROSS_ORIGIN_FETCH_LIMIT, async (href) => {
    try {
      const res = await page.context().request.get(href, { timeout: CROSS_ORIGIN_FETCH_TIMEOUT_MS });
      return res.ok() ? await res.text() : null;
    } catch {
      return null;
    }
  });
  const cssTexts = fetched.filter((text): text is string => text !== null);
  const extra = cssTexts.length
    ? await evalOrCrash(page, "Cross-origin CSSOM parse", () => page.evaluate(parseCssTextInPage, cssTexts))
    : { keyframes: [], fontFace: [], media: [], varNames: [], stateSelectors: [] };

  const varNames = dedupe([...main.varNames, ...extra.varNames]);
  const vars = await evalOrCrash(page, "CSS var resolution", () => page.evaluate(readCssomVarsInPage, varNames));

  return {
    keyframes: dedupe([...main.keyframes, ...extra.keyframes]),
    fontFace: dedupe([...main.fontFace, ...extra.fontFace]),
    media: dedupe([...main.media, ...extra.media]),
    stateSelectors: dedupe([...main.stateSelectors, ...extra.stateSelectors]),
    vars,
  };
}
