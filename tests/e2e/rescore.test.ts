// "Chạy lại QA" (spec parity §4.3, D3): a completed clone re-scored through the job queue — no fix loop, no AI call.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { saveProvider } from "@/core/gateway";
import { createProject, enqueue, isQueuedOrActive, projectDocuments, runProject, startProject, subscribe, type JobDeps, type QaFile, type StampedEvent } from "@/core/jobs";
import { serveDir } from "@/core/serve";
import { getDb } from "@/app/_server/db";
import * as preview from "@/app/api/projects/[id]/preview/route";
import * as rescore from "@/app/api/projects/[id]/qa/rescore/route";
import { offline } from "./offline-deps";

let site: { url: string; close(): Promise<void> } | undefined;
// P11 (spec §7.4 binding): a real mock provider server, not just a tokens_used check, proves zero AI calls.
let ai: Server;
let aiRequests = 0;
let id = "";
const created: string[] = [];

beforeAll(async () => {
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  ai = createServer((req, res) => {
    aiRequests++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { total_tokens: 0 }, data: [] }));
  });
  await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));
  const providerId = saveProvider(getDb(), {
    name: "mock-rescore",
    kind: "openai",
    baseUrl: `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`,
    apiKey: "sk-test",
    roles: { vision: "m1", code: "m1" },
  });
  id = createProject(getDb(), { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0, providerId } });
  created.push(id);
  await enqueue(getDb(), id, [`${site.url}/index.html`]);
  await runProject(getDb(), id, { deps: offline });
}, 300_000);

afterAll(async () => {
  await site?.close();
  await new Promise((r) => ai?.close(r));
  for (const x of created) await rm(join(config.workspaceRoot, x), { recursive: true, force: true, maxRetries: 3 });
});

const post = (x: string, init: RequestInit = {}) => rescore.POST(new Request("http://127.0.0.1", { method: "POST", ...init }), { params: Promise.resolve({ id: x }) });
const statusOf = (x: string) => (getDb().prepare("SELECT status FROM projects WHERE id=?").get(x) as { status: string }).status;
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;
const msgOf = async (res: Response) => ((await res.json()) as { message: string }).message;
// requireEditable's emit-done check (spec §3): a project the route sees as "clone emitted" needs an emit task 'done'.
const markEmitDone = (x: string) => getDb().prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'emit','all','done')").run(randomUUID(), x);

test("completed + stale: 202, running -> completed; qa.json rewritten without stale; no fix task, no token, only qa:rescore ran", async () => {
  const db = getDb();
  const qaPath = join(config.workspaceRoot, id, "qa.json");
  const firstScores = (JSON.parse(await readFile(qaPath, "utf8")) as QaFile).scores;
  // an editor step (a title attribute: nothing rendered changes) through the document store marks qa.json stale
  const store = projectDocuments(db);
  const doc = await store.loadDocument(id);
  const { revision } = await store.commitCommands(id, doc.revision, [{ op: "setAttribute", id: doc.sections[0]!.root.id, name: "title", value: "edited" }], "user");
  expect((JSON.parse(await readFile(qaPath, "utf8")) as QaFile).stale).toBe(true);
  const fixCount = () => (db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND phase='fix'").get(id) as { n: number }).n;
  const tokens = () => (db.prepare("SELECT tokens_used t FROM projects WHERE id=?").get(id) as { t: number }).t;
  const [fixesBefore, tokensBefore, aiRequestsBefore] = [fixCount(), tokens(), aiRequests];
  const seen: StampedEvent[] = [];
  const off = subscribe(id, (e) => seen.push(e));
  const res = await post(id);
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, queued: false });
  await expect.poll(() => seen.some((e) => e.type === "status" && e.status === "completed"), { timeout: 180_000 }).toBe(true);
  off();
  // the queue's active slot frees only after runProject's `finally` (handle.close()) resolves, strictly after
  // the "completed" event above: wait for it so the next test's queue-capacity arithmetic isn't off by one.
  await expect.poll(() => !isQueuedOrActive(id), { timeout: 30_000 }).toBe(true);
  const qa = JSON.parse(await readFile(qaPath, "utf8")) as QaFile;
  expect(qa.stale).toBeUndefined();
  expect(qa.scores.length).toBeGreaterThan(0);
  // the v2 pipeline's output re-emitted from the document scores exactly like the first run's: no score moved
  const key = (x: QaFile["scores"][number]) => `${x.pageId}/${x.sectionId}@${x.bp}`;
  expect(qa.scores.map(key).sort()).toEqual(firstScores.map(key).sort());
  const first = new Map(firstScores.map((x) => [key(x), x.score]));
  for (const x of qa.scores) expect(Math.abs(x.score - first.get(key(x))!)).toBeLessThanOrEqual(0.001);
  expect((await store.historyState(id)).revision).toBe(revision); // scoring is not a document change
  expect(fixCount()).toBe(fixesBefore);
  expect(tokens()).toBe(tokensBefore);
  expect(aiRequests).toBe(aiRequestsBefore); // P11: zero requests reached the (real, mock) provider server
  const tasks = seen.filter((e) => e.type === "task");
  expect(tasks.length).toBeGreaterThan(0);
  expect(tasks.every((e) => e.type === "task" && e.phase === "qa" && e.key === "rescore")).toBe(true);
  expect(seen.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status : ""))).toEqual(["running", "completed"]);
});

test("refusals: not completed -> 409 BAD_STATE, no out/ -> 409 NO_OUTPUT, foreign Origin / text/plain body -> 403", async () => {
  const db = getDb();
  const draft = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  const bare = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  created.push(draft, bare);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(bare);
  markEmitDone(bare); // emitted (requireEditable passes) but out/ was never written: NO_OUTPUT, not BAD_STATE
  const a = await post(draft);
  expect([a.status, await codeOf(a)]).toEqual([409, "BAD_STATE"]);
  const b = await post(bare);
  expect([b.status, await codeOf(b)]).toEqual([409, "NO_OUTPUT"]);
  expect((await post(id, { headers: { origin: "http://evil.test" } })).status).toBe(403);
  expect((await post(id, { body: "{}", headers: { "content-type": "text/plain", "content-length": "2" } })).status).toBe(403);
});

test("waiting in the queue -> a second press is 409 BAD_STATE (requireEditable: already running/queued); a full queue -> 429 QUEUE_FULL before anything is requeued", async () => {
  const db = getDb();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hang: JobDeps = {
    openBrowser: async () => {
      await gate;
      throw new Error("released by test");
    },
  };
  const completedWithOut = async () => {
    const x = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
    created.push(x);
    db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(x);
    markEmitDone(x);
    await mkdir(join(config.workspaceRoot, x, "out"), { recursive: true });
    return x;
  };
  const fillers = Array.from({ length: 5 }, () => {
    const f = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
    created.push(f);
    return f;
  });
  startProject(db, fillers[0]!, { deps: hang }); // the active job, blocked on the gate
  const q1 = await completedWithOut();
  const first = await post(q1);
  expect([first.status, await first.json()]).toEqual([202, { ok: true, queued: true }]);
  const again = await post(q1);
  expect([again.status, await codeOf(again)]).toEqual([409, "BAD_STATE"]);
  for (const f of fillers.slice(1)) startProject(db, f, { deps: hang }); // waiting: q1 + 4 = 5
  const q2 = await completedWithOut();
  const full = await post(q2);
  expect([full.status, await codeOf(full)]).toEqual([429, "QUEUE_FULL"]);
  expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND key='rescore'").get(q2) as { n: number }).n).toBe(0);
  release();
  await expect.poll(() => [...fillers, q1].every((x) => ["failed", "completed"].includes(statusOf(x))), { timeout: 60_000 }).toBe(true);
});

test("recovery (spec §3, ghi đè R69): accepted on a failed project once the clone is emitted; refused with no emit yet, or while running", async () => {
  const db = getDb();
  // `id` finished a real run in beforeAll (emit task done, out/ written): failed is still recoverable
  db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(id);
  const res = await post(id);
  expect(res.status).toBe(202);
  await expect.poll(() => statusOf(id) === "completed", { timeout: 180_000 }).toBe(true);

  const noEmit = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  created.push(noEmit);
  db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(noEmit);
  const a = await post(noEmit);
  expect(a.status).toBe(409);
  expect(await msgOf(a)).toBe("Chưa có bản clone để sửa (pha emit chưa xong). Bấm Tiếp tục ở trang Tiến độ.");

  const running = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  created.push(running);
  db.prepare("UPDATE projects SET status='running' WHERE id=?").run(running);
  markEmitDone(running);
  const b = await post(running);
  expect(b.status).toBe(409);
  expect(await codeOf(b)).toBe("BAD_STATE");
});

test("recovery (final review #1): paused in fix -> rescore closes the fix round, no AI request, completes; paused in capture -> 409, button hidden", async () => {
  const db = getDb();
  await expect.poll(() => !isQueuedOrActive(id), { timeout: 30_000 }).toBe(true);
  const ir = JSON.parse(await readFile(join(config.workspaceRoot, id, "ir.json"), "utf8")) as { sections: { id: string; pageId: string }[] };
  const s = ir.sections[0]!;
  db.prepare("UPDATE projects SET status='paused' WHERE id=?").run(id);
  db.prepare("INSERT OR REPLACE INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix',?,'pending')").run(randomUUID(), id, `${s.pageId}:${s.id}`);
  db.prepare("UPDATE tasks SET status='pending' WHERE project_id=? AND phase='qa' AND key='all'").run(id);
  const aiBefore = aiRequests;
  const seen: StampedEvent[] = [];
  const off = subscribe(id, (e) => seen.push(e));
  const res = await post(id);
  expect(res.status).toBe(202);
  await expect.poll(() => statusOf(id), { timeout: 180_000 }).toBe("completed");
  off();
  expect(aiRequests).toBe(aiBefore);
  const fix = db.prepare("SELECT status,error_msg FROM tasks WHERE project_id=? AND phase='fix' AND key=?").get(id, `${s.pageId}:${s.id}`);
  expect(fix).toEqual({ status: "done", error_msg: "Đã chạy lại QA — bỏ vòng sửa AI còn dở." });
  expect(seen.filter((e) => e.type === "task").every((e) => e.type === "task" && e.phase === "qa" && e.key === "rescore")).toBe(true);

  const capture = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  created.push(capture);
  db.prepare("UPDATE projects SET status='paused' WHERE id=?").run(capture);
  markEmitDone(capture);
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'capture','home','pending')").run(randomUUID(), capture);
  await mkdir(join(config.workspaceRoot, capture, "out"), { recursive: true });
  const refused = await post(capture);
  expect(refused.status).toBe(409);
  expect(await refused.clone().json()).toMatchObject({ code: "BAD_STATE", message: "Project chưa chạy xong — bấm Tiếp tục ở trang Tiến độ trước khi chạy lại QA." });
  expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND key='rescore'").get(capture) as { n: number }).n).toBe(0);
  const view = (await (await preview.GET(new Request("http://127.0.0.1"), { params: Promise.resolve({ id: capture }) })).json()) as { rescoreAvailable: boolean };
  expect(view.rescoreAvailable).toBe(false);
});
