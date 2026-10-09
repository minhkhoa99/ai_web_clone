// E4 Task 6: the chat routes over a seeded project (generate mocked: no provider, no network).
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { config } from "@/core/config";
import { AppError } from "@/core/errors";
import { generate, type GenerateResult } from "@/core/gateway";
import { buildIR } from "@/core/ir";
import type { IRNodeV2 } from "@/core/ir-v2";
import { createProject, enqueue, projectDocuments } from "@/core/jobs";
import { listMessages } from "@/core/chat-store";
import type { ChatTurnResult } from "@/core/ai-chat";
import { chatBusy } from "@/app/_server/chat";
import { getDb } from "@/app/_server/db";
import * as chat from "@/app/api/projects/[id]/editor/chat/route";
import * as cancel from "@/app/api/projects/[id]/editor/chat/cancel/route";
import * as project from "@/app/api/projects/[id]/route";

vi.mock("@/core/gateway", async (orig) => ({ ...(await orig<typeof import("@/core/gateway")>()), generate: vi.fn() }));
const gen = vi.mocked(generate);
// Review Focus 4: something to run right before the route's commit (a cancel landing late). Every projectDocuments()
// store (the route's, exclusiveEdit's) wraps commitCommands with it.
const beforeCommit = vi.hoisted(() => ({ run: undefined as undefined | (() => Promise<void> | void) }));
vi.mock("@/core/jobs", async (orig) => {
  const real = await orig<typeof import("@/core/jobs")>();
  return {
    ...real,
    projectDocuments: (db: Parameters<typeof real.projectDocuments>[0]) => {
      const store = real.projectDocuments(db);
      return { ...store, commitCommands: async (...a: Parameters<typeof store.commitCommands>) => { await beforeCommit.run?.(); return store.commitCommands(...a); } };
    },
  };
});
beforeEach(() => { gen.mockReset(); beforeCommit.run = undefined; });

const created: string[] = [];
afterAll(async () => { for (const id of created) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 }); });

const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
// same seeding as tests/unit/editor-api.test.ts (a completed project with one page and an emitted clone)
async function seed(): Promise<string> {
  const db = getDb();
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  created.push(id);
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  const dom = el("html", [el("head"), el("body", [el("header", [el("h1", [el("#text", [], "Tiêu đề")])]), el("main", [el("p", [el("#text", [], "Thân")])])])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-10-09T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "ir.json"), JSON.stringify(buildIR([capture])));
  await mkdir(join(ws, "out"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "<p>emitted</p>");
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", id);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(id);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(id);
  return id;
}
const walk = (n: IRNodeV2): IRNodeV2[] => [n, ...n.children.flatMap(walk)];
const docOf = (id: string) => projectDocuments(getDb()).loadDocument(id);
const h1Of = async (id: string) => (await docOf(id)).sections.flatMap((s) => walk(s.root)).find((n) => n.tag === "h1")!;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = "http://127.0.0.1/x") => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Request(url, { method, ...(text !== undefined && { body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } }) });
};
const send = async (id: string, body: Record<string, unknown>) => chat.POST(req("POST", { pageId: "home", selection: [], breakpoint: 1440, text: "đổi màu tiêu đề", ...body }), ctx(id));
const answer = (commands: unknown[], reply = "Đã đổi"): GenerateResult => ({ text: JSON.stringify({ reply, commands }), tokens: 12 });
const historyRows = (id: string) => getDb().prepare("SELECT source FROM document_history WHERE project_id=? ORDER BY seq").all(id) as { source: string }[];

test("ok turn: one ai_editor step, affected section, both messages stored, fix tasks closed (R10)", async () => {
  const id = await seed();
  const h1 = await h1Of(id), rev = (await docOf(id)).revision;
  // closeOutstandingFixes skips a completed project (jobs.ts): a failed one with a pending fix task, as a run leaves it
  getDb().prepare("UPDATE projects SET status='failed' WHERE id=?").run(id);
  getDb().prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix','s1','pending')").run(randomUUID(), id);
  gen.mockResolvedValueOnce(answer([{ op: "setStyle", id: h1.id, target: "base", changes: { color: "red" } }]));
  const res = await send(id, { baseRevision: rev, selection: [h1.id] });
  expect(res.status).toBe(200);
  const r = (await res.json()) as ChatTurnResult;
  expect(r).toMatchObject({ status: "ok", reply: "Đã đổi", tokens: 12, revision: rev + 1, canUndo: true });
  expect(r.affected?.sections).toHaveLength(1);
  expect(r.message).toMatchObject({ role: "assistant", status: "ok", revision: rev + 1, commands: 1 });
  expect(historyRows(id).map((x) => x.source)).toEqual(["ai_editor"]);
  expect((await h1Of(id)).styles.base.color).toBe("red");
  expect((getDb().prepare("SELECT status FROM tasks WHERE project_id=? AND phase='fix'").get(id) as { status: string }).status).toBe("done");
  expect(gen.mock.calls[0]![1]).toMatchObject({ role: "code", projectId: id });
});

test("answer turn: no step; stale base: no AI call, status stale with the current revision", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockResolvedValueOnce(answer([], "Màu đen."));
  const a = (await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult;
  expect(a).toMatchObject({ status: "answer", reply: "Màu đen.", revision: rev });
  expect(historyRows(id)).toEqual([]);
  const s = (await (await send(id, { baseRevision: rev + 5 })).json()) as ChatTurnResult;
  expect(s).toMatchObject({ status: "stale", revision: rev });
  expect(gen).toHaveBeenCalledTimes(1);
  expect(listMessages(getDb(), id).map((m) => m.status)).toEqual([null, "answer", null, "stale"]);
});

test("refused after 3 bad replies; error code from the gateway (budget)", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockResolvedValue(answer([{ op: "setText", id: "not-here", text: "x" }]));
  const r = (await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult;
  expect(r.status).toBe("refused");
  expect(gen).toHaveBeenCalledTimes(3);
  expect((await docOf(id)).revision).toBe(rev);
  gen.mockReset();
  gen.mockRejectedValueOnce(new AppError("BUDGET_EXCEEDED", "over"));
  expect((await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult).toMatchObject({ status: "error", code: "BUDGET_EXCEEDED" });
});

test("another tab commits while the AI thinks -> stale, nothing written over it", async () => {
  const id = await seed();
  const h1 = await h1Of(id), rev = (await docOf(id)).revision;
  gen.mockImplementationOnce(async () => {
    await projectDocuments(getDb()).commitCommands(id, rev, [{ op: "setName", id: h1.id, name: "Khác" }], "user");
    return answer([{ op: "setStyle", id: h1.id, target: "base", changes: { color: "red" } }]);
  });
  const r = (await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult;
  expect(r).toMatchObject({ status: "stale", revision: rev + 1 });
  expect((await h1Of(id)).styles.base.color).not.toBe("red");
  expect(historyRows(id).map((x) => x.source)).toEqual(["user"]);
});

test("one turn per project: a second POST -> 409 CHAT_BUSY; cancel aborts the first (cancelled, no step); DELETE chat refused meanwhile", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  gen.mockImplementationOnce((_db, opts) => new Promise((_res, rej) => { started(); opts.signal!.addEventListener("abort", () => rej(new Error("aborted"))); }));
  const first = send(id, { baseRevision: rev });
  await running;
  const second = await send(id, { baseRevision: rev });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { code: string }).code).toBe("CHAT_BUSY");
  expect((await chat.DELETE(req("DELETE"), ctx(id))).status).toBe(409);
  const c = await cancel.POST(req("POST"), ctx(id));
  expect(await c.json()).toEqual({ cancelled: true });
  expect(((await (await first).json()) as ChatTurnResult).status).toBe("cancelled");
  expect(historyRows(id)).toEqual([]);
  expect(await (await cancel.POST(req("POST"), ctx(id))).json()).toEqual({ cancelled: false });
});

test("a cancel that lands after the commit started: the POST still reports ok (Review Focus 4)", async () => {
  const id = await seed();
  const h1 = await h1Of(id), rev = (await docOf(id)).revision;
  gen.mockResolvedValueOnce(answer([{ op: "setHidden", id: h1.id, hidden: true }]));
  let cancelled: unknown;
  beforeCommit.run = async () => { cancelled = await (await cancel.POST(req("POST"), ctx(id))).json(); };
  const r = (await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult;
  expect(cancelled).toEqual({ cancelled: true });
  expect(r).toMatchObject({ status: "ok", revision: rev + 1 });
  expect(historyRows(id).map((x) => x.source)).toEqual(["ai_editor"]);
});

test("GET lists messages with the budget; DELETE clears; validation 400; unknown page 404; deleting the project drops its chat", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockResolvedValueOnce(answer([], "ok"));
  await send(id, { baseRevision: rev });
  const g = (await (await chat.GET(req("GET"), ctx(id))).json()) as { messages: unknown[]; tokensUsed: number; tokenBudget: number; busy: boolean };
  expect(g.messages).toHaveLength(2);
  expect(g).toMatchObject({ busy: false, tokenBudget: config.tokenBudget });
  expect((await chat.GET(req("GET", undefined, "http://127.0.0.1/x?before=abc"), ctx(id))).status).toBe(400);
  for (const bad of [{ text: "   " }, { text: "x".repeat(2001) }, { selection: Array.from({ length: 51 }, (_, i) => `n${i}`) }, { breakpoint: 1024 }, { extra: 1 }])
    expect((await send(id, { baseRevision: rev, ...bad })).status).toBe(400);
  expect((await send(id, { baseRevision: rev, pageId: "nope" })).status).toBe(404);
  expect((await chat.DELETE(req("DELETE"), ctx(id))).status).toBe(200);
  expect(listMessages(getDb(), id)).toEqual([]);
  gen.mockResolvedValueOnce(answer([], "ok"));
  await send(id, { baseRevision: rev });
  expect((await project.DELETE(req("DELETE"), ctx(id))).status).toBe(200);
  expect(listMessages(getDb(), id)).toEqual([]);
});

test("deleting the project during a running turn cancels it and leaves no chat rows (final review I2)", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  gen.mockImplementationOnce((_db, opts) => new Promise((_res, rej) => { started(); opts.signal!.addEventListener("abort", () => rej(new Error("aborted"))); }));
  const first = send(id, { baseRevision: rev });
  await running;
  const del = await project.DELETE(req("DELETE"), ctx(id));
  expect(del.status).toBe(200);
  const done = await first;
  if (done.status === 200) expect(((await done.json()) as ChatTurnResult).status).toBe("cancelled"); // else 404: the project was already gone
  expect(listMessages(getDb(), id)).toEqual([]);
  expect(chatBusy(id)).toBe(false); // the turn is registered no more
});

test("a project that vanishes under a turn: the late ending writes no chat rows (final review I2)", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockImplementationOnce(async () => {
    const db = getDb();
    for (const t of ["tasks", "nodes", "edges", "document_state", "document_history"]) db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(id);
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
    return answer([], "muộn");
  });
  expect((await send(id, { baseRevision: rev })).status).toBe(404);
  expect(listMessages(getDb(), id)).toEqual([]);
});

test("clear chat needs an editable project (final review M3)", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockResolvedValueOnce(answer([], "ok"));
  await send(id, { baseRevision: rev });
  getDb().prepare("UPDATE projects SET status='running' WHERE id=?").run(id);
  expect((await chat.DELETE(req("DELETE"), ctx(id))).status).toBe(409);
  expect(listMessages(getDb(), id)).toHaveLength(2);
  getDb().prepare("UPDATE projects SET status='completed' WHERE id=?").run(id);
  expect((await chat.DELETE(req("DELETE"), ctx(id))).status).toBe(200);
  expect(listMessages(getDb(), id)).toEqual([]);
});

test("a zod refusal reaches the user's bubble as 'path: message', not a JSON dump (final review M1)", async () => {
  const id = await seed();
  const rev = (await docOf(id)).revision;
  gen.mockResolvedValue({ text: JSON.stringify({ reply: 5, commands: [] }), tokens: 3 });
  const r = (await (await send(id, { baseRevision: rev })).json()) as ChatTurnResult;
  expect(r.status).toBe("refused");
  expect(r.reply).toMatch(/^AI chưa tạo được thay đổi hợp lệ: reply: /);
  expect(r.reply).not.toMatch(/\[\s*\{|"code"/);
});
