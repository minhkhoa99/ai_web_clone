// Spec §14: an API key and a login password never appear in logs, the graph or any output. A real run
// (auto login with remembered credentials, AI naming through a local mock provider) is grepped byte-wise:
// every workspace file, the raw SQLite files, graph rows, SSE events and everything written to the console.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { openDb } from "@/core/db";
import { history, settled } from "@/core/event-log";
import { saveProvider } from "@/core/gateway";
import { createProject, enqueue, runProject, subscribe, type JobEvent } from "@/core/jobs";
import { serveDir } from "@/core/serve";
import type { ProjectRow } from "@/app/_server/http";
import { credentialsFor, holdCredentials } from "@/app/_server/session";

const API_KEY = "sk-TEST-SECRET-7f3a9";
const PASSWORD = "P@ss-SECRET-4411";
const SECRETS = [API_KEY, PASSWORD];

let tmp = "";
let db: DatabaseSync;
let fixtures: { url: string; close(): Promise<void> };
let site: Server & { url?: string };
const referers: { path: string; referer: string }[] = [];
let ai: Server;
const aiRequests: { auth: string; body: string }[] = [];
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "secrets-"));
  db = openDb(join(tmp, "sp1.db"));
  fixtures = await serveDir(fileURLToPath(new URL("../fixtures/auth", import.meta.url)));
  // Recording pass-through: a dashboard request referred by login.html = the form was submitted with the
  // right password (the fixture redirects only on success), i.e. autoLogin really typed it.
  site = createServer((req, res) => {
    referers.push({ path: req.url ?? "", referer: req.headers.referer ?? "" });
    const up = request(`${fixtures.url}${req.url}`, { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  // OpenAI-compatible mock: records what reached the provider, answers "no names" (fallback names kept).
  ai = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      aiRequests.push({ auth: req.headers.authorization ?? "", body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { total_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  db?.close();
  site?.closeAllConnections();
  await new Promise((r) => site?.close(r));
  await fixtures?.close();
  await new Promise((r) => ai?.close(r));
  if (projectId) await rm(join(config.workspaceRoot, projectId), { recursive: true, force: true, maxRetries: 3 });
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

// Byte search in UTF-8 and UTF-16LE (Chromium stores some profile strings as UTF-16).
const leaks = (bytes: Buffer): string[] => SECRETS.filter((s) => bytes.includes(Buffer.from(s, "utf8")) || bytes.includes(Buffer.from(s, "utf16le")));

test("api key + password: absent from workspace files, raw db bytes, graph, SSE events and console output", { timeout: 300_000 }, async () => {
  saveProvider(db, { name: "mock", kind: "openai", baseUrl: `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`, apiKey: API_KEY, roles: { vision: "m1", code: "m1" } });
  projectId = createProject(db, { url: `${site.url}/login.html`, mode: "single", config: { delayMs: 0, auth: { mode: "auto" } } });
  holdCredentials(db, projectId, { user: "demo@example.com", pass: PASSWORD, remember: true });
  await enqueue(db, projectId, [`${site.url}/dashboard.html`]);
  const row = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as ProjectRow;
  expect(typeof row.auth_enc).toBe("string"); // remembered = stored encrypted

  const events: JobEvent[] = [];
  const off = subscribe(projectId, (e) => events.push(e));
  const printed: string[] = [];
  const spies = [
    ...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")))),
    ...[process.stdout, process.stderr].map((s) =>
      vi.spyOn(s, "write").mockImplementation((chunk: string | Uint8Array) => (printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), true)),
    ),
  ];
  try {
    await runProject(db, projectId, { credentials: credentialsFor(db, row) });
  } finally {
    spies.forEach((s) => s.mockRestore());
    off();
  }
  await settled(projectId); // the event log's appends are on disk before the files are grepped

  const status = db.prepare("SELECT status FROM projects WHERE id=?").get(projectId) as { status: string };
  expect(status.status).toBe("completed");
  const login = db.prepare("SELECT status FROM tasks WHERE project_id=? AND phase='login'").get(projectId) as { status: string };
  expect(login.status).toBe("done");
  expect(referers).toContainEqual({ path: "/dashboard.html", referer: `${site.url}/login.html` }); // the password was really used
  expect(aiRequests.length).toBeGreaterThan(0); // the key was really used ...
  expect(aiRequests.every((r) => r.auth === `Bearer ${API_KEY}`)).toBe(true);
  expect(aiRequests.flatMap((r) => leaks(Buffer.from(r.body)))).toEqual([]); // ... but never sent in a prompt

  const ws = join(config.workspaceRoot, projectId);
  const files = await filesUnder(ws);
  expect(files.some((f) => f.endsWith("ir.json"))).toBe(true);
  const fileLeaks = [];
  for (const f of files) for (const s of leaks(await readFile(f))) fileLeaks.push(`${f}: ${s}`);
  expect(fileLeaks).toEqual([]);
  expect(files.some((f) => f.endsWith("events.jsonl"))).toBe(true); // the durable log was grepped above
  expect(leaks(Buffer.from(JSON.stringify(history(projectId))))).toEqual([]); // the SSE history message

  const dbFiles = (await readdir(tmp)).filter((f) => f.startsWith("sp1.db")).map((f) => join(tmp, f));
  expect(dbFiles.length).toBeGreaterThan(0);
  for (const f of dbFiles) expect(leaks(await readFile(f)), f).toEqual([]);

  const graph = db.prepare("SELECT data_json FROM nodes WHERE project_id=? UNION ALL SELECT src||dst||type FROM edges WHERE project_id=?").all(projectId, projectId);
  expect(graph.length).toBeGreaterThan(0);
  expect(leaks(Buffer.from(JSON.stringify(graph)))).toEqual([]);
  expect(events.length).toBeGreaterThan(0);
  expect(leaks(Buffer.from(JSON.stringify(events)))).toEqual([]);
  expect(leaks(Buffer.from(printed.join("\n")))).toEqual([]);
});
