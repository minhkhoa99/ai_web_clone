import { expect, test, vi } from "vitest";
import type { BrowserHandle } from "@/core/browser";
import { openDb } from "@/core/db";
import { createProject, discoverPages } from "@/core/jobs";

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
