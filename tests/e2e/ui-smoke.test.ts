// UI smoke: a real `next build` + `next start` (tmp db/workspace/key), driven by Playwright.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { startNextApp } from "./next-app";

const DRIFT = /Turnstile|Telemetry|Deploy|Inject Auth|Stealth|Auto-reconcile|claude-3|gpt-4o/i;

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> };
let base = "";
let tmp = "";

async function expectNoDrift(page: Page): Promise<void> {
  expect(await page.locator("body").innerText()).not.toMatch(DRIFT);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ui-smoke-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  [app, site, browser] = await Promise.all([startNextApp(env), serveDir(fileURLToPath(new URL("../fixtures/site3", import.meta.url))), chromium.launch()]);
  base = app.base;
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  app?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// node:http, because fetch won't let a caller set Host
const statusWithHost = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}${path}`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject).end();
  });

test("proxy: every path answers 403 to a non-loopback Host (DNS rebinding), loopback is served", async () => {
  for (const path of ["/", "/new", "/settings/ai", "/p/x/sitemap", "/api/providers"]) expect(await statusWithHost(path, "evil.test")).toBe(403);
  expect(await statusWithHost("/", "evil.test:80")).toBe(403);
  expect(await statusWithHost("/new", "localhost")).toBe(200);
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

  // edit without a new key keeps the stored one; delete asks first
  await row.getByRole("button", { name: "Sửa" }).click();
  await page.getByLabel("Tên").fill("Renamed OpenAI");
  await page.getByRole("button", { name: "Lưu" }).click();
  const renamed = page.getByRole("listitem").filter({ hasText: "Renamed OpenAI" });
  await expect.poll(() => renamed.innerText()).toContain("sk-…1234");
  page.once("dialog", (d) => void d.accept());
  await renamed.getByRole("button", { name: "Xóa" }).click();
  await expect.poll(() => page.getByRole("listitem").filter({ hasText: "OpenAI" }).count()).toBe(0);
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
  // progress screen renders the stepper from the task rows (the discover task is done)
  await page.goto(page.url().replace(/\/sitemap$/, ""));
  await expect.poll(() => page.getByRole("list", { name: "Các pha" }).innerText()).toContain("✓ discover");
  await expectNoDrift(page);
  await page.close();
});
