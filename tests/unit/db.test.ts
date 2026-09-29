import { expect, test } from "vitest";
import { openDb } from "@/core/db";

test("migrate + insert project", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)")
    .run("p1", "http://x", "single", "{}", "draft");
  const row = db.prepare("SELECT status FROM projects WHERE id=?").get("p1") as { status: string };
  expect(row.status).toBe("draft");
});

test("tasks UNIQUE(project_id,phase,key)", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,?,?,?)").run("t1", "p", "capture", "/a", "pending");
  expect(() => db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,?,?,?)").run("t2", "p", "capture", "/a", "pending")).toThrow();
});

test("reopening a db file keeps the auth_enc migration idempotent", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "sp1-db-")), "t.db");
  openDb(path).close();
  const db = openDb(path);
  const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  expect(cols.filter((c) => c.name === "auth_enc")).toHaveLength(1);
  db.close();
});

test("a connection waits up to 5s for another writer's lock instead of failing with 'database is locked'", () => {
  const db = openDb(":memory:");
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
});

test("document_state/document_history exist, keyed by project (+ seq), and survive a reopen", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "sp1-db-")), "t.db");
  const first = openDb(path);
  first.prepare("INSERT INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES('p','{}',0,0,0)").run();
  first.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES('p',1,'[]','[]','user')").run();
  expect(() => first.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES('p',1,'[]','[]','user')").run()).toThrow();
  first.close();
  const db = openDb(path);
  const row = db.prepare("SELECT created_at FROM document_history WHERE project_id='p' AND seq=1").get() as { created_at: number };
  expect(row.created_at).toBeGreaterThan(0);
  expect(db.prepare("SELECT revision FROM document_state WHERE project_id='p'").get()).toEqual({ revision: 0 });
  db.close();
});
