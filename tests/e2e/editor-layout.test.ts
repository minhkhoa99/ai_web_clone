// Editor left column layout (Layers / Section card) at 1440, 1024 and 768 wide, tall and short windows: tabs, layer
// search, layer list and the Section card (title, hint, list, button) never paint over each other, the list scrolls
// on its own and no text runs out of its box. Screenshots go to SHOTS_DIR when set.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "editor-layout-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

type Problem = string;
// every pair of the column's regions, and of the Section card's parts, must not intersect; each region stays inside
// its parent; no element in the column paints text outside its own box (unless it is an ellipsis box)
const layoutProblems = (page: Page): Promise<Problem[]> => page.evaluate(() => {
  const out: string[] = [];
  const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
  const left = q('[data-ui="ui_editor_layers"]');
  if (!left) return ["no left column"];
  const rect = (el: Element) => el.getBoundingClientRect();
  const hit = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const inside = (a: DOMRect, b: DOMRect) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  const named = (pairs: [string, HTMLElement | null][]) => pairs.filter((p): p is [string, HTMLElement] => !!p[1]);
  const card = q('[data-ui="ui_editor_sections_panel"]', left);
  const layers = q(".ve-layers", left);
  const regions = named([["tabs", q('[data-ui="ui_editor_left_tabs"]', left)], ["search", q('[data-ui="ui_editor_layer_search"]', left)], ["list", q(".ve-layer-list", left)],
    ["card title", card && q(".panel-head", card)], ["card hint", card && q("p", card)], ["card list", card && q(".editor-sections", card)], ["card button", card && q("button:not([role])", card)]]);
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    if (hit(rect(regions[i]![1]), rect(regions[j]![1]))) out.push(`${regions[i]![0]} overlaps ${regions[j]![0]}`);
  }
  if (layers) for (const [name, el] of named([["search", q('[data-ui="ui_editor_layer_search"]', layers)], ["list", q(".ve-layer-list", layers)]])) {
    if (!inside(rect(el), rect(layers))) out.push(`${name} runs out of the layers box`);
  }
  if (card) for (const [name, el] of regions.filter(([n]) => n.startsWith("card"))) if (!inside(rect(el), rect(card))) out.push(`${name} runs out of the card`);
  for (const el of Array.from(left.querySelectorAll<HTMLElement>("*"))) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || el.closest(".ve-layer-list") || !el.textContent?.trim()) continue; // scrollers and ellipsis boxes clip on purpose
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.push(`text runs out of <${el.tagName.toLowerCase()} class="${el.className}">: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
});

const SIZES: { width: number; height: number }[] = [{ width: 1440, height: 900 }, { width: 1440, height: 700 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }];

test("editor left column: layers and the Section card never overlap, the layer list scrolls on its own, no text runs out — 1440 / 1024 / 768, tall and short", { timeout: 240_000 }, async () => {
  const shots = process.env.SHOTS_DIR;
  if (shots) await mkdir(shots, { recursive: true });
  const problems: string[] = [];
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: size });
    await page.goto(`${app!.base}/p/${projectId}/editor`);
    await page.frameLocator('[data-ui="ui_editor_canvas_frame"]').locator("h1").waitFor({ timeout: 30_000 });
    // selecting the h1 opens its ancestors in the tree (a longer list), as a user does
    await page.frameLocator('[data-ui="ui_editor_canvas_frame"]').locator("h1").click();
    if (size.width <= 1099) {
      await page.getByRole("button", { name: "Mở Layers" }).click();
      await expect.poll(() => page.locator('[data-ui="ui_editor_layers"]').evaluate((el) => getComputedStyle(el).visibility)).toBe("visible");
      await page.waitForTimeout(250); // the drawer's 0.15 s slide
    }
    await page.locator('[data-ui="ui_editor_sections_panel"]').waitFor();
    if (shots) await page.screenshot({ path: join(shots, `editor-left-${size.width}x${size.height}.png`) });
    problems.push(...(await layoutProblems(page)).map((p) => `${size.width}x${size.height}: ${p}`));
    // the list scrolls by itself: it is a scroller with a usable height, and when the column runs out of room the tree is
    // the part that gives way (its own scrollbar), not the column growing to the whole tree
    const scroll = await page.evaluate(() => {
      const list = document.querySelector(".ve-layer-list") as HTMLElement, left = document.querySelector('[data-ui="ui_editor_layers"]') as HTMLElement;
      return { scroller: getComputedStyle(list).overflowY !== "visible", box: list.clientHeight, content: list.scrollHeight, columnOverflows: left.scrollHeight > left.clientHeight + 1 };
    });
    if (!scroll.scroller || scroll.box < 150) problems.push(`${size.width}x${size.height}: the layer list is not a usable scroller (${scroll.box}px)`);
    if (scroll.columnOverflows && scroll.content <= scroll.box) problems.push(`${size.width}x${size.height}: the column scrolls while the tree is shown in full (${scroll.content}px) — the list does not scroll on its own`);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
    // the Thêm tab in the same row: its items keep their size, stay inside the column and scroll there
    await page.getByRole("tab", { name: "Thêm" }).click();
    if (shots) await page.screenshot({ path: join(shots, `editor-insert-${size.width}x${size.height}.png`) });
    const insert = await page.evaluate(() => {
      const ul = document.querySelector('[data-ui="ui_editor_insert_panel"]') as HTMLElement, left = document.querySelector('[data-ui="ui_editor_layers"]') as HTMLElement;
      const item = ul.querySelector("button") as HTMLElement, a = ul.getBoundingClientRect(), b = left.getBoundingClientRect();
      return { itemHeight: item.getBoundingClientRect().height, inside: a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5 };
    });
    if (insert.itemHeight > 90 || !insert.inside) problems.push(`${size.width}x${size.height}: Thêm panel item ${insert.itemHeight}px, inside column ${insert.inside}`);
    await page.close();
  }
  expect(problems).toEqual([]);
});
