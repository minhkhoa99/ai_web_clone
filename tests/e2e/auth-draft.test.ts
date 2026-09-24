// Logging in before the crawl (spec §0, ruling R70): a draft project may open the login window, and the
// crawl runs on the project's persistent profile, so pages behind the login are discovered as logged in.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { config } from "@/core/config";
import { discoverPages } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { openAuthWindow } from "@/app/_server/session";
import * as projects from "@/app/api/projects/route";
import * as authOpen from "@/app/api/projects/[id]/auth/open/route";

// no headed Chrome in tests: the window itself is covered by the manual flow; here only the route's gate
vi.mock("@/app/_server/session", async (orig) => ({ ...(await orig<typeof import("@/app/_server/session")>()), openAuthWindow: vi.fn(async () => {}) }));

let server: Server;
let base = "";
const created: string[] = [];

beforeAll(async () => {
  // "/" is a login form unless the browser sends the session cookie
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") return void res.writeHead(404).end();
    const loggedIn = /(^|;\s*)sid=ok/.test(req.headers.cookie ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end(loggedIn ? "<h1>Dashboard</h1>" : '<form><input name="user"><input type="password" name="pass"></form>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const id of created) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

async function newProject(): Promise<string> {
  const body = JSON.stringify({ url: `${base}/`, mode: "single", config: { delayMs: 0, auth: { mode: "manual" } } });
  const res = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) } }));
  const { id } = (await res.json()) as { id: string };
  created.push(id);
  return id;
}

const open = (id: string) => authOpen.POST(new Request("http://127.0.0.1", { method: "POST" }), { params: Promise.resolve({ id }) });

test("auth/open is allowed on a draft (login before crawl) and still refused for other states", async () => {
  const id = await newProject();
  const res = await open(id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, url: `${base}/` });
  expect(vi.mocked(openAuthWindow)).toHaveBeenCalledWith(expect.anything(), id, `${base}/`);
  getDb().prepare("UPDATE projects SET status='completed' WHERE id=?").run(id);
  expect((await open(id)).status).toBe(409);
});

// timeout: ~2s alone, but three persistent-profile launches can crawl while the suite runs `next build` in parallel
test("discoverPages crawls on the project profile: a login made there (cookie in the profile) is used", { timeout: 180_000 }, async () => {
  const [loggedIn, fresh] = [await newProject(), await newProject()];
  // what the user's login in the window leaves behind: a cookie in <ws>/profile
  const ctx = await chromium.launchPersistentContext(join(config.workspaceRoot, loggedIn, "profile"), { headless: true });
  await ctx.addCookies([{ name: "sid", value: "ok", url: base, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await ctx.close();
  expect(await discoverPages(getDb(), loggedIn)).toMatchObject([{ url: `${base}/`, needsAuth: false, status: 200 }]);
  expect(await discoverPages(getDb(), fresh)).toMatchObject([{ url: `${base}/`, needsAuth: true, status: 200 }]);
});
