import { afterAll, expect, test, vi } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { config } from "@/core/config";
import { emitHtml } from "@/core/emit-html";
import { buildIR } from "@/core/ir";
import { createProject, enqueue, isQueuedOrActive, startProject, type JobDeps } from "@/core/jobs";
import type { BrowserHandle } from "@/core/browser";
import { emit } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { n, siteOf, t } from "./component-site";
import * as providers from "@/app/api/providers/route";
import * as providerTest from "@/app/api/providers/test/route";
import * as providerModels from "@/app/api/providers/models/route";
import * as providerOne from "@/app/api/providers/[id]/route";
import * as projects from "@/app/api/projects/route";
import * as project from "@/app/api/projects/[id]/route";
import * as start from "@/app/api/projects/[id]/start/route";
import * as crawl from "@/app/api/projects/[id]/crawl/route";
import * as authOpen from "@/app/api/projects/[id]/auth/open/route";
import * as events from "@/app/api/projects/[id]/events/route";
import * as files from "@/app/api/projects/[id]/files/[...path]/route";
import * as exportRoute from "@/app/api/projects/[id]/export/route";
import * as preview from "@/app/api/projects/[id]/preview/route";
import * as runLog from "@/app/api/projects/[id]/log/route";

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
  return new Request("http://127.0.0.1/api", { method: "POST", body: text, headers: jsonHeaders(text), signal });
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
  const res = await projects.GET(new Request(`http://127.0.0.1/api/projects?group=incomplete&q=${encodeURIComponent(url)}&page=1`));
  const body = (await res.json()) as { total: number; projects: { id: string; url: string; status: string }[] };
  expect(res.status).toBe(200);
  expect(body.total).toBe(1);
  expect(body.projects[0]).toMatchObject({ id, url, status: "draft", statusReason: null });
  const completed = (await (await projects.GET(new Request(`http://127.0.0.1/api/projects?group=completed&q=${encodeURIComponent(url)}`))).json()) as { total: number };
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
  const list = await (await projects.GET(new Request("http://127.0.0.1/api/projects"))).text();
  expect(list).not.toContain("hunter2-secret");
  expect(list).not.toContain(row.auth_enc as string);
});

test("needsCredentials (list): auto mode without held/remembered creds or after LOGIN_FAILED; not once logged in or in other modes", async () => {
  const make = async (config: unknown, credentials?: unknown) => {
    const url = uniqueUrl();
    const res = await projects.POST(post({ url, mode: "single", config, ...(credentials ? { credentials } : {}) }));
    const { id } = (await res.json()) as { id: string };
    created.push(id);
    return { id, url };
  };
  const flag = async (p: { url: string }) =>
    ((await (await projects.GET(new Request(`http://127.0.0.1/api/projects?q=${encodeURIComponent(p.url)}`))).json()) as { projects: { needsCredentials: boolean }[] }).projects[0]!
      .needsCredentials;
  const bare = await make({ auth: { mode: "auto" } });
  const held = await make({ auth: { mode: "auto" } }, { user: "u", pass: "p", remember: true });
  const manual = await make({ auth: { mode: "manual" } });
  expect([await flag(bare), await flag(held), await flag(manual)]).toEqual([true, false, false]);

  const db = getDb();
  const login = (id: string, status: string, code: string | null) =>
    db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code) VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), id, "login", "k", status, code);
  login(held.id, "failed", "LOGIN_FAILED"); // a wrong password is never retried: ask even though creds are remembered
  login(bare.id, "done", null); // the session lives in the profile: nothing to ask
  expect([await flag(bare), await flag(held)]).toEqual([false, true]);
});

test("GET /api/projects: counts (q, not group), pageCount, phaseDone/phaseTotal, lastError — fixed queries, no N+1", async () => {
  const db = getDb();
  const prefix = `https://list.test/${crypto.randomUUID()}/`;
  type T = [phase: string, key: string, status: string, code: string | null, msg: string | null];
  const mk = (suffix: string, status: string, tasks: T[]) => {
    const id = crypto.randomUUID();
    created.push(id);
    db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)").run(id, prefix + suffix, "single", "{}", status);
    for (const [phase, key, st, code, msg] of tasks)
      db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code,error_msg) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, phase, key, st, code, msg);
    return id;
  };
  const failed = mk("failed", "failed", [
    ["discover", prefix, "done", null, null],
    ["capture", "a", "done", null, null],
    ["capture", "b", "failed", "NAV_TIMEOUT", "timeout 30000ms"],
    ["ir", "all", "pending", null, null],
  ]);
  const auth = mk("auth", "needs_auth", [["capture", "home", "needs_auth", "AUTH_REQUIRED", "login wall at /home"]]);
  const draft = mk("draft", "draft", [["discover", prefix, "done", null, null]]);
  mk("done", "completed", [["capture", "home", "done", null, null]]);

  const spy = vi.spyOn(db, "prepare");
  type Body = { counts: { incomplete: number; completed: number }; total: number; projects: Record<string, unknown>[] };
  let body: Body;
  let sqls: string[];
  try {
    body = (await (await projects.GET(new Request(`http://127.0.0.1/api/projects?group=incomplete&q=${encodeURIComponent(prefix)}`))).json()) as Body;
    sqls = spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
  expect(body.counts).toEqual({ incomplete: 3, completed: 1 });
  expect(body.total).toBe(3);
  const row = (id: string) => body.projects.find((p) => p.id === id);
  expect(row(failed)).toMatchObject({ phase: "capture", pageCount: 2, phaseDone: 1, phaseTotal: 2, lastError: { code: "NAV_TIMEOUT", message: "timeout 30000ms", phase: "capture", key: "b" } });
  expect(row(auth)).toMatchObject({ pageCount: 1, lastError: { code: "AUTH_REQUIRED", message: "login wall at /home", phase: "capture", key: "home" } });
  expect(row(draft)).toMatchObject({ pageCount: null, phaseDone: null, phaseTotal: null, lastError: null });
  const count = (re: RegExp) => sqls.filter((s) => re.test(s)).length;
  expect([count(/GROUP BY project_id, phase/), count(/ROW_NUMBER\(\)/), count(/SUM\(status<>'completed'\)/)]).toEqual([1, 1, 1]);
  // spec §4.7: 4 fixed queries — counts, rows, agg, lastError; `total` is derived from `counts` + `group`
  expect(sqls).toHaveLength(4);
  // no per-row query: each row's needsCredentials/lastError/pageCount comes from the fixed set of queries above,
  // never a query keyed by that row's own id
  expect(sqls.filter((s) => /WHERE id=\?/.test(s) || /WHERE project_id=\?( |$)/.test(s))).toEqual([]);
});

test("GET /api/projects: query count stays constant regardless of row count (no N+1)", async () => {
  const db = getDb();
  const queryCountFor = async (n: number) => {
    const prefix = `https://qcount.test/${crypto.randomUUID()}/`;
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      created.push(id);
      db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)").run(id, `${prefix}${i}`, "single", "{}", "draft");
    }
    const spy = vi.spyOn(db, "prepare");
    try {
      const body = (await (await projects.GET(new Request(`http://127.0.0.1/api/projects?q=${encodeURIComponent(prefix)}`))).json()) as { total: number };
      expect(body.total).toBe(n);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };
  expect(await queryCountFor(1)).toBe(await queryCountFor(20));
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
    const text = await (await providers.GET(new Request("http://127.0.0.1/api/providers"))).text();
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain("api_key_enc");
    const mine = (JSON.parse(text) as { providers: { id: string; apiKey: string }[] }).providers.find((p) => p.id === id);
    expect(mine?.apiKey).toBe("sk-…abcd");

    const t = await providerTest.POST(post({ providerId: id }));
    const tested = (await t.json()) as { ok: boolean; models: number; latencyMs: number; httpStatus: number };
    expect(tested).toMatchObject({ ok: true, models: 2, httpStatus: 200 });
    expect(tested.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen.authorization).toBe(`Bearer ${apiKey}`);
    // D7: an unsaved form (Test before Save) works the same, with the typed values
    const unsaved = (await (await providerTest.POST(post({ kind: "openai", baseUrl, apiKey: "sk-unsaved-key-5555" }))).json()) as { models: number; httpStatus: number };
    expect(unsaved).toMatchObject({ models: 2, httpStatus: 200 });
    expect(seen.authorization).toBe("Bearer sk-unsaved-key-5555");
    getDb().prepare("DELETE FROM providers WHERE id=?").run(id);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("providers/test (P27): a saved provider tested with an edited, unsaved baseUrl — the override is called with the stored key, never echoed", async () => {
  const hits: { url: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const apiKey = "sk-stored-key-override-4242";
  let id = "";
  try {
    id = ((await (await providers.POST(post({ name: "p27", kind: "openai", baseUrl: `${origin}/saved/v1`, apiKey, roles: {} }))).json()) as { id: string }).id;
    const res = await providerTest.POST(post({ providerId: id, kind: "openai", baseUrl: `${origin}/edited/v1/` }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, models: 1, httpStatus: 200 });
    expect(text).not.toContain(apiKey);
    expect(hits).toEqual([{ url: "/edited/v1/models", auth: `Bearer ${apiKey}` }]);
    // the models route takes the same body
    const models = (await (await providerModels.POST(post({ providerId: id, baseUrl: `${origin}/edited/v1` }))).json()) as { models: string[] };
    expect(models.models).toEqual(["m1"]);
    expect(hits.at(-1)?.url).toBe("/edited/v1/models");
    // a saved provider's body still rejects a typed key alongside the id, and a bad override URL is a 400
    expect((await providerTest.POST(post({ providerId: id, apiKey: "sk-x" }))).status).toBe(400);
    expect((await providerTest.POST(post({ providerId: id, baseUrl: "ftp://nope" }))).status).toBe(400);
  } finally {
    if (id) getDb().prepare("DELETE FROM providers WHERE id=?").run(id);
    await new Promise((r) => server.close(r));
  }
});

test("providers/test: an upstream 401 is 502 AI_AUTH with the status in the message; no key in the response", async () => {
  const server = createServer((_req, res) => res.writeHead(401).end("nope"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const res = await providerTest.POST(post({ kind: "anthropic", baseUrl, apiKey: "sk-denied-key-7777" }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "AI_AUTH" });
    expect(text).toContain("401");
    expect(text).not.toContain("sk-denied-key-7777");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'";

test("providers: PATCH edits fields (a new key re-encrypted, an omitted key kept), DELETE removes; unknown id 404", async () => {
  const created = await providers.POST(post({ name: "p", kind: "openai", baseUrl: "https://o.test/v1", apiKey: "sk-original-key-1234", roles: { code: "m1" } }));
  const { id } = (await created.json()) as { id: string };
  const one = async () =>
    ((await (await providers.GET(new Request("http://127.0.0.1/api/providers"))).json()) as { providers: { id: string; name: string; baseUrl: string; apiKey: string; roles: Record<string, string> }[] }).providers.find((p) => p.id === id);
  const patch = (body: unknown, target = id) => {
    const text = JSON.stringify(body);
    return providerOne.PATCH(new Request("http://127.0.0.1", { method: "PATCH", body: text, headers: jsonHeaders(text) }), ctx({ id: target }));
  };

  expect((await patch({ name: "renamed", baseUrl: "https://n.test/v1/", roles: { vision: "v1" } })).status).toBe(200);
  expect(await one()).toMatchObject({ name: "renamed", baseUrl: "https://n.test/v1", apiKey: "sk-…1234", roles: { vision: "v1" } });
  expect((await patch({ apiKey: "sk-replaced-key-9999" })).status).toBe(200);
  expect((await one())?.apiKey).toBe("sk-…9999");
  const row = getDb().prepare("SELECT * FROM providers WHERE id=?").get(id) as Record<string, unknown>;
  expect(JSON.stringify(row)).not.toContain("sk-replaced-key-9999");
  expect((await patch({ kind: "anthropic" })).status).toBe(400); // kind is fixed
  expect((await patch({ name: "x" }, "missing")).status).toBe(404);

  const del = () => providerOne.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }));
  expect((await del()).status).toBe(200);
  expect(await one()).toBeUndefined();
  expect((await del()).status).toBe(404);
});

test("files route: assets and SVG are sandboxed, unknown downloads (.bin) are attachments, pages pin script-src to the runtime", async () => {
  const id = await newProject();
  const assets = join(config.workspaceRoot, id, "out", "assets");
  await mkdir(assets, { recursive: true });
  const sha = "c".repeat(64);
  await writeFile(join(assets, `${sha}.bin`), "<script>alert(1)</script>");
  await writeFile(join(assets, `${sha}.svg`), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await writeFile(join(assets, `${sha}.png`), "png");
  await writeFile(join(config.workspaceRoot, id, "out", "index.html"), `<script src="assets/${sha}.js"></script>`);
  const get = (...path: string[]) => files.GET(new Request("http://127.0.0.1:3107", { headers: { host: "localhost:3107" } }), ctx({ id, path }));

  const bin = await get("out", "assets", `${sha}.bin`);
  expect(bin.headers.get("content-type")).toBe("application/octet-stream");
  expect(bin.headers.get("content-disposition")).toBe("attachment");
  expect(bin.headers.get("content-security-policy")).toBe(FILE_CSP);
  for (const ext of ["svg", "png"]) {
    const res = await get("out", "assets", `${sha}.${ext}`);
    expect(res.headers.get("content-security-policy")).toBe(FILE_CSP);
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect((await get("out", "assets", `${sha}.svg`)).headers.get("content-type")).toBe("image/svg+xml");

  // the page's only script source is the exact runtime URL on the request's host: assets/<sha>.js can't match it
  const page = (await get("out", "index.html")).headers.get("content-security-policy")!;
  const scriptSrc = page.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  expect(scriptSrc).toBe(`script-src http://localhost:3107/api/projects/${id}/files/out/js/runtime.js`);
  expect(page).not.toContain("'self'; object-src"); // no 'self' in script-src
});

test("files route serves only allowlisted workspace dirs and rejects traversal", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(join(ws, "out"), { recursive: true });
  await mkdir(join(ws, "pages", "home", "shots"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "<p>hi</p>");
  await writeFile(join(ws, "pages", "home", "capture.json"), "{}");
  await writeFile(join(ws, "pages", "home", "shots", "375.png"), "png");
  await writeFile(join(ws, "events.jsonl"), "{}\n");
  await writeFile(join(ws, "events.prev.jsonl"), "{}\n");
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["events.jsonl"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["events.prev.jsonl"] }))).status).toBe(404);

  const ok = await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["out", "index.html"] }));
  expect(ok.status).toBe(200);
  const runtime = `http://127.0.0.1/api/projects/${id}/files/out/js/runtime.js`;
  const csp = `default-src 'self' data: blob: http: https:; script-src ${runtime}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
  expect(ok.headers.get("content-security-policy")).toBe(csp);
  expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  const missing = await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["out", "nope.html"] }));
  expect(missing.headers.get("content-security-policy")).toBe(csp);
  expect(ok.headers.get("content-type")).toContain("text/html");
  expect(await ok.text()).toBe("<p>hi</p>");
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["pages", "home", "shots", "375.png"] }))).status).toBe(200);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["pages", "home", "capture.json"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["out", "..", "pages", "home", "capture.json"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["out", "..", "..", "..", "secret.key"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["out", "missing.html"] }))).status).toBe(404);
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
  await writeFile(join(config.workspaceRoot, id, "events.jsonl"), "{}\n");

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
  // the body goes through the capped reader: an oversized one is refused before it is parsed
  const huge = await exportRoute.POST(post({ mode: "folder", dest: "x".repeat(4000), pad: "x".repeat(1_100_000) }), ctx({ id }));
  expect([huge.status, ((await huge.json()) as { code: string }).code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
});

test("export: the zip stream holds the busy guard until read to the end; stripIds re-emits without data-ir-id", async () => {
  const db = getDb();
  const id = await newProject("http://x.test/");
  const ws = join(config.workspaceRoot, id);
  const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
  const dom = el("html", [el("head"), el("body", [el("main", [el("h1", [el("#text", [], "Hello")])])])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  const ir = buildIR([capture]);
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "pages.json"), JSON.stringify([{ pageId: "home", url: "http://x.test/" }]));
  await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,output_path) VALUES(?,?,'capture','home','done','pages/home/capture.json')").run(crypto.randomUUID(), id);
  await emitHtml(ir, { assetMap: {}, pageUrls: { home: "http://x.test/" }, outDir: join(ws, "out"), workspaceDir: ws });

  const res = await exportRoute.POST(post({ mode: "zip" }), ctx({ id }));
  expect(res.status).toBe(200);
  const del = () => project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }));
  expect((await del()).status).toBe(409); // mid-stream: nothing may wipe out/
  expect(unzip(Buffer.from(await res.arrayBuffer()))["index.html"]).toContain("data-ir-id");

  const stripped = unzip(Buffer.from(await (await exportRoute.POST(post({ mode: "zip", stripIds: true }), ctx({ id }))).arrayBuffer()));
  expect(stripped["index.html"]).toContain("Hello");
  expect(stripped["index.html"]).not.toContain("data-ir-id");
  expect(Object.keys(stripped).sort()).toEqual(["css/styles.css", "index.html", "js/runtime.js"]);
  const dest = join(await mkdtemp(join(tmpdir(), "sp1-export-")), "site");
  tmpDirs.push(dest);
  expect((await exportRoute.POST(post({ mode: "folder", dest, stripIds: true }), ctx({ id }))).status).toBe(200);
  expect(await readFile(join(dest, "index.html"), "utf8")).not.toContain("data-ir-id");
  expect((await readdir(ws)).filter((f) => f.startsWith("export-"))).toEqual([]); // temp emit removed
  expect((await del()).status).toBe(200); // the finished stream released the guard
});

test("preview returns pages with emitted file names, qa scores and coverage", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(ws, { recursive: true });
  const el = (tag: string, children: CaptureNode[] = []): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children });
  const dom = el("html", [el("head"), el("body", [el("main")])]);
  const cap = (pageId: string, url: string) => ({
    url, pageId, capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  }) as PageCapture;
  await writeFile(join(ws, "pages.json"), JSON.stringify([{ pageId: "home", url: "http://x.test/" }, { pageId: "about", url: "http://x.test/about" }]));
  // a v2 checkpoint read through the loader (never adopted)
  await writeFile(join(ws, "ir.json"), JSON.stringify(buildIR([cap("home", "http://x.test/"), cap("about", "http://x.test/about")])));
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [{ pageId: "home", sectionId: "s1", bp: 375, score: 0.9 }], stale: true }));
  getDb().prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code,error_msg) VALUES(?,?,'fix','home:s1','done','BUDGET_EXCEEDED','token budget spent')").run(crypto.randomUUID(), id);
  const body = (await (await preview.GET(new Request("http://127.0.0.1"), ctx({ id }))).json()) as { pages: unknown[]; scores: unknown[]; stale: boolean; coverage: unknown[]; fixes: unknown[]; fidelity: unknown[] };
  expect(body.pages).toEqual([{ pageId: "home", path: "/", file: "index.html" }, { pageId: "about", path: "/about", file: "about.html" }]);
  expect(body.scores).toHaveLength(1);
  expect(body.stale).toBe(true);
  expect(body.coverage).toEqual([]);
  expect(body.fixes).toEqual([{ pageId: "home", sectionId: "s1", status: "done", errorCode: "BUDGET_EXCEEDED", errorMsg: "token budget spent" }]);
  expect(Array.isArray(body.fidelity)).toBe(true);
  expect(getDb().prepare("SELECT 1 FROM document_state WHERE project_id=?").get(id)).toBeUndefined();
  // an ir.json the loader refuses: said in the Fidelity list instead of failing the preview (no v1 cast of the raw file)
  await writeFile(join(ws, "ir.json"), JSON.stringify({ pages: [{ id: "home", path: "/" }] }));
  const refused = (await (await preview.GET(new Request("http://127.0.0.1"), ctx({ id }))).json()) as typeof body;
  expect(refused.pages).toEqual([]);
  expect(refused.scores).toHaveLength(1);
  expect(refused.fidelity).toEqual([expect.objectContaining({ feature: "fidelity-unavailable", status: "partial" })]);
});

test("preview: behaviour QA from a fresh qa.json upgrades the component's Fidelity item at read time; stale -> none (R5)", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(ws, { recursive: true });
  const tabs = n("tabs", "section", [n("t0", "button", [t("a", "1")]), n("t1", "button", [t("b", "2")]), n("p0", "div", [t("c", "one")]), n("p1", "div", [t("d", "two")])],
    { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t0", panel: "p0" }, { trigger: "t1", panel: "p1" }], active: 0 } });
  await writeFile(join(ws, "pages.json"), JSON.stringify([{ pageId: "home", url: "http://x.test/" }]));
  await writeFile(join(ws, "ir.json"), JSON.stringify(siteOf(tabs)));
  const behavior = [{ pageId: "home", nodeId: "tabs", kind: "tabs", ok: true }];
  type Body = { behavior: unknown[]; fidelity: { feature: string; nodeId?: string; status: string }[] };
  const read = async () => (await (await preview.GET(new Request("http://127.0.0.1"), ctx({ id }))).json()) as Body;
  const item = (b: Body) => b.fidelity.find((x) => x.feature === "component" && x.nodeId === "tabs");
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [], behavior }));
  const fresh = await read();
  expect(fresh.behavior).toEqual(behavior);
  expect(item(fresh)?.status).toBe("supported");
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [], behavior, stale: true }));
  const stale = await read();
  expect(stale.behavior).toEqual([]);
  expect(item(stale)?.status).toBe("partial"); // guessed: back to its own status
});

test("DELETE removes the rows and the workspace; unknown id is 404", async () => {
  const id = await newProject();
  const ws = join(config.workspaceRoot, id);
  await mkdir(join(ws, "out"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "x");
  // the document store's rows go with the project (no orphan state/history for a reused id)
  getDb().prepare("INSERT INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES(?,'{}',1,1,1)").run(id);
  getDb().prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES(?,1,'[]','[]','user')").run(id);
  const res = await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }));
  expect(res.status).toBe(200);
  expect(existsSync(ws)).toBe(false);
  expect(getDb().prepare("SELECT id FROM projects WHERE id=?").get(id)).toBeUndefined();
  for (const table of ["document_state", "document_history"]) expect(getDb().prepare(`SELECT 1 FROM ${table} WHERE project_id=?`).get(id)).toBeUndefined();
  expect((await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }))).status).toBe(404);
});

test("GET log: run.prev.log + run.log as a text/plain attachment; empty log 200; unknown id 404; non-loopback 403", async () => {
  const id = await newProject();
  const get = (pid: string, headers?: Record<string, string>) => runLog.GET(new Request("http://127.0.0.1/api", { headers }), ctx({ id: pid }));
  const empty = await get(id);
  expect([empty.status, await empty.text()]).toEqual([200, ""]);
  await writeFile(join(config.workspaceRoot, id, "run.prev.log"), "old line\n");
  emit(id, { type: "log", level: "info", message: "fresh line" });
  const res = await get(id);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="run-${id.slice(0, 8)}.log"`);
  expect(await res.text()).toMatch(/^old line\n\S+ INFO \[job\] fresh line\n$/);
  expect((await get(crypto.randomUUID())).status).toBe(404);
  expect((await get(id, { host: "evil.test:3000" })).status).toBe(403);
});

test("SSE: persisted history first, then the current status, then live stamped events; closes on abort; replayed next time", async () => {
  const id = await newProject();
  const open = async () => {
    const ac = new AbortController();
    const res = await events.GET(new Request("http://127.0.0.1", { signal: ac.signal }), ctx({ id }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const next = async () => JSON.parse(dec.decode((await reader.read()).value).replace(/^data: /, "")) as Record<string, unknown>;
    return { ac, reader, next };
  };
  const first = await open();
  expect(await first.next()).toEqual({ type: "history", events: [] });
  expect(await first.next()).toEqual({ type: "status", status: "draft", queued: false, at: expect.any(Number) });
  emit(id, { type: "log", level: "info", message: "hello" });
  expect(await first.next()).toEqual({ type: "log", level: "info", message: "hello", at: expect.any(Number) });
  first.ac.abort();
  expect((await first.reader.read()).done).toBe(true);
  emit(id, { type: "log", level: "info", message: "after close" }); // must not throw into the job

  const second = await open();
  const replay = (await second.next()) as { type: string; events: { message: string }[] };
  expect(replay.type).toBe("history");
  expect(replay.events.map((e) => e.message)).toEqual(["hello", "after close"]);
  second.ac.abort();

  // the persisted status_reason rides on the snapshot, so the progress banner survives a reload / reconnect
  getDb().prepare("UPDATE projects SET status='completed',status_reason='AI_QUOTA' WHERE id=?").run(id);
  const third = await open();
  await third.next();
  expect(await third.next()).toEqual({ type: "status", status: "completed", reason: "AI_QUOTA", queued: false, at: expect.any(Number) });
  third.ac.abort();
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
  expect(existsSync(join(config.workspaceRoot, id, "pages.json"))).toBe(false); // refused before enqueue

  // a waiting (still draft) project can't be re-started: 409 before its page selection is rewritten
  const again = await start.POST(post({ pages: [uniqueUrl()] }), ctx({ id: fillers[1]! }));
  expect(again.status).toBe(409);
  expect(((await again.json()) as { code: string }).code).toBe("PROJECT_BUSY");
  expect(existsSync(join(config.workspaceRoot, fillers[1]!, "pages.json"))).toBe(false);

  // waiting projects are flagged queued (list + the SSE's first event); the active one is running, not queued
  const listed = async (p: string) => {
    const url = (db.prepare("SELECT url FROM projects WHERE id=?").get(p) as { url: string }).url;
    return ((await (await projects.GET(new Request(`http://127.0.0.1/api/projects?q=${encodeURIComponent(url)}`))).json()) as { projects: { queued: boolean; status: string }[] }).projects[0]!;
  };
  expect(await listed(fillers[0]!)).toMatchObject({ status: "running", queued: false });
  expect(await listed(fillers[1]!)).toMatchObject({ status: "draft", queued: true });
  const ac = new AbortController();
  const sse = await events.GET(new Request("http://127.0.0.1", { signal: ac.signal }), ctx({ id: fillers[1]! }));
  const sseReader = sse.body!.getReader();
  expect(new TextDecoder().decode((await sseReader.read()).value)).toContain('"type":"history"');
  expect(new TextDecoder().decode((await sseReader.read()).value)).toContain('"queued":true');
  ac.abort();

  // a queued project waiting on a login can't get a login window (it would fight the job for the profile)
  db.prepare("UPDATE projects SET status='needs_auth' WHERE id=?").run(fillers[2]!);
  const open = await authOpen.POST(new Request("http://127.0.0.1", { method: "POST" }), ctx({ id: fillers[2]! }));
  expect(open.status).toBe(409);
  expect(((await open.json()) as { code: string }).code).toBe("PROJECT_BUSY");

  release();
  const statusOf = (p: string) => (db.prepare("SELECT status FROM projects WHERE id=?").get(p) as { status: string }).status;
  await expect.poll(() => fillers.every((f) => statusOf(f) === "failed"), { timeout: 10_000 }).toBe(true);
});

test("CSRF guard: foreign Origin and non-JSON bodies are refused; same-origin JSON passes", async () => {
  const body = JSON.stringify({ url: uniqueUrl(), mode: "single", config: {} });
  const foreign = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: jsonHeaders(body, { origin: "http://evil.test" }) }));
  expect(foreign.status).toBe(403);
  const opaque = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: jsonHeaders(body, { origin: "null" }) }));
  expect(opaque.status).toBe(403);
  const plain = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: jsonHeaders(body, { "content-type": "text/plain" }) }));
  expect(plain.status).toBe(403);
  const same = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: jsonHeaders(body, { "content-type": "application/json; charset=utf-8", origin: "http://127.0.0.1" }) }));
  expect(same.status).toBe(201);
  const { id } = (await same.json()) as { id: string };
  created.push(id);
  // bodiless mutations need no content-type but are still Origin-checked
  expect((await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE", headers: { origin: "http://evil.test" } }), ctx({ id }))).status).toBe(403);
  expect((await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE", headers: { origin: "http://127.0.0.1" } }), ctx({ id }))).status).toBe(200);
});

test("DNS rebinding: a non-loopback Host is refused on every request, GET included", async () => {
  const evil = { host: "evil.test:3000" };
  expect((await projects.GET(new Request("http://127.0.0.1/api/projects", { headers: evil }))).status).toBe(403);
  expect((await providers.GET(new Request("http://127.0.0.1/api/providers", { headers: evil }))).status).toBe(403);
  const body = JSON.stringify({ url: uniqueUrl(), mode: "single", config: {} });
  const rebound = await projects.POST(new Request("http://127.0.0.1/api/projects", { method: "POST", body, headers: jsonHeaders(body, { ...evil, origin: "http://evil.test:3000" }) }));
  expect(rebound.status).toBe(403);
  for (const host of ["localhost:3000", "127.0.0.1:3107", "[::1]:3000"]) {
    expect((await projects.GET(new Request("http://127.0.0.1/api/projects?q=none", { headers: { host } }))).status).toBe(200);
  }
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
    const crawling = crawl.POST(new Request("http://127.0.0.1", { method: "POST" }), ctx({ id }));
    await firstHit;
    const del = await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }));
    expect(del.status).toBe(409);
    expect(((await del.json()) as { code: string }).code).toBe("PROJECT_BUSY");
    release();
    expect((await crawling).status).toBe(200);
    expect((await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }))).status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("DELETE of a running project stops it (browser closed, run ended) and removes the rows: 200", { timeout: 30_000 }, async () => {
  const db = getDb();
  const id = await newProject();
  await enqueue(db, id, [(db.prepare("SELECT url FROM projects WHERE id=?").get(id) as { url: string }).url]);
  let closeBrowser!: () => void;
  const closed = new Promise<never>((_, reject) => (closeBrowser = () => reject(new Error("browser closed"))));
  closed.catch(() => {});
  let started!: () => void;
  const capturing = new Promise<void>((r) => (started = r));
  const deps: JobDeps = {
    openBrowser: async () => ({ context: {} as BrowserHandle["context"], close: async () => closeBrowser() }),
    capturePage: () => (started(), closed), // a slow capture: only the closed browser ends it
  };
  startProject(db, id, { deps });
  await capturing;
  expect(isQueuedOrActive(id)).toBe(true);
  const res = await project.DELETE(new Request("http://127.0.0.1", { method: "DELETE" }), ctx({ id }));
  expect(res.status).toBe(200);
  expect(isQueuedOrActive(id)).toBe(false);
  expect(db.prepare("SELECT id FROM projects WHERE id=?").get(id)).toBeUndefined();
  expect(db.prepare("SELECT id FROM tasks WHERE project_id=?").all(id)).toEqual([]);
});
