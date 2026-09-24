// "Xóa phiên" and "Import cookie / storageState JSON" (spec §3) on the project's persistent profile.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { config } from "@/core/config";
import { createProject, discoverPages } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import * as clear from "@/app/api/projects/[id]/session/clear/route";
import * as importRoute from "@/app/api/projects/[id]/session/import/route";

let server: Server;
let base = "";
const created: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") return void res.writeHead(404).end();
    const loggedIn = /(^|;\s*)sid=secret-cookie-value/.test(req.headers.cookie ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end(loggedIn ? "<h1>Dashboard</h1>" : '<form><input type="password" name="pass"></form>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const id of created) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

const newProject = () => {
  const id = createProject(getDb(), { url: `${base}/`, mode: "single", config: { delayMs: 0 } });
  created.push(id);
  return id;
};
const post = (route: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }, id: string, body?: unknown) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = text ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : undefined;
  return route.POST(new Request("http://127.0.0.1", { method: "POST", body: text, headers }), { params: Promise.resolve({ id }) });
};
const state = { cookies: [{ name: "sid", value: "secret-cookie-value", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] as unknown[] };

test("import: a storageState (session cookie + localStorage) lands in the persistent profile; the crawl is logged in", async () => {
  const id = newProject();
  const res = await post(importRoute, id, { storageState: { ...state, origins: [{ origin: base, localStorage: [{ name: "theme", value: "dark" }] }] } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: true, cookies: 1, origins: 1 });
  expect(text).not.toContain("secret-cookie-value");
  expect(await discoverPages(getDb(), id)).toEqual([{ url: `${base}/`, needsAuth: false }]);

  const ctx = await chromium.launchPersistentContext(join(config.workspaceRoot, id, "profile"), { headless: true });
  try {
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");
  } finally {
    await ctx.close();
  }
});

test("clear: removes the profile, the next crawl is logged out", async () => {
  const id = newProject();
  expect((await post(importRoute, id, { storageState: state })).status).toBe(200);
  expect(await discoverPages(getDb(), id)).toEqual([{ url: `${base}/`, needsAuth: false }]);
  expect((await post(clear, id)).status).toBe(200);
  expect(existsSync(join(config.workspaceRoot, id, "profile"))).toBe(false);
  expect(await discoverPages(getDb(), id)).toEqual([{ url: `${base}/`, needsAuth: true }]);
});

test("import: invalid JSON shapes are 400; a second import while one runs is 409 PROJECT_BUSY", async () => {
  const id = newProject();
  expect((await post(importRoute, id, { storageState: { cookies: [{ name: "x", value: "y" }] } })).status).toBe(400); // no url/domain
  expect((await post(importRoute, id, { storageState: { origins: [{ origin: "javascript:alert(1)" }] } })).status).toBe(400);
  expect((await post(importRoute, id, { cookies: [] })).status).toBe(400);
  const [a, b] = await Promise.all([post(importRoute, id, { storageState: state }), post(importRoute, id, { storageState: state })]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect((await post(clear, "no-such-project")).status).toBe(404);
});
