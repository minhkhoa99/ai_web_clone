// UI smoke: a real `next build` + `next start` (tmp db/workspace/key), driven by Playwright.
import { afterAll, beforeAll, expect, test } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";

const root = fileURLToPath(new URL("../..", import.meta.url));
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const DRIFT = /Turnstile|Telemetry|Deploy|Inject Auth|Stealth|Auto-reconcile|claude-3|gpt-4o/i;

let server: ChildProcess;
let browser: Browser;
let site: { url: string; close(): Promise<void> };
let base = "";
let tmp = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

async function waitReady(url: string, deadline = Date.now() + 60_000): Promise<void> {
  while (Date.now() < deadline) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`next start not ready at ${url}`);
}

async function expectNoDrift(page: Page): Promise<void> {
  expect(await page.locator("body").innerText()).not.toMatch(DRIFT);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ui-smoke-"));
  const env = { ...process.env, DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  await promisify(execFile)(process.execPath, [nextBin, "build"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, stdio: "ignore" });
  [site, browser] = await Promise.all([serveDir(fileURLToPath(new URL("../fixtures/site3", import.meta.url))), chromium.launch()]);
  await waitReady(`${base}/api/providers`);
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  server?.kill();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("settings/ai: add a provider, it is listed with a masked key", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/settings/ai`);
  await page.getByRole("button", { name: "Add OpenAI Compatible" }).click();
  await page.getByLabel("Tên").fill("Local OpenAI");
  await page.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
  await page.getByLabel("API key").fill("sk-smoke-secret-key-1234");
  await page.getByRole("button", { name: "Lưu" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Local OpenAI" });
  await expect.poll(() => row.innerText()).toContain("sk-…1234");
  expect(await page.content()).not.toContain("sk-smoke-secret-key-1234");
  await expectNoDrift(page);
  await page.close();
});

test("new: crawl the site3 fixture, land on the sitemap with its 3 pages", async () => {
  const page = await browser.newPage();
  for (const path of ["/", "/new"]) {
    await page.goto(`${base}${path}`);
    await expectNoDrift(page);
  }
  await page.getByLabel("URL").fill(`${site.url}/index.html`);
  await page.getByLabel("Crawl nhiều trang").check();
  await page.getByRole("button", { name: "Quét trang" }).click();
  await page.waitForURL(/\/p\/[^/]+\/sitemap$/, { timeout: 60_000 });
  const pages = page.getByRole("checkbox", { name: /^\/(index|about|pricing)\.html$/ });
  await expect.poll(() => pages.count(), { timeout: 30_000 }).toBe(3);
  expect(await page.getByText("private.html").count()).toBe(0);
  await expect.poll(() => page.getByRole("button", { name: "Bắt đầu clone" }).isVisible()).toBe(true);
  await expectNoDrift(page);
  await page.close();
});
