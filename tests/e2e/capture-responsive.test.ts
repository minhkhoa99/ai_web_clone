import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { captureResponsive, readCssom } from "@/core/capture";

const fixtureDir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));
const crossOriginDir = fileURLToPath(new URL("../fixtures/cross-origin", import.meta.url));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };
let crossOrigin: { url: string; close(): Promise<void> };

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
  crossOrigin = await serveDir(crossOriginDir);
});

afterAll(async () => {
  await handle.close();
  await site.close();
  await crossOrigin.close();
});

test("captureResponsive returns 3 breakpoints in order with full-page PNG shots", async () => {
  const results = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    return captureResponsive(page);
  });

  expect(results.map((r) => r.bp)).toEqual([375, 768, 1440]);
  for (const r of results) {
    expect(r.dom.tag).toBe("html");
    expect(r.shot.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(typeof r.truncated).toBe("boolean");
    expect(r.truncated).toBe(false);
  }
});

test("lazy image below the fold is loaded after the scroll pass", async () => {
  const naturalWidth = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    await captureResponsive(page);
    return page.evaluate(() => document.querySelector<HTMLImageElement>("img.lazy-img")!.naturalWidth);
  });
  expect(naturalWidth).toBeGreaterThan(0);
});

test("readCssom extracts keyframes, font-face, media, vars, and state selectors", async () => {
  const cssom = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    return readCssom(page);
  });

  expect(cssom.keyframes.some((k) => k.includes("spin"))).toBe(true);
  expect(cssom.fontFace.some((f) => f.includes("LocalFont"))).toBe(true);
  expect(cssom.media.some((m) => m.includes("mq-note"))).toBe(true);
  expect(cssom.vars["--brand-color"]).toBe("#ff6600");
  expect(cssom.stateSelectors).toContain(".card");
  // deduped: .card appears once even though :hover and :focus both target it
  expect(cssom.stateSelectors.filter((s) => s === ".card")).toHaveLength(1);
});

test("readCssom fetches and parses a cross-origin stylesheet's rules", async () => {
  const cssom = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    await page.addStyleTag({ url: `${crossOrigin.url}/external.css` });
    return readCssom(page);
  });

  expect(cssom.keyframes.some((k) => k.includes("cross-spin"))).toBe(true);
  expect(cssom.fontFace.some((f) => f.includes("CrossFont"))).toBe(true);
  expect(cssom.media.some((m) => m.includes("cross-note"))).toBe(true);
});
