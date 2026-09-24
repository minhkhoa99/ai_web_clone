import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { config } from "@/core/config";
import { openDb } from "@/core/db";
import type { IR, IRNode } from "@/core/ir";
import { serveDir } from "@/core/serve";
import { createProject, discoverPages, enqueue, pauseProject, recoverOnStartup, resumeProject, runProject, startProject, subscribe, type JobEvent } from "@/core/jobs";
import { offline } from "./offline-deps";

const site3Dir = fileURLToPath(new URL("../fixtures/site3", import.meta.url));
const authDir = fileURLToPath(new URL("../fixtures/auth", import.meta.url));

let server: { url: string; close(): Promise<void> };
let authServer: { url: string; close(): Promise<void> };
let db: DatabaseSync;
const projects: string[] = [];

beforeAll(async () => {
  [server, authServer] = await Promise.all([serveDir(site3Dir), serveDir(authDir)]);
  db = openDb(":memory:");
});

afterAll(async () => {
  await Promise.all([server.close(), authServer.close()]);
  for (const id of projects) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

const countNodes = (n: IRNode): number => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
async function irNodeCount(projectId: string): Promise<number> {
  const ir = JSON.parse(await readFile(join(config.workspaceRoot, projectId, "ir.json"), "utf8")) as IR;
  return [...ir.sections.map((s) => s.root), ...ir.pages.map((p) => p.shell)].reduce((a, n) => a + countNodes(n), 0);
}
const task = (projectId: string, phase: string, key: string) =>
  db.prepare("SELECT status,attempts,output_path FROM tasks WHERE project_id=? AND phase=? AND key=?").get(projectId, phase, key) as
    | { status: string; attempts: number; output_path: string | null }
    | undefined;
const statusOf = (projectId: string) => (db.prepare("SELECT status,progress FROM projects WHERE id=?").get(projectId) as { status: string; progress: number });
const capturedAt = async (projectId: string, pageId: string) =>
  (JSON.parse(await readFile(join(config.workspaceRoot, projectId, "pages", pageId, "capture.json"), "utf8")) as PageCapture).capturedAt;

test("site3: killed during capture of page 2 -> recover + resume completes with the same IR as an uninterrupted run", { timeout: 240_000 }, async () => {
  // Uninterrupted reference run (discover -> enqueue -> run).
  const ref = createProject(db, { url: `${server.url}/index.html`, mode: "crawl", config: { delayMs: 0 } });
  projects.push(ref);
  const pages = await discoverPages(db, ref);
  const urls = pages.map((p) => p.url);
  expect(urls.map((u) => new URL(u).pathname).sort()).toEqual(["/about.html", "/index.html", "/pricing.html"]);
  expect(task(ref, "discover", `${server.url}/index.html`)).toMatchObject({ status: "done", output_path: "discover.json" });
  await enqueue(db, ref, urls);
  const events: JobEvent[] = [];
  const off = subscribe(ref, (e) => events.push(e));
  await runProject(db, ref, { deps: offline });
  off();
  expect(statusOf(ref)).toEqual({ status: "completed", progress: 100 });
  expect(events.filter((e) => e.type === "phase").map((e) => (e as { phase: string }).phase).slice(0, 5)).toEqual(["capture", "ir", "name", "emit", "qa"]);
  expect(JSON.stringify(events)).not.toMatch(/pass(word)?"/i);
  const refNodes = await irNodeCount(ref);
  expect(refNodes).toBeGreaterThan(0);

  // Interrupted run: concurrency 1, capture of page 2 never returns (the process "dies" there).
  const id = createProject(db, { url: `${server.url}/index.html`, mode: "crawl", config: { delayMs: 0, concurrency: 1 } });
  projects.push(id);
  await enqueue(db, id, urls);
  let zombie: BrowserHandle | undefined;
  let killed!: () => void;
  const atKill = new Promise<void>((resolve) => (killed = resolve));
  void runProject(db, id, {
    deps: {
      ...offline,
      openBrowser: async (opts) => (zombie = await openBrowser(opts)),
      capturePage: (handle, opts) => {
        if (opts.pageId !== "about") return capturePage(handle, opts);
        killed();
        return new Promise<never>(() => {});
      },
    },
  });
  await atKill;
  await zombie!.close(); // the dead process's browser is gone
  expect(statusOf(id).status).toBe("running");
  expect(task(id, "capture", "about")!.status).toBe("running");
  const homeBefore = { ...task(id, "capture", "index")!, at: await capturedAt(id, "index") };
  expect(homeBefore).toMatchObject({ status: "done", attempts: 1 });

  recoverOnStartup(db);
  expect(statusOf(id).status).toBe("interrupted");
  expect(task(id, "capture", "about")!.status).toBe("pending");

  await resumeProject(db, id, { deps: offline });
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  expect(task(id, "capture", "index")).toMatchObject({ status: "done", attempts: 1 }); // not re-captured
  expect(await capturedAt(id, "index")).toBe(homeBefore.at);
  expect(task(id, "capture", "about")).toMatchObject({ status: "done", attempts: 2 });
  expect(await irNodeCount(id)).toBe(refNodes);
  const open = db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND status<>'done'").get(id) as { n: number };
  expect(open.n).toBe(0);
});

const statusEvent = (projectId: string, status: string) =>
  new Promise<void>((resolve) => {
    const off = subscribe(projectId, (e) => {
      if (e.type !== "status" || e.status !== status) return;
      off();
      resolve();
    });
  });

test("pause from inside a capture: the run ends paused with the rest pending; startProject resumes to completed", { timeout: 240_000 }, async () => {
  const id = createProject(db, { url: `${server.url}/index.html`, mode: "crawl", config: { delayMs: 0, concurrency: 1 } });
  projects.push(id);
  await enqueue(db, id, ["index", "about", "pricing"].map((p) => `${server.url}/${p}.html`));
  await runProject(db, id, {
    deps: {
      ...offline,
      capturePage: (handle, opts) => {
        if (opts.pageId === "index") pauseProject(id);
        return capturePage(handle, opts);
      },
    },
  });
  expect(statusOf(id).status).toBe("paused");
  expect(["index", "about", "pricing"].map((k) => task(id, "capture", k)!.status)).toEqual(["done", "pending", "pending"]);
  expect(task(id, "ir", "all")!.status).toBe("pending");

  const completed = statusEvent(id, "completed");
  startProject(db, id, { deps: offline });
  await completed;
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  expect(task(id, "capture", "index")!.attempts).toBe(1);
});

test("auto login with a wrong password: LOGIN_FAILED is recorded on the login task, resume without credentials never retries", { timeout: 240_000 }, async () => {
  const loginUrl = `${authServer.url}/login.html`;
  const id = createProject(db, { url: loginUrl, mode: "single", config: { auth: { mode: "auto" } } });
  projects.push(id);
  await enqueue(db, id, [`${authServer.url}/dashboard.html`]);
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  await runProject(db, id, { deps: offline, credentials: { user: "demo@example.com", pass: "wrong-secret-9" } });
  expect(statusOf(id).status).toBe("failed");
  const login = () => db.prepare("SELECT status,attempts,error_code FROM tasks WHERE project_id=? AND phase='login' AND key=?").get(id, loginUrl);
  expect(login()).toEqual({ status: "failed", attempts: 1, error_code: "LOGIN_FAILED" });
  expect(task(id, "capture", "dashboard")!.status).toBe("pending");

  await resumeProject(db, id, { deps: offline });
  expect(statusOf(id).status).toBe("failed");
  expect(login()).toEqual({ status: "failed", attempts: 1, error_code: "LOGIN_FAILED" });
  expect(task(id, "capture", "dashboard")!.status).toBe("pending");

  await resumeProject(db, id, { deps: offline, credentials: { user: "demo@example.com", pass: "pass123" } });
  off();
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  expect(login()).toMatchObject({ status: "done", attempts: 2, error_code: null });
  expect(JSON.stringify(events)).not.toMatch(/wrong-secret-9|pass123/);
});
