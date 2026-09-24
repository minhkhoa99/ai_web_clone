// D8: "Bắt đầu clone" closes an open login window first (like /crawl) instead of answering 409 PROJECT_BUSY.
import { afterAll, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle } from "@/core/browser";
import { config } from "@/core/config";
import { getDb } from "@/app/_server/db";
import * as projects from "@/app/api/projects/route";
import * as authOpen from "@/app/api/projects/[id]/auth/open/route";
import * as start from "@/app/api/projects/[id]/start/route";

const { closed } = vi.hoisted(() => ({ closed: vi.fn(async () => {}) }));
// no headed Chrome in tests: the "window" is a fake handle whose close() is observable
vi.mock("@/core/browser", async (orig) => {
  const real = await orig<typeof import("@/core/browser")>();
  const fake = { context: { once: () => {}, newPage: async () => ({ goto: async () => null }) }, close: closed } as unknown as BrowserHandle;
  return { ...real, openBrowser: vi.fn(async () => fake) };
});

let id = "";
afterAll(async () => {
  if (id) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

const json = (body: unknown) => {
  const text = JSON.stringify(body);
  return new Request("http://127.0.0.1", { method: "POST", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
};

test("draft + auth/open -> start is 202 (the window is closed first), not 409 PROJECT_BUSY", async () => {
  const url = "http://127.0.0.1:9/";
  id = ((await (await projects.POST(json({ url, mode: "single", config: { delayMs: 0, auth: { mode: "manual" } } }))).json()) as { id: string }).id;
  expect((await authOpen.POST(new Request("http://127.0.0.1", { method: "POST" }), { params: Promise.resolve({ id }) })).status).toBe(200);
  expect(closed).not.toHaveBeenCalled();
  const res = await start.POST(json({ pages: [url] }), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(202);
  expect(closed).toHaveBeenCalled();
  // the queued run gets the fake browser and fails: wait for it so nothing leaks into later tests
  const statusOf = () => (getDb().prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status;
  await expect.poll(statusOf, { timeout: 30_000 }).toBe("failed");
});
