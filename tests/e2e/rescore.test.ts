// "Chạy lại QA" (spec parity §4.3, D3): a completed clone re-scored through the job queue — no fix loop, no AI call.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { saveProvider } from "@/core/gateway";
import { createProject, enqueue, isQueuedOrActive, runProject, saveEdited, startProject, subscribe, type JobDeps, type QaFile, type StampedEvent } from "@/core/jobs";
import { serveDir } from "@/core/serve";
import { getDb } from "@/app/_server/db";
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

test("completed + stale: 202, running -> completed; qa.json rewritten without stale; no fix task, no token, only qa:rescore ran", async () => {
  const db = getDb();
  await saveEdited(db, id, (ir) => ir); // an editor save marks qa.json stale
  const qaPath = join(config.workspaceRoot, id, "qa.json");
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
  const a = await post(draft);
  expect([a.status, await codeOf(a)]).toEqual([409, "BAD_STATE"]);
  const b = await post(bare);
  expect([b.status, await codeOf(b)]).toEqual([409, "NO_OUTPUT"]);
  expect((await post(id, { headers: { origin: "http://evil.test" } })).status).toBe(403);
  expect((await post(id, { body: "{}", headers: { "content-type": "text/plain", "content-length": "2" } })).status).toBe(403);
});

test("waiting in the queue -> a second press is 409 PROJECT_BUSY; a full queue -> 429 QUEUE_FULL before anything is requeued", async () => {
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
  expect([again.status, await codeOf(again)]).toEqual([409, "PROJECT_BUSY"]);
  for (const f of fillers.slice(1)) startProject(db, f, { deps: hang }); // waiting: q1 + 4 = 5
  const q2 = await completedWithOut();
  const full = await post(q2);
  expect([full.status, await codeOf(full)]).toEqual([429, "QUEUE_FULL"]);
  expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND key='rescore'").get(q2) as { n: number }).n).toBe(0);
  release();
  await expect.poll(() => [...fillers, q1].every((x) => ["failed", "completed"].includes(statusOf(x))), { timeout: 60_000 }).toBe(true);
});
