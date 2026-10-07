// E3b: the advanced visual editor (Style Manager, …) over a real site1 clone (pipeline, AI stubbed) in a `next build`
// app. Tests run in order on one project; each restores what it changed.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
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
  tmp = await mkdtemp(join(tmpdir(), "visual-advanced-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId); // finished before next start: recoverOnStartup must not see it running
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

type Tree = { id: string; tag: string; name?: string; text?: string; children: Tree[] };
type Payload = { revision: number; page: { id: string; sections: { id: string; root: Tree }[] } };
const canvas = (page: Page): FrameLocator => page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
const payload = async (): Promise<Payload> => (await (await fetch(`${app!.base}/api/projects/${projectId}/editor`)).json()) as Payload;
const outHtml = async () => (await fetch(`${app!.base}/api/projects/${projectId}/files/out/index.html`)).text();
const status = (page: Page) => page.getByRole("status");
const saved = (page: Page) => expect.poll(() => page.locator('[data-ui="ui_editor_save_state"]').innerText(), { timeout: 30_000 }).toBe("Đã lưu");
const walk = (n: Tree): Tree[] => [n, ...n.children.flatMap(walk)];
const allNodes = async () => (await payload()).page.sections.flatMap((s) => walk(s.root));
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth);
async function open(width = 1440, height = 1000): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  return page;
}
// counts section roots inserted into the frame (one per partial-update swap)
async function countSwaps(page: Page): Promise<() => Promise<number>> {
  const roots = (await payload()).page.sections.map((s) => s.root.id);
  await canvas(page).locator("body").evaluate((body, ids) => {
    const w = window as unknown as { __swaps: number };
    w.__swaps = 0;
    new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && ids.includes((n as Element).getAttribute("data-ir-id") ?? "")) w.__swaps++; }).observe(body, { childList: true, subtree: true });
  }, roots);
  return () => canvas(page).locator("body").evaluate(() => (window as unknown as { __swaps: number }).__swaps);
}
const nodeById = async (nid: string) => (await allNodes()).find((x) => x.id === nid) as (Tree & { styles: { base: Record<string, string>; bp: Record<string, Record<string, string>>; state: Record<string, Record<string, string>> } }) | undefined;
const fieldIn = (page: Page, prop: string) => page.locator(`[data-ui="ui_editor_style_field"][data-prop="${prop}"]`);

test("E3b Style Manager: values with their source (inherited at 768), optimistic at once, one section swapped, several edits on one field = one Undo; unsafe values never sent; ↺ removes the layer; :hover; free property", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.click();
  await page.getByRole("tab", { name: "Style" }).click();
  const color = fieldIn(page, "color");
  await expect.poll(() => color.locator("input").inputValue()).toBe("rgb(200, 30, 60)");
  expect(await color.innerText()).toContain("đặt ở bp này");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await expect.poll(() => color.innerText()).toContain("kế thừa từ Desktop");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  // two edits 500 ms apart: optimistic, one section swapped per step, one Undo restores the original
  const swaps = await countSwaps(page);
  const rev = (await payload()).revision;
  await color.locator("input").fill("rgb(0, 128, 0)");
  expect(await h1.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(0, 128, 0)");
  await page.waitForTimeout(500);
  await color.locator("input").fill("rgb(0, 0, 255)");
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.color, { timeout: 30_000 }).toBe("rgb(0, 0, 255)");
  expect((await payload()).revision).toBe(rev + 2);
  expect(await swaps()).toBe(2);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.color, { timeout: 30_000 }).toBe("rgb(200, 30, 60)");
  await expect.poll(() => color.locator("input").inputValue()).toBe("rgb(200, 30, 60)"); // the typed draft gives way to the stored value
  // unsafe: inline error, nothing sent, the canvas back to the stored value
  const before = (await payload()).revision;
  await color.locator("input").fill("red; } body{display:none");
  await expect.poll(() => color.locator('[role="alert"]').innerText()).toMatch(/không hợp lệ/);
  await page.waitForTimeout(600);
  expect((await payload()).revision).toBe(before);
  expect(await h1.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(200, 30, 60)");
  // ↺ at 768 (switching breakpoint drops the refused draft): set, then removed again
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await color.locator("input").fill("rgb(10, 10, 10)");
  await saved(page);
  await expect.poll(() => color.innerText()).toContain("đặt ở bp này");
  await color.getByRole("button", { name: "Bỏ color ở lớp này" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.color).toBeUndefined();
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  // :hover and a free property
  await page.getByRole("group", { name: "Trạng thái" }).getByRole("button", { name: ":hover" }).click();
  await expect.poll(() => page.getByText("Trạng thái áp cho mọi breakpoint").isVisible()).toBe(true);
  await color.locator("input").fill("rgb(1, 2, 3)");
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.state.hover?.color, { timeout: 30_000 }).toBe("rgb(1, 2, 3)");
  await page.getByRole("group", { name: "Trạng thái" }).getByRole("button", { name: "Mặc định" }).click();
  const free = page.locator('[data-ui="ui_editor_style_free"]');
  await free.locator("summary").click();
  await free.getByRole("textbox", { name: "Thuộc tính" }).fill("outline-offset");
  await free.getByRole("textbox", { name: "Giá trị" }).fill("3px");
  await free.getByRole("button", { name: "Thêm" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base["outline-offset"], { timeout: 30_000 }).toBe("3px");
  expect(await noSideScroll(page)).toBe(true);
  for (let i = 0; i < 4; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); } // free, hover, ↺, 768 set
  await expectUi(page, ["ui_editor_style_panel", "ui_editor_style_group", "ui_editor_style_state"]);
  await page.close();
});

test("E3b Style Manager: switching breakpoint within the 300 ms debounce still sends what was typed at the old one", { timeout: 120_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.click();
  const color = fieldIn(page, "color");
  await expect.poll(() => color.locator("input").inputValue()).toBe("rgb(200, 30, 60)");
  const rev = (await payload()).revision;
  await color.locator("input").fill("rgb(0, 128, 0)");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await color.locator("input").fill("rgb(0, 0, 255)");
  await saved(page);
  await expect.poll(async () => { const n = await nodeById(h1Id); return [n?.styles.base.color, n?.styles.bp["768"]?.color]; }, { timeout: 30_000 }).toEqual(["rgb(0, 128, 0)", "rgb(0, 0, 255)"]);
  expect((await payload()).revision).toBe(rev + 2);
  for (let i = 0; i < 2; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); }
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.color, { timeout: 30_000 }).toBe("rgb(200, 30, 60)");
  await page.close();
});
