import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type PageCapture } from "@/core/capture";
import { applyPatch, buildIR, type IR, type PatchOp, type Section } from "@/core/ir";
import { openDb } from "@/core/db";
import { contextForFix, writeGraph } from "@/core/graph";
import { AppError } from "@/core/errors";
import { generate } from "@/core/gateway";
import { fixAll, fixSection, type FixCtx } from "@/core/qa-fix";

vi.mock("@/core/gateway", () => ({ generate: vi.fn() }));
vi.mock("@/core/graph", async (orig) => {
  const graph = await orig<typeof import("@/core/graph")>();
  return { ...graph, contextForFix: vi.fn(graph.contextForFix) }; // real behaviour, budgets observable
});
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
const logsTo = (ctx: FixCtx): string[] => {
  const lines: string[] = [];
  ctx.log = (level, message) => lines.push(`${level} ${message}`);
  return lines;
};
const pct = /\d+\.\d%/.source;
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
  writeGraph(db, "p1", broken, cap.assets); // accepted patches rewrite the graph
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
  const logs = logsTo(ctx);
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ rounds: 3, patched: false, status: "red" });
  const at = `fix home:${hero.id}`;
  expect(logs).toHaveLength(7);
  for (let n = 1; n <= 3; n++) {
    expect(logs[2 * n - 2]).toMatch(new RegExp(`^info ${at} vòng ${n}: bắt đầu [(]điểm ${pct}[)]$`));
    expect(logs[2 * n - 1]).toMatch(new RegExp(`^info ${at} vòng ${n}: ứng viên ${pct} < ${pct}, revert$`));
  }
  expect(logs[6]).toMatch(new RegExp(`^warn ${at}: đỏ điểm ${pct} sau 3 vòng$`));
  expect(ctx.ir).toBe(broken);
  expect(generateMock).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 3; i++) expect(userText(i)).toContain("A11Y_SNAPSHOT");
  // No regression: the result is the unpatched score (well above the 0 of a hidden section).
  const baseline = await fixSection({ ...newCtx(), threshold: 0 }, hero.id, "home");
  expect(baseline.rounds).toBe(0);
  expect(res.finalScore).toBeCloseTo(baseline.finalScore, 3);
});

test("an accepted patch is written to the graph: the next round's context shows it", async () => {
  generateMock.mockResolvedValue(reply([restore(hero)]));
  const ctx = { ...newCtx(), threshold: 1.01 }; // unreachable: round 1 is accepted, rounds 2-3 re-send it
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ rounds: 3, patched: true, status: "red" });
  const fixedCls = ctx.ir.sections.find((s) => s.id === hero.id)!.root.cls[0]!;
  const contextOf = (call: number) => userText(call).slice(userText(call).indexOf("CONTEXT "));
  expect(contextOf(0)).not.toContain(fixedCls);
  expect(contextOf(1)).toContain(fixedCls);
});

test("non-JSON and out-of-section ops each burn a round; the next good patch still lands", async () => {
  generateMock
    .mockResolvedValueOnce({ text: "sure, here is a fix", tokens: 1 })
    .mockResolvedValueOnce(reply([restore(hero), { op: "setText", id: footer.root.id, text: "x" }]))
    .mockResolvedValueOnce(reply([restore(hero)]));
  const ctx = { ...newCtx(), onRetry: () => {} };
  const logs = logsTo(ctx);
  const res = await fixSection(ctx, hero.id, "home");
  expect(res).toMatchObject({ rounds: 3, patched: true, status: "pass" });
  const at = `fix home:${hero.id}`;
  expect(logs.filter((l) => !l.includes("bắt đầu"))).toEqual([
    `warn ${at} vòng 1: AI trả sai định dạng`,
    `warn ${at} vòng 2: AI trả sai định dạng`,
    expect.stringMatching(new RegExp(`^info ${at} vòng 3: nhận ứng viên [(]điểm ${pct}[)]$`)),
    expect.stringMatching(new RegExp(`^info ${at}: pass điểm ${pct} sau 3 vòng$`)),
  ]);
  expect(generateMock.mock.calls[0]![1].onRetry).toBe(ctx.onRetry); // gateway retries reach the job's run.log
  expect(ctx.ir.sections.find((s) => s.id === footer.id)).toEqual(footer);
});

test("tool calls are fed back as TOOL_RESULTS; the 6th call wastes the round", async () => {
  const sel = `[data-ir-id="${hero.root.id}"]`;
  const calls = (n: number) => ({ text: "", tokens: 1, toolCalls: Array.from({ length: n }, () => ({ name: "readStyle", args: { target: "clone", selector: sel, props: ["background-color"] } })) });
  generateMock.mockResolvedValueOnce(calls(3)).mockResolvedValueOnce(calls(3)).mockResolvedValueOnce(reply([restore(hero)]));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ rounds: 2, patched: true, status: "pass" });
  expect(generateMock.mock.calls[0]![1].images).toHaveLength(3);
  expect(generateMock.mock.calls[1]![1].images).toBeUndefined(); // images only on the first call of a round
  const fed = generateMock.mock.calls[1]![1].messages.at(-1)!;
  expect(fed.role).toBe("user");
  expect(fed.content.startsWith("TOOL_RESULTS ")).toBe(true);
  expect(fed.content).toContain("rgb(255, 0, 0)");
  // the AI's own turn (its tool calls) precedes the results, so the conversation reads in order
  const turn = generateMock.mock.calls[1]![1].messages.at(-2)!;
  expect(turn.role).toBe("assistant");
  expect(turn.content).toContain("TOOL_CALLS ");
  expect(turn.content).toContain("readStyle");
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

test("AI_AUTH stops the section with the best score kept (never rethrown)", async () => {
  generateMock.mockRejectedValue(new AppError("AI_AUTH", "bad key"));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ status: "ai_stopped", patched: false, rounds: 1, errorCode: "AI_AUTH", errorMessage: "bad key" });
  expect(res.finalScore).toBeLessThan(0.95);
});

test("AI_QUOTA: fixAll resolves, every section ai_stopped, no AI call after the first failure", async () => {
  generateMock.mockRejectedValue(new AppError("AI_QUOTA", "provider \"p\" model \"m\" returned status 402: no credit"));
  const ctx = newCtx();
  const logs = logsTo(ctx);
  const all = await fixAll(ctx, [hero, header, features].map((s) => ({ sectionId: s.id, pageId: "home" })));
  expect(all.map((r) => [r.status, r.errorCode])).toEqual(Array(3).fill(["ai_stopped", "AI_QUOTA"]));
  expect(generateMock.mock.calls.length).toBeLessThanOrEqual(2); // 2 in parallel may both be in flight
  // hardening spec §8: logged when AI stops (the first section to hit it), once, not after the whole fix phase
  expect(logs.filter((l) => l.includes("AI dừng"))).toEqual(['warn AI dừng: AI_QUOTA — provider "p" model "m" returned status 402: no credit']);
});

test("malformed tool calls (inherited tool name, unparseable args) waste the round; the project isn't failed", async () => {
  generateMock
    .mockResolvedValueOnce({ text: "", tokens: 1, toolCalls: [{ name: "constructor", args: {} }, { name: "__proto__", args: {} }] })
    .mockResolvedValueOnce(reply([restore(hero)]));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ rounds: 1, patched: true, status: "pass" });
  const fed = generateMock.mock.calls[1]![1].messages.at(-1)!.content;
  expect(fed).toContain("unknown tool: constructor");

  // what generate now throws for a tool call whose arguments aren't JSON: the round is spent, the next one lands
  generateMock.mockReset();
  generateMock.mockRejectedValueOnce(new AppError("AI_BAD_RESPONSE", "tool call arguments are not JSON")).mockResolvedValueOnce(reply([restore(hero)]));
  expect(await fixSection(newCtx(), hero.id, "home")).toMatchObject({ rounds: 2, patched: true, status: "pass" });
});

test("a tool screenshot reaches the next generate call as an image, not as TOOL_RESULTS text (< 2KB)", async () => {
  generateMock
    .mockResolvedValueOnce({ text: "", tokens: 1, toolCalls: [{ name: "screenshotSection", args: { target: "clone", bbox: [0, 0, 5000, 5000] } }] })
    .mockResolvedValueOnce(reply([restore(hero)]));
  const res = await fixSection(newCtx(), hero.id, "home");
  expect(res).toMatchObject({ rounds: 1, patched: true, status: "pass" });
  const second = generateMock.mock.calls[1]![1];
  const fed = second.messages.at(-1)!.content;
  expect(fed.startsWith("TOOL_RESULTS ")).toBe(true);
  expect(fed.length).toBeLessThan(2048);
  expect(fed).toContain("image attached");
  expect(second.images).toHaveLength(1);
  const png = PNG.sync.read(Buffer.from(second.images![0]!, "base64"));
  expect(png.width).toBeLessThanOrEqual(800);
  expect(png.height).toBeLessThanOrEqual(800);
});

test("AI_TOO_LARGE spends that section's round; its next rounds go without images at half the CONTEXT budget; other sections unaffected", async () => {
  const tooLarge = new AppError("AI_TOO_LARGE", 'provider "p" model "m" returned status 400: {"error":{"code":"context_length_exceeded"}}');
  let heroCalls = 0;
  generateMock.mockImplementation(async (_db, opts) => {
    const text = opts.messages.map((m) => m.content).join("\n");
    if (text.includes(`SECTION ${hero.id} `) && ++heroCalls === 1) throw tooLarge;
    return reply([restore(text.includes(`SECTION ${hero.id} `) ? hero : header)]);
  });
  vi.mocked(contextForFix).mockClear();
  const ctx = newCtx();
  const logs = logsTo(ctx);
  const all = await fixAll(ctx, [hero, header].map((s) => ({ sectionId: s.id, pageId: "home" })));
  expect(all.map((r) => [r.sectionId, r.status, r.rounds])).toEqual([
    [hero.id, "pass", 2],
    [header.id, "pass", 1],
  ]);
  const calls = generateMock.mock.calls.map((c) => c[1]);
  const heroOpts = calls.filter((o) => o.messages.some((m) => m.content.includes(`SECTION ${hero.id} `)));
  const headerOpts = calls.filter((o) => o.messages.some((m) => m.content.includes(`SECTION ${header.id} `)));
  expect(heroOpts[0]!.images).toHaveLength(3);
  expect(heroOpts[1]!.images).toBeUndefined(); // reduced: no images
  const budgets = (id: string) => [...new Set(vi.mocked(contextForFix).mock.calls.filter((c) => c[2] === id).map((c) => c[3]))];
  expect(budgets(hero.id)).toEqual([24_000, 12_000]); // round 2: half the CONTEXT budget
  expect(budgets(header.id)).toEqual([24_000]);
  expect(headerOpts[0]!.images).toHaveLength(3); // the sibling keeps its images
  expect(logs).toContainEqual(`warn fix home:${hero.id} vòng 1: request quá lớn (AI_TOO_LARGE), vòng sau bỏ ảnh và giảm ngữ cảnh`);
  expect(logs.some((l) => l.includes("AI dừng"))).toBe(false);
});
