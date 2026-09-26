import type { Page } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, writeFileAtomic } from "./fsx";
import { AppError, Codes } from "./errors";
import { mapLimit } from "./limit";
import { snapshotInPage, lazyLoadInPage, readCssomInPage, parseCssTextInPage, readCssomVarsInPage, fontsReadyInPage } from "./capture-eval";
import { withPage, blockNavigationAway, type BrowserHandle } from "./browser";
import { detectNeedsAuth } from "./auth";
import { scanInteractions, type Interaction } from "./interactions";
import { trackResponses, collectAssetUrls, downloadAssets, type DownloadResult } from "./assets";

// Runs `run` (a page.evaluate call) and rethrows any failure (crashed page,
// detached frame, throw inside the page) as AppError(BROWSER_CRASH, …) with
// url context — the same wrapping every evaluate call in this file needs.
export async function evalOrCrash<R>(page: Page, what: string, run: () => Promise<R>): Promise<R> {
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
export const FONTS_READY_MS = 10_000;

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

// --- capturePage ------------------------------------------------------------

const CAPTURE_NAV_TIMEOUT_MS = 30_000;

function assertSafePageId(pageId: string): void {
  if (!pageId || pageId.includes("/") || pageId.includes("\\") || pageId.includes("..")) {
    throw new Error(`capturePage: unsafe pageId ${JSON.stringify(pageId)}`);
  }
}

const EMPTY_DOM: CaptureNode = { tag: "", attrs: {}, style: {}, bbox: [0, 0, 0, 0], children: [] };

// Union of every asset reference across all 3 breakpoint DOMs (responsive
// layouts can swap images) plus the network-observed URLs, deduped.
function collectAllAssetUrls(breakpoints: ResponsiveCapture[], networkUrls: string[], baseUrl: string): string[] {
  const fromDoms = breakpoints.flatMap((bp) => collectAssetUrls(bp.dom, [], baseUrl));
  const fromNetwork = collectAssetUrls(EMPTY_DOM, networkUrls, baseUrl);
  return [...new Set([...fromDoms, ...fromNetwork])];
}

// title + head meta[name]/meta[property] -> content.
async function readPageMeta(page: Page): Promise<{ title: string; meta: Record<string, string> }> {
  return evalOrCrash(page, "Meta read", () =>
    page.evaluate(() => {
      const meta: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("head meta[name], head meta[property]"))) {
        const key = el.getAttribute("name") ?? el.getAttribute("property");
        const content = el.getAttribute("content");
        if (key && content !== null) meta[key] = content;
      }
      return { title: document.title, meta };
    }),
  );
}

export type DynamicAsset = { order: number; asset: string };

const MAX_CANVAS_SHOTS = 20;

// Spec §6 step 8 (canvas/WebGL -> image + `dynamic`): screenshots every
// visible <canvas>, in document order, up to the cap. Content-hash named and
// deduped like other assets (tmp -> rename, reused if already on disk).
// Sequential: bounded to MAX_CANVAS_SHOTS actions on the one shared page.
// A single canvas failing to screenshot is a warning, never a throw.
async function captureCanvases(page: Page, workspaceDir: string): Promise<{ dynamic: DynamicAsset[]; warnings: string[] }> {
  const total = Math.min(await page.locator("canvas").count(), MAX_CANVAS_SHOTS);
  const assetsDir = join(workspaceDir, "assets");
  const dynamic: DynamicAsset[] = [];
  const warnings: string[] = [];

  for (let order = 0; order < total; order++) {
    const locator = page.locator("canvas").nth(order);
    try {
      if (!(await locator.isVisible())) continue;
      const shot = await locator.screenshot({ animations: "disabled" });
      const fileName = `${createHash("sha256").update(shot).digest("hex")}.png`;
      const absPath = join(assetsDir, fileName);
      if (!(await fileExists(absPath))) {
        await mkdir(assetsDir, { recursive: true });
        await writeFileAtomic(absPath, shot);
      }
      dynamic.push({ order, asset: `assets/${fileName}` });
    } catch (err) {
      warnings.push(`canvas #${order} screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { dynamic, warnings };
}

export type PageCapture = {
  url: string;
  pageId: string;
  capturedAt: string;
  title: string;
  meta: Record<string, string>;
  cssom: CssomResult;
  breakpoints: Pick<ResponsiveCapture, "bp" | "dom" | "truncated">[];
  interactions: Interaction[];
  assets: Record<string, string>;
  skippedAssets: DownloadResult["skipped"];
  dynamic: DynamicAsset[];
};

export type PageCaptureMeta = {
  pageId: string;
  capturePath: string;
  shots: Record<number, string>;
  assetBytes: number;
  warnings: string[];
};

// Writes capture.json + shots/<bp>.png (each tmp -> rename) and returns the
// lightweight metadata capturePage resolves with — never the DOMs/buffers.
async function writeCaptureOutput(
  workspaceDir: string,
  pageId: string,
  data: PageCapture,
  breakpoints: ResponsiveCapture[],
  skipped: DownloadResult["skipped"],
  assetBytes: number,
  extraWarnings: string[],
): Promise<PageCaptureMeta> {
  const pageDir = join(workspaceDir, "pages", pageId);
  await mkdir(join(pageDir, "shots"), { recursive: true });

  const shots: Record<number, string> = {};
  await Promise.all(
    breakpoints.map(async (bp) => {
      const relPath = `pages/${pageId}/shots/${bp.bp}.png`;
      await writeFileAtomic(join(workspaceDir, relPath), bp.shot);
      shots[bp.bp] = relPath;
    }),
  );

  const capturePath = `pages/${pageId}/capture.json`;
  await writeFileAtomic(join(workspaceDir, capturePath), JSON.stringify(data));

  const warnings: string[] = [...extraWarnings];
  for (const bp of breakpoints) {
    if (bp.truncated) warnings.push(`breakpoint ${bp.bp}px: lazy-load truncated`);
  }
  for (const s of skipped) warnings.push(`asset skipped (${s.code}): ${s.url}`);

  return { pageId, capturePath, shots, assetBytes, warnings };
}

export type CapturePageOpts = { url: string; pageId: string; workspaceDir: string; budgetBytes?: number };

// Ties T9-T12 into one call per page (spec §6 steps 1-8): navigate (blocked
// from leaving, networkidle, fonts ready) -> auth/captcha check -> CSSOM ->
// responsive DOM+screenshots -> canvas/WebGL snapshots -> hidden interactions
// at 1440 -> assets. Writes capture.json + shots and resolves with metadata only.
export async function capturePage(handle: BrowserHandle, opts: CapturePageOpts): Promise<PageCaptureMeta> {
  assertSafePageId(opts.pageId);
  const { url, pageId, workspaceDir, budgetBytes } = opts;

  return withPage(handle, async (page) => {
    const tracker = trackResponses(page);
    const unblock = await blockNavigationAway(page, url);
    try {
      const response = await page
        .goto(url, { waitUntil: "networkidle", timeout: CAPTURE_NAV_TIMEOUT_MS })
        .catch((err) => {
          throw new AppError(Codes.NAV_TIMEOUT, `navigation to ${url} timed out`, { url, cause: err });
        });

      await evalOrCrash(page, "Fonts ready", () => page.evaluate(fontsReadyInPage, FONTS_READY_MS));

      const authState = await detectNeedsAuth(page, { status: response?.status(), requestedUrl: url });
      if (authState === "auth") throw new AppError(Codes.AUTH_REQUIRED, `page requires login: ${url}`, { url });
      if (authState === "captcha") throw new AppError(Codes.CAPTCHA_REQUIRED, `page requires captcha: ${url}`, { url });

      const cssom = await readCssom(page);
      const breakpoints = await captureResponsive(page);
      const { dynamic, warnings: canvasWarnings } = await captureCanvases(page, workspaceDir);
      const interactions = await scanInteractions(page, { stateSelectors: cssom.stateSelectors });
      const { title, meta } = await readPageMeta(page);

      const assetUrls = collectAllAssetUrls(breakpoints, tracker.urls(), url);
      const { assets, skipped, bytes } = await downloadAssets(handle.context, assetUrls, join(workspaceDir, "assets"), {
        budgetBytes,
      });

      const data: PageCapture = {
        url,
        pageId,
        capturedAt: new Date().toISOString(),
        title,
        meta,
        cssom,
        breakpoints: breakpoints.map(({ bp, dom, truncated }) => ({ bp, dom, truncated })),
        interactions,
        assets: Object.fromEntries(assets),
        skippedAssets: skipped,
        dynamic,
      };
      return await writeCaptureOutput(workspaceDir, pageId, data, breakpoints, skipped, bytes, canvasWarnings);
    } finally {
      tracker.stop();
      await unblock();
    }
  });
}
