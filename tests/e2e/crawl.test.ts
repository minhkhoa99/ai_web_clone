import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  expect(results.every((r) => r.status === 200 && (r.loadMs ?? -1) >= 0 && r.redirected === false)).toBe(true);
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

test("records per page the HTTP status, the time to DOMContentLoaded and whether it was redirected; no extra request", async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/robots.txt" || req.url === "/sitemap.xml") return void res.writeHead(404).end();
    if (req.url === "/old") return void res.writeHead(302, { location: "/new" }).end();
    if (req.url === "/private") return void res.writeHead(401, { "content-type": "text/html" }).end("<p>login required</p>");
    res.writeHead(200, { "content-type": "text/html" }).end('<a href="/old">old</a> <a href="/private">private</a> <a href="/new">new</a>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const results = await crawl(handle, { start: `${origin}/`, depth: 1, maxPages: 20, sameOriginOnly: true, delayMs: 0 });
    const by = new Map(results.map((r) => [new URL(r.url).pathname, r]));
    expect(by.get("/")).toMatchObject({ status: 200, redirected: false, needsAuth: false });
    expect(by.get("/old")).toMatchObject({ status: 200, redirected: true });
    expect(by.get("/private")).toMatchObject({ status: 401, redirected: false, needsAuth: true });
    for (const r of results) expect(r.loadMs).toBeGreaterThanOrEqual(0);
    // one navigation per page (+ the redirect hop): the timing adds no request
    expect(hits.filter((h) => h === "/").length).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
