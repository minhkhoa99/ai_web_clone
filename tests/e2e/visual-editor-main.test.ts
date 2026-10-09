// E3b edit main (R16–R18): the visual editor over a real site5 clone (three same-shaped cards -> one component, three
// instances; pipeline, AI stubbed) in a `next build` app.
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
import { expectIconButtonsLabelled, expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "visual-editor-main-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site5", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId); // finished before next start: recoverOnStartup must not see it running
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

type Tree = { id: string; tag: string; name?: string; text?: string; component?: { id: string; role: string; sourceId?: string; overrides?: string[] }; children: Tree[] };
type Payload = { revision: number; page: { id: string; sections: { id: string; root: Tree }[] } };
const canvas = (page: Page): FrameLocator => page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
const payload = async (): Promise<Payload> => (await (await fetch(`${app!.base}/api/projects/${projectId}/editor`)).json()) as Payload;
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

test("E3b edit main: Sửa main on an instance; H hides the h3 of every card in one step; inline text edits the main (card 1 follows, cards 2–3 keep their own text); Esc at the root, Xong and a click outside leave", { timeout: 240_000 }, async () => {
  const roots = (await allNodes()).filter((x) => x.component?.role === "instance" && x.children.some((c) => c.tag === "h3"));
  expect(roots).toHaveLength(3); // site5 must give E1 one component — if not, stop and report (do not change detection)
  const h3Id = (k: number) => roots[k]!.children.find((c) => c.tag === "h3")!.id;
  const page = await open();
  const h3 = (k: number) => canvas(page).locator(`[data-ir-id="${h3Id(k)}"]`);
  const bar = page.locator('[data-ui="ui_editor_edit_main_bar"]');
  await h3(1).click();
  await page.locator('[data-ui="ui_editor_edit_main"]').click();
  await expect.poll(() => bar.isVisible()).toBe(true);
  await expectUi(page, ["ui_editor_edit_main_bar", "ui_editor_edit_main_frame"]);
  expect(await page.locator('[data-ui="ui_editor_edit_main_frame"]').count()).toBe(1);
  expect(await noSideScroll(page)).toBe(true);
  await expectIconButtonsLabelled(page);
  // H on card 2's h3 = setHidden on the main's h3: every card follows, one revision, one Undo
  const rev = (await payload()).revision;
  await page.keyboard.press("h");
  await saved(page);
  await expect.poll(async () => (await payload()).revision, { timeout: 30_000 }).toBe(rev + 1);
  for (const k of [0, 1, 2]) await expect.poll(() => h3(k).isVisible(), { timeout: 30_000 }).toBe(false);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  for (const k of [0, 1, 2]) await expect.poll(() => h3(k).isVisible(), { timeout: 30_000 }).toBe(true);
  // inline text on card 1 edits the main's text: card 1 follows, cards 2–3 keep their own (text override). Selecting
  // inside another instance of the same component moves the open instance there (still the same main)
  await h3(0).dblclick();
  await expect.poll(() => bar.isVisible()).toBe(true);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Main mới");
  await page.keyboard.press("Enter");
  await saved(page);
  await expect.poll(() => h3(0).innerText(), { timeout: 30_000 }).toBe("Main mới");
  expect([await h3(1).innerText(), await h3(2).innerText()]).toEqual(["Gọn", "Tĩnh"]);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => h3(0).innerText(), { timeout: 30_000 }).toBe("Nhanh");
  // Esc goes up inside the instance; at its root Esc leaves the mode
  await h3(1).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => bar.isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => bar.count()).toBe(0);
  // Xong, and a click outside the instance, leave too
  await h3(1).click();
  await page.locator('[data-ui="ui_editor_edit_main"]').click();
  await page.getByRole("button", { name: "Xong" }).click();
  await expect.poll(() => bar.count()).toBe(0);
  await h3(1).click();
  await page.locator('[data-ui="ui_editor_edit_main"]').click();
  await expect.poll(() => bar.isVisible()).toBe(true);
  await canvas(page).locator("h1").click();
  await expect.poll(() => bar.count()).toBe(0);
  // ≤ 1099px (drawers): the bar still fits; < 768px (view-only) the mode closes
  await h3(1).click();
  await page.locator('[data-ui="ui_editor_edit_main"]').click();
  await page.setViewportSize({ width: 1024, height: 1000 });
  await expect.poll(() => bar.isVisible()).toBe(true);
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect.poll(() => bar.count()).toBe(0);
  await page.close();
});

test("E4: while editing main the AI input is off with its note; Xong turns it back on", { timeout: 120_000 }, async () => {
  const roots = (await allNodes()).filter((x) => x.component?.role === "instance" && x.children.some((c) => c.tag === "h3"));
  const h3 = roots[1]!.children.find((c) => c.tag === "h3")!.id;
  const page = await open();
  await canvas(page).locator(`[data-ir-id="${h3}"]`).click();
  await page.locator('[data-ui="ui_editor_edit_main"]').click();
  await page.locator('[data-ui="ui_editor_ai_tab"]').click();
  const input = page.locator('[data-ui="ui_editor_ai_input"]');
  await expect.poll(() => input.isDisabled()).toBe(true);
  expect(await page.getByText("Đang sửa main component — bấm Xong để chat.").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Xong" }).click();
  await expect.poll(() => input.isDisabled()).toBe(false);
  await page.close();
});
