// E2 §7: the Component panel over a real site4 clone in the GrapesJS editor of a `next build` app.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";
import { expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "editor-components-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const slideCount = async (base: string) => ((await (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text()).match(/data-c-role="slide"/g) ?? []).length;
const status = (page: Page) => page.getByRole("status");
// the first carousel's shown slide, once the edit-mode runtime laid the carousel out at its captured item
// (data-c-active, set on the editor's frame load); the others may sit outside the viewport
async function shownSlide(page: Page): Promise<Locator> {
  const root = page.frameLocator("iframe.gjs-frame").locator('[data-c="carousel"]').first();
  await root.and(page.frameLocator("iframe.gjs-frame").locator("[data-c-active]")).waitFor({ timeout: 30_000 });
  return root.locator('[data-c-role="slide"]').nth(Number(await root.getAttribute("data-c-active")));
}
// a canvas element clicked by position: scrolled clear of the app's fixed header first (at 375 Playwright's own
// scroll-into-view leaves it under the header, which then takes the click)
async function clickIn(page: Page, el: Locator, x = 4, y = 4): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  const box = (await el.boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
}
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth);

test("panel: select a slide -> Carousel panel; add, duplicate, delete, reorder; Undo/Redo; reload keeps it; 409 asks to reload", { timeout: 240_000 }, async () => {
  const base = app!.base;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await page.goto(`${base}/p/${projectId}/editor?legacy=1`);
  const canvas = page.frameLocator("iframe.gjs-frame");
  await (await shownSlide(page)).click();
  const panel = page.locator('[data-ui="ui_editor_component_panel"]');
  await expect.poll(() => panel.isVisible(), { timeout: 30_000 }).toBe(true);
  await expectUi(page, ["ui_editor_component_header", "ui_editor_component_items", "ui_editor_component_form", "ui_editor_component_unwrap"]);
  // every icon-only button of the panel names itself (GrapesJS' own Style Manager buttons are not ours)
  expect(await panel.locator("button").evaluateAll((els) => els.filter((b) => !b.textContent?.trim() && (!b.getAttribute("aria-label") || !b.getAttribute("title"))).length)).toBe(0);
  expect(await panel.innerText()).toMatch(/Carousel/);
  // the canvas runs the runtime in edit mode (R8): an item click shows that slide (edit-time state only)
  const rootId = (await canvas.locator('[data-c="carousel"]').first().getAttribute("data-ir-id"))!;
  await panel.locator(".cmp-item-pick").nth(1).click();
  await expect.poll(() => canvas.locator(`[data-ir-id="${rootId}"]`).getAttribute("data-c-active"), { timeout: 10_000 }).toBe("1");
  // a value the schema refuses is never sent: inline Vietnamese error, the input back to the stored value
  const interval = panel.getByLabel("Khoảng thời gian (ms)");
  const stored = await interval.inputValue();
  const revisionNow = async () => ((await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number }).revision;
  const rev = await revisionNow();
  await interval.fill("1500.5");
  await interval.press("Enter");
  expect(await panel.getByRole("alert").innerText()).toBe("Cần số nguyên từ 1000 đến 60000.");
  expect(await interval.inputValue()).toBe(stored);
  expect(await revisionNow()).toBe(rev);
  const before = await slideCount(base);
  // the panel stays locked from the command until the reload lands: never re-enabled in between (a click there was lost
  // when the reload locked it again, or sent the old revision)
  await page.evaluate(() => {
    const f = document.querySelector(".cmp-fieldset")!, w = window as unknown as { locks: boolean[] };
    w.locks = [];
    new MutationObserver(() => w.locks.push(f.hasAttribute("disabled"))).observe(f, { attributes: true, attributeFilter: ["disabled"] });
  });
  await panel.getByRole("button", { name: "Thêm" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã cập nhật component — điểm QA cần chạy lại");
  expect(await slideCount(base)).toBe(before + 1);
  const canvasSlides = canvas.locator('[data-c-role="slide"]'); // every carousel, like slideCount
  await expect.poll(async () => (await canvasSlides.count()) === before + 1 && !(await page.locator(".cmp-fieldset").isDisabled()), { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { locks: boolean[] }).locks)).toEqual([true, false]);
  await panel.getByRole("button", { name: /Nhân bản/ }).first().click();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 2);
  await panel.getByRole("button", { name: /Xoá/ }).first().click();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 1);
  await panel.getByRole("button", { name: /Xuống/ }).first().click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã cập nhật component — điểm QA cần chạy lại");
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await page.getByRole("button", { name: "Làm lại" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã làm lại — điểm QA cần chạy lại");
  await page.reload();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 1);
  // another tab commits first: the panel's next command gets 409 and the editor's "Tải lại" banner
  await (await shownSlide(page)).click();
  await expect.poll(() => panel.isVisible(), { timeout: 30_000 }).toBe(true);
  const { revision } = (await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number };
  expect((await fetch(`${base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: revision, commands: [{ op: "updateComponent", id: rootId, patch: { speed: 500 } }] }) })).status).toBe(200);
  await panel.getByRole("button", { name: "Thêm" }).click();
  await expect.poll(() => page.getByRole("button", { name: "Tải lại" }).isVisible(), { timeout: 30_000 }).toBe(true);
  await page.close();
});

test("panel: a plain node offers 'Đánh dấu là component…'; parity — no horizontal scroll at 375 and 1440 (wizard and carousel panel)", { timeout: 180_000 }, async () => {
  for (const width of [375, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${app!.base}/p/${projectId}/editor?legacy=1`);
    // section#sw of site4: wraps the swiper root but is no part of it (the canvas drops html ids: found as the root's parent)
    const plain = page.frameLocator("iframe.gjs-frame").locator('[data-c="carousel"]').first().locator("xpath=..");
    await plain.waitFor({ timeout: 30_000 });
    await clickIn(page, plain); // in the section's 16px padding: selects the section itself
    const convert = page.locator('[data-ui="ui_editor_component_convert"]');
    await expect.poll(() => convert.isVisible(), { timeout: 30_000 }).toBe(true);
    await convert.click();
    await expectUi(page, ["ui_editor_component_wizard"]);
    expect(await noSideScroll(page)).toBe(true);
    await clickIn(page, await shownSlide(page), 20, 20);
    await expect.poll(() => page.locator('[data-ui="ui_editor_component_items"]').isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    if (process.env.PARITY_DIR) {
      await mkdir(process.env.PARITY_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PARITY_DIR, `e2-panel-${width}.png`), fullPage: true });
    }
    await page.close();
  }
});
