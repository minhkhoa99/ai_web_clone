import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { snapshotDom, type CaptureNode } from "@/core/capture";
import { scanInteractives, type CapturedInteractive } from "@/core/interactive-scan";
import { serveDir } from "@/core/serve";

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  await handle.context.route(/^https?:\/\/www\.youtube-nocookie\.com\//, (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" })); // local fake embed, no network
  site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
});
afterAll(async () => { await handle.close(); await site.close(); });

const open = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${site.url}/index.html`, { waitUntil: "networkidle" });
};
const scan = (limits?: Parameters<typeof scanInteractives>[1], prepare?: (page: Page) => Promise<unknown>) => withPage(handle, async (page) => {
  await open(page);
  await prepare?.(page);
  return scanInteractives(page, limits);
});
type Carousel = Extract<CapturedInteractive, { kind: "carousel" }>;
const carousel = (all: CapturedInteractive[], id: string) => all.find((x): x is Carousel => x.kind === "carousel" && x.selector.startsWith(`#${id}`));

test("config: Swiper params per breakpoint, Slick options (max-width responsive)", { timeout: 60_000 }, async () => {
  const all = await scan();
  expect(carousel(all, "swiper-a")).toMatchObject({ source: "swiper", confidence: "config", read: {
    loop: true, autoplay: true, interval: 3000, speed: 400, effect: "slide", direction: "horizontal",
    perBp: { "1440": { spv: 3, gap: 30 }, "768": { spv: 2, gap: 20 }, "375": { spv: 1, gap: 10 } } } });
  expect(carousel(all, "slick-a")).toMatchObject({ source: "slick", confidence: "config", read: { loop: true, autoplay: false, perBp: { "1440": { spv: 2 }, "768": { spv: 1 }, "375": { spv: 1 } } } });
  expect(all).toContainEqual(expect.objectContaining({ kind: "dropdown", openOn: "hover" }));
});

test("Review Focus 2 — el.swiper not exposed: observed autoplay + interval, never config; scroll-snap observed without autoplay", { timeout: 60_000 }, async () => {
  const all = await scan();
  const hidden = carousel(all, "swiper-hidden")!;
  expect(hidden).toMatchObject({ source: "swiper", confidence: "observed", autoplay: true });
  expect(hidden.interval).toBeGreaterThanOrEqual(1200);
  expect(hidden.interval).toBeLessThanOrEqual(1800);
  expect(carousel(all, "snap")).toMatchObject({ source: "scroll-snap", confidence: "observed", autoplay: false });
});

test("budgets: a config read that times out falls back to observed; no page budget left -> guessed; never throws", { timeout: 60_000 }, async () => {
  expect(carousel(await scan({ limits: { configMs: 1 } }), "swiper-a")?.confidence).toBe("observed");
  const none = await scan({ limits: { configMs: 1, pageMs: 0 } });
  expect(carousel(none, "swiper-hidden")?.confidence).toBe("guessed");
});

test("config read: originalParams over the live params, a breakpoint without a gap keeps the base gap, functions and free strings are dropped, a throwing instance costs only its own carousel", { timeout: 60_000 }, async () => {
  const all = await scan(undefined, (page) => page.evaluate(() => {
    const add = (id: string) => { const el = document.createElement("div"); el.className = "swiper"; el.id = id; el.innerHTML = '<div class="swiper-wrapper"><div class="swiper-slide">X</div></div>'; document.body.append(el); return el as HTMLElement & { swiper?: unknown }; };
    add("odd").swiper = { params: { slidesPerView: 9 }, realIndex: 0,
      originalParams: { slidesPerView: 2, spaceBetween: "12px", breakpoints: { 768: { slidesPerView: 3 } }, effect: "alert(1)", autoplay: { delay: () => 1 } } };
    Object.defineProperty(add("boom"), "swiper", { get() { throw new Error("boom"); } });
  }));
  const odd = carousel(all, "odd")!;
  expect(odd).toMatchObject({ confidence: "config", read: { autoplay: true, perBp: { "1440": { spv: 3, gap: 12 }, "768": { spv: 3, gap: 12 }, "375": { spv: 2, gap: 12 } } } });
  expect(odd.read!.effect).toBeUndefined();
  expect(odd.read!.interval).toBeUndefined();
  expect(carousel(all, "boom")?.confidence).toBe("observed");
  expect(carousel(all, "swiper-a")?.confidence).toBe("config");
});

test("embed iframe src is stored absolute: a protocol-relative src resolves against the page URL", { timeout: 60_000 }, async () => {
  const dom = await withPage(handle, async (page) => {
    await open(page);
    await page.evaluate(() => { const f = document.createElement("iframe"); f.src = "//www.youtube-nocookie.com/embed/rel1"; document.body.append(f); });
    return snapshotDom(page);
  });
  const srcs: string[] = [];
  const walk = (n: CaptureNode) => { if (n.tag === "iframe") srcs.push(n.attrs.src!); n.children.forEach(walk); };
  walk(dom);
  expect(srcs).toEqual(["https://www.youtube-nocookie.com/embed/abc123", `${new URL(site.url).protocol}//www.youtube-nocookie.com/embed/rel1`]);
});

test("hover probes (which scroll triggers into view) leave the page scrolled back to the top", { timeout: 60_000 }, async () => {
  const [all, y] = await withPage(handle, async (page) => {
    await open(page);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div style="margin-top:4000px"><button aria-haspopup="true">Low</button><ul style="display:none"><li>x</li></ul></div>')); // a trigger far below the fold
    const all = await scanInteractives(page);
    return [all, await page.evaluate(() => scrollY)] as const;
  });
  expect(all.some((x) => x.kind === "dropdown")).toBe(true);
  expect(y).toBe(0);
});
