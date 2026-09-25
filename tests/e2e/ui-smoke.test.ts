// UI smoke: a real `next build` + `next start` (tmp db/workspace/key), driven by Playwright.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { openDb } from "@/core/db";
import type { ProjectConfig } from "@/core/jobs-base";
import { serveDir } from "@/core/serve";
import { startNextApp } from "./next-app";
import { expectIconButtonsLabelled, expectNoDrift, expectUi, trackForeignRequests } from "./ui-checks";
import { pngOf, seedProject, writeWs } from "./ui-seed";
import { parityShot } from "./parity-shots";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> };
let base = "";
let tmp = "";
let env: { DB_PATH: string; WORKSPACE_ROOT: string; KEY_PATH: string };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ui-smoke-"));
  env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
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

test("settings/ai: 2-column layout, Test before Save (ms + HTTP), eye toggle, filter, kebab edit/delete, masked key", async () => {
  const models = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] })));
  await new Promise<void>((r) => models.listen(0, "127.0.0.1", r));
  const modelsUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  try {
    await page.goto(`${base}/settings/ai`);
    await expectUi(page, ["ui_settings_ai_page_header", "ui_settings_ai_add_provider_buttons", "ui_settings_ai_endpoint_list", "ui_settings_ai_endpoint_filter", "ui_settings_ai_config_panel"]);
    expect(await page.locator('[data-ui="ui_settings_ai_config_panel"]').innerText()).toContain("Chọn một endpoint để sửa, hoặc thêm mới.");
    const adds = page.locator('[data-ui="ui_settings_ai_add_provider_buttons"]').getByRole("button");
    expect(await adds.allInnerTexts()).toEqual(["Add Anthropic Compatible", "Add OpenAI Compatible"]);

    await page.getByRole("button", { name: "Add OpenAI Compatible" }).click();
    const form = page.getByRole("form", { name: "Cấu hình provider" });
    await expectUi(page, ["ui_settings_ai_display_name", "ui_settings_ai_protocol", "ui_settings_ai_base_url", "ui_settings_ai_api_key", "ui_settings_ai_fetch_models", "ui_settings_ai_test_endpoint", "ui_settings_ai_role_matrix", "ui_settings_ai_save_provider"]);
    expect(await form.locator('[data-ui="ui_settings_ai_protocol"]').innerText()).toContain("OpenAI Chat Completions API");
    await expectNoDrift(page); // also checked with the config panel form open, not just the empty screen
    await form.getByLabel("Tên hiển thị").fill("Local OpenAI");
    await form.getByLabel("Base URL").fill(modelsUrl);
    const key = form.getByLabel("API key", { exact: true });
    await key.fill("sk-smoke-secret-key-1234");
    expect(await key.getAttribute("type")).toBe("password");
    await form.getByRole("button", { name: "Hiện mật khẩu" }).click();
    expect(await key.getAttribute("type")).toBe("text");
    await form.getByRole("button", { name: "Test kết nối" }).click(); // D7: before the provider is saved
    await expect.poll(() => form.locator('[data-ui="ui_settings_ai_test_endpoint"] [role="status"]').innerText()).toMatch(/^Kết nối OK · \d+ ms · HTTP 200 · 2 model$/);
    expect(await form.getByLabel("Model cho vai trò vision").isDisabled()).toBe(true);
    await form.getByRole("button", { name: "Fetch models" }).click();
    await expect.poll(() => form.locator('[data-ui="ui_settings_ai_fetch_models"]').innerText()).toContain("2 model");
    await form.getByLabel("Model cho vai trò vision").selectOption("m1");
    await parityShot(page, "settings-ai-form");
    await form.getByRole("button", { name: "Lưu provider" }).click();

    const rows = page.locator('[data-ui="ui_settings_ai_endpoint_row"]');
    const row = rows.filter({ hasText: "Local OpenAI" });
    await expect.poll(() => row.innerText()).toContain("sk-…1234");
    expect(await row.innerText()).toContain("OPENAI");
    expect(await row.innerText()).toContain("chưa test");
    expect(await page.content()).not.toContain("sk-smoke-secret-key-1234");
    expect(await page.locator('[data-ui="ui_settings_ai_endpoint_list"] .badge').first().innerText()).toBe(String(await rows.count()));

    // row Test: latency on the row
    await row.getByRole("button", { name: "Test", exact: true }).click();
    await expect.poll(() => row.innerText()).toMatch(/\d+ ms/);
    await parityShot(page, "settings-ai-rows"); // a saved, tested row: dot + name + kind badge, latency + masked key

    // filter is a literal, client-side substring over name / base URL / models
    const filter = page.getByRole("searchbox", { name: "Lọc endpoint" });
    await filter.fill("(");
    expect(await rows.count()).toBe(0);
    expect(await page.locator('[data-ui="ui_settings_ai_endpoint_list"]').innerText()).toContain("Không có endpoint khớp.");
    await filter.fill("LOCAL open");
    expect(await rows.count()).toBe(1);
    await filter.fill("");

    // kebab: Esc closes and returns focus; Sửa opens the form; the saved key is never filled back
    const kebab = row.getByRole("button", { name: "Thao tác" });
    await kebab.click();
    expect(await page.getByRole("menu").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await kebab.evaluate((el) => el === document.activeElement)).toBe(true);
    await kebab.click();
    await page.getByRole("menuitem", { name: "Sửa" }).click();
    expect(await page.locator('[data-ui="ui_settings_ai_config_panel"] h2').innerText()).toBe("Sửa: Local OpenAI");
    expect(await form.getByLabel("API key", { exact: true }).inputValue()).toBe("");
    expect(await row.getAttribute("class")).toContain("is-open");
    await form.getByLabel("Tên hiển thị").fill("Renamed OpenAI");
    await form.getByRole("button", { name: "Lưu provider" }).click();
    const renamed = rows.filter({ hasText: "Renamed OpenAI" });
    await expect.poll(() => renamed.innerText()).toContain("sk-…1234");

    page.once("dialog", (d) => void d.accept());
    await renamed.getByRole("button", { name: "Thao tác" }).click();
    await page.getByRole("menuitem", { name: "Xóa" }).click();
    await expect.poll(() => rows.filter({ hasText: "OpenAI" }).count()).toBe(0);

    await expectNoDrift(page);
    await expectIconButtonsLabelled(page);
    expect(foreign).toEqual([]);
  } finally {
    await page.close();
    await new Promise((r) => models.close(r));
  }
});

test("new: centered card ≤1000px, copy-URL icon, mode toggle, crawl limits only when crawling, QA slider ⇄ number, SP2 outputs disabled", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/new`);
  await expectUi(page, ["ui_new_clone_page_header", "ui_new_clone_card", "ui_new_clone_url_input", "ui_new_clone_mode_toggle", "ui_new_clone_auth_select", "ui_new_clone_qa_threshold", "ui_new_clone_token_budget", "ui_new_clone_output_format", "ui_new_clone_cancel", "ui_new_clone_preview_sitemap"]);
  expect((await page.locator('[data-ui="ui_new_clone_card"]').boundingBox())!.width).toBeLessThanOrEqual(1000);
  expect(await page.locator('[data-ui="ui_new_clone_crawl_limits"]').count()).toBe(0);
  await page.getByRole("group", { name: "Chế độ clone" }).getByRole("button", { name: "Crawl nhiều trang" }).click();
  expect(await page.locator('[data-ui="ui_new_clone_crawl_limits"]').innerText()).toMatch(/GIỚI HẠN CRAWL[\s\S]*Số trang tối đa[\s\S]*Độ sâu[\s\S]*Trang chụp song song[\s\S]*Delay giữa request/);

  const slider = page.getByRole("slider", { name: "Ngưỡng QA" });
  const exact = page.getByRole("spinbutton", { name: "Chính xác (%)" });
  expect(await exact.inputValue()).toBe("95");
  await slider.focus();
  for (let i = 0; i < 10; i++) await slider.press("ArrowLeft");
  expect(await exact.inputValue()).toBe("85");
  await exact.fill("99");
  expect(await slider.inputValue()).toBe("99");
  expect(await page.locator('[data-ui="ui_new_clone_qa_threshold"]').innerText()).toMatch(/99%[\s\S]*70% \(thoáng\)[\s\S]*85% \(cân bằng\)[\s\S]*95% \(chặt\)[\s\S]*100% \(khớp pixel\)/);

  const outputs = page.getByRole("radiogroup", { name: "Định dạng output" });
  expect(await outputs.getByRole("radio", { checked: true }).innerText()).toMatch(/HTML[\s\S]*Đang dùng/);
  const disabled = outputs.locator('[aria-disabled="true"]');
  expect(await disabled.count()).toBe(4);
  for (const [i, name] of ["React", "Next.js", "Vue", "WordPress"].entries()) expect(await disabled.nth(i).innerText()).toMatch(new RegExp(`${name.replace(".", "\\.")}[\\s\\S]*SP2`));

  await page.getByLabel("Cách đăng nhập").selectOption("auto");
  await expectUi(page, ["ui_new_clone_auth_credentials", "ui_new_clone_auth_selectors"]);
  await page.getByRole("button", { name: "Hiện mật khẩu" }).click();
  expect(await page.getByLabel("Mật khẩu", { exact: true }).getAttribute("type")).toBe("text");
  await page.getByRole("textbox", { name: "URL trang web" }).fill("https://example.com/");
  expect(await page.getByRole("button", { name: "Sao chép URL" }).count()).toBe(1);
  expect(await page.getByRole("link", { name: "Hủy" }).getAttribute("href")).toBe("/");
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "new-clone-crawl-auto");

  // 375px: crawl limits + auto-auth credentials + the optional-selectors grid all expanded, no horizontal scroll.
  await page.getByText("Selector form đăng nhập (tùy chọn)").click();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  expect(foreign).toEqual([]);
  await page.close();
});

test("new: crawl the site3 fixture, land on the sitemap with its 3 pages", async () => {
  const page = await browser.newPage();
  for (const path of ["/", "/new"]) {
    await page.goto(`${base}${path}`);
    await expectNoDrift(page);
  }
  await page.getByRole("textbox", { name: "URL trang web" }).fill(`${site.url}/index.html`);
  await page.getByRole("group", { name: "Chế độ clone" }).getByRole("button", { name: "Crawl nhiều trang" }).click();
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

test("new (manual login): after create the login step comes before the crawl; Quét trang then crawls", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/new`);
  await page.getByRole("textbox", { name: "URL trang web" }).fill(`${site.url}/index.html`);
  await page.getByLabel("Cách đăng nhập").selectOption("manual");
  await page.getByRole("button", { name: "Quét trang" }).click();
  const step = page.getByRole("group", { name: "Đăng nhập trước khi quét" });
  await expect.poll(() => step.getByRole("button", { name: "Mở cửa sổ đăng nhập" }).isVisible()).toBe(true);
  expect(page.url()).toMatch(/\/new$/); // not crawled yet
  await step.getByRole("button", { name: "Quét trang" }).click();
  await page.waitForURL(/\/p\/[^/]+\/sitemap$/, { timeout: 60_000 });
  // session tools on the sitemap: import a storageState file, then clear the session
  const session = page.getByRole("region", { name: "Phiên đăng nhập" });
  await session.getByLabel("Import cookie / storageState JSON").setInputFiles({
    name: "state.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ cookies: [{ name: "sid", value: "v", url: site.url }], origins: [] })),
  });
  await expect.poll(() => session.getByRole("status").innerText(), { timeout: 30_000 }).toBe("Đã import 1 cookie, 0 origin.");
  page.once("dialog", (d) => void d.accept());
  await session.getByRole("button", { name: "Xóa phiên" }).click();
  await expect.poll(() => session.getByRole("status").innerText(), { timeout: 30_000 }).toBe("Đã xóa phiên.");
  await page.close();
});

test("new: delay, QA threshold, token budget and optional login selectors are saved in the project config", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/new`);
  await page.getByRole("textbox", { name: "URL trang web" }).fill(`${site.url}/index.html`);
  await page.getByRole("group", { name: "Chế độ clone" }).getByRole("button", { name: "Crawl nhiều trang" }).click();
  await page.getByLabel("Delay giữa request").fill("0");
  await page.getByRole("spinbutton", { name: "Chính xác (%)" }).fill("90");
  const budget = page.getByRole("textbox", { name: "Ngân sách token" });
  await budget.fill("1500000");
  await budget.blur();
  expect(await budget.inputValue()).toBe("1.500.000");
  await page.getByLabel("Cách đăng nhập").selectOption("auto");
  await page.getByLabel("Tài khoản", { exact: true }).fill("u");
  await page.getByLabel("Mật khẩu", { exact: true }).fill("p");
  await page.getByText("Selector form đăng nhập (tùy chọn)").click();
  await page.getByLabel("Selector ô mật khẩu").fill("#pw");
  await page.getByLabel("Selector nút gửi").fill("button.go");
  await page.getByRole("button", { name: "Quét trang" }).click();
  await page.waitForURL(/\/p\/[^/]+\/sitemap$/, { timeout: 60_000 });
  const id = /\/p\/([^/]+)\/sitemap$/.exec(page.url())![1]!;
  const db = openDb(env.DB_PATH);
  try {
    const cfg = JSON.parse((db.prepare("SELECT config_json FROM projects WHERE id=?").get(id) as { config_json: string }).config_json) as ProjectConfig;
    expect(cfg.delayMs).toBe(0);
    expect(cfg.auth).toEqual({ mode: "auto", selectors: { pass: "#pw", submit: "button.go" } });
    expect(cfg.threshold).toBe(0.9);
    expect(cfg.tokenBudget).toBe(1_500_000);
  } finally {
    db.close();
  }
  await page.close();
});

test("progress: after LOGIN_FAILED, Tiếp tục asks for the account and resumes with it", async () => {
  const db = openDb(env.DB_PATH); // the app's own db file (WAL): seed a project whose auto login failed
  const id = crypto.randomUUID();
  const url = "http://127.0.0.1:9/";
  try {
    db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,'failed')").run(id, url, "single", JSON.stringify({ auth: { mode: "auto" } }));
    db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code) VALUES(?,?,'login',?,'failed','LOGIN_FAILED')").run(crypto.randomUUID(), id, url);
    db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'capture','home','pending')").run(crypto.randomUUID(), id);
    await mkdir(join(env.WORKSPACE_ROOT, id), { recursive: true });
    await writeFile(join(env.WORKSPACE_ROOT, id, "pages.json"), JSON.stringify([{ pageId: "home", url }]));
    const page = await browser.newPage();
    await page.goto(`${base}/p/${id}`);
    await page.getByRole("button", { name: "Tiếp tục" }).click();
    const form = page.getByRole("form", { name: "Đăng nhập lại" });
    await form.getByLabel("Tài khoản").fill("smoke-user");
    await form.getByLabel("Mật khẩu").fill("smoke-pass-4321");
    await form.getByLabel("Ghi nhớ").check();
    await form.getByRole("button", { name: "Tiếp tục với tài khoản này" }).click();
    await expect.poll(() => form.count()).toBe(0);
    // the resume carried the credentials: remembered (encrypted), never in the page, and the login ran again
    // with them (without new credentials a LOGIN_FAILED login is never re-attempted)
    const row = db.prepare("SELECT auth_enc FROM projects WHERE id=?").get(id) as { auth_enc: string | null };
    expect(row.auth_enc).toBeTruthy();
    expect(row.auth_enc).not.toContain("smoke-pass-4321");
    expect(await page.content()).not.toContain("smoke-pass-4321");
    const login = () => db.prepare("SELECT attempts,error_code FROM tasks WHERE project_id=? AND phase='login'").get(id) as { attempts: number; error_code: string | null };
    await expect.poll(() => login().attempts, { timeout: 30_000 }).toBe(1);
    await page.close();
  } finally {
    db.close();
  }
});

test("history: tab counts, row states (failed code, needs_auth, running phase x/y, draft), actions, ZIP download, long URL, pagination", async () => {
  const db = openDb(env.DB_PATH);
  const pfx = `http://history.test/${crypto.randomUUID()}`;
  const ws = env.WORKSPACE_ROOT;
  let done = "";
  try {
    done = seedProject(db, { url: `${pfx}/done`, status: "completed", progress: 100, tasks: [{ phase: "capture", key: "home", status: "done" }] });
    await writeWs(ws, done, "pages/home/shots/1440.png", pngOf(40, 25, [40, 60, 200]));
    await writeWs(ws, done, "out/index.html", "<h1>done</h1>");
    seedProject(db, { url: `${pfx}/running`, status: "running", progress: 40, mode: "crawl", tasks: [{ phase: "capture", key: "home", status: "done" }, { phase: "capture", key: "about", status: "running" }] });
    seedProject(db, { url: `${pfx}/failed`, status: "failed", progress: 10, tasks: [{ phase: "capture", key: "home", status: "failed", errorCode: "NAV_TIMEOUT", errorMsg: "navigation timeout 30000ms" }] });
    seedProject(db, { url: `${pfx}/auth`, status: "needs_auth", tasks: [{ phase: "capture", key: "home", status: "needs_auth", errorCode: "AUTH_REQUIRED", errorMsg: "login wall" }] });
    seedProject(db, { url: `${pfx}/interrupted`, status: "interrupted", progress: 55, tasks: [{ phase: "capture", key: "home", status: "running" }] });
    seedProject(db, { url: `${pfx}/${"very-long-segment-".repeat(16)}draft`, status: "draft", tasks: [{ phase: "discover", key: pfx, status: "done" }] });
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/`);
  const search = page.getByRole("searchbox", { name: "Tìm theo URL" });
  await search.fill(pfx);
  await search.press("Enter");
  const rows = page.locator('[data-ui="ui_history_job_rows"] [role="row"]:not(.grid-head)');
  await expect.poll(() => rows.count()).toBe(5);
  const tabs = page.getByRole("tablist", { name: "Nhóm dự án" });
  expect(await tabs.getByRole("tab", { name: /Chưa hoàn thành/ }).innerText()).toMatch(/Chưa hoàn thành\s*5/);
  expect(await tabs.getByRole("tab", { name: /Đã hoàn thành/ }).innerText()).toMatch(/Đã hoàn thành\s*1/);
  expect(await page.locator('[data-ui="ui_history_page_header"]').innerText()).toContain("6 dự án");
  const row = (s: string) => rows.filter({ hasText: `${pfx}/${s}` });
  expect(await row("failed").innerText()).toContain("NAV_TIMEOUT: navigation timeout 30000ms");
  expect(await row("auth").innerText()).toContain("Cần đăng nhập (AUTH_REQUIRED) — mở dự án để đăng nhập");
  expect(await row("auth").getAttribute("class")).toContain("row-warn");
  expect(await row("auth").getByRole("link", { name: "Tiếp tục" }).getAttribute("href")).toMatch(/^\/p\/[^/]+$/);
  expect(await row("running").innerText()).toMatch(/capture 1\/2[\s\S]*40%/);
  expect(await row("running").getByRole("button", { name: "Tạm dừng" }).count()).toBe(1);
  expect(await row("running").innerText()).toMatch(/Crawl · 2 trang · bắt đầu/);
  expect(await row("interrupted").getByRole("button", { name: "Tiếp tục" }).getAttribute("class")).toContain("tone-warn");
  expect(await rows.filter({ hasText: "draft" }).innerText()).toContain("chưa chọn trang");
  for (const s of ["failed", "needs_auth", "running", "interrupted", "draft"]) expect(await rows.locator(`[data-status="${s}"]`).count()).toBe(1);
  expect(await page.locator('[data-ui="ui_history_pagination"]').innerText()).toContain("Hiển thị 1–5 / 5 dự án");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // a 300-char URL never widens the page
  expect((await page.locator('[data-ui="ui_history_url_search"]').boundingBox())?.width).toBeGreaterThanOrEqual(380); // ~400px at 1440, not squeezed to fit-content
  await expectUi(page, ["ui_shell_page_header", "ui_history_page_header", "ui_history_status_tabs", "ui_history_url_search", "ui_history_refresh", "ui_history_job_rows", "ui_history_row_url", "ui_history_row_subtitle", "ui_history_failed_error_log", "ui_history_needs_auth_status", "ui_history_status_pill", "ui_history_progress_bar", "ui_history_row_actions", "ui_history_pause_button", "ui_history_resume_button", "ui_history_open_button", "ui_history_reclone_button", "ui_history_delete_button", "ui_history_pagination"]);
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "history-mixed");

  await tabs.getByRole("tab", { selected: true }).press("ArrowRight"); // keyboard: → selects "Đã hoàn thành"
  await expect.poll(() => rows.count()).toBe(1);
  expect(await rows.locator('[data-ui="ui_history_row_thumb"]').count()).toBe(1);
  expect(await rows.innerText()).toContain("xong");
  await expectUi(page, ["ui_history_row_thumb", "ui_history_download_export"]);
  const [download] = await Promise.all([page.waitForEvent("download"), rows.getByRole("button", { name: "Tải ZIP" }).click()]);
  expect(download.suggestedFilename()).toBe(`${done}.zip`);
  await parityShot(page, "history-completed");

  await tabs.getByRole("tab", { name: /Chưa hoàn thành/ }).click();
  await expect.poll(() => rows.count()).toBe(5);
  page.once("dialog", (d) => void d.accept());
  await rows.filter({ hasText: "draft" }).getByRole("button", { name: "Xóa" }).click();
  await expect.poll(() => rows.count()).toBe(4);
  await search.fill(`${pfx}/nothing-here`);
  await search.press("Enter");
  await expect.poll(() => page.locator('[data-ui="ui_history_empty"]').innerText()).toContain("Không có dự án nào.");
  await expectUi(page, ["ui_history_empty"]);
  expect(foreign).toEqual([]);
  await page.close();
});

test("shell: fixed 56px header; 3 general nav items; under /p/[id] the 5 project links; no request off loopback", async () => {
  const db = openDb(env.DB_PATH);
  let id = "";
  try {
    id = seedProject(db, { url: "http://shell.test/", status: "draft" });
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/`);
  await expectUi(page, ["ui_shell_header", "ui_shell_new_clone_cta", "ui_shell_settings_link", "ui_shell_sidebar_nav"]);
  expect((await page.locator('[data-ui="ui_shell_header"]').boundingBox())?.height).toBe(56);
  const general = page.getByRole("navigation", { name: "Chung" });
  expect(await general.getByRole("link").allInnerTexts()).toEqual(["Lịch sử", "Clone mới", "Cài đặt AI"]);
  expect(await general.getByRole("link", { name: "Lịch sử" }).getAttribute("aria-current")).toBe("page");
  expect(await page.getByRole("navigation", { name: "Dự án" }).count()).toBe(0);

  await page.goto(`${base}/p/${id}/sitemap`);
  const project = page.getByRole("navigation", { name: "Dự án" });
  expect(await project.getByRole("link").allInnerTexts()).toEqual(["Tiến độ", "Sitemap", "Preview", "Editor", "Code"]);
  expect(await project.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(
    ["", "/sitemap", "/preview", "/editor", "/code"].map((s) => `/p/${id}${s}`),
  );
  expect(await project.getByRole("link", { name: "Sitemap" }).getAttribute("aria-current")).toBe("page");

  for (const path of ["/new", "/settings/ai"]) await page.goto(`${base}${path}`);
  expect(await page.locator('[data-ui="ui_shell_settings_link"]').getAttribute("aria-current")).toBe("page");
  await expectIconButtonsLabelled(page);
  await expectNoDrift(page);
  expect(foreign).toEqual([]);
  await parityShot(page, "shell-settings");
  await page.close();
});
