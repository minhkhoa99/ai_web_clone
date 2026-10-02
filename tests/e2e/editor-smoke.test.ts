// Editor smoke: a completed site1 clone (real pipeline, AI steps stubbed) opened in the real GrapesJS
// editor of a `next build` + `next start` app; one text edited like a user would, saved, re-emitted.
import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { fmtPct } from "@/app/_ui/format";
import { fidelityCounts } from "@/app/p/[id]/preview/preview-model";
import type { FidelityItem } from "@/core/ir-v2";
import type { PageCapture } from "@/core/capture";
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
  // E2 §5: one passed and one failed behaviour check on this page (a long reason must wrap, never scroll sideways)
  const behavior = [{ pageId, nodeId: "n-carousel-ok", kind: "carousel", ok: true }, { pageId, nodeId: "n-modal-failed-with-a-long-node-id", kind: "modal", ok: false, reason: "không đóng được dialog (Esc / nút đóng)" }];
  await writeFile(qaPath, JSON.stringify({ ...qa, behavior }));
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
  // a short wide section's heatmap (1440×40) still reads as a thumbnail, not a thin bar: its drawn height >= 48px
  const drawnH = await card.locator(".fix-heat img").evaluate(async (img: HTMLImageElement) => {
    const c = Object.assign(document.createElement("canvas"), { width: 1440, height: 40 });
    const g = c.getContext("2d")!;
    g.fillStyle = "#e05050";
    g.fillRect(0, 0, 1440, 40);
    img.src = c.toDataURL();
    await img.decode();
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    const sx = r.width / img.naturalWidth, sy = r.height / img.naturalHeight;
    const scale = fit === "cover" ? Math.max(sx, sy) : fit === "fill" ? sy : Math.min(sx, sy);
    return Math.min(r.height, img.naturalHeight * scale);
  });
  expect(drawnH, "heat thumbnail drawn height").toBeGreaterThanOrEqual(48);
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
  const checks = page.locator('[data-ui="ui_qa_preview_behavior_list"] > li');
  expect(await checks.allInnerTexts()).toEqual([expect.stringMatching(/carousel · n-carousel-ok\s*hành vi đạt/), expect.stringMatching(/modal · iled-with-a-long-node-id\s*không đóng được dialog/)]);
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll at 375 (behaviour list)").toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Fidelity (E1 §5): its own tab, counts = the API's items, page/status filters, node links only for present nodes
  const fidelity = ((await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as { fidelity: FidelityItem[] }).fidelity;
  expect(fidelity.length).toBeGreaterThan(0);
  expect(fidelity.length).toBeLessThanOrEqual(2000);
  expect(fidelity.find((x) => x.feature === "script")).toMatchObject({ status: "unsupported" }); // site1 has inline scripts: never supported
  const counts = fidelityCounts(fidelity);
  await page.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: `Fidelity (${fidelity.length})` }).click();
  await expectUi(page, ["ui_qa_preview_fidelity_panel", "ui_qa_preview_fidelity_summary", "ui_qa_preview_fidelity_filters", "ui_qa_preview_fidelity_list", "ui_qa_preview_fidelity_export"]);
  expect(await page.locator('[data-ui="ui_qa_preview_fidelity_summary"] .badge').allInnerTexts()).toEqual([`${counts.supported} hỗ trợ`, `${counts.partial} một phần`, `${counts.unsupported} không hỗ trợ`]);
  const rows = page.locator('[data-ui="ui_qa_preview_fidelity_list"] > li');
  expect(await rows.count()).toBe(fidelity.length); // one page: no grouped rows
  // the script item has no node: listed, no link
  const scriptRow = rows.filter({ has: page.locator(".fid-feature", { hasText: /^script$/ }) });
  expect(await scriptRow.count()).toBe(1);
  expect(await scriptRow.getByRole("button").count()).toBe(0);
  // every link targets a node the loaded clone page really has
  const links = page.locator('[data-ui="ui_qa_preview_fidelity_list"]').getByRole("button", { name: /^Tới node / });
  const anchored = fidelity.filter((x) => x.nodeId && x.pageId === pageId);
  expect(await links.count()).toBeLessThanOrEqual(anchored.length);
  if (anchored.length) expect(await links.count()).toBeGreaterThan(0);
  const statusSelect = page.locator('[data-ui="ui_qa_preview_fidelity_filters"]').getByLabel("Trạng thái");
  await statusSelect.selectOption("unsupported");
  expect(await rows.count()).toBe(counts.unsupported);
  expect(new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status"))))).toEqual(new Set(counts.unsupported ? ["unsupported"] : []));
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Xuất JSON" }).click()]);
  const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as { status: string; items: FidelityItem[] };
  expect([exported.status, exported.items]).toEqual(["unsupported", fidelity.filter((x) => x.status === "unsupported")]);
  await statusSelect.selectOption("all");
  // the pixel score is a separate measure: unchanged by the Fidelity tab
  expect(await page.locator('[data-ui="ui_qa_preview_match_score"]').innerText()).toBe(`${fmtPct(mean)} khớp`);
  const parity = process.env.FIDELITY_SHOTS_DIR;
  if (parity) await page.screenshot({ path: join(parity, "e1-fidelity-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll at 375 (Fidelity tab)").toBe(true);
  if (parity) await page.screenshot({ path: join(parity, "e1-fidelity-375.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
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
  // hanging indent: a wrapped line's continuation rows start after the gutter, never under the line numbers
  const indents = await pane.evaluate((el) => {
    const left = el.getBoundingClientRect().left;
    const em = parseFloat(getComputedStyle(el.querySelector(".line")!).fontSize);
    return [...el.querySelectorAll(".line")].flatMap((l) => [...l.getClientRects()].slice(1).map((r) => (r.left - left) / em));
  });
  expect(indents.length, "the one-long-line body wraps").toBeGreaterThan(0);
  expect(Math.min(...indents), "continuation indent (em)").toBeGreaterThanOrEqual(4);
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

test("editor: edit one heading in the canvas, save -> exactly one command, out/index.html has the new text; server Undo/Redo; a stale tab is told to reload", async () => {
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

  // Hoàn tác / Làm lại: the server History (not GrapesJS' UndoManager); the editor reloads from the document
  const outHtml = async () => (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text();
  const status = page.getByRole("status");
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  expect(await outHtml()).toContain("Build faster sites");
  await expect.poll(() => page.getByRole("button", { name: "Làm lại" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Làm lại" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã làm lại — điểm QA cần chạy lại");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Edited headline");
  expect(await outHtml()).toMatch(/<h1[^>]*>Edited headline<\/h1>/);

  // another tab commits first: this tab's Lưu gets 409 and asks for a reload, nothing is overwritten
  await expect.poll(() => page.getByRole("button", { name: "Hoàn tác" }).isEnabled(), { timeout: 30_000 }).toBe(true); // reloaded
  const { revision } = (await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number };
  const irId = (await heading.getAttribute("data-ir-id"))!;
  const other = await fetch(`${base}/api/projects/${projectId}/editor/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: revision, commands: [{ op: "setAttribute", id: irId, name: "title", value: "other tab" }] }),
  });
  expect(other.status).toBe(200);
  await heading.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Lost update");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe(`Dự án đã thay đổi ở nơi khác (revision ${revision + 1}). Tải lại để tiếp tục.`);
  expect(await outHtml()).not.toContain("Lost update");
  expect(await outHtml()).toContain('title="other tab"');
  // "Tải lại" reloads the editor from the server document
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Edited headline");
  expect(await heading.getAttribute("title")).toBe("other tab");
  expect(await page.getByRole("button", { name: "Tải lại" }).count()).toBe(0);

  // text typed but still in rich-text editing is flushed first: Hoàn tác refuses instead of dropping it on reload
  await expect.poll(() => page.getByRole("button", { name: "Hoàn tác" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  await heading.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Unsaved words");
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Có thay đổi chưa lưu — Lưu trước khi Hoàn tác / Làm lại / Gộp layout.");
  expect(await heading.innerText()).toBe("Unsaved words");
  expect(await outHtml()).toMatch(/Edited headline<\/h1>/);
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
  // no default GrapesJS panel is left with an empty (Font Awesome, unloaded) icon: every visible one has a real
  // svg + title (ruling P19 fix round 1 #1), and the duplicate device dropdown (#2) is gone
  const gjsButtons = page.locator(".editor-shell .gjs-pn-btn");
  expect(await gjsButtons.count()).toBe(4);
  for (const btn of await gjsButtons.all()) {
    expect(await btn.getAttribute("title")).toBeTruthy();
    expect(await btn.locator("svg").count()).toBe(1);
  }
  expect(await page.locator(".editor-shell .gjs-pn-devices-c").count()).toBe(0);
  await expectNoDrift(page);
  await parityShot(page, "editor");

  // tablet: toolbar + editor-grid (stacked below ~1100px) never force a horizontal page scroll
  await page.setViewportSize({ width: 768, height: 900 });
  await shotAt(page, "editor-768");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "scrollWidth at 768").toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${base}/p/${projectId}/editor?page=nope`);
  await expect.poll(() => select.inputValue(), { timeout: 30_000 }).toBe(pageId);
  expect(await page.getByRole("status").innerText()).toBe("");
  await page.close();
});

test("editor API: recovery (spec §3, ghi đè R69) — failed/interrupted/paused are editable once the clone is emitted; running is not; no emit -> Vietnamese 409; an invalid patch is refused", async () => {
  const base = app!.base;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/projects/${projectId}/editor/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { revision } = (await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number };
  expect((await post("save", { baseRevision: revision, pageId: "nope", project: { components: [] } })).status).toBe(400);
  expect((await post("promote-layout", { baseRevision: revision, sectionIds: ["x"] })).status).toBe(400);
  expect((await post("save", { pageId: "nope", project: { components: [] } })).status).toBe(400); // no baseRevision
  try {
    // running: not a recoverable status regardless of the clone
    db!.prepare("UPDATE projects SET status='running' WHERE id=?").run(projectId);
    const running = await fetch(`${base}/api/projects/${projectId}/editor`);
    expect(running.status).toBe(409);
    expect(((await running.json()) as { message: string }).message).toBe("Chưa thể sửa ở trạng thái running.");

    // failed / interrupted / paused, clone already emitted (E3 fix): editable
    for (const status of ["failed", "interrupted", "paused"]) {
      db!.prepare("UPDATE projects SET status=? WHERE id=?").run(status, projectId);
      expect((await fetch(`${base}/api/projects/${projectId}/editor`)).status, status).toBe(200);
    }

    // failed, but the emit task isn't done: 409, Vietnamese message (not the raw "BAD_STATE: cannot edit…")
    db!.prepare("UPDATE projects SET status='failed' WHERE id=?").run(projectId);
    db!.prepare("UPDATE tasks SET status='pending' WHERE project_id=? AND phase='emit'").run(projectId);
    const noEmit = await fetch(`${base}/api/projects/${projectId}/editor`);
    expect(noEmit.status).toBe(409);
    expect(((await noEmit.json()) as { message: string }).message).toBe("Chưa có bản clone để sửa (pha emit chưa xong). Bấm Tiếp tục ở trang Tiến độ.");
  } finally {
    db!.prepare("UPDATE tasks SET status='done' WHERE project_id=? AND phase='emit'").run(projectId);
    db!.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  }
});

test("recovery (fix round 1 review): editor save on a non-completed project closes outstanding fix tasks — the manual edit wins, a later resume won't re-fix (and clobber) that section", async () => {
  const base = app!.base;
  const ir = JSON.parse(await readFile(join(workspaceRoot, projectId, "ir.json"), "utf8")) as { pages: { id: string }[]; sections: { id: string; pageId: string }[] };
  const pageId = ir.pages[0]!.id;
  const sectionId = ir.sections.find((s) => s.pageId === pageId)!.id;
  const fixKey = `${pageId}:${sectionId}`;
  // a fix task left over from before the project went failed (pending: never got to run; this is also what a
  // retryable `failed` fix task looks like to runnable(), so this covers both)
  db!.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix',?,'pending')").run(randomUUID(), projectId, fixKey);
  db!.prepare("UPDATE projects SET status='failed' WHERE id=?").run(projectId);
  try {
    type Comp = { type?: string; content?: string; attributes?: Record<string, string>; components?: Comp[] };
    const data = (await (await fetch(`${base}/api/projects/${projectId}/editor?page=${pageId}`)).json()) as { pageId: string; components: Comp[]; revision: number };
    const firstText = (cs: Comp[]): Comp | undefined => cs.map((c) => (c.type === "textnode" && c.content?.trim() ? c : firstText(c.components ?? []))).find(Boolean);
    firstText(data.components)!.content = "Sửa tay";
    // plus a style GrapesJS can hold but the IR cannot (hover at 375): skipped, recorded as Fidelity, not a History step
    const styled = (cs: Comp[]): Comp | undefined => cs.map((c) => (c.attributes?.["data-ir-id"] && c.type !== "textnode" && c.components?.length ? c : styled(c.components ?? []))).find(Boolean);
    const target = styled(data.components)!;
    target.attributes!.id = "ifid";
    const styles = [{ selectors: ["#ifid"], style: { color: "red" }, state: "hover", mediaText: "(max-width: 767.98px)", atRuleType: "media" }];
    const save = await fetch(`${base}/api/projects/${projectId}/editor/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: data.revision, pageId: data.pageId, project: { components: data.components, styles } }),
    });
    const saved = (await save.json()) as { ops: number; revision: number; skipped: string[] };
    expect([save.status, saved.ops, saved.skipped.length]).toEqual([200, 1, 1]);
    const lost = ((await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as { fidelity: FidelityItem[] }).fidelity.filter((x) => x.feature === "style-target");
    expect(lost).toEqual([expect.objectContaining({ pageId, status: "unsupported", sourceRef: target.attributes!["data-ir-id"] })]);
    const after = (await (await fetch(`${base}/api/projects/${projectId}/editor?page=${pageId}`)).json()) as { revision: number };
    expect(after.revision).toBe(saved.revision); // the Fidelity update moved no revision: an open tab still saves
    const fixTask = db!.prepare("SELECT status,error_code,error_msg FROM tasks WHERE project_id=? AND phase='fix' AND key=?").get(projectId, fixKey) as {
      status: string;
      error_code: string | null;
      error_msg: string | null;
    };
    expect(fixTask).toEqual({ status: "done", error_code: null, error_msg: "Đã sửa tay trong Editor — bỏ vòng sửa AI." });
    // runnable() (jobs.ts) only re-arms pending/retryable-failed tasks: 'done' means a later resume's runFixes
    // never selects this task, so fixAll is never called for it and ir.json/out/qa.json are never re-patched.
    const stillOpen = db!.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND phase='fix' AND status IN ('pending','failed')").get(projectId) as { n: number };
    expect(stillOpen.n).toBe(0);
  } finally {
    db!.prepare("DELETE FROM tasks WHERE project_id=? AND phase='fix' AND key=?").run(projectId, fixKey);
    db!.prepare("UPDATE tasks SET status='done' WHERE project_id=? AND phase='emit'").run(projectId);
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

// A v1-era project: the completed clone's rows + workspace copied, ir.json = the v1 build of the same capture and
// out/ its v1 output (renderView), qa.json fresh; the capture keeps only its 1440 breakpoint (no 768/375 box).
async function copyAsV1(from: string): Promise<{ id: string; pageId: string }> {
  const [{ buildLegacyIR }, { renderView }] = await Promise.all([import("@/core/ir"), import("@/core/emit-html")]);
  const id = randomUUID();
  const copy = (table: string, key: string, fresh: Record<string, string> = {}) => {
    const cols = (db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const values = cols.map((c) => (c === key ? "?" : (fresh[c] ?? c)));
    db!.prepare(`INSERT INTO ${table}(${cols.join(",")}) SELECT ${values.join(",")} FROM ${table} WHERE ${key}=?`).run(id, from);
  };
  copy("projects", "id");
  copy("tasks", "project_id", { id: "lower(hex(randomblob(16)))" });
  copy("nodes", "project_id");
  copy("edges", "project_id");
  const [src, ws] = [join(workspaceRoot, from), join(workspaceRoot, id)];
  await cp(src, ws, { recursive: true, filter: (p) => !p.startsWith(join(src, "profile")) });
  const { output_path: capPath } = db!.prepare("SELECT output_path FROM tasks WHERE project_id=? AND phase='capture'").get(id) as { output_path: string };
  const cap = JSON.parse(await readFile(join(ws, capPath), "utf8")) as PageCapture;
  const v1 = buildLegacyIR([cap]);
  await writeFile(join(ws, "ir.json"), JSON.stringify(v1));
  for (const [rel, text] of Object.entries(renderView(v1, { assetMap: cap.assets, pageUrls: { [cap.pageId]: cap.url } }))) await writeFile(join(ws, "out", rel), text);
  const qa = JSON.parse(await readFile(join(ws, "qa.json"), "utf8")) as { scores: unknown[] };
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: qa.scores }));
  await writeFile(join(ws, capPath), JSON.stringify({ ...cap, breakpoints: cap.breakpoints.filter((b) => b.bp === 1440) }));
  return { id, pageId: cap.pageId };
}

test("v1 → v2: Preview reads a v1 project without migrating it; the editor adopts it once (QA stale, v2 mirror); Save/Undo/Redo survive a reload; a failed repair serves no preview/file/export", { timeout: 180_000 }, async () => {
  const base = app!.base;
  const { id, pageId } = await copyAsV1(projectId);
  const ws = join(workspaceRoot, id);
  const json = async (rel: string) => JSON.parse(await readFile(join(ws, rel), "utf8")) as Record<string, unknown>;
  const docRow = () => db!.prepare("SELECT revision,cursor,materialized_revision FROM document_state WHERE project_id=?").get(id);
  const statusOf = () => (db!.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status;
  const api = (path: string, init?: RequestInit) => fetch(`${base}/api/projects/${id}${path}`, init);
  const postJson = (path: string, body: unknown) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Preview: the loader migrates in memory — nothing written, no job started; a capture missing 768/375 still has Fidelity
  const preview = await api("/preview");
  expect(preview.status).toBe(200);
  const data = (await preview.json()) as { pages: { pageId: string; file: string }[]; stale: boolean; scores: { heatPath: string | null }[]; fidelity: FidelityItem[] };
  expect(data.pages).toEqual([expect.objectContaining({ pageId, file: "index.html" })]);
  expect(data.stale).toBe(false);
  expect(data.fidelity.some((x) => x.status === "partial")).toBe(true);
  expect(data.fidelity).toContainEqual(expect.objectContaining({ pageId, feature: "capture-box", status: "partial", breakpoint: 768 }));
  expect([docRow(), (await json("ir.json")).version, statusOf()]).toEqual([undefined, undefined, "completed"]);

  // Editor: the first read adopts the migrated document at revision 0 — QA of the v1 output stale, ir.json the v2 mirror
  const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } });
  await page.goto(`${base}/p/${id}/editor`);
  const heading = page.frameLocator("iframe.gjs-frame").locator("h1");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  expect(docRow()).toEqual({ revision: 0, cursor: 0, materialized_revision: 0 });
  expect(await json("ir.json")).toMatchObject({ version: 2, revision: 0 });
  expect((await json("qa.json")).stale).toBe(true);

  // Lưu / Hoàn tác / Làm lại, then a reload: the document and its History come from the server
  const status = page.getByRole("status");
  await heading.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Upgraded headline");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã lưu: 1 thay đổi — điểm QA cần chạy lại");
  await expect.poll(() => page.getByRole("button", { name: "Hoàn tác" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  await expect.poll(() => page.getByRole("button", { name: "Làm lại" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Làm lại" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã làm lại — điểm QA cần chạy lại");
  await page.reload();
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Upgraded headline");
  await expect.poll(() => page.getByRole("button", { name: "Hoàn tác" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  expect(await page.getByRole("button", { name: "Làm lại" }).isEnabled()).toBe(false);
  expect(docRow()).toEqual({ revision: 3, cursor: 1, materialized_revision: 3 });
  expect(await json("ir.json")).toMatchObject({ version: 2, revision: 3 });
  const irId = (await heading.getAttribute("data-ir-id"))!;
  await page.close();

  // A step whose materialization fails: committed, output behind — Preview, out/ and export serve nothing half-written
  const pagesJson = await readFile(join(ws, "pages.json"), "utf8");
  await writeFile(join(ws, "pages.json"), "{");
  const failed = await postJson("/editor/commands", { baseRevision: 3, commands: [{ op: "setAttribute", id: irId, name: "title", value: "repaired" }] });
  expect([failed.status, await failed.json()]).toEqual([500, expect.objectContaining({ code: "DOCUMENT_MATERIALIZE_FAILED", revision: 4 })]);
  expect(docRow()).toEqual({ revision: 4, cursor: 2, materialized_revision: 3 });
  const file = await api("/files/out/index.html");
  expect([file.status, file.headers.get("retry-after")]).toEqual([503, "5"]);
  expect((await api("/preview")).status).toBe(503);
  expect((await postJson("/export", { mode: "zip" })).status).toBe(503);
  const heat = data.scores.find((s) => s.heatPath)!.heatPath!;
  expect((await api(`/files/${heat}`)).status).toBe(200); // QA/capture images never go through the emit gate

  // repaired on the next read: the new revision is served
  await writeFile(join(ws, "pages.json"), pagesJson);
  const repaired = await api("/files/out/index.html");
  expect(repaired.status).toBe(200);
  expect(repaired.headers.get("content-security-policy")).toContain("script-src ");
  expect(await repaired.text()).toMatch(/<h1[^>]*title="repaired"[^>]*>Upgraded headline<\/h1>/);
  expect(docRow()).toEqual({ revision: 4, cursor: 2, materialized_revision: 4 });
  expect((await api("/preview")).status).toBe(200);
  const zip = await postJson("/export", { mode: "zip", stripIds: true });
  expect([zip.status, zip.headers.get("content-type")]).toEqual([200, "application/zip"]);
  expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
  expect(statusOf()).toBe("completed"); // nothing above started a job

  // Preview & QA of the upgraded project at 1440/768/375: its Fidelity tab, no sideways scroll
  const fidelity = ((await (await api("/preview")).json()) as { fidelity: FidelityItem[] }).fidelity;
  const counts = fidelityCounts(fidelity);
  expect(counts.partial).toBeGreaterThan(0);
  const view = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await view.goto(`${base}/p/${id}/preview`);
  await view.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: `Fidelity (${fidelity.length})` }).click();
  expect(await view.locator('[data-ui="ui_qa_preview_fidelity_summary"] .badge').allInnerTexts()).toEqual([`${counts.supported} hỗ trợ`, `${counts.partial} một phần`, `${counts.unsupported} không hỗ trợ`]);
  for (const w of [1440, 768, 375]) {
    await view.setViewportSize({ width: w, height: 900 });
    await shotAt(view, `preview-v1-upgraded-${w}`);
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `scrollWidth at ${w}`).toBe(true);
  }
  await view.close();
});
