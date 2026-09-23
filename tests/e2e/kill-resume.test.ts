// Spec §13 resume: a real `next start` is killed mid-capture (no shutdown hook runs), a new server starts
// (instrumentation's recoverOnStartup marks the project interrupted, nothing auto-runs), POST /resume
// completes the project with the same IR as an uninterrupted run and without re-capturing done pages.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageCapture } from "@/core/capture";
import type { IR, IRNode } from "@/core/ir";
import { serveDir } from "@/core/serve";
import { startNextApp, type NextEnv } from "./next-app";

let tmp = "";
let env: NextEnv;
let site: { url: string; close(): Promise<void> };
let app: Awaited<ReturnType<typeof startNextApp>> | undefined;
let db: DatabaseSync | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kill-resume-"));
  env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  site = await serveDir(fileURLToPath(new URL("../fixtures/site3", import.meta.url)));
}, 600_000);

afterAll(async () => {
  db?.close();
  app?.stop();
  await site?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${app!.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// The server's db, read from the test process (WAL: readers never block the writer).
const q = <T>(sql: string, ...args: string[]) => db!.prepare(sql).all(...args) as T[];
const projectOf = (id: string) => q<{ status: string; progress: number }>("SELECT status,progress FROM projects WHERE id=?", id)[0]!;
const captures = (id: string) => q<{ key: string; status: string; attempts: number }>("SELECT key,status,attempts FROM tasks WHERE project_id=? AND phase='capture' ORDER BY key", id);
const running = (id: string) => q<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND status='running'", id)[0]!.n;

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 180_000, everyMs = 20): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(everyMs)) {
    const v = read();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function createAndStart(): Promise<string> {
  const { id } = await api<{ id: string }>("/api/projects", { url: `${site.url}/index.html`, mode: "crawl", config: { delayMs: 0, concurrency: 1 } });
  const { pages } = await api<{ pages: { url: string }[] }>(`/api/projects/${id}/crawl`, {});
  expect(pages).toHaveLength(3);
  await api(`/api/projects/${id}/start`, { pages: pages.map((p) => p.url) });
  return id;
}

const ws = (id: string, ...rel: string[]) => join(env.WORKSPACE_ROOT, id, ...rel);
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const countNodes = (n: IRNode): number => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
const irNodes = (ir: IR) => [...ir.sections.map((s) => s.root), ...ir.pages.map((p) => p.shell)].reduce((a, n) => a + countNodes(n), 0);

test("next start killed mid-capture -> restart marks interrupted, nothing auto-runs -> /resume completes like an uninterrupted run", { timeout: 900_000 }, async () => {
  app = await startNextApp(env);
  db = new DatabaseSync(env.DB_PATH, { readOnly: true });
  const id = await createAndStart();

  // Kill as soon as one capture is done while another is still to do.
  const done = await until("a done capture with another pending/running", () => {
    const rows = captures(id);
    const doneRow = rows.find((r) => r.status === "done");
    return doneRow && rows.some((r) => r.status === "pending" || r.status === "running") ? doneRow : undefined;
  });
  app.stop("SIGKILL");
  const capturedAt = (await readJson<PageCapture>(ws(id, "pages", done.key, "capture.json"))).capturedAt;
  const frozen = JSON.stringify(captures(id));
  expect(projectOf(id).status).toBe("running"); // nobody got to write anything else
  await sleep(1_500);
  expect(JSON.stringify(captures(id))).toBe(frozen); // the process is really gone: no further writes

  app = await startNextApp(env);
  expect(projectOf(id).status).toBe("interrupted");
  expect(running(id)).toBe(0);
  await sleep(2_000);
  expect(projectOf(id).status).toBe("interrupted"); // not auto-resumed
  expect(captures(id).filter((r) => r.status === "done").map((r) => r.key)).toEqual(
    (JSON.parse(frozen) as { key: string; status: string }[]).filter((r) => r.status === "done").map((r) => r.key),
  );

  await api(`/api/projects/${id}/resume`, {});
  await until("resumed project completed", () => (projectOf(id).status === "completed" ? true : undefined));
  expect(projectOf(id)).toEqual({ status: "completed", progress: 100 });
  expect(captures(id).find((r) => r.key === done.key)).toMatchObject({ status: "done", attempts: 1 }); // not re-captured
  expect((await readJson<PageCapture>(ws(id, "pages", done.key, "capture.json"))).capturedAt).toBe(capturedAt);
  expect(captures(id).every((r) => r.status === "done")).toBe(true);

  // Uninterrupted reference run of the same site on the same server.
  const ref = await createAndStart();
  await until("reference project completed", () => (projectOf(ref).status === "completed" ? true : undefined));
  const [resumed, reference] = await Promise.all([readJson<IR>(ws(id, "ir.json")), readJson<IR>(ws(ref, "ir.json"))]);
  expect(irNodes(resumed)).toBe(irNodes(reference));
  expect(resumed).toEqual(reference);
});
