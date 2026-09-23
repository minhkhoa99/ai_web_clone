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
