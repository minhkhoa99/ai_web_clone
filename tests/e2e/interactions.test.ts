import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { readCssom } from "@/core/capture";
import { scanInteractions, type Interaction } from "@/core/interactions";

const fixtureDir = fileURLToPath(new URL("../fixtures/site2", import.meta.url));

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

async function scanSite2<T>(
  opts: Parameters<typeof scanInteractions>[1],
  after?: (page: Page, found: Interaction[]) => Promise<T>,
) {
  return withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    const { stateSelectors } = await readCssom(page);
    const found = await scanInteractions(page, { stateSelectors, ...opts });
    return { found, extra: after ? await after(page, found) : undefined };
  });
}

const captured = (found: Interaction[], kind: Interaction["kind"]) =>
  found.filter((i) => i.kind === kind && i.status === "captured");

test("site2: every interaction kind is captured and the page is restored", async () => {
  const { found, extra } = await scanSite2({}, (page) =>
    Promise.all([
      page.locator("#main-nav").isVisible(),
      page.evaluate(() => document.querySelectorAll(".open").length),
      page.locator("#dialog").isVisible(),
      page.locator("#panel-2").isVisible(),
      page.locator("#panel-1").isVisible(),
      page.evaluate(() => document.querySelector("details")!.open),
    ]),
  );

  // display:none nav, visibility:hidden and opacity:0 dropdowns all count as revealed.
  const menu = captured(found, "menu");
  expect(menu.map((m) => m.trigger).sort()).toEqual(["#fade-btn", "#menu-btn", "#vis-btn"]);
  const menuHtml = (trigger: string) => menu.find((m) => m.trigger === trigger)!.subtreeHtml;
  expect(menuHtml("#menu-btn")).toContain('id="main-nav"');
  expect(menuHtml("#vis-btn")).toContain('id="vis-menu"');
  expect(menuHtml("#fade-btn")).toContain('id="fade-menu"');

  const tabs = captured(found, "tab");
  expect(tabs.map((t) => t.trigger).sort()).toEqual(["#tab-1", "#tab-2", "#tab-3"]);
  expect(tabs.find((t) => t.trigger === "#tab-2")!.subtreeHtml).toContain("Panel two");

  const modal = captured(found, "modal");
  expect(modal).toHaveLength(1);
  expect(modal[0]!.subtreeHtml).toContain("Dialog body");

  const accordion = captured(found, "accordion");
  expect(accordion).toHaveLength(1);
  expect(accordion[0]!.subtreeHtml).toContain("Answer text");

  const carousel = captured(found, "carousel");
  expect(carousel.map((c) => c.trigger)).toEqual(["#carousel"]);

  const sticky = captured(found, "sticky");
  expect(sticky).toHaveLength(1);
  expect(sticky[0]!.styleDelta!["background-color"]).toBe("rgb(20, 20, 20)");

  const hoverCard = captured(found, "hover").find((h) => h.styleDelta?.["background-color"] === "rgb(0, 120, 255)");
  expect(hoverCard).toBeDefined();

  const form = captured(found, "form");
  expect(form).toHaveLength(1);
  expect(form[0]!.styleDelta!["outline-color"]).toBe("rgb(0, 200, 0)");
  expect(form[0]!.subtreeHtml).toContain('placeholder="you@example.com"');

  // Restored: no menu/dialog left open, tab-2 hidden, default tab visible, details closed.
  expect(extra).toEqual([false, 0, false, false, true, false]);

  // ids are unique + deterministic per kind+trigger.
  expect(new Set(found.map((i) => i.id)).size).toBe(found.length);
  const again = await scanSite2({});
  expect(again.found.map((i) => i.id)).toEqual(found.map((i) => i.id));
});

test("limits: max caps entries, zero budget skips, per-interaction timeout fails without throwing", async () => {
  const capped = await scanSite2({ limits: { max: 3 } });
  expect(capped.found).toHaveLength(3);

  const noBudget = await scanSite2({ limits: { totalMs: 0 } });
  expect(noBudget.found.length).toBeGreaterThan(0);
  expect(noBudget.found.every((i) => i.status === "skipped")).toBe(true);

});

// Counts in-flight Page calls: if a timed-out scanner kept running next to the
// following one (or outlived scanInteractions), two calls would overlap.
function trackPageCalls(page: Page) {
  const stats = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const methods = ["click", "hover", "focus", "evaluate", "reload", "waitForTimeout"] as const;
  const target = page as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of methods) {
    const original = target[name]!.bind(page);
    target[name] = async (...args: unknown[]) => {
      stats.calls++;
      stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
      try {
        return await original(...args);
      } finally {
        stats.inFlight--;
      }
    };
  }
  return stats;
}

test("per-interaction timeout: failed, never overlaps the next scan, page left clean", async () => {
  const result = await withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    const { stateSelectors } = await readCssom(page);
    const stats = trackPageCalls(page);
    const found = await scanInteractions(page, { stateSelectors, limits: { perInteractionMs: 1 } });
    const afterScan = { ...stats };
    await new Promise((resolve) => setTimeout(resolve, 2_500)); // > ACTION_TIMEOUT_MS: nothing may still be running
    const lateCalls = stats.calls - afterScan.calls;
    const openCount = await page.evaluate(() => document.querySelectorAll(".open, details[open]").length);
    return { found, afterScan, lateCalls, openCount };
  });

  expect(result.found.length).toBeGreaterThan(0);
  expect(result.found.every((i) => i.status === "failed")).toBe(true);
  expect(result.afterScan.maxInFlight).toBe(1);
  expect(result.afterScan.inFlight).toBe(0);
  expect(result.lateCalls).toBe(0);
  expect(result.openCount).toBe(0);
});
