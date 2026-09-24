import { expect, test, vi } from "vitest";
import type { BrowserHandle } from "@/core/browser";
import { openDb } from "@/core/db";
import { createProject, discoverPages, subscribe, type StampedEvent } from "@/core/jobs";

vi.mock("@/core/crawl", () => ({ crawl: vi.fn(async () => [{ url: "http://x.test/", needsAuth: false }]) }));

test("a draft whose only done task is discover shows 0% progress (discover is not part of the clone run)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await discoverPages(db, id, {} as BrowserHandle); // crawl is mocked: the handle is never used
  const row = db.prepare("SELECT progress FROM projects WHERE id=?").get(id) as { progress: number };
  const discover = db.prepare("SELECT status FROM tasks WHERE project_id=? AND phase='discover'").get(id) as { status: string };
  expect(discover.status).toBe("done");
  expect(row.progress).toBe(0);
});

test("progress events carry the project's tokensUsed (read in the same transaction)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  db.prepare("UPDATE projects SET tokens_used=42 WHERE id=?").run(id);
  const got: StampedEvent[] = [];
  const off = subscribe(id, (e) => got.push(e));
  await discoverPages(db, id, {} as BrowserHandle);
  off();
  expect(got.find((e) => e.type === "progress")).toMatchObject({ type: "progress", progress: 0, tokensUsed: 42 });
});
