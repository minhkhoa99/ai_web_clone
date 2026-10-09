// E4: the AI tab over a real site1 clone (pipeline, AI stubbed) in a `next build` app, with a scripted
// OpenAI-compatible provider: every chat request pops the next scripted reply.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";
import { expectIconButtonsLabelled, expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let ai: Server | undefined;
let tmp = "";
let projectId = "";
type Scripted = { content: string; delayMs?: number };
const script: Scripted[] = [];
let aiCalls = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ai-chat-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  Object.assign(process.env, env); // crypto (KEY_PATH) and the workspace must match the app's
  ai = createServer((req, res) => {
    req.resume();
    aiCalls++;
    const next = script.shift() ?? { content: JSON.stringify({ reply: "(hết kịch bản)", commands: [] }) };
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: next.content } }], usage: { total_tokens: 50 } })), next.delayMs ?? 0);
  });
  await new Promise<void>((r) => ai!.listen(0, "127.0.0.1", r));
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }, { saveProvider }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log"), import("@/core/gateway")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  const providerId = saveProvider(db, { name: "mock-chat", kind: "openai", baseUrl: `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`, apiKey: "sk-test", roles: { code: "m1" } });
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0, providerId } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); await new Promise((r) => ai?.close(r)); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

type Tree = { id: string; tag: string; text?: string; styles?: { base: Record<string, string>; bp: Record<string, Record<string, string>> }; children: Tree[] };
type Payload = { revision: number; page: { sections: { id: string; root: Tree }[] } };
const canvas = (page: Page): FrameLocator => page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
const payload = async (): Promise<Payload> => (await (await fetch(`${app!.base}/api/projects/${projectId}/editor`)).json()) as Payload;
const walk = (n: Tree): Tree[] => [n, ...n.children.flatMap(walk)];
const h1Node = async () => (await payload()).page.sections.flatMap((s) => walk(s.root)).find((n) => n.tag === "h1")!;
const reply = (commands: unknown[], text = "Đã đổi màu tiêu đề.") => ({ content: JSON.stringify({ reply: text, commands }) });
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth);
async function open(width = 1440, height = 1000): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  return page;
}
const aiTab = (page: Page) => page.locator('[data-ui="ui_editor_ai_tab"]');
const input = (page: Page) => page.locator('[data-ui="ui_editor_ai_input"]');
async function ask(page: Page, text: string) {
  await input(page).fill(text);
  await page.locator('[data-ui="ui_editor_ai_send"]').click();
}
const lastAssistant = (page: Page) => page.locator('[data-ui="ui_editor_ai_messages"] .is-assistant').last();

test("chọn h1 → 'đổi màu chữ thành đỏ' → một bước ai_editor, đúng một section thay, reload còn; Hoàn tác lượt này khôi phục", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  await h1.click();
  await aiTab(page).click();
  await expectUi(page, ["ui_editor_ai_tab", "ui_editor_ai_messages", "ui_editor_ai_scope", "ui_editor_ai_input", "ui_editor_ai_send", "ui_editor_ai_tokens", "ui_editor_ai_clear"]);
  await expect.poll(() => page.locator('[data-ui="ui_editor_ai_scope"]').innerText()).toMatch(/^Phạm vi: section /);
  const node = await h1Node(), rev = (await payload()).revision;
  script.push(reply([{ op: "setStyle", id: node.id, target: "base", changes: { color: "rgb(255, 0, 0)" } }]));
  // a mark on the frame's window: still there after the turn = sections were swapped in place, the frame never reloaded
  await canvas(page).locator("body").evaluate(() => { (window as unknown as { aiwcMark?: number }).aiwcMark = 1; });
  const calls = aiCalls;
  await ask(page, "đổi màu chữ thành đỏ");
  await expect.poll(() => lastAssistant(page).innerText(), { timeout: 30_000 }).toContain("Đã đổi màu tiêu đề.");
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).color), { timeout: 30_000 }).toBe("rgb(255, 0, 0)");
  expect(await canvas(page).locator("body").evaluate(() => (window as unknown as { aiwcMark?: number }).aiwcMark)).toBe(1);
  expect(aiCalls - calls).toBe(1);
  expect((await payload()).revision).toBe(rev + 1);
  const sources = db!.prepare("SELECT source FROM document_history WHERE project_id=? ORDER BY seq DESC LIMIT 1").get(projectId) as { source: string };
  expect(sources.source).toBe("ai_editor");
  await page.reload();
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  expect(await canvas(page).locator("h1").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
  await aiTab(page).click();
  await page.locator('[data-ui="ui_editor_ai_undo"]').last().click();
  await expect.poll(() => canvas(page).locator("h1").evaluate((el) => getComputedStyle(el).color), { timeout: 30_000 }).not.toBe("rgb(255, 0, 0)");
  expect(await noSideScroll(page)).toBe(true);
  await expectIconButtonsLabelled(page);
  await page.close();
});

test("ở 768 lệnh ghi lớp 768, 1440 không đổi; gõ Style rồi gửi ngay: Style lưu trước, không 409 (Review Focus 2)", { timeout: 240_000 }, async () => {
  const page = await open();
  await page.locator('[data-ui="ui_editor_bp_switch"]').getByRole("button", { name: "768" }).click();
  await canvas(page).locator("h1").click();
  const node = await h1Node(), rev = (await payload()).revision;
  // a Style edit still in its 300 ms debounce when Gửi is pressed (switching to the AI tab unmounts the Style panel:
  // its flush runs on the way, like any other path — the turn must still start at the revision after it)
  const field = page.locator('[data-ui="ui_editor_style_field"][data-prop="font-size"] input').first();
  await field.fill("40px");
  await aiTab(page).click();
  script.push(reply([{ op: "setStyle", id: node.id, target: 768, changes: { "letter-spacing": "3px" } }], "Đã giãn chữ ở 768."));
  await ask(page, "giãn chữ tiêu đề");
  await expect.poll(() => lastAssistant(page).innerText(), { timeout: 30_000 }).toContain("Đã giãn chữ ở 768.");
  const after = await h1Node();
  expect(after.styles!.bp["768"]?.["letter-spacing"]).toBe("3px");
  expect(after.styles!.base["letter-spacing"]).not.toBe("3px");
  expect((await payload()).revision).toBe(rev + 2); // the Style step, then the AI step
  expect(await page.locator('[data-ui="ui_editor_stale_banner"]').count()).toBe(0);
  await page.close();
});

test("carousel: 'thêm một slide' → addCarouselSlide, một Undo xoá nó; AI trả id ngoài phạm vi rồi sửa được; sai 3 lần → báo lỗi, revision giữ", { timeout: 300_000 }, async () => {
  const page = await open();
  await canvas(page).locator("h1").click();
  await page.locator('[data-ui="ui_editor_left_tabs"]').getByRole("tab", { name: "Thêm" }).click();
  await page.getByRole("button", { name: "Carousel" }).click();
  await expect.poll(() => canvas(page).locator('[data-c="carousel"] [data-c-role="slide"]').count(), { timeout: 30_000 }).toBe(3);
  const car = (await payload()).page.sections.flatMap((s) => walk(s.root)).find((n) => (n as Tree & { interactive?: { kind: string } }).interactive?.kind === "carousel")!;
  await canvas(page).locator('[data-c="carousel"]').first().click();
  await aiTab(page).click();
  script.push(reply([{ op: "setText", id: "nope-outside", text: "x" }], "thử"), reply([{ op: "addCarouselSlide", id: car.id, index: 3 }], "Đã thêm slide."));
  await ask(page, "thêm một slide");
  await expect.poll(() => lastAssistant(page).innerText(), { timeout: 30_000 }).toContain("Đã thêm slide.");
  await expect.poll(() => canvas(page).locator('[data-c="carousel"] [data-c-role="slide"]').count(), { timeout: 30_000 }).toBe(4);
  await page.getByRole("button", { name: "Hoàn tác", exact: true }).click();
  await expect.poll(() => canvas(page).locator('[data-c="carousel"] [data-c-role="slide"]').count(), { timeout: 30_000 }).toBe(3);
  const rev = (await payload()).revision;
  for (let i = 0; i < 3; i++) script.push(reply([{ op: "deleteNode", id: "nope-outside" }], "x"));
  await ask(page, "xoá cái gì đó");
  await expect.poll(() => lastAssistant(page).innerText(), { timeout: 30_000 }).toContain("AI chưa tạo được thay đổi hợp lệ");
  expect((await payload()).revision).toBe(rev);
  await page.getByRole("button", { name: "Hoàn tác", exact: true }).click(); // remove the inserted carousel
  await page.close();
});

test("Huỷ giữa lượt → không có bước mới; trong lúc AI chạy Delete bị chặn; tab khác sửa xen giữa → banner Tải lại", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  await h1.click();
  const node = await h1Node();
  await aiTab(page).click();
  let rev = (await payload()).revision;
  script.push({ ...reply([{ op: "setHidden", id: node.id, hidden: true }]), delayMs: 4000 });
  await ask(page, "ẩn tiêu đề");
  await page.locator('[data-ui="ui_editor_ai_cancel"]').waitFor();
  await h1.click();
  await page.keyboard.press("Delete");
  await expect.poll(() => page.getByRole("status").first().innerText()).toContain("AI đang sửa");
  await page.locator('[data-ui="ui_editor_ai_cancel"]').click();
  await expect.poll(() => lastAssistant(page).innerText(), { timeout: 30_000 }).toContain("Đã huỷ");
  expect((await payload()).revision).toBe(rev);
  expect(await h1.isVisible()).toBe(true);
  // another tab commits while the AI thinks
  rev = (await payload()).revision;
  script.push({ ...reply([{ op: "setHidden", id: node.id, hidden: true }]), delayMs: 3000 });
  await ask(page, "ẩn tiêu đề");
  await fetch(`${app!.base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: rev, commands: [{ op: "setName", id: node.id, name: "Tab khác" }] }) });
  await expect.poll(() => page.locator('[data-ui="ui_editor_stale_banner"]').count(), { timeout: 30_000 }).toBe(1);
  expect(await h1.isVisible()).toBe(true);
  await page.close();
});

test("Sửa main / view-only tắt ô nhập, lịch sử vẫn đọc; hết ngân sách tắt ô nhập; 768 drawer; Xoá hội thoại", { timeout: 240_000 }, async () => {
  const page = await open(800, 900);
  await page.locator('[data-ui="ui_editor_drawer_toggle"]').getByRole("button", { name: /bảng Style/ }).click();
  await aiTab(page).click();
  await expect.poll(() => page.locator('[data-ui="ui_editor_ai_messages"] li').count()).toBeGreaterThan(0);
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 600, height: 900 }); // view-only
  await page.locator('[data-ui="ui_editor_drawer_toggle"]').getByRole("button", { name: /bảng AI/ }).click();
  await expect.poll(() => input(page).isDisabled()).toBe(true);
  expect(await page.locator('[data-ui="ui_editor_ai_messages"] li').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator("#ve-right").getByText("Dùng màn hình ≥ 768px để chỉnh sửa").count()).toBeGreaterThan(0);
  await page.close();
  db!.prepare("UPDATE projects SET tokens_used=999999999 WHERE id=?").run(projectId);
  const p2 = await open();
  await aiTab(p2).click();
  await expect.poll(() => input(p2).isDisabled()).toBe(true);
  db!.prepare("UPDATE projects SET tokens_used=0 WHERE id=?").run(projectId);
  p2.on("dialog", (d) => void d.accept());
  await p2.reload();
  await canvas(p2).locator("h1").waitFor({ timeout: 30_000 });
  await aiTab(p2).click();
  await p2.locator('[data-ui="ui_editor_ai_clear"]').click();
  await expect.poll(() => p2.locator('[data-ui="ui_editor_ai_messages"] li').count()).toBe(0);
  await p2.close();
});
