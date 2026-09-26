// Editor smoke: a completed site1 clone (real pipeline, AI steps stubbed) opened in the real GrapesJS
// editor of a `next build` + `next start` app; one text edited like a user would, saved, re-emitted.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { fmtPct } from "@/app/_ui/format";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";
import { parityShot } from "./parity-shots";
import { expectIconButtonsLabelled, expectNoDrift, expectUi, trackForeignRequests } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";
let workspaceRoot = "";

// a full-page shot at the current viewport (parityShot always resets to 1440x900); a no-op without PARITY_DIR
async function shotAt(page: Page, name: string): Promise<void> {
  if (!process.env.PARITY_DIR) return;
  await mkdir(process.env.PARITY_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.PARITY_DIR, `${name}.png`), fullPage: true });
}

// The pipeline runs in this process against the app's tmp workspace + db. core/config reads WORKSPACE_ROOT at
// import, so the core modules are imported only after it is set.
async function seedCompleted(env: { DB_PATH: string; WORKSPACE_ROOT: string }): Promise<string> {
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  const id = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, id, [`${site.url}/index.html`]);
  await runProject(db, id, { deps: offline });
  await settled(id); // the run's events are on disk: the app process replays them
  return id;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "editor-smoke-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  // seedCompleted must fully finish (status='completed', events flushed) before the real Next server starts:
  // its instrumentation.ts runs recoverOnStartup, which marks any row still 'running' at that instant
  // 'interrupted' — a race that intermittently corrupted the completed run's status (fix round 1 #11).
  workspaceRoot = env.WORKSPACE_ROOT;
  [projectId, browser] = await Promise.all([seedCompleted(env), chromium.launch()]);
  app = await startNextApp(env);
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  app?.stop();
  db?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("progress (completed): the finished run's log is replayed from disk by the app; every phase done; run clock shown", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${app!.base}/p/${projectId}`);
  const lines = page.locator('[data-ui="ui_progress_log_line"]');
  await expect.poll(() => lines.count(), { timeout: 30_000 }).toBeGreaterThan(5);
  expect(await page.getByRole("log").innerText()).toContain("trạng thái → completed");
  const states = await page.locator('[data-ui="ui_progress_phase_stepper"] li').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(new Set(states)).toEqual(new Set(["done"]));
  expect(await page.locator('[data-ui="ui_progress_stats_bar"]').innerText()).toMatch(/\d\d:\d\d:\d\d/);
  await parityShot(page, "progress-completed");
  await page.close();
});

type PreviewData = { pages: { pageId: string }[]; scores: { pageId: string; sectionId: string; bp: number; score: number; heatPath: string | null }[]; stale: boolean };

test("preview: toolbar, mean match, panes fill the area, onion/swipe, heatmap overlay, fix card → editor, next diff, checklist", async () => {
  const base = app!.base;
  // force one failing section (all 3 breakpoints) so the "cần sửa" card is deterministic
  const qaPath = join(workspaceRoot, projectId, "qa.json");
  const qa = JSON.parse(await readFile(qaPath, "utf8")) as { scores: PreviewData["scores"] };
  const pageId = qa.scores[0]!.pageId; // from the data (site1's page is "index"), never hard-coded
  const forced = qa.scores[0]!.sectionId;
  for (const s of qa.scores) if (s.sectionId === forced) s.score = 0.5;
  await writeFile(qaPath, JSON.stringify(qa));
  // site1 captures every interaction: mark one skipped for this page load only (ir.json is restored right after)
  const irPath = join(workspaceRoot, projectId, "ir.json");
  const irText = await readFile(irPath, "utf8");
  const ir = JSON.parse(irText) as { interactions: { status: string }[] };
  ir.interactions[0]!.status = "skipped";
  await writeFile(irPath, JSON.stringify(ir));

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  try {
    await page.goto(`${base}/p/${projectId}/preview`);
    await page.locator('[data-ui="ui_qa_preview_match_score"]').waitFor(); // the view loads its data client-side
  } finally {
    await writeFile(irPath, irText);
  }
  // every toolbar item sits on one row at 1440, in each compare mode: same vertical center ±2px (the items are
  // centered and differ in height — the slider label is shorter than a segmented control — so tops differ by design)
  const oneRow = async (label: string) => {
    const mids = await page.locator(".qa-toolbar .qa-tools > *").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }));
    expect(Math.max(...mids) - Math.min(...mids), `toolbar one row (${label})`).toBeLessThanOrEqual(2);
  };
  await oneRow("side");
  await expectUi(page, ["ui_qa_preview_page_header", "ui_qa_preview_page_select", "ui_qa_preview_breakpoint_switch", "ui_qa_preview_compare_modes", "ui_qa_preview_heatmap_toggle", "ui_qa_preview_match_score", "ui_qa_preview_export_button", "ui_qa_preview_side_by_side_panes", "ui_qa_preview_sync_scroll", "ui_qa_preview_rail_tabs", "ui_qa_preview_summary", "ui_qa_preview_section_scores", "ui_qa_preview_fix_request", "ui_qa_preview_next_diff"]);
  const data = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as PreviewData;
  const at1440 = data.scores.filter((s) => s.pageId === pageId && s.bp === 1440);
  const mean = at1440.reduce((a, s) => a + s.score, 0) / at1440.length;
  expect(await page.locator('[data-ui="ui_qa_preview_match_score"]').innerText()).toBe(`${fmtPct(mean)} khớp`);
  expect(await page.locator('[data-ui="ui_qa_preview_match_score"]').getAttribute("class")).toContain("tone-danger"); // one section below the gate
  expect(await page.locator('[data-ui="ui_qa_preview_summary"]').innerText()).toMatch(/\d+ đạt • [1-9]\d* cần sửa · ngưỡng 95,0%/);
  expect(await page.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: `Section (${at1440.length})` }).count()).toBe(1);

  // panes share the compare area: no dead space at 1440; >= 500px each at 1920 (the sidebar + rail leave less at 1440)
  const area = (await page.locator('[data-ui="ui_qa_preview_sync_scroll"]').boundingBox())!;
  const panes = page.locator('[data-ui="ui_qa_preview_side_by_side_panes"] .pane-sticky');
  await expect.poll(async () => (await panes.first().boundingBox())!.width * 2 + 12).toBeGreaterThan(area.width - 24 - 4);
  expect(await panes.first().locator(".pane-head").textContent()).toMatch(/^Gốc · 1440 × \d+px$/);
  expect(await panes.nth(1).locator(".pane-head").textContent()).toMatch(/^Clone · 1440 × \d+px$/);
  await parityShot(page, "preview-side");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await panes.first().boundingBox())!.width).toBeGreaterThanOrEqual(500);
  await shotAt(page, "preview-1920");
  await page.setViewportSize({ width: 1440, height: 900 });

  const modes = page.getByRole("group", { name: "Chế độ so sánh" });
  await modes.getByRole("button", { name: "Chồng mờ" }).click();
  // compact slider: "<n>%" shown, the name is the slider's accessible name
  expect(await page.locator('[data-ui="ui_qa_preview_overlay_slider"]').innerText()).toBe("50%");
  expect(await page.getByRole("slider", { name: "Độ trong" }).getAttribute("aria-valuetext")).toBe("50%");
  expect(await page.locator(".clone-frame").evaluate((el) => (el as HTMLElement).style.opacity)).toBe("0.5");
  await oneRow("onion");
  await parityShot(page, "preview-onion");
  await modes.getByRole("button", { name: "Trượt so sánh" }).click();
  expect(await page.getByRole("slider", { name: "Vị trí" }).getAttribute("aria-valuetext")).toBe("50%");
  await oneRow("swipe");
  await parityShot(page, "preview-swipe");
  expect(await page.locator("body").innerText()).not.toContain("Chồng lớp");
  await modes.getByRole("button", { name: "Cạnh nhau" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_overlay_slider"]').count()).toBe(0);

  const heat = page.getByRole("button", { name: "Heatmap" });
  await heat.click();
  expect(await heat.getAttribute("aria-pressed")).toBe("true");
  await expect.poll(() => page.locator(".heat-overlay").count()).toBeGreaterThan(0);
  expect(await page.locator(".heat-overlay").count()).toBeLessThanOrEqual(at1440.filter((s) => s.heatPath).length);

  const card = page.locator('[data-ui="ui_qa_preview_fix_request"]').first();
  expect(await card.getByRole("link", { name: "Sửa trong editor" }).getAttribute("href")).toBe(`/p/${projectId}/editor?page=${pageId}`);
  await page.getByRole("button", { name: "Section chưa đạt tiếp theo" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_section_scores"] li[data-marked]').count()).toBe(1);
  expect(await page.getByRole("link", { name: "Xuất mã" }).getAttribute("href")).toBe(`/p/${projectId}/code`);

  // tablet + phone: toolbar, compare area and rail never force a horizontal page scroll
  for (const w of [768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await shotAt(page, `preview-${w}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `scrollWidth at ${w}`).toBe(true);
    // the pane header keeps "· 1440 × <h>px" fully visible (only the label may truncate)
    for (const size of await page.locator(".pane-size").all()) expect(await size.evaluate((el) => el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right), `pane size visible at ${w}`).toBe(true);
    // the compare modes stay one row of whole buttons
    const heights = await page.locator('[data-ui="ui_qa_preview_compare_modes"]').evaluate((g) => [g.getBoundingClientRect().height, g.querySelector("button")!.getBoundingClientRect().height]);
    expect(heights[0]!, `compare modes one row at ${w}`).toBeLessThan(heights[1]! * 1.5);
    expect(await modes.getByRole("button", { name: "Trượt so sánh" }).count()).toBe(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: /Checklist độ phủ/ }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_coverage_checklist"]').innerText()).toMatch(/CHECKLIST ĐỘ PHỦ[\s\S]*\d+\/\d+ đã chụp/);
  const skipped = page.locator('[data-ui="ui_qa_preview_skipped_item"]');
  expect(await skipped.count()).toBe(1);
  expect(await skipped.locator(".check-status").innerText()).toBe("bỏ qua");
  expect(await skipped.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(144, 143, 160)"); // --c-text-3
  await parityShot(page, "preview-checklist");
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  expect(foreign).toEqual([]);
  await page.close();
});

test("code viewer: tree + filter, file header (size, lines), copy = file content, wrap on for .html, line numbers, footer totals", async () => {
  const base = app!.base;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${projectId}/code`);
  await expectUi(page, ["ui_code_viewer_page_header", "ui_code_viewer_file_search", "ui_code_viewer_file_tree", "ui_code_viewer_file_header", "ui_code_viewer_copy_button", "ui_code_viewer_strip_ids", "ui_code_viewer_export_zip", "ui_code_viewer_export_folder", "ui_code_viewer_code_pane", "ui_code_viewer_wrap_toggle", "ui_code_viewer_build_status"]);
  const html = await (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text();
  const n = html === "" ? 0 : html.split("\n").length - (html.endsWith("\n") ? 1 : 0);
  expect(await page.locator('[data-ui="ui_code_viewer_file_header"]').innerText()).toMatch(new RegExp(`out/index\\.html[\\s\\S]*\\d+(,\\d)? (B|KB)[\\s\\S]*${n} dòng`));
  // the gutter's ".line" count matches the header's line count exactly (no phantom trailing-newline row from shiki)
  expect(await page.locator('[data-ui="ui_code_viewer_code_pane"] .line').count()).toBe(n);
  const tree = page.locator('[data-ui="ui_code_viewer_file_tree"]');
  expect(await tree.getByRole("link", { name: "index.html" }).getAttribute("aria-current")).toBe("page");
  expect(await tree.getByRole("button", { name: /out/ }).getAttribute("aria-expanded")).toBe("true");

  const wrap = page.getByRole("button", { name: "Xuống dòng" });
  const pane = page.locator('[data-ui="ui_code_viewer_code_pane"]');
  expect(await wrap.getAttribute("aria-pressed")).toBe("true");
  expect(await pane.getAttribute("class")).toContain("wrap");
  // wrap on, initially: the pane itself never scrolls horizontally (the emitted HTML's one-long-line body wraps)
  expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth), "wrapped initially").toBe(true);
  await wrap.click();
  expect(await wrap.getAttribute("aria-pressed")).toBe("false");
  expect(await pane.getAttribute("class")).not.toContain("wrap");
  expect(await pane.locator(".line").first().evaluate((el) => getComputedStyle(el, "::before").content)).toBe("counter(line)");
  // wrap off + the emitted HTML's one-long-line body: only the pane scrolls horizontally, never the page
  expect(await pane.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await wrap.click(); // back on, for the copy/clipboard check below
  expect(await wrap.getAttribute("aria-pressed")).toBe("true");
  expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth), "wrapped again after re-enabling").toBe(true);

  await page.getByRole("button", { name: "Sao chép" }).click();
  await expect.poll(() => page.getByRole("button", { name: "Đã sao chép" }).count()).toBe(1);
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(html);
  expect(await page.locator('[data-ui="ui_code_viewer_build_status"]').innerText()).toMatch(/^\d+ file · [\d,]+ (B|KB|MB)$/);
  await parityShot(page, "code");

  // filter by file name (not content): only the css file stays, its folder auto-opens
  await page.getByRole("searchbox", { name: "Lọc file" }).fill("STYLES");
  expect(await tree.getByRole("link").allInnerTexts()).toEqual(["styles.css"]);

  // switching files remounts CodeFile (`key={current}`): a per-file default (wrap) never leaks from the last file
  await tree.getByRole("link", { name: "styles.css" }).click();
  await page.waitForURL(/file=css%2Fstyles\.css/);
  expect(await wrap.getAttribute("aria-pressed"), "css defaults to wrap off").toBe("false");
  await page.getByRole("searchbox", { name: "Lọc file" }).fill("");
  await tree.getByRole("link", { name: "index.html" }).click();
  await page.waitForURL(/file=index\.html/);
  expect(await wrap.getAttribute("aria-pressed"), "back to html's default: wrap on").toBe("true");

  await page.getByRole("searchbox", { name: "Lọc file" }).fill("(");
  expect(await tree.getByRole("link").count()).toBe(0);

  // export-to-folder popover: Esc closes it
  const folder = page.locator('[data-ui="ui_code_viewer_export_folder"]');
  await folder.locator("summary").click();
  expect(await folder.getByLabel("Thư mục đích (đường dẫn tuyệt đối)").isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  expect(await folder.getAttribute("open")).toBeNull();

  // tablet + phone: tree + code pane never force a horizontal page scroll
  for (const w of [768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await shotAt(page, `code-${w}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `scrollWidth at ${w}`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  expect(foreign).toEqual([]);
  await context.close();
});

test("editor: edit one heading in the canvas, save -> exactly one patch op, out/index.html has the new text", async () => {
  const base = app!.base;
  // Taller viewport: the fixed shell header/sidebar leave less room below the fold at the Playwright default
  // (1280x720), which raced a canvas resize against the dblclick and missed the rich-text edit.
  const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } });
  await page.goto(`${base}/p/${projectId}/preview`);
  await page.getByRole("navigation", { name: "Dự án" }).getByRole("link", { name: "Editor" }).click();
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
  await expect.poll(() => page.getByRole("status").innerText(), { timeout: 30_000 }).toBe("Đã lưu: 1 thay đổi — điểm QA cần chạy lại");
  expect(await page.getByRole("link", { name: "Mở Preview" }).getAttribute("href")).toBe(`/p/${projectId}/preview`);

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

test("editor: ?page= opens that page, an unknown one falls back to the default; toolbar + GrapesJS on the tokens", async () => {
  const base = app!.base;
  // site1's one page is id "index" (from pathIdsFor's slug of "index.html"), never hard-coded "home" (ruling P2)
  const ir = JSON.parse(await readFile(join(workspaceRoot, projectId, "ir.json"), "utf8")) as { pages: { id: string }[] };
  const pageId = ir.pages[0]!.id;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/editor?page=${pageId}`);
  const select = page.locator('[data-ui="ui_editor_toolbar"] select');
  await expect.poll(() => select.inputValue(), { timeout: 30_000 }).toBe(pageId);
  await expectUi(page, ["ui_editor_page_header", "ui_editor_toolbar", "ui_editor_canvas_chrome", "ui_editor_effects_panel", "ui_editor_sections_panel"]);
  // no more default #444 GrapesJS panels: --c-surface-low
  await expect.poll(() => page.locator(".editor-shell .gjs-one-bg").first().evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: 30_000 }).toBe("rgb(25, 28, 35)");
  expect(await page.getByRole("group", { name: "Thiết bị" }).getByRole("button").allInnerTexts()).toEqual(["1440", "768", "375"]);
  expect(await page.getByRole("button", { name: "Hoàn tác" }).getAttribute("title")).toBe("Hoàn tác");
  expect(await page.getByRole("button", { name: "Làm lại" }).getAttribute("title")).toBe("Làm lại");
  await expectNoDrift(page);
  await parityShot(page, "editor");
  await page.goto(`${base}/p/${projectId}/editor?page=nope`);
  await expect.poll(() => select.inputValue(), { timeout: 30_000 }).toBe(pageId);
  expect(await page.getByRole("status").innerText()).toBe("");
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

test("preview: after an editor save, 'Chạy lại QA' re-scores through the queue (one POST even on double click); the banner goes away", { timeout: 240_000 }, async () => {
  const base = app!.base;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/qa/rescore")) posts.push(r.method());
  });
  await page.goto(`${base}/p/${projectId}/preview`);
  const banner = page.locator('[data-ui="ui_qa_preview_rerun_qa"]');
  await expect.poll(() => banner.innerText()).toContain("Điểm QA chưa cập nhật sau chỉnh sửa.");
  await parityShot(page, "preview-stale");
  await banner.getByRole("button", { name: "Chạy lại QA" }).dblclick();
  await expect.poll(() => banner.count(), { timeout: 180_000 }).toBe(0);
  expect(posts).toEqual(["POST"]);
  const after = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as PreviewData;
  expect(after.stale).toBe(false);
  await page.close();
});
