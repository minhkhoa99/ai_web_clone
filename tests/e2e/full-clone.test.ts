// SP1 acceptance (spec §13/§14): clone each fixture site through the real pipeline with no AI help —
// every section x breakpoint >= 0.95, site2's interaction checklist fully captured, site3's shared
// header stored once in the IR and present on every emitted page.
import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "@/core/config";
import { openDb } from "@/core/db";
import { coverage } from "@/core/graph";
import type { IR } from "@/core/ir";
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";
import { serveDir } from "@/core/serve";
import { createProject, discoverPages, enqueue, runProject, type JobDeps, type QaFile } from "@/core/jobs";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const THRESHOLD = 0.95;

// No network AI: naming keeps the deterministic fallback names, the fix loop patches nothing.
const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) =>
    failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};

let db: DatabaseSync;
const servers: { close(): Promise<void> }[] = [];
const projects: string[] = [];

beforeAll(() => {
  db = openDb(":memory:");
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const id of projects) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

async function cloneSite(site: string, mode: "single" | "crawl"): Promise<{ id: string; ws: string; ir: IR; qa: QaFile }> {
  const server = await serveDir(fixture(site));
  servers.push(server);
  const id = createProject(db, { url: `${server.url}/index.html`, mode, config: { delayMs: 0 } });
  projects.push(id);
  const pages = await discoverPages(db, id);
  await enqueue(db, id, pages.map((p) => p.url));
  await runProject(db, id, { deps: offline });
  const ws = join(config.workspaceRoot, id);
  const read = async <T>(f: string) => JSON.parse(await readFile(join(ws, f), "utf8")) as T;
  return { id, ws, ir: await read<IR>("ir.json"), qa: await read<QaFile>("qa.json") };
}

function expectAllPass(ir: IR, qa: QaFile): { min: number; median: number } {
  const expected = ir.pages.flatMap((p) => p.sectionIds.flatMap((s) => [375, 768, 1440].map((bp) => `${p.id}/${s}@${bp}`)));
  expect(qa.scores.map((s) => `${s.pageId}/${s.sectionId}@${s.bp}`).sort()).toEqual(expected.sort());
  const below = qa.scores.filter((s) => s.score < THRESHOLD).map((s) => `${s.pageId}/${s.sectionId}@${s.bp}=${s.score.toFixed(4)}`);
  expect(below).toEqual([]);
  const sorted = qa.scores.map((s) => s.score).sort((a, b) => a - b);
  return { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]! };
}

const statusOf = (id: string) => db.prepare("SELECT status,progress FROM projects WHERE id=?").get(id) as { status: string; progress: number };

test("site1 (landing): every section >= 95% at 375/768/1440 without AI", { timeout: 300_000 }, async ({ annotate }) => {
  const { id, ir, qa } = await cloneSite("site1", "single");
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  const { min, median } = expectAllPass(ir, qa);
  await annotate(`site1 min ${min.toFixed(4)} median ${median.toFixed(4)} (${qa.scores.length} scores)`);
});

test("site2 (interactions): every section >= 95%, checklist 100% captured with every kind", { timeout: 300_000 }, async ({ annotate }) => {
  const { id, ir, qa } = await cloneSite("site2", "single");
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  const { min, median } = expectAllPass(ir, qa);
  await annotate(`site2 min ${min.toFixed(4)} median ${median.toFixed(4)} (${qa.scores.length} scores)`);

  const [cov] = coverage(db, id);
  expect(cov).toMatchObject({ failed: 0, skipped: 0 });
  expect(cov!.captured).toBeGreaterThan(0);
  const kinds = new Set(ir.interactions.filter((i) => i.status === "captured").map((i) => i.kind));
  expect([...kinds].sort()).toEqual(["accordion", "carousel", "form", "hover", "menu", "modal", "sticky", "tab"]);
});

test("site3 (multi-page): every section >= 95%, shared header stored once and emitted on every page", { timeout: 300_000 }, async ({ annotate }) => {
  const { id, ws, ir, qa } = await cloneSite("site3", "crawl");
  expect(statusOf(id)).toEqual({ status: "completed", progress: 100 });
  expect(ir.pages.map((p) => p.path).sort()).toEqual(["/about.html", "/index.html", "/pricing.html"]);
  const { min, median } = expectAllPass(ir, qa);
  await annotate(`site3 min ${min.toFixed(4)} median ${median.toFixed(4)} (${qa.scores.length} scores)`);

  const headers = ir.sections.filter((s) => s.root.tag === "header");
  expect(headers).toHaveLength(1);
  expect(ir.layouts.length).toBeGreaterThanOrEqual(1);
  expect(ir.layouts.map((l) => l.sectionId)).toContain(headers[0]!.id);
  for (const p of ir.pages) expect(p.sectionIds).toContain(headers[0]!.id);

  const htmlFiles = (await readdir(join(ws, "out"))).filter((f) => f.endsWith(".html"));
  expect(htmlFiles).toHaveLength(3);
  for (const f of htmlFiles) {
    const html = await readFile(join(ws, "out", f), "utf8");
    expect(html, f).toMatch(/<header[\s>][\s\S]*Home[\s\S]*About[\s\S]*Pricing[\s\S]*<\/header>/);
  }
});
