import { afterAll, expect, test } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { config } from "@/core/config";
import { createProject, startProject, type JobDeps } from "@/core/jobs";
import { emit } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import * as providers from "@/app/api/providers/route";
import * as providerTest from "@/app/api/providers/test/route";
import * as projects from "@/app/api/projects/route";
import * as project from "@/app/api/projects/[id]/route";
import * as start from "@/app/api/projects/[id]/start/route";
import * as crawl from "@/app/api/projects/[id]/crawl/route";
import * as events from "@/app/api/projects/[id]/events/route";
import * as files from "@/app/api/projects/[id]/files/[...path]/route";
import * as exportRoute from "@/app/api/projects/[id]/export/route";
import * as preview from "@/app/api/projects/[id]/preview/route";

const created: string[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of [...created.map((id) => join(config.workspaceRoot, id)), ...tmpDirs]) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

// In-process Requests carry no Content-Length unless set; real clients always send it (the CSRF guard relies on it).
const jsonHeaders = (body: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "content-length": String(Buffer.byteLength(body)),
  ...extra,
});
const post = (body: unknown, signal?: AbortSignal) => {
  const text = JSON.stringify(body);
  return new Request("http://x/api", { method: "POST", body: text, headers: jsonHeaders(text), signal });
};
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const uniqueUrl = () => `https://example.com/${crypto.randomUUID()}`;

async function newProject(url = uniqueUrl()): Promise<string> {
  const res = await projects.POST(post({ url, mode: "single", config: {} }));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  created.push(id);
  return id;
}

test("POST /api/projects returns an id; GET /api/projects lists it", async () => {
  const url = uniqueUrl();
  const id = await newProject(url);
  const res = await projects.GET(new Request(`http://x/api/projects?group=incomplete&q=${encodeURIComponent(url)}&page=1`));
  const body = (await res.json()) as { total: number; projects: { id: string; url: string; status: string }[] };
  expect(res.status).toBe(200);
  expect(body.total).toBe(1);
  expect(body.projects[0]).toMatchObject({ id, url, status: "draft" });
  const completed = (await (await projects.GET(new Request(`http://x/api/projects?group=completed&q=${encodeURIComponent(url)}`))).json()) as { total: number };
  expect(completed.total).toBe(0);
});

test("POST /api/projects rejects an invalid body with 400 and never stores credentials in plaintext", async () => {
  expect((await projects.POST(post({ url: "ftp://x", mode: "single", config: {} }))).status).toBe(400);
  const res = await projects.POST(post({ url: uniqueUrl(), mode: "single", config: { auth: { mode: "auto" } }, credentials: { user: "u", pass: "hunter2-secret", remember: true } }));
  const { id } = (await res.json()) as { id: string };
  created.push(id);
  const row = getDb().prepare("SELECT * FROM projects WHERE id=?").get(id) as Record<string, unknown>;
  expect(typeof row.auth_enc).toBe("string");
  expect(JSON.stringify(row)).not.toContain("hunter2-secret");
  const list = await (await projects.GET(new Request("http://x/api/projects"))).text();
  expect(list).not.toContain("hunter2-secret");
  expect(list).not.toContain(row.auth_enc as string);
});

test("providers: GET masks the key; /test decrypts it server-side and counts models", async () => {
  let seen: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const apiKey = "sk-plaintext-key-9876abcd";
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const res = await providers.POST(post({ name: "local", kind: "openai", baseUrl, apiKey, roles: { vision: "m1" } }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const text = await (await providers.GET(new Request("http://x/api/providers"))).text();
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain("api_key_enc");
    const mine = (JSON.parse(text) as { providers: { id: string; apiKey: string }[] }).providers.find((p) => p.id === id);
    expect(mine?.apiKey).toBe("sk-…abcd");

    const t = await providerTest.POST(post({ providerId: id }));
    expect(await t.json()).toEqual({ ok: true, models: 2 });
    expect(seen.authorization).toBe(`Bearer ${apiKey}`);
    getDb().prepare("DELETE FROM providers WHERE id=?").run(id);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("files route serves only allowlisted workspace dirs and rejects traversal", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(join(ws, "out"), { recursive: true });
  await mkdir(join(ws, "pages", "home", "shots"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "<p>hi</p>");
  await writeFile(join(ws, "pages", "home", "capture.json"), "{}");
  await writeFile(join(ws, "pages", "home", "shots", "375.png"), "png");

  const ok = await files.GET(new Request("http://x"), ctx({ id, path: ["out", "index.html"] }));
  expect(ok.status).toBe(200);
  const csp = "default-src 'self' data: blob: http: https:; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  expect(ok.headers.get("content-security-policy")).toBe(csp);
  expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  const missing = await files.GET(new Request("http://x"), ctx({ id, path: ["out", "nope.html"] }));
  expect(missing.headers.get("content-security-policy")).toBe(csp);
  expect(ok.headers.get("content-type")).toContain("text/html");
  expect(await ok.text()).toBe("<p>hi</p>");
  expect((await files.GET(new Request("http://x"), ctx({ id, path: ["pages", "home", "shots", "375.png"] }))).status).toBe(200);
  expect((await files.GET(new Request("http://x"), ctx({ id, path: ["pages", "home", "capture.json"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://x"), ctx({ id, path: ["out", "..", "pages", "home", "capture.json"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://x"), ctx({ id, path: ["out", "..", "..", "..", "secret.key"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://x"), ctx({ id, path: ["out", "missing.html"] }))).status).toBe(404);
});

// Tiny zip reader: walks the central directory and inflates each entry via its local header.
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const local = buf.readUInt32LE(p + 42);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = inflateRawSync(buf.subarray(dataAt, dataAt + csize)).toString("utf8");
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test("export: zip streams out/ as a valid zip; folder refuses the workspace and copies elsewhere", async () => {
  const id = await newProject();
  const out = join(config.workspaceRoot, id, "out");
  await mkdir(join(out, "assets"), { recursive: true });
  await writeFile(join(out, "index.html"), "<h1>clone</h1>".repeat(50));
  await writeFile(join(out, "assets", "a.css"), "body{}");

  const res = await exportRoute.POST(post({ mode: "zip" }), ctx({ id }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  const zip = Buffer.from(await res.arrayBuffer());
  expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(unzip(zip)).toEqual({ "assets/a.css": "body{}", "index.html": "<h1>clone</h1>".repeat(50) });

  expect((await exportRoute.POST(post({ mode: "folder", dest: join(config.workspaceRoot, "x") }), ctx({ id }))).status).toBe(400);
  expect((await exportRoute.POST(post({ mode: "folder", dest: "relative/dir" }), ctx({ id }))).status).toBe(400);
  const dest = join(await mkdtemp(join(tmpdir(), "sp1-export-")), "site");
  tmpDirs.push(dest);
  expect((await exportRoute.POST(post({ mode: "folder", dest }), ctx({ id }))).status).toBe(200);
  expect(await readFile(join(dest, "assets", "a.css"), "utf8")).toBe("body{}");
});

test("preview returns pages with emitted file names, qa scores and coverage", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "ir.json"), JSON.stringify({ pages: [{ id: "home", path: "/" }, { id: "about", path: "/about" }] }));
  await writeFile(join(ws, "qa.json"), JSON.stringify([{ pageId: "home", sectionId: "s1", bp: 375, score: 0.9 }]));
  const body = (await (await preview.GET(new Request("http://x"), ctx({ id }))).json()) as { pages: unknown[]; scores: unknown[]; coverage: unknown[] };
  expect(body.pages).toEqual([{ pageId: "home", path: "/", file: "index.html" }, { pageId: "about", path: "/about", file: "about.html" }]);
  expect(body.scores).toHaveLength(1);
  expect(body.coverage).toEqual([]);
});

test("DELETE removes the rows and the workspace; unknown id is 404", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(join(ws, "out"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "x");
  const res = await project.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id }));
  expect(res.status).toBe(200);
  expect(existsSync(ws)).toBe(false);
  expect(getDb().prepare("SELECT id FROM projects WHERE id=?").get(id)).toBeUndefined();
  expect((await project.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id }))).status).toBe(404);
});

test("SSE streams the current status, then job events, and closes on abort", async () => {
  const id = await newProject();
  const ac = new AbortController();
  const res = await events.GET(new Request("http://x", { signal: ac.signal }), ctx({ id }));
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  expect(dec.decode((await reader.read()).value)).toBe(`data: ${JSON.stringify({ type: "status", status: "draft" })}\n\n`);
  emit(id, { type: "log", level: "info", message: "hello" });
  expect(dec.decode((await reader.read()).value)).toBe(`data: ${JSON.stringify({ type: "log", level: "info", message: "hello" })}\n\n`);
  ac.abort();
  expect((await reader.read()).done).toBe(true);
  emit(id, { type: "log", level: "info", message: "after close" }); // must not throw into the job
});

test("start maps a full queue to 429 QUEUE_FULL", async () => {
  const db = getDb();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deps: JobDeps = {
    openBrowser: async () => {
      await gate;
      throw new Error("released by test");
    },
  };
  const fillers = Array.from({ length: 6 }, () => createProject(db, { url: uniqueUrl(), mode: "single", config: {} }));
  created.push(...fillers);
  for (const f of fillers) startProject(db, f, { deps }); // 1 active (blocked) + 5 waiting

  const id = await newProject();
  const res = await start.POST(post({ pages: [uniqueUrl()] }), ctx({ id }));
  expect(res.status).toBe(429);
  expect(((await res.json()) as { code: string }).code).toBe("QUEUE_FULL");

  // a waiting (still draft) project can't be re-started: 409 before its page selection is rewritten
  const again = await start.POST(post({ pages: [uniqueUrl()] }), ctx({ id: fillers[1]! }));
  expect(again.status).toBe(409);
  expect(((await again.json()) as { code: string }).code).toBe("PROJECT_BUSY");
  expect(existsSync(join(config.workspaceRoot, fillers[1]!, "pages.json"))).toBe(false);

  release();
  const statusOf = (p: string) => (db.prepare("SELECT status FROM projects WHERE id=?").get(p) as { status: string }).status;
  await expect.poll(() => fillers.every((f) => statusOf(f) === "failed"), { timeout: 10_000 }).toBe(true);
});

test("CSRF guard: foreign Origin and non-JSON bodies are refused; same-origin JSON passes", async () => {
  const body = JSON.stringify({ url: uniqueUrl(), mode: "single", config: {} });
  const foreign = await projects.POST(new Request("http://x/api/projects", { method: "POST", body, headers: jsonHeaders(body, { origin: "http://evil.test" }) }));
  expect(foreign.status).toBe(403);
  const opaque = await projects.POST(new Request("http://x/api/projects", { method: "POST", body, headers: jsonHeaders(body, { origin: "null" }) }));
  expect(opaque.status).toBe(403);
  const plain = await projects.POST(new Request("http://x/api/projects", { method: "POST", body, headers: jsonHeaders(body, { "content-type": "text/plain" }) }));
  expect(plain.status).toBe(403);
  const same = await projects.POST(new Request("http://x/api/projects", { method: "POST", body, headers: jsonHeaders(body, { "content-type": "application/json; charset=utf-8", origin: "http://x" }) }));
  expect(same.status).toBe(201);
  const { id } = (await same.json()) as { id: string };
  created.push(id);
  // bodiless mutations need no content-type but are still Origin-checked
  expect((await project.DELETE(new Request("http://x", { method: "DELETE", headers: { origin: "http://evil.test" } }), ctx({ id }))).status).toBe(403);
  expect((await project.DELETE(new Request("http://x", { method: "DELETE", headers: { origin: "http://x" } }), ctx({ id }))).status).toBe(200);
});

test("a project is busy while its crawl runs: DELETE -> 409 PROJECT_BUSY", async () => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const firstHit = new Promise<void>((r) => (hit = r));
  const server = createServer((req, res) => {
    hit();
    void released.then(() =>
      req.url === "/robots.txt" ? res.writeHead(404).end() : res.writeHead(200, { "content-type": "text/html" }).end("<p>home</p>"),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const id = await newProject(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const crawling = crawl.POST(new Request("http://x", { method: "POST" }), ctx({ id }));
    await firstHit;
    const del = await project.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id }));
    expect(del.status).toBe(409);
    expect(((await del.json()) as { code: string }).code).toBe("PROJECT_BUSY");
    release();
    expect((await crawling).status).toBe(200);
    expect((await project.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id }))).status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
