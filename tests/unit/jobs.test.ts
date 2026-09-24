import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { AppError } from "@/core/errors";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle } from "@/core/browser";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { PNG } from "pngjs";
import { config } from "@/core/config";
import { createProject, enqueue, pageIdsFor, pauseProject, recoverOnStartup, runProject, startProject, subscribe, type JobEvent } from "@/core/jobs";

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
  expect(got).toEqual([{ type: "status", status: "interrupted" }]);
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
