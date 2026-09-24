import type { BrowserHandle } from "./browser";
import { withPage } from "./browser";
import { normalizeUrl, sameOrigin, isHtmlLike } from "./url";
import { AppError, Codes } from "./errors";
import { detectNeedsAuth } from "./auth";

export type CrawlPage = { url: string; needsAuth: boolean; status?: number | null; loadMs?: number; redirected?: boolean };

type Loaded = { links: string[]; needsAuth: boolean; status: number | null; loadMs: number; redirected: boolean };

type CrawlOpts = {
  start: string;
  depth: number;
  maxPages: number;
  sameOriginOnly: true;
  delayMs?: number;
};

async function fetchText(handle: BrowserHandle, url: string): Promise<string | null> {
  try {
    const res = await handle.context.request.get(url);
    if (!res.ok()) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Minimal robots.txt parser: collects Disallow prefixes under "User-agent: *".
function parseRobotsDisallow(text: string): string[] {
  const disallow: string[] = [];
  let inWildcard = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const agentMatch = /^user-agent\s*:\s*(\S+)/i.exec(line);
    if (agentMatch) {
      inWildcard = agentMatch[1] === "*";
      continue;
    }
    if (!inWildcard) continue;
    const disallowMatch = /^disallow\s*:\s*(\S*)/i.exec(line);
    if (disallowMatch && disallowMatch[1]) disallow.push(disallowMatch[1]);
  }
  return disallow;
}

function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] as string);
}

// The navigation's own response: status, time to DOMContentLoaded, redirect — no extra request.
async function loadPage(handle: BrowserHandle, pageUrl: string): Promise<Loaded> {
  return withPage(handle, async (page) => {
    const t0 = performance.now();
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    const loadMs = Math.round(performance.now() - t0);
    const authState = await detectNeedsAuth(page, { status: response?.status(), requestedUrl: pageUrl });
    // `any`: $$eval runs in the browser context, not Node — no DOM lib types here.
    const links = await page.$$eval("a[href]", (anchors: any[]) => anchors.map((a) => a.getAttribute("href") ?? ""));
    return { links, needsAuth: authState !== "none", status: response?.status() ?? null, loadMs, redirected: !!response?.request().redirectedFrom() };
  });
}

/**
 * Bounded, same-origin BFS crawl: seeds from sitemap.xml (depth 1) + <a href>
 * links found on each visited page, respecting robots.txt. Stops at depth or
 * maxPages. needsAuth comes from detectNeedsAuth (password field, login
 * redirect, 401/403, or captcha) run on each visited page.
 */
// ponytail: sequential BFS, not mapLimit-parallel — single origin + a
// per-origin politeness delay make concurrent fetches pointless here.
export async function crawl(handle: BrowserHandle, opts: CrawlOpts): Promise<CrawlPage[]> {
  const depth = Math.min(5, Math.max(0, opts.depth));
  const maxPages = Math.min(100, Math.max(1, opts.maxPages));
  const delayMs = opts.delayMs ?? 500;

  const start = normalizeUrl(opts.start);
  if (!start) throw new AppError(Codes.NAV_TIMEOUT, "invalid start URL", { url: opts.start });

  const origin = new URL(start).origin;
  const robotsText = await fetchText(handle, `${origin}/robots.txt`);
  const disallow = robotsText ? parseRobotsDisallow(robotsText) : [];
  const isAllowed = (url: string) => !disallow.some((prefix) => new URL(url).pathname.startsWith(prefix));

  if (!isAllowed(start)) {
    throw new AppError(Codes.ROBOTS_DISALLOWED, "start URL disallowed by robots.txt", { url: start });
  }

  const visited = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];

  if (depth >= 1) {
    const sitemapText = await fetchText(handle, `${origin}/sitemap.xml`);
    for (const loc of sitemapText ? parseSitemapLocs(sitemapText) : []) {
      const normalized = normalizeUrl(loc, start);
      if (!normalized || !sameOrigin(normalized, start) || !isHtmlLike(normalized)) continue;
      if (visited.has(normalized) || !isAllowed(normalized)) continue;
      visited.add(normalized);
      queue.push({ url: normalized, depth: 1 });
    }
  }

  let lastFetchAt = 0;
  async function politeDelay(): Promise<void> {
    const wait = lastFetchAt + delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastFetchAt = Date.now();
  }

  const results: CrawlPage[] = [];
  while (queue.length > 0 && results.length < maxPages) {
    const item = queue.shift();
    if (!item) break;
    await politeDelay();

    let page: Loaded;
    try {
      page = await loadPage(handle, item.url);
    } catch (err) {
      if (item.url === start) {
        throw new AppError(Codes.NAV_TIMEOUT, "failed to load start URL", { url: start, cause: err });
      }
      continue; // skip this page, keep crawling the rest of the queue
    }

    results.push({ url: item.url, needsAuth: page.needsAuth, status: page.status, loadMs: page.loadMs, redirected: page.redirected });
    if (results.length >= maxPages || item.depth >= depth) continue;

    for (const href of page.links) {
      const normalized = normalizeUrl(href, item.url);
      if (!normalized || !sameOrigin(normalized, start) || !isHtmlLike(normalized)) continue;
      if (visited.has(normalized) || !isAllowed(normalized)) continue;
      visited.add(normalized);
      queue.push({ url: normalized, depth: item.depth + 1 });
    }
  }

  return results;
}
