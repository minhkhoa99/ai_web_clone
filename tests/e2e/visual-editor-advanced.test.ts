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

// drags with the real mouse: down on the element, a few moves (past the 4 px start threshold), up at the target
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { alt?: boolean; shift?: boolean } = {}) {
  if (opts.alt) await page.keyboard.down("Alt");
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
  if (opts.alt) await page.keyboard.up("Alt");
}
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("E3b flow drag: the h1 dropped into the features section keeps its id (moveNode across sections, one Undo); dragging a section root onto a node shows a red indicator with its reason and sends nothing", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const features = canvas(page).locator("#features");
  const featuresId = (await features.getAttribute("data-ir-id"))!;
  await h1.click();
  await features.scrollIntoViewIfNeeded();
  await h1.scrollIntoViewIfNeeded();
  const fb = (await features.boundingBox())!;
  // into the section's own 24 px left padding (its cards may be component instances, which refuse children)
  // the left end of the h1 (its centre lies under the right panel: the 1440 frame is wider than the canvas pane)
  await drag(page, { ...centre((await h1.boundingBox())!), x: (await h1.boundingBox())!.x + 10 }, { x: fb.x + 6, y: fb.y + fb.height / 2 });
  await saved(page);
  await expect.poll(async () => (await allNodes()).find((x) => x.id === featuresId)?.children.some((c) => c.id === h1Id), { timeout: 30_000 }).toBe(true);
  expect(await canvas(page).locator(`[data-ir-id="${h1Id}"]`).count()).toBe(1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await allNodes()).find((x) => x.id === featuresId)?.children.some((c) => c.id === h1Id), { timeout: 30_000 }).toBe(false);
  // a section root (Esc from the h1) dragged onto the paragraph: red, reasoned, nothing sent
  await canvas(page).locator("h1").click();
  await page.keyboard.press("Escape");
  const rev = (await payload()).revision;
  const para = canvas(page).getByText("Plain paragraph text.");
  const pb = (await para.boundingBox())!, hb = (await canvas(page).locator("h1").boundingBox())!;
  await page.mouse.move(hb.x + 4, hb.y + 4);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(hb.x + 4, hb.y + 4 + ((pb.y + pb.height / 2 - hb.y - 4) * k) / 6);
  const bad = page.locator('[data-ui="ui_editor_drop_indicator"].is-bad');
  await expect.poll(() => bad.isVisible()).toBe(true);
  expect(await bad.innerText()).toMatch(/Section chỉ đổi thứ tự|chính nó/); // the hero is a section root (or, if not, the p is inside it)
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev);
  // Escape mid-drag (blue indicator showing): the gesture ends, the capture overlay goes, nothing is sent on release
  await canvas(page).locator("h1").click();
  const rev2 = (await payload()).revision;
  const hb2 = (await canvas(page).locator("h1").boundingBox())!, fb2 = (await features.boundingBox())!;
  await page.mouse.move(hb2.x + 10, hb2.y + hb2.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(hb2.x + 10 + ((fb2.x + 6 - hb2.x - 10) * k) / 6, hb2.y + hb2.height / 2 + ((fb2.y + fb2.height / 2 - hb2.y - hb2.height / 2) * k) / 6);
  const drop = page.locator('[data-ui="ui_editor_drop_indicator"]');
  await expect.poll(() => drop.isVisible()).toBe(true);
  expect(await drop.getAttribute("class")).not.toContain("is-bad");
  await page.keyboard.press("Escape");
  await expect.poll(() => drop.count()).toBe(0);
  expect(await page.locator(".ve-capture").count()).toBe(0);
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev2);
  await page.close();
});

test("E3b Alt+drag: the paragraph becomes absolute where dropped (its static parent relative), one batch at the current breakpoint; Alt+hover measures px to another node", { timeout: 240_000 }, async () => {
  const page = await open();
  const para = canvas(page).getByText("Plain paragraph text.");
  const paraId = (await para.getAttribute("data-ir-id"))!;
  const heroId = (await para.evaluate((el) => el.parentElement!.getAttribute("data-ir-id")))!;
  await para.click();
  // Alt+hover the h1: a px distance to the selection
  await page.keyboard.down("Alt");
  await canvas(page).locator("h1").hover();
  await expect.poll(() => page.locator('[data-ui="ui_editor_measure"]').first().innerText()).toMatch(/^\d+$/);
  await page.keyboard.up("Alt");
  const rev = (await payload()).revision;
  const b = (await para.boundingBox())!;
  await drag(page, { x: b.x + 10, y: b.y + 5 }, { x: b.x + 70, y: b.y + 45 }, { alt: true });
  await saved(page);
  await expect.poll(async () => (await nodeById(paraId))?.styles.base.position, { timeout: 30_000 }).toBe("absolute");
  const p = (await nodeById(paraId))!.styles.base;
  expect([p.left, p.top, p.width].every((v) => /^-?\d+px$/.test(v ?? ""))).toBe(true);
  expect((await nodeById(heroId))!.styles.base.position).toBe("relative");
  expect((await payload()).revision).toBe(rev + 1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(paraId))?.styles.base.position).toBeUndefined();
  // Escape mid Alt+drag: the paragraph goes back (its inline translate removed), nothing is sent on release
  await para.click();
  const rev2 = (await payload()).revision;
  const b2 = (await para.boundingBox())!;
  const translate = () => para.evaluate((el) => (el as HTMLElement).style.translate);
  await page.keyboard.down("Alt");
  await page.mouse.move(b2.x + 10, b2.y + 5);
  await page.mouse.down();
  for (let k = 1; k <= 4; k++) await page.mouse.move(b2.x + 10 + 15 * k, b2.y + 5 + 10 * k);
  await expect.poll(translate).not.toBe("");
  await page.keyboard.press("Escape");
  await expect.poll(translate).toBe("");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev2);
  await page.close();
});

test("E3b resize: the e handle at 768 writes width in the 768 layer only (1440 unchanged); a padding handle writes padding-top at the breakpoint; one Undo each", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const width1440 = await h1.evaluate((el) => el.getBoundingClientRect().width);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await h1.click();
  const e = page.locator('[data-ui="ui_editor_resize_handle"][data-handle="e"]');
  await expect.poll(() => e.isVisible()).toBe(true);
  expect(await page.locator('[data-ui="ui_editor_resize_handle"]').count()).toBe(3); // flow node: e, s, se (R13)
  await e.scrollIntoViewIfNeeded(); // the 768 frame is wider than the canvas pane here: its right edge needs the pane scrolled
  const hb = (await e.boundingBox())!;
  const before = await h1.evaluate((el) => el.getBoundingClientRect().width);
  await drag(page, centre(hb), { x: hb.x + hb.width / 2 - 120, y: hb.y + hb.height / 2 });
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.width, { timeout: 30_000 }).toBe(`${Math.round(before - 120)}px`);
  expect((await nodeById(h1Id))!.styles.base.width).toBeUndefined();
  const top = page.locator('[data-ui="ui_editor_spacing_handle"][data-side="top"]');
  const tb = (await top.boundingBox())!;
  await drag(page, centre(tb), { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 + 12 });
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.["padding-top"], { timeout: 30_000 }).toBe("12px");
  // cancelled mid-gesture (Escape on a resize, a frame scroll on a padding drag): the preview goes back, nothing is sent
  const rev = (await payload()).revision;
  const inline = (prop: string) => h1.evaluate((el, p) => (el as HTMLElement).style.getPropertyValue(p), prop);
  const half = async (b: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
    await page.mouse.move(centre(b).x, centre(b).y);
    await page.mouse.down();
    for (let k = 1; k <= 4; k++) await page.mouse.move(centre(b).x + (dx * k) / 4, centre(b).y + (dy * k) / 4);
  };
  await e.scrollIntoViewIfNeeded();
  await half((await e.boundingBox())!, -40, 0);
  await expect.poll(() => inline("width")).not.toBe("");
  await page.keyboard.press("Escape");
  await expect.poll(() => inline("width")).toBe("");
  await page.mouse.up();
  await half((await top.boundingBox())!, 0, 20);
  await expect.poll(() => inline("padding-top")).not.toBe("");
  await canvas(page).locator("body").evaluate(() => window.scrollBy(0, 30));
  await expect.poll(() => inline("padding-top")).toBe("");
  expect(await page.locator(".ve-capture").count()).toBe(0);
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  await expect.poll(() => h1.evaluate((el) => el.getBoundingClientRect().width)).toBe(width1440);
  // the gap band of the features grid (cards side by side: the column gap, dragged along x): 16 + 8 = 24px at Desktop;
  // the row gap (and the `gap` shorthand) untouched
  const features = canvas(page).locator("#features");
  const featuresId = (await features.getAttribute("data-ir-id"))!;
  const baseBefore = (await nodeById(featuresId))!.styles.base;
  await features.click({ position: { x: 6, y: 6 } });
  const gap = page.locator('[data-ui="ui_editor_spacing_handle"][data-side="gap"]');
  await expect.poll(() => gap.count()).toBe(1);
  await gap.scrollIntoViewIfNeeded();
  const gb = (await gap.boundingBox())!;
  await drag(page, centre(gb), { x: centre(gb).x + 8, y: centre(gb).y });
  await saved(page);
  await expect.poll(async () => (await nodeById(featuresId))?.styles.base["column-gap"], { timeout: 30_000 }).toBe("24px");
  const baseAfter = (await nodeById(featuresId))!.styles.base;
  expect([baseAfter["row-gap"], baseAfter.gap]).toEqual([baseBefore["row-gap"], baseBefore.gap]);
  expect(await features.evaluate((el) => getComputedStyle(el).rowGap)).toBe("16px");
  for (let i = 0; i < 3; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); }
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.width, { timeout: 30_000 }).toBeUndefined();
  await page.close();
});

test("E3b zoom: Ctrl+- to 50 % scales the frame and the overlay, a click still selects the right node; Vừa khung fits; Ctrl+0 back to 100 %; Space+drag pans", { timeout: 180_000 }, async () => {
  const page = await open();
  const frame = page.locator('[data-ui="ui_editor_canvas_frame"]');
  const label = page.locator('[data-ui="ui_editor_zoom"] > span');
  await canvas(page).locator("body").click({ position: { x: 5, y: 5 } }); // focus the canvas
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+-"); // 100 -> 75 -> 67 -> 50
  await expect.poll(() => label.innerText()).toBe("50%");
  await expect.poll(() => frame.evaluate((f) => getComputedStyle(f).transform)).toBe("matrix(0.5, 0, 0, 0.5, 0, 0)");
  const h1 = canvas(page).locator("h1");
  await h1.click();
  const sel = page.locator('[data-ui="ui_editor_selection_box"]').first();
  await expect.poll(() => sel.getAttribute("data-for")).toBe(await h1.getAttribute("data-ir-id"));
  const [hb, sb] = [(await h1.boundingBox())!, (await sel.boundingBox())!];
  expect(Math.abs(hb.x - sb.x) + Math.abs(hb.y - sb.y) + Math.abs(hb.width - sb.width)).toBeLessThan(3);
  // resize at 50 %: 60 screen px on the e handle = 120 px of the page (toDoc ÷ zoom)
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const before = await h1.evaluate((el) => el.getBoundingClientRect().width);
  const e = page.locator('[data-ui="ui_editor_resize_handle"][data-handle="e"]');
  await e.scrollIntoViewIfNeeded(); // the 720 px frame is wider than the pane here
  const eb = (await e.boundingBox())!;
  await drag(page, centre(eb), { x: centre(eb).x - 60, y: centre(eb).y });
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.width, { timeout: 30_000 }).toBe(`${Math.round(before - 120)}px`);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.width, { timeout: 30_000 }).toBeUndefined();
  await page.getByRole("button", { name: "Vừa khung" }).click();
  const pane = page.locator('[data-ui="ui_editor_canvas_chrome"]');
  // zoom is kept to 2 decimals: at 1440 that is within 8 px of the pane
  await expect.poll(async () => Math.abs((await frame.boundingBox())!.width - ((await pane.evaluate((p) => p.clientWidth)) - 16))).toBeLessThan(8);
  expect(await pane.evaluate((p) => p.scrollWidth <= p.clientWidth)).toBe(true);
  expect(await noSideScroll(page)).toBe(true);
  await page.keyboard.press("Control+0");
  await expect.poll(() => label.innerText()).toBe("100%");
  // Ctrl+wheel over the frame: ×1.1 per notch
  const fb0 = (await frame.boundingBox())!;
  await page.mouse.move(fb0.x + 200, fb0.y + 200);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => label.innerText()).toBe("110%");
  await page.keyboard.press("Control+0");
  await expect.poll(() => label.innerText()).toBe("100%");
  // pan: the 1440 frame is wider than the pane
  const rev = (await payload()).revision;
  const sx = await pane.evaluate((p) => p.scrollLeft);
  await page.keyboard.down(" ");
  const fb = (await frame.boundingBox())!;
  await drag(page, { x: fb.x + 400, y: fb.y + 200 }, { x: fb.x + 100, y: fb.y + 200 });
  await page.keyboard.up(" ");
  await expect.poll(() => pane.evaluate((p) => p.scrollLeft)).toBeGreaterThan(sx);
  await expect.poll(() => sel.getAttribute("data-for")).toBe(h1Id); // the pan's release did not select
  expect((await payload()).revision).toBe(rev);
  // 200 % with the frame scrolled: a click still selects its node, the box matches
  await canvas(page).locator("body").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+="); // 100 -> 125 -> 150 -> 200
  await expect.poll(() => label.innerText()).toBe("200%");
  await canvas(page).locator("body").evaluate(() => window.scrollTo(0, 120));
  const para = canvas(page).getByText("Plain paragraph text.");
  await para.click();
  await expect.poll(() => sel.getAttribute("data-for")).toBe(await para.getAttribute("data-ir-id"));
  const [pb, sb2] = [(await para.boundingBox())!, (await sel.boundingBox())!];
  expect(Math.abs(pb.x - sb2.x) + Math.abs(pb.y - sb2.y) + Math.abs(pb.width - sb2.width)).toBeLessThan(3);
  await page.close();
});
