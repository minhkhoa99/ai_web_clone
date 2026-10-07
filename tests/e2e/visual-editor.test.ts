// E3a: the visual editor over a real site1 clone (pipeline, AI stubbed) in a `next build` app. Tests run in order on
// one project; each restores what it changed.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { parityShot } from "./parity-shots";
import { startNextApp } from "./next-app";
import { expectIconButtonsLabelled, expectNoDrift, expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "visual-editor-"));
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

test("E3a shell: the new editor by default — sandboxed srcdoc frame based on out/, one runtime script, CSP; links never navigate; breakpoints resize the frame; Editor cũ keeps GrapesJS; no sideways scroll at 1440", { timeout: 120_000 }, async () => {
  const page = await open();
  await parityShot(page, "e3a-shell-1440"); // before any click scrolls the canvas
  const frame = page.locator('[data-ui="ui_editor_canvas_frame"]');
  expect(await frame.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts");
  const h1 = canvas(page).locator("h1");
  expect(await h1.innerText()).toBe("Build faster sites");
  expect(await h1.evaluate(() => document.baseURI)).toBe(`${app!.base}/api/projects/${projectId}/files/out/index.html`);
  expect(await h1.evaluate(() => [...document.scripts].map((s) => s.src))).toEqual([`${app!.base}/api/projects/${projectId}/files/out/js/runtime.js?edit=1`]);
  expect(await h1.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "")).toContain("script-src ");
  await canvas(page).getByRole("link", { name: "Features" }).click();
  expect(await h1.evaluate(() => location.href)).toBe("about:srcdoc");
  await expectUi(page, ["ui_editor_page_header", "ui_editor_toolbar", "ui_editor_bp_switch", "ui_editor_save_state", "ui_editor_legacy_link", "ui_editor_layers", "ui_editor_canvas_chrome", "ui_editor_canvas_frame", "ui_editor_right_tabs"]);
  expect(await page.getByRole("group", { name: "Thiết bị" }).getByRole("button").allInnerTexts()).toEqual(["1440", "768", "375"]);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await expect.poll(() => frame.evaluate((f) => f.getBoundingClientRect().width)).toBe(768);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  expect(await noSideScroll(page)).toBe(true);
  await expectIconButtonsLabelled(page);
  await expectNoDrift(page);
  await page.getByRole("link", { name: "Editor cũ" }).click();
  await page.waitForURL(/legacy=1/);
  await page.frameLocator("iframe.gjs-frame").locator("h1").waitFor({ timeout: 30_000 });
  await page.getByRole("link", { name: "Editor mới" }).click();
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  await page.close();
});

test("E3a canvas: captured text holding markup shows as text (no handler runs, still one script); Undo goes through the bus and swaps only the section in place", { timeout: 120_000 }, async () => {
  const before = await payload();
  const text = walk(before.page.sections.flatMap((s) => walk(s.root)).find((n) => n.tag === "h1")!).find((n) => n.tag === "#text")!;
  const evil = '<img src=x onerror="window.__pwned=1">';
  const res = await fetch(`${app!.base}/api/projects/${projectId}/editor/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: before.revision, commands: [{ op: "setText", id: text.id, text: evil }] }),
  });
  expect(res.status).toBe(200);
  const page = await open();
  const h1 = canvas(page).locator("h1");
  expect(await h1.innerText()).toBe(evil);
  expect(await h1.evaluate(() => [document.querySelectorAll("img[onerror]").length, document.scripts.length, "__pwned" in window])).toEqual([0, 1, false]);
  await h1.evaluate(() => { (window as unknown as { __same: number }).__same = 1; });
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(() => status(page).innerText()).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await expect.poll(() => h1.innerText()).toBe("Build faster sites");
  expect(await h1.evaluate(() => (window as unknown as { __same?: number }).__same)).toBe(1); // partial update: same frame document
  expect((await payload()).revision).toBe(before.revision + 2);
  expect(await outHtml()).toContain("Build faster sites");
  await page.close();
});
