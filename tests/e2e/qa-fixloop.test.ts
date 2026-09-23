import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type PageCapture } from "@/core/capture";
import { applyPatch, buildIR, type IR, type PatchOp, type Section } from "@/core/ir";
import { openDb } from "@/core/db";
import { writeGraph } from "@/core/graph";
import { AppError } from "@/core/errors";
import { generate } from "@/core/gateway";
import { fixAll, fixSection, type FixCtx } from "@/core/qa-fix";

vi.mock("@/core/gateway", () => ({ generate: vi.fn() }));
const generateMock = vi.mocked(generate);

const site1Dir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));
const RED = { "background-color": "rgb(255, 0, 0)" };

let handle: BrowserHandle;
let tmp: string;
let server: { url: string; close(): Promise<void> };
let cap: PageCapture;
let ir: IR;
let broken: IR;
let db: DatabaseSync;
let workspaceDir: string;
let url: string;
let hero: Section;
let header: Section;
let features: Section;
let footer: Section;

const restore = (s: Section): PatchOp => ({ op: "setStyle", id: s.root.id, style: { "background-color": ir.classes[s.root.cls[0]!]?.base["background-color"] ?? "rgba(0, 0, 0, 0)" } });
const reply = (ops: PatchOp[]) => ({ text: JSON.stringify({ ops }), tokens: 10 });
const newCtx = (): FixCtx => ({ db, projectId: "p1", handle, workspaceDir, ir: broken, captures: [cap], emit: { assetMap: cap.assets, pageUrls: { home: url } }, threshold: 0.95 });
const bgOf = (x: IR, id: string) => x.classes[x.sections.find((s) => s.id === id)!.root.cls[0]!]?.base["background-color"];
const userText = (call: number) => generateMock.mock.calls[call]![1].messages.map((m) => m.content).join("\n");

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  tmp = await mkdtemp(join(tmpdir(), "ai-web-clone-fix-"));
  server = await serveDir(site1Dir);
  workspaceDir = join(tmp, "ws");
  url = `${server.url}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  ir = buildIR([cap]);
  const bySection = (pred: (s: Section) => boolean) => ir.sections.find(pred)!;
  hero = bySection((s) => JSON.stringify(s.root).includes("Build faster sites"));
  header = bySection((s) => s.root.tag === "header");
  features = bySection((s) => JSON.stringify(s.root).includes("Rated top"));
  footer = bySection((s) => s.root.tag === "footer");
  broken = applyPatch(ir, [hero, header, features].map((s) => ({ op: "setStyle", id: s.root.id, style: RED })));
  db = openDb(":memory:");
  writeGraph(db, "p1", broken, cap.assets);
});

afterAll(async () => {
  await handle.close();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  generateMock.mockReset();
});

test("a patch restoring the background passes the gate in one round; inspector evidence precedes the AI call", async () => {
  generateMock.mockResolvedValue(reply([restore(hero)]));
  const ctx = newCtx();
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ sectionId: hero.id, pageId: "home", rounds: 1, patched: true, status: "pass" });
  expect(res.finalScore).toBeGreaterThanOrEqual(0.95);
  expect(Object.keys(res.scores).sort()).toEqual(["1440", "375", "768"]);
  expect(ctx.ir).not.toBe(broken);
  expect(bgOf(ctx.ir, hero.id)).not.toBe(RED["background-color"]);

  const opts = generateMock.mock.calls[0]![1];
  expect(opts.role).toBe("code");
  expect(opts.images).toHaveLength(3);
  expect(opts.tools!.map((t) => t.name)).toContain("readStyle");
  expect(userText(0)).toContain("A11Y_SNAPSHOT");
  expect(userText(0)).toContain("FOCUS_NODES");
  expect(await readdir(join(workspaceDir, "qa-tmp"))).toEqual([]);
});

test("a harmful patch is reverted every round: score never drops, section ends red", async () => {
  generateMock.mockResolvedValue(reply([{ op: "setStyle", id: hero.root.id, style: { display: "none" } }]));
  const ctx = newCtx();
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ rounds: 3, patched: false, status: "red" });
  expect(ctx.ir).toBe(broken);
  expect(generateMock).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 3; i++) expect(userText(i)).toContain("A11Y_SNAPSHOT");
  // No regression: the result is the unpatched score (well above the 0 of a hidden section).
  const baseline = await fixSection({ ...newCtx(), threshold: 0 }, hero.id, "home");
  expect(baseline.rounds).toBe(0);
  expect(res.finalScore).toBeCloseTo(baseline.finalScore, 3);
});

test("non-JSON and out-of-section ops each burn a round; the next good patch still lands", async () => {
  generateMock
    .mockResolvedValueOnce({ text: "sure, here is a fix", tokens: 1 })
    .mockResolvedValueOnce(reply([restore(hero), { op: "setText", id: footer.root.id, text: "x" }]))
    .mockResolvedValueOnce(reply([restore(hero)]));
  const ctx = newCtx();
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ rounds: 3, patched: true, status: "pass" });
  expect(ctx.ir.sections.find((s) => s.id === footer.id)).toEqual(footer);
});

test("tool calls are fed back as TOOL_RESULTS; the 6th call wastes the round", async () => {
  const sel = `[data-ir-id="${hero.root.id}"]`;
  const calls = (n: number) => ({ text: "", tokens: 1, toolCalls: Array.from({ length: n }, () => ({ name: "readStyle", args: { target: "clone", selector: sel, props: ["background-color"] } })) });
  generateMock.mockResolvedValueOnce(calls(3)).mockResolvedValueOnce(calls(3)).mockResolvedValueOnce(reply([restore(hero)]));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ rounds: 2, patched: true, status: "pass" });
  const fed = generateMock.mock.calls[1]![1].messages.at(-1)!;
  expect(fed.role).toBe("user");
  expect(fed.content.startsWith("TOOL_RESULTS ")).toBe(true);
  expect(fed.content).toContain("rgb(255, 0, 0)");
});

test("BUDGET_EXCEEDED stops the section without throwing; fixAll starts no AI work after it", async () => {
  generateMock.mockRejectedValue(new AppError("BUDGET_EXCEEDED", "over budget"));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ status: "budget", patched: false });

  generateMock.mockClear();
  const all = await fixAll(newCtx(), [hero, header, features].map((s) => ({ sectionId: s.id, pageId: "home" })));
  expect(all.map((r) => r.status)).toEqual(["budget", "budget", "budget"]);
  expect(generateMock.mock.calls.length).toBeLessThanOrEqual(2);
});

test("fixAll fixes two sections in parallel and merges both patches into ctx.ir", async () => {
  generateMock.mockImplementation(async (_db, opts) => {
    const text = opts.messages.map((m) => m.content).join("\n");
    return reply([restore(text.includes(`SECTION ${hero.id} `) ? hero : header)]);
  });
  const ctx = newCtx();
  const all = await fixAll(ctx, [hero, header].map((s) => ({ sectionId: s.id, pageId: "home" })));
  expect(all.map((r) => [r.sectionId, r.status, r.patched])).toEqual([
    [hero.id, "pass", true],
    [header.id, "pass", true],
  ]);
  for (const s of [hero, header]) expect(bgOf(ctx.ir, s.id)).not.toBe(RED["background-color"]);
});

test("AI_AUTH is rethrown", async () => {
  generateMock.mockRejectedValue(new AppError("AI_AUTH", "bad key"));
  await expect(fixSection(newCtx(), hero.id, "home")).rejects.toMatchObject({ code: "AI_AUTH" });
});
