import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { AppError } from "@/core/errors";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle } from "@/core/browser";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { PNG } from "pngjs";
import { config } from "@/core/config";
import { createProject, enqueue, pageIdsFor, pauseProject, pipelineUnfinished, recoverOnStartup, requeueRescore, runProject, startProject, subscribe, type JobEvent } from "@/core/jobs";
import { projectConfigSchema } from "@/core/jobs-base";
import type { FixCtx } from "@/core/qa-fix";

test("pageIdsFor: / -> home, /a/b -> a-b, .html stripped, unsafe chars sanitized, dupes get -2 in URL order", () => {
  expect(
    pageIdsFor([
      "http://x.test/",
      "http://x.test/a/b",
      "http://x.test/About.html",
      "http://x.test/a-b",
      "http://x.test/..%2Fetc/p@ss?q=1",
      "http://x.test/?page=2",
    ]),
  ).toEqual(["home", "a-b", "about", "a-b-2", "2fetc-p-ss", "home-2"]);
});

test("createProject freezes validated config with defaults; bad values and secrets are rejected", () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "crawl", config: { depth: 1 } });
  const row = db.prepare("SELECT status,mode,config_json FROM projects WHERE id=?").get(id) as { status: string; mode: string; config_json: string };
  expect(row.status).toBe("draft");
  expect(row.mode).toBe("crawl");
  expect(JSON.parse(row.config_json)).toEqual({
    depth: 1,
    maxPages: 20,
    concurrency: 3,
    delayMs: 500,
    headed: false,
    threshold: 0.95,
    tokenBudget: 2_000_000,
    auth: { mode: "none" },
  });

  const bad = (config: Record<string, unknown>) => () => createProject(db, { url: "http://x.test/", mode: "single", config });
  expect(bad({ depth: 6 })).toThrow();
  expect(bad({ maxPages: 101 })).toThrow();
  expect(bad({ concurrency: 0 })).toThrow();
  expect(bad({ threshold: 1.5 })).toThrow();
  expect(bad({ password: "hunter2" })).toThrow();
  expect(bad({ auth: { mode: "auto", pass: "hunter2" } })).toThrow();
  expect(() => createProject(db, { url: "ftp://x.test/", mode: "single", config: {} })).toThrow();
  expect((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n).toBe(1);
});

test("projectConfigSchema.headed defaults to false and accepts true (hardening spec §5)", () => {
  expect(projectConfigSchema.parse({}).headed).toBe(false);
  expect(projectConfigSchema.parse({ headed: true }).headed).toBe(true);
});

test("runProject opens the browser with cfg.headed (hardening spec §5)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: { headed: true } });
  await enqueue(db, id, ["http://x.test/"]);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='pages/home/missing.json' WHERE project_id=? AND phase='capture'").run(id);
  let seenHeaded: boolean | undefined;
  const deps = {
    openBrowser: async (opts?: { headed?: boolean }): Promise<BrowserHandle> => {
      seenHeaded = opts?.headed;
      return { context: {} as BrowserHandle["context"], close: async () => {} };
    },
  };
  await expect(runProject(db, id, { deps })).rejects.toThrow(/ENOENT/);
  expect(seenHeaded).toBe(true);
});

test("enqueue creates exactly capture/name per page + ir/emit/qa, all pending; re-enqueue replaces the selection", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "crawl", config: {} });
  await enqueue(db, id, ["http://x.test/", "http://x.test/a/b", "http://x.test/"]);
  const tasks = () =>
    db.prepare("SELECT phase||':'||key AS k, status FROM tasks WHERE project_id=? ORDER BY k").all(id) as { k: string; status: string }[];
  expect(tasks().map((t) => t.k)).toEqual(["capture:a-b", "capture:home", "emit:all", "ir:all", "name:a-b", "name:home", "qa:all"]);
  expect(new Set(tasks().map((t) => t.status))).toEqual(new Set(["pending"]));

  await enqueue(db, id, ["http://x.test/c"]);
  expect(tasks().map((t) => t.k)).toEqual(["capture:c", "emit:all", "ir:all", "name:c", "qa:all"]);
  await expect(enqueue(db, id, [])).rejects.toThrow();
});

test("recoverOnStartup: running tasks -> pending, running projects -> interrupted, nothing else touched or started", () => {
  const db = openDb(":memory:");
  const insP = db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)");
  insP.run("p1", "http://x.test/", "crawl", "{}", "running");
  insP.run("p2", "http://x.test/", "crawl", "{}", "paused");
  const insT = db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,attempts) VALUES(?,?,?,?,?,?)");
  insT.run("t1", "p1", "capture", "home", "done", 1);
  insT.run("t2", "p1", "capture", "about", "running", 1);
  insT.run("t3", "p1", "capture", "pricing", "pending", 0);
  const events: JobEvent[] = [];
  const off = subscribe("p1", (e) => events.push(e));

  recoverOnStartup(db);
  off();

  const statusOf = (table: string, id: string) => (db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id) as { status: string }).status;
  expect(statusOf("projects", "p1")).toBe("interrupted");
  expect(statusOf("projects", "p2")).toBe("paused");
  expect(["t1", "t2", "t3"].map((t) => statusOf("tasks", t))).toEqual(["done", "pending", "pending"]);
  expect((db.prepare("SELECT attempts FROM tasks WHERE id='t2'").get() as { attempts: number }).attempts).toBe(1);
  expect(events.some((e) => e.type === "task" || e.type === "phase")).toBe(false);
});

test("queue: 1 running + 5 waiting; the 7th start throws QUEUE_FULL; a duplicate start is a no-op", () => {
  const db = openDb(":memory:");
  const hang = { openBrowser: () => new Promise<never>(() => {}) }; // run never finishes
  const ids = Array.from({ length: 7 }, () => createProject(db, { url: "http://x.test/", mode: "single", config: {} }));
  for (const id of ids.slice(0, 6)) startProject(db, id, { deps: hang });
  startProject(db, ids[0]!, { deps: hang });
  try {
    startProject(db, ids[6]!, { deps: hang });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("QUEUE_FULL");
  }

  // Pausing a waiting job takes it out of the queue now (status paused), freeing a slot; pausing a
  // project that is neither running nor queued changes nothing.
  const statusOf = (id: string) => (db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status;
  pauseProject(ids[5]!);
  expect(statusOf(ids[5]!)).toBe("paused");
  startProject(db, ids[6]!, { deps: hang });
  expect(statusOf(ids[6]!)).toBe("draft"); // waiting, not started
  pauseProject("not-a-project");
});

test("subscribe: listeners get events for their project only and are removed on unsubscribe", () => {
  const db = openDb(":memory:");
  const got: JobEvent[] = [];
  const off = subscribe("p1", (e) => got.push(e));
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES('p1','http://x.test/','single','{}','running')").run();
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES('p9','http://x.test/','single','{}','running')").run();
  recoverOnStartup(db);
  expect(got).toEqual([{ type: "status", status: "interrupted", at: expect.any(Number) }]);
  off();
  db.prepare("UPDATE projects SET status='running'").run();
  recoverOnStartup(db);
  expect(got).toHaveLength(1);
});

test("an unexpected throw mid-phase leaves that task failed (retryable), never running, and the project failed", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='pages/home/missing.json' WHERE project_id=? AND phase='capture'").run(id);
  const fakeBrowser = { openBrowser: async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} }) };
  await expect(runProject(db, id, { deps: fakeBrowser })).rejects.toThrow(/ENOENT/);
  const ir = db.prepare("SELECT status,attempts FROM tasks WHERE project_id=? AND phase='ir'").get(id) as { status: string; attempts: number };
  expect(ir).toEqual({ status: "failed", attempts: 1 });
  expect((db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status).toBe("failed");
});

test("name:<pageId> of a page whose capture was skipped finishes without an AI call", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/", "http://x.test/gone"]);
  const set = db.prepare("UPDATE tasks SET status=?,error_code=?,attempts=1,output_path=? WHERE project_id=? AND phase=? AND key=?");
  set.run("done", null, "pages/home/capture.json", id, "capture", "home");
  set.run("failed", "NODE_LIMIT", null, id, "capture", "gone");
  for (const phase of ["ir", "emit", "qa"]) set.run("done", null, "x", id, phase, "all");
  const ws = join(config.workspaceRoot, id);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "ir.json"), JSON.stringify({ pages: [{ id: "home", sectionIds: [] }], sections: [] }));
  await mkdir(join(ws, "pages", "home", "shots"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "shots", "1440.png"), PNG.sync.write(new PNG({ width: 1440, height: 900 })));
  const calls: string[] = [];
  let thumb: PNG | undefined;
  const deps = {
    openBrowser: async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} }),
    nameSections: async (_db: unknown, _p: string, _ir: unknown, pageId: string, opts?: { thumbnail?: string }) => {
      calls.push(pageId);
      thumb = opts?.thumbnail ? PNG.sync.read(Buffer.from(opts.thumbnail, "base64")) : undefined;
      return { names: {} };
    },
  };
  await runProject(db, id, { deps });
  expect(calls).toEqual(["home"]);
  expect([thumb?.width, thumb?.height]).toEqual([400, 250]); // the 1440 shot, downscaled, goes with the naming call
  const gone = db.prepare("SELECT status,error_code FROM tasks WHERE project_id=? AND phase='name' AND key='gone'").get(id);
  expect(gone).toEqual({ status: "done", error_code: null });
  expect((db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status).toBe("completed");
});

test("fix phase: the graph is rewritten from the persisted IR before fixAll (a resumed fix never sees a stale graph)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
  const dom = el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("#text", [], "Body")])])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  const ir = buildIR([capture]);
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", id);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(id);
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES('fx',?,'fix',?,'pending')").run(id, `home:${ir.sections[0]!.id}`);
  let seen: string[] = [];
  const deps = {
    openBrowser: async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} }),
    fixAll: async () => {
      seen = (db.prepare("SELECT id FROM nodes WHERE project_id=? AND type='Section' ORDER BY id").all(id) as { id: string }[]).map((r) => r.id);
      throw new Error("stop after the check");
    },
  };
  await expect(runProject(db, id, { deps })).rejects.toThrow("stop after the check");
  expect(seen).toEqual(ir.sections.map((s) => s.id).sort());
});

test("the run's user/password never reach error_msg, events or the thrown error (a Playwright error echoing them)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const creds = { user: "alice@example.test", pass: "hunter2-Secret!" };
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = {
    openBrowser: async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} }),
    capturePage: async () => {
      throw new Error(`locator.fill: Timeout 30000ms exceeded.\n  - fill("${creds.pass}") into input[name=pass] for ${creds.user}`);
    },
  };
  const err = await runProject(db, id, { credentials: creds, deps }).then(() => new Error("expected the run to throw"), (e: unknown) => e as Error);
  off();
  const stored = JSON.stringify(db.prepare("SELECT error_msg FROM tasks WHERE project_id=?").all(id));
  for (const secret of [creds.user, creds.pass]) {
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(err.message).not.toContain(secret);
  }
  expect(stored).toContain("[redacted]");
  expect(events.some((e) => e.type === "task" && e.error?.includes("[redacted]"))).toBe(true);
});

// --- persistent AI errors (hardening spec §1) ---------------------------------------------

const fakeOpen = async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} });
const statusOf = (db: ReturnType<typeof openDb>, id: string) => (db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status;
const tasksIn = (db: ReturnType<typeof openDb>, id: string, phase: string) =>
  db.prepare("SELECT key,status,error_code,error_msg FROM tasks WHERE project_id=? AND phase=? ORDER BY rowid").all(id, phase) as { key: string; status: string; error_code: string | null; error_msg: string | null }[];
const logsOf = (events: JobEvent[], prefix: string) => events.flatMap((e) => (e.type === "log" && e.level === "warn" && e.message.startsWith(prefix) ? [e.message] : []));

// One captured page (home) with a real IR, every phase but fix done, and a fix task per given section index.
async function fixReady(fixSections: number[]) {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
  const dom = el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("#text", [], "Body")])])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  const ir = buildIR([capture]);
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", id);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(id);
  const targets = fixSections.map((i) => ({ pageId: "home", sectionId: ir.sections[i]!.id }));
  for (const t of targets) db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix',?,'pending')").run(`fx-${t.sectionId}`, id, `home:${t.sectionId}`);
  return { db, id, targets };
}

const QUOTA_MSG = 'provider "apmix" model "m1" returned status 402: insufficient credit';

test("AI_QUOTA in the fix phase: fix tasks done with the code + message, one warn log, project completed with the reason", async () => {
  const { db, id, targets } = await fixReady([0, 1]);
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = {
    openBrowser: fakeOpen,
    scoreSections: async () => [],
    fixAll: async () =>
      targets.map((t) => ({ ...t, finalScore: 0.5, scores: { 375: 0.5, 768: 0.5, 1440: 0.5 }, rounds: 1, patched: false, status: "ai_stopped" as const, errorCode: "AI_QUOTA" as const, errorMessage: QUOTA_MSG })),
  };
  await runProject(db, id, { deps });
  off();
  expect(statusOf(db, id)).toBe("completed");
  const fixes = tasksIn(db, id, "fix");
  expect(fixes).toHaveLength(2);
  for (const t of fixes) expect(t).toMatchObject({ status: "done", error_code: "AI_QUOTA", error_msg: QUOTA_MSG });
  expect(logsOf(events, "AI dừng:")).toEqual([`AI dừng: AI_QUOTA — ${QUOTA_MSG}`]);
  // the live task event carries the message too (the progress page's error panel shows it without a reload)
  const done = events.filter((e) => e.type === "task" && e.phase === "fix" && e.status === "done");
  expect(done).toHaveLength(2);
  for (const e of done) expect(e).toMatchObject({ errorCode: "AI_QUOTA", error: QUOTA_MSG });
  expect(events.at(-1)).toMatchObject({ type: "status", status: "completed", reason: "AI_QUOTA" });
});

test("a transient AI error thrown by fixAll no longer fails the project: fix tasks done with that code + message", async () => {
  const { db, id } = await fixReady([0]);
  const deps = {
    openBrowser: fakeOpen,
    scoreSections: async () => [],
    fixAll: async (): Promise<never> => {
      throw new AppError("AI_RATE_LIMIT", "rate limited after 3 retries");
    },
  };
  await runProject(db, id, { deps });
  expect(statusOf(db, id)).toBe("completed");
  expect(tasksIn(db, id, "fix")).toEqual([expect.objectContaining({ status: "done", error_code: "AI_RATE_LIMIT", error_msg: "rate limited after 3 retries" })]);
});

test("a transient AI error after a sibling section's patch was merged: the patch is persisted, project completed", async () => {
  const { db, id } = await fixReady([0, 1]);
  const deps = {
    openBrowser: fakeOpen,
    scoreSections: async () => [],
    fixAll: async (ctx: FixCtx): Promise<never> => {
      ctx.ir = { ...ctx.ir, sections: ctx.ir.sections.map((s, i) => (i === 0 ? { ...s, name: "patched-by-sibling" } : s)) };
      throw new AppError("AI_RATE_LIMIT", "rate limited after 3 retries");
    },
  };
  await runProject(db, id, { deps });
  expect(statusOf(db, id)).toBe("completed");
  const saved = JSON.parse(await readFile(join(config.workspaceRoot, id, "ir.json"), "utf8")) as { sections: { name: string }[] };
  expect(saved.sections[0]!.name).toBe("patched-by-sibling");
});

// n named pages over an empty IR (no sections): capture/ir/emit/qa done, one pending fix task.
async function namesReady(n: number) {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "crawl", config: {} });
  const urls = Array.from({ length: n }, (_, i) => `http://x.test/p${i}`);
  await enqueue(db, id, urls);
  const pageIds = pageIdsFor(urls);
  const ws = join(config.workspaceRoot, id);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "ir.json"), JSON.stringify({ ...buildIR([]), pages: pageIds.map((p) => ({ id: p, path: `/${p}`, sectionIds: [] })) }));
  const set = db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase=?");
  for (const phase of ["capture", "ir", "emit", "qa"]) set.run(id, phase);
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES('fx',?,'fix','p0:s1','pending')").run(id);
  return { db, id, pageIds };
}

test("naming AI_AUTH on page 1 of 3: no further naming or fix AI call, every name/fix task carries the code + message, project completed", async () => {
  const { db, id, pageIds } = await namesReady(3);
  const authMsg = 'provider "apmix" model "m1" returned status 401: bad key';
  const calls: string[] = [];
  let fixCalls = 0;
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = {
    openBrowser: fakeOpen,
    nameSections: async (_db: unknown, _p: string, _ir: unknown, pageId: string) => {
      calls.push(pageId);
      return { names: {}, error: "AI_AUTH", errorMessage: authMsg };
    },
    fixAll: async () => {
      fixCalls++;
      return [];
    },
  };
  await runProject(db, id, { deps });
  off();
  expect(calls).toEqual([pageIds[0]]);
  expect(fixCalls).toBe(0);
  expect(statusOf(db, id)).toBe("completed");
  const all = [...tasksIn(db, id, "name"), ...tasksIn(db, id, "fix")];
  expect(all).toHaveLength(4);
  for (const t of all) expect(t).toMatchObject({ status: "done", error_code: "AI_AUTH", error_msg: authMsg });
  expect(logsOf(events, "AI dừng:")).toEqual([`AI dừng: AI_AUTH — ${authMsg}`]);
  expect(events.at(-1)).toMatchObject({ type: "status", status: "completed", reason: "AI_AUTH" });
});

test("5 AI_BAD_RESPONSE in a row while naming still opens the circuit: project failed + AI_CIRCUIT_OPEN", async () => {
  const { db, id } = await namesReady(5);
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = { openBrowser: fakeOpen, nameSections: async () => ({ names: {}, error: "AI_BAD_RESPONSE", errorMessage: "naming reply is not JSON" }) };
  await runProject(db, id, { deps });
  off();
  expect(statusOf(db, id)).toBe("failed");
  expect(events.at(-1)).toMatchObject({ type: "status", status: "failed", reason: "AI_CIRCUIT_OPEN" });
  // the four before the breaker tripped keep their fallback names and store the message
  const names = tasksIn(db, id, "name");
  expect(names.slice(0, 4).map((t) => [t.status, t.error_code, t.error_msg])).toEqual(Array(4).fill(["done", "AI_BAD_RESPONSE", "naming reply is not JSON"]));
  expect(names[4]).toMatchObject({ status: "failed", error_code: "AI_CIRCUIT_OPEN" });
});

test("4 naming AI failures then a transient AI error in fixAll (the 5th in a row): project failed + AI_CIRCUIT_OPEN", async () => {
  const { db, id, pageIds } = await namesReady(4);
  // every capture task points at `x`: a minimal capture so the fix phase can build its context
  await writeFile(join(config.workspaceRoot, id, "x"), JSON.stringify({ pageId: pageIds[0], url: "http://x.test/p0", assets: {} }));
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = {
    openBrowser: fakeOpen,
    nameSections: async () => ({ names: {}, error: "AI_BAD_RESPONSE", errorMessage: "naming reply is not JSON" }),
    fixAll: async (): Promise<never> => {
      throw new AppError("AI_RATE_LIMIT", "rate limited after 3 retries");
    },
  };
  await runProject(db, id, { deps });
  off();
  expect(statusOf(db, id)).toBe("failed");
  expect(events.at(-1)).toMatchObject({ type: "status", status: "failed", reason: "AI_CIRCUIT_OPEN" });
  expect(tasksIn(db, id, "fix")).toEqual([expect.objectContaining({ status: "failed", error_code: "AI_RATE_LIMIT" })]);
});

// --- immediate pause (hardening spec §2) --------------------------------------------------

// A fake browser whose close is counted, and an AI call that only ends when the run's signal aborts.
const closable = () => {
  const h = { closed: 0, open: async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => void h.closed++ }) };
  return h;
};
const untilAborted = <T>(signal: AbortSignal | undefined, value: T) =>
  new Promise<T>((resolve, reject) => {
    if (!signal) return reject(new Error("no signal"));
    signal.addEventListener("abort", () => resolve(value), { once: true });
  });
const failedOf = (db: ReturnType<typeof openDb>, id: string) => db.prepare("SELECT phase,key FROM tasks WHERE project_id=? AND status='failed'").all(id);

test("pause mid fix phase: the hung AI call is aborted, the browser closed, fix tasks back to pending, project paused; resume completes", async () => {
  const { db, id, targets } = await fixReady([0, 1]);
  const browser = closable();
  let started!: () => void;
  const inFix = new Promise<void>((r) => (started = r));
  const run = runProject(db, id, {
    deps: {
      openBrowser: browser.open,
      scoreSections: async () => [],
      fixAll: (ctx: FixCtx) => {
        started();
        // like generate: an aborted call rejects with the signal's reason
        return new Promise<never>((_, reject) => ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }));
      },
    },
  });
  await inFix;
  const t0 = Date.now();
  pauseProject(id);
  await run;
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(statusOf(db, id)).toBe("paused");
  expect(tasksIn(db, id, "fix").map((t) => t.status)).toEqual(["pending", "pending"]);
  expect(failedOf(db, id)).toEqual([]);
  expect(browser.closed).toBeGreaterThanOrEqual(1);

  const red = (t: (typeof targets)[number]) => ({ ...t, finalScore: 0.5, scores: { 375: 0.5, 768: 0.5, 1440: 0.5 }, rounds: 3, patched: false, status: "red" as const });
  await runProject(db, id, { deps: { openBrowser: fakeOpen, scoreSections: async () => [], fixAll: async () => targets.map(red) } });
  expect(statusOf(db, id)).toBe("completed");
  expect(tasksIn(db, id, "fix").map((t) => t.status)).toEqual(["done", "done"]);
});

test("pause mid naming: the aborted call's fallback is not kept, name tasks back to pending, no AI failure counted", async () => {
  const { db, id } = await namesReady(2);
  let started!: () => void;
  const inName = new Promise<void>((r) => (started = r));
  const run = runProject(db, id, {
    deps: {
      openBrowser: fakeOpen,
      nameSections: (_db: unknown, _p: string, _ir: unknown, _page: string, opts?: { signal?: AbortSignal }) => {
        started();
        // like the real nameSections: an aborted generate comes back as fallback names + an error code
        return untilAborted(opts?.signal, { names: {}, error: "AI_BAD_RESPONSE", errorMessage: "This operation was aborted" });
      },
    },
  });
  await inName;
  pauseProject(id);
  await run;
  expect(statusOf(db, id)).toBe("paused");
  expect(tasksIn(db, id, "name").map((t) => [t.status, t.error_code])).toEqual([["pending", null], ["pending", null]]);
  expect(failedOf(db, id)).toEqual([]);
});

// --- error surfacing (hardening spec §4) ----------------------------------------------------

const reasonOf = (db: ReturnType<typeof openDb>, id: string) => (db.prepare("SELECT status_reason FROM projects WHERE id=?").get(id) as { status_reason: string | null }).status_reason;

test("status_reason: persisted on failed, cleared when the next run starts, set to the AI stop code on completed", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='pages/home/missing.json' WHERE project_id=? AND phase='capture'").run(id);
  await expect(runProject(db, id, { deps: { openBrowser: fakeOpen } })).rejects.toThrow(/ENOENT/);
  expect(statusOf(db, id)).toBe("failed");
  expect(reasonOf(db, id)).toMatch(/ENOENT/);
  let atStart: string | null = "unset";
  const stop = new Error("stop");
  await expect(runProject(db, id, { deps: { openBrowser: async () => ((atStart = reasonOf(db, id)), Promise.reject(stop)) } })).rejects.toBe(stop);
  expect(atStart).toBeNull();

  const ready = await fixReady([0]);
  const deps = {
    openBrowser: fakeOpen,
    scoreSections: async () => [],
    fixAll: async () => ready.targets.map((t) => ({ ...t, finalScore: 0.5, scores: { 375: 0.5, 768: 0.5, 1440: 0.5 }, rounds: 1, patched: false, status: "ai_stopped" as const, errorCode: "AI_QUOTA" as const, errorMessage: QUOTA_MSG })),
  };
  await runProject(ready.db, ready.id, { deps });
  expect([statusOf(ready.db, ready.id), reasonOf(ready.db, ready.id)]).toEqual(["completed", "AI_QUOTA"]);
});

test("a completed run with no AI stop / budget has no status_reason, even with an older marker task", async () => {
  const { db, id } = await fixReady([0]);
  db.prepare("UPDATE tasks SET error_code='AI_BAD_RESPONSE',error_msg='old' WHERE project_id=? AND phase='name'").run(id);
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const deps = { openBrowser: fakeOpen, scoreSections: async () => [], fixAll: async (ctx: FixCtx, ts: { pageId: string; sectionId: string }[]) => ts.map((t) => ({ ...t, finalScore: 1, scores: { 375: 1, 768: 1, 1440: 1 }, rounds: 0, patched: false, status: "pass" as const })) };
  await runProject(db, id, { deps });
  off();
  expect([statusOf(db, id), reasonOf(db, id)]).toEqual(["completed", null]);
  expect(events.at(-1)).toEqual({ type: "status", status: "completed", at: expect.any(Number) });
});

// --- "Chạy lại QA" on a recovered project (hardening final review #1) --------------------------

test("rescore on a project paused in fix: outstanding fix tasks closed, qa:all done, no fixAll call, project completed", async () => {
  const { db, id } = await fixReady([0, 1]);
  db.prepare("UPDATE projects SET status='paused' WHERE id=?").run(id);
  db.prepare("UPDATE tasks SET status='pending' WHERE project_id=? AND phase='qa' AND key='all'").run(id);
  await writeFile(join(config.workspaceRoot, id, "qa.json"), JSON.stringify({ scores: [] }));
  expect(pipelineUnfinished(db, id)).toBe(false);
  requeueRescore(db, id);
  let fixCalls = 0;
  const deps = { openBrowser: fakeOpen, scoreSections: async () => [], fixAll: async () => (fixCalls++, []) };
  await runProject(db, id, { deps });
  expect(fixCalls).toBe(0);
  expect(statusOf(db, id)).toBe("completed");
  for (const t of tasksIn(db, id, "fix")) expect(t).toMatchObject({ status: "done", error_code: null, error_msg: "Đã chạy lại QA — bỏ vòng sửa AI còn dở." });
  expect(tasksIn(db, id, "qa").map((t) => [t.key, t.status])).toEqual([["all", "done"], ["rescore", "done"]]);
});

test("qa:all and qa:rescore both runnable (paused in the first scoring, no qa.json): one scoring, rescore semantics, no fix task", async () => {
  const { db, id } = await fixReady([]);
  db.prepare("UPDATE tasks SET status='pending' WHERE project_id=? AND phase='qa' AND key='all'").run(id);
  requeueRescore(db, id);
  let scored = 0;
  const failing = [{ pageId: "home", sectionId: "s1", bp: 1440, score: 0.1 }];
  const deps = { openBrowser: fakeOpen, scoreSections: async () => (scored++, failing as never), fixAll: async () => [] };
  await runProject(db, id, { deps });
  expect(scored).toBe(1);
  expect(tasksIn(db, id, "qa").map((t) => [t.key, t.status])).toEqual([["all", "done"], ["rescore", "done"]]);
  expect(tasksIn(db, id, "fix")).toEqual([]);
  expect(statusOf(db, id)).toBe("completed");
});

test("pipelineUnfinished: a runnable task before qa (pending capture, retryable failed name) -> true; skipped / done -> false", async () => {
  const { db, id } = await fixReady([0]);
  expect(pipelineUnfinished(db, id)).toBe(false); // pending fix tasks don't count
  db.prepare("UPDATE tasks SET status='failed',error_code='NODE_LIMIT',attempts=1 WHERE project_id=? AND phase='capture'").run(id);
  expect(pipelineUnfinished(db, id)).toBe(false); // skipped for good
  db.prepare("UPDATE tasks SET status='failed',error_code='AI_BAD_RESPONSE',attempts=1 WHERE project_id=? AND phase='name'").run(id);
  expect(pipelineUnfinished(db, id)).toBe(true);
  db.prepare("UPDATE tasks SET status='done' WHERE project_id=? AND phase='name'").run(id);
  db.prepare("UPDATE tasks SET status='pending',error_code=NULL WHERE project_id=? AND phase='capture'").run(id);
  expect(pipelineUnfinished(db, id)).toBe(true);
});
