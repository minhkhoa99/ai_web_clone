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
      page.locator("#dialog").isVisible(),
      page.locator("#panel-2").isVisible(),
      page.locator("#panel-1").isVisible(),
      page.evaluate(() => document.querySelector("details")!.open),
    ]),
  );

  const menu = captured(found, "menu");
  expect(menu).toHaveLength(1);
  expect(menu[0]!.trigger).toBe("#menu-btn");
  expect(menu[0]!.subtreeHtml).toContain('id="main-nav"');

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

  // Restored: menu/dialog/tab-2 hidden again, default tab visible, details closed.
  expect(extra).toEqual([false, false, false, true, false]);

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

  const timedOut = await scanSite2({ limits: { perInteractionMs: 1 } });
  expect(timedOut.found.length).toBeGreaterThan(0);
  expect(timedOut.found.every((i) => i.status === "failed")).toBe(true);
});
