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
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";
import { serveDir } from "@/core/serve";
import { createProject, discoverPages, enqueue, recoverOnStartup, resumeProject, runProject, subscribe, type JobDeps, type JobEvent } from "@/core/jobs";

const site3Dir = fileURLToPath(new URL("../fixtures/site3", import.meta.url));

// No network AI: naming keeps IR defaults, fixing reports every section red without patching.
const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) =>
    failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};

let server: { url: string; close(): Promise<void> };
let db: DatabaseSync;
const projects: string[] = [];

beforeAll(async () => {
  server = await serveDir(site3Dir);
  db = openDb(":memory:");
});

afterAll(async () => {
  await server.close();
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
