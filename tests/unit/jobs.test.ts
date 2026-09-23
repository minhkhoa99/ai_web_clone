import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { AppError } from "@/core/errors";
import type { BrowserHandle } from "@/core/browser";
import { createProject, enqueue, pageIdsFor, recoverOnStartup, runProject, startProject, subscribe, type JobEvent } from "@/core/jobs";

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
