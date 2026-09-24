// Editor smoke: a completed site1 clone (real pipeline, AI steps stubbed) opened in the real GrapesJS
// editor of a `next build` + `next start` app; one text edited like a user would, saved, re-emitted.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser } from "playwright";
import type { JobDeps } from "@/core/jobs";
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";
import { serveDir } from "@/core/serve";
import { startNextApp } from "./next-app";

// No network AI: naming keeps IR defaults, fixing reports every section red without patching.
const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) =>
    failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

// The pipeline runs in this process against the app's tmp workspace + db. core/config reads WORKSPACE_ROOT at
// import, so the core modules are imported only after it is set.
async function seedCompleted(env: { DB_PATH: string; WORKSPACE_ROOT: string }): Promise<string> {
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }] = await Promise.all([import("@/core/db"), import("@/core/jobs")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  const id = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, id, [`${site.url}/index.html`]);
  await runProject(db, id, { deps: offline });
  return id;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "editor-smoke-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  [projectId, app, browser] = await Promise.all([seedCompleted(env), startNextApp(env), chromium.launch()]);
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  app?.stop();
  db?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("editor: edit one heading in the canvas, save -> exactly one patch op, out/index.html has the new text", async () => {
  const base = app!.base;
  // Taller viewport: the fixed shell header/sidebar leave less room below the fold at the Playwright default
  // (1280x720), which raced a canvas resize against the dblclick and missed the rich-text edit.
  const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } });
  await page.goto(`${base}/p/${projectId}/preview`);
  await page.getByRole("link", { name: "Editor" }).click();
  await page.waitForURL(/\/editor$/);

  const canvas = page.frameLocator("iframe.gjs-frame");
  const heading = canvas.locator("h1");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  // the canvas resolves urls like the emitted page: based on out/index.html via the files route
  expect(await heading.evaluate(() => document.baseURI)).toBe(`${base}/api/projects/${projectId}/files/out/index.html`);
  await heading.dblclick(); // GrapesJS rich-text editing
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited headline");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect.poll(() => page.getByRole("status").innerText(), { timeout: 30_000 }).toBe("Đã lưu: 1 thay đổi");

  const html = await (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text();
  expect(html).toMatch(/<h1[^>]*>Edited headline<\/h1>/);
  expect(html).not.toContain("Build faster sites");
  // the editor reloaded from the saved IR
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Edited headline");
  // QA scores are not recomputed after an edit: flagged stale
  const preview = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as { stale: boolean; scores: unknown[] };
  expect(preview.stale).toBe(true);
  expect(preview.scores.length).toBeGreaterThan(0);
  await page.close();
});

test("editor API: only completed projects are editable; an invalid patch is refused", async () => {
  const base = app!.base;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/projects/${projectId}/editor/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("save", { pageId: "nope", project: { components: [] } })).status).toBe(400);
  expect((await post("promote-layout", { sectionIds: ["x"] })).status).toBe(400);
  try {
    for (const status of ["running", "paused", "interrupted"]) {
      db!.prepare("UPDATE projects SET status=? WHERE id=?").run(status, projectId);
      expect((await fetch(`${base}/api/projects/${projectId}/editor`)).status).toBe(409);
    }
  } finally {
    db!.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  }
});
