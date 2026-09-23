import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { crawl } from "@/core/crawl";

const fixtureDir = fileURLToPath(new URL("../fixtures/site3", import.meta.url));

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
});

afterAll(async () => {
  await handle.close();
  await site.close();
});

test("crawls site3 to depth 2 and returns exactly the 3 allowed pages, no dupes", async () => {
  const results = await crawl(handle, {
    start: `${site.url}/index.html`,
    depth: 2,
    maxPages: 20,
    sameOriginOnly: true,
    delayMs: 5,
  });

  const urls = results.map((r) => r.url).sort();
  expect(urls).toEqual([`${site.url}/about.html`, `${site.url}/index.html`, `${site.url}/pricing.html`].sort());
  expect(new Set(urls).size).toBe(urls.length);
  expect(results.every((r) => r.needsAuth === false)).toBe(true);
});

test("excludes robots-disallowed, off-origin, mailto, and asset links", async () => {
  const results = await crawl(handle, {
    start: `${site.url}/index.html`,
    depth: 2,
    maxPages: 20,
    sameOriginOnly: true,
    delayMs: 5,
  });

  const urls = results.map((r) => r.url);
  expect(urls).not.toContain(`${site.url}/private.html`);
  expect(urls.some((u) => u.includes("example.com"))).toBe(false);
  expect(urls.some((u) => u.startsWith("mailto:"))).toBe(false);
  expect(urls.some((u) => u.endsWith(".png"))).toBe(false);
});

test("caps at maxPages", async () => {
  const results = await crawl(handle, {
    start: `${site.url}/index.html`,
    depth: 2,
    maxPages: 2,
    sameOriginOnly: true,
    delayMs: 5,
  });

  expect(results.length).toBe(2);
});

test("rejects with ROBOTS_DISALLOWED when the start URL itself is disallowed", async () => {
  await expect(
    crawl(handle, {
      start: `${site.url}/private.html`,
      depth: 1,
      maxPages: 20,
      sameOriginOnly: true,
      delayMs: 5,
    }),
  ).rejects.toMatchObject({ code: "ROBOTS_DISALLOWED" });
});

test("depth 0 returns only the start page", async () => {
  const results = await crawl(handle, {
    start: `${site.url}/index.html`,
    depth: 0,
    maxPages: 20,
    sameOriginOnly: true,
    delayMs: 5,
  });

  expect(results.map((r) => r.url)).toEqual([`${site.url}/index.html`]);
});
