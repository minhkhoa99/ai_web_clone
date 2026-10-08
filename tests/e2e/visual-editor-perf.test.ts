// E3 §9 hiệu năng: a page of 5 000+ nodes — from the click to the drawn selection overlay under 50 ms (median of 5).
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser } from "playwright";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { startNextApp } from "./next-app";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";
const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
const card = (i: number, j: number) => el("div", [el("h3", [el("#text", [], `Thẻ ${i}.${j}`)]), el("p", [el("#text", [], "Nội dung thẻ")]), el("span")]);
// 50 sections x 20 cards x 6 nodes + html/head/body = 6 053 nodes
const bigDom = () => el("html", [el("head"), el("body", Array.from({ length: 50 }, (_, i) => el("section", Array.from({ length: 20 }, (_, j) => card(i, j)))))]);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "visual-perf-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue }, { buildIR }, { emitHtml }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/ir"), import("@/core/emit-html")]);
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: "http://big.test/", mode: "single", config: {} });
  await enqueue(db, projectId, ["http://big.test/"]);
  const ws = join(env.WORKSPACE_ROOT, projectId);
  const capture = {
    url: "http://big.test/", pageId: "home", capturedAt: "2026-10-07T00:00:00.000Z", title: "big", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom: bigDom(), truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  const ir = buildIR([capture]);
  await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
  await emitHtml(ir, { outDir: join(ws, "out"), workspaceDir: ws, assetMap: {}, pageUrls: { home: "http://big.test/" } });
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", projectId);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(projectId);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test("5 000-node page: click -> selection overlay drawn in under 50 ms (median of 5)", { timeout: 180_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  const frame = page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
  await frame.locator("h3").first().waitFor({ timeout: 60_000 });
  expect(await frame.locator("[data-ir-id]").count()).toBeGreaterThanOrEqual(4000); // elements (+ #text nodes: > 5 000)
  const times: number[] = [];
  for (let k = 0; k < 5; k++) {
    times.push(await page.evaluate(async (k) => {
      const doc = document.querySelector<HTMLIFrameElement>('[data-ui="ui_editor_canvas_frame"]')!.contentDocument!;
      const els = doc.querySelectorAll("h3[data-ir-id]");
      const target = els[Math.floor((els.length * (k + 1)) / 6)] as HTMLElement;
      target.scrollIntoView({ block: "center" });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const id = target.getAttribute("data-ir-id");
      const t0 = performance.now();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise<void>((r) => {
        const check = () => ((document.querySelector('[data-ui="ui_editor_selection_box"]') as HTMLElement | null)?.dataset.for === id ? r() : requestAnimationFrame(check));
        check();
      });
      return performance.now() - t0;
    }, k));
  }
  times.sort((a, b) => a - b);
  expect(times[2]).toBeLessThan(50);
  await page.close();
});
