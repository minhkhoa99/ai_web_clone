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

test("E3a canvas: until the frame's load wired its guards it takes no input — a click on a link before load never navigates", { timeout: 120_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  // a held image keeps the frame's load event from firing while its document is already parsed
  await page.route(/\/api\/projects\/[^/]+\/editor(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { page: { html: string } };
    json.page.html = json.page.html.replace("</html>", `<img src="${app!.base}/__hold.png" alt=""></html>`);
    await route.fulfill({ response: res, json });
  });
  await page.route("**/__hold.png", async (route) => { await gate; await route.fulfill({ status: 404, body: "" }); });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  const link = canvas(page).getByRole("link", { name: "Features" });
  await link.waitFor({ timeout: 30_000 });
  const box = (await link.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  expect(await canvas(page).locator("h1").evaluate(() => location.href)).toBe("about:srcdoc");
  release();
  const frame = page.locator('[data-ui="ui_editor_canvas_frame"]');
  await expect.poll(() => frame.evaluate((f) => getComputedStyle(f).pointerEvents)).toBe("auto");
  expect(await frame.evaluate((f) => (f as HTMLIFrameElement).inert)).toBe(false);
  await page.close();
});

test("E3a bus: a reload owed to a shellChanged step still happens when the last queued step is refused", { timeout: 120_000 }, async () => {
  const before = await payload();
  const text = walk(before.page.sections.flatMap((s) => walk(s.root)).find((n) => n.tag === "h1")!).find((n) => n.tag === "#text")!;
  const res = await fetch(`${app!.base}/api/projects/${projectId}/editor/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: before.revision, commands: [{ op: "setText", id: text.id, text: "Tạm" }] }),
  });
  expect(res.status).toBe(200);
  const page = await open();
  const h1 = canvas(page).locator("h1");
  expect(await h1.innerText()).toBe("Tạm");
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  // 1st Undo: the real step, its answer forged to shellChanged; 2nd Undo (queued behind it): refused with a 400
  await page.route("**/editor/undo", async (route) => {
    if (++n === 1) {
      await gate;
      const r = await route.fetch();
      const json = (await r.json()) as { affected: object };
      json.affected = { ...json.affected, shellChanged: true, sections: [] };
      return route.fulfill({ response: r, json });
    }
    return route.fulfill({ status: 400, json: { code: "IR_PATCH_INVALID", message: "forced" } });
  });
  await h1.evaluate(() => { (window as unknown as { __same: number }).__same = 1; });
  const undo = page.getByRole("button", { name: "Hoàn tác" });
  await undo.click();
  await undo.click();
  release();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toContain("forced");
  // the frame was reloaded (a fresh document) and shows the server's text
  await expect.poll(() => h1.evaluate(() => (window as unknown as { __same?: number }).__same ?? 0), { timeout: 30_000 }).toBe(0);
  expect(await h1.innerText()).toBe("Build faster sites");
  await saved(page);
  await page.close();
});

test("E3a select/hover: hover label tag · name · W×H; click selects the deepest node (box on it) with margin/padding bands and the parent outlined; Shift+click toggles; Esc parent, Ctrl+Enter child, Ctrl+A siblings", { timeout: 120_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.hover();
  const hoverBox = page.locator('[data-ui="ui_editor_hover_box"]');
  await expect.poll(() => hoverBox.getAttribute("data-for")).toBe(h1Id);
  expect(await hoverBox.innerText()).toMatch(/^h1 · .+ · \d+×\d+$/);
  await h1.click();
  const sel = page.locator('[data-ui="ui_editor_selection_box"]');
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(h1Id);
  const [hb, sb] = [(await h1.boundingBox())!, (await sel.first().boundingBox())!];
  expect(Math.abs(sb.x - hb.x) + Math.abs(sb.y - hb.y) + Math.abs(sb.width - hb.width)).toBeLessThan(3);
  expect(await page.locator('[data-ui="ui_editor_spacing"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-ui="ui_editor_parent_box"]').count()).toBe(1);
  await page.locator('[data-ui="ui_editor_canvas_chrome"]').evaluate((el) => { el.scrollLeft = 0; }); // the click scrolled the 1440 frame sideways
  await parityShot(page, "e3a-overlay-1440");
  const para = canvas(page).getByText("Plain paragraph text.");
  await para.click({ modifiers: ["Shift"] });
  await expect.poll(() => sel.count()).toBe(2);
  await para.click({ modifiers: ["Shift"] });
  await expect.poll(() => sel.count()).toBe(1);
  const heroId = await h1.evaluate((el) => el.parentElement!.getAttribute("data-ir-id"));
  await page.keyboard.press("Escape");
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(heroId);
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(h1Id);
  await page.keyboard.press("Control+a");
  await expect.poll(() => sel.count()).toBe(2); // h1 + p of the hero
  // a hidden node (site1 .secret, display:none) is never selectable on the canvas
  expect(await canvas(page).locator(".secret").isVisible()).toBe(false);
  await page.close();
});
