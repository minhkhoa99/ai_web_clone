// QA fix loop (spec §9): <=3 AI rounds per failing section. Before every AI call the orchestrator
// gathers inspector evidence; each candidate IR is emitted + scored in its own temp dir and only
// accepted when its min score over the breakpoints rises, so a section's score never regresses.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { z } from "zod";
import { evalWithTimeout, withPage, type BrowserHandle } from "./browser";
import type { CaptureNode, PageCapture } from "./capture";
import { emitHtml, pageFileNames, type RenderOpts } from "./emit-html";
import { AppError, Codes, type Code } from "./errors";
import { generate, type ChatMessage, type GenerateOptions } from "./gateway";
import { contextForFix, writeGraph } from "./graph";
import { asTools, readStyle, snapshotA11y } from "./inspector";
import { applyPatch, type IR, type IRNode, type PatchOp } from "./ir";
import { mapLimit } from "./limit";
import { fitImages, fitRequest, MAX_IMAGES_B64, MAX_IMAGE_WIDTH } from "./naming";
import { prepareClonePage, scoreSections, sectionNodes, type Bp, type SectionScore } from "./qa";
import { attrsSchema, tagSchema } from "./safe-names";
import { serveDir } from "./serve";
import { STOP_AI, STOP_AI_CODES } from "./statuses";

export type FixCtx = {
  db: DatabaseSync;
  projectId: string;
  handle: BrowserHandle;
  workspaceDir: string;
  ir: IR; // current best, replaced on every accepted patch
  captures: PageCapture[];
  emit: Pick<RenderOpts, "assetMap" | "pageUrls">;
  threshold?: number; // default 0.95
  contextBudgetChars?: number; // default 24_000
  signal?: AbortSignal; // the run's: pause aborts the AI call in flight
  log?: (level: "info" | "warn", message: string) => void; // fix-round progress (hardening spec §4): the job's log events
  onRetry?: GenerateOptions["onRetry"]; // gateway backoffs: the job's run.log
};
export type FixTarget = { sectionId: string; pageId: string };
export type FixResult = FixTarget & {
  finalScore: number; // min over bps
  scores: Record<Bp, number>;
  rounds: number;
  patched: boolean;
  status: "pass" | "red" | "budget" | "ai_stopped";
  errorCode?: Code; // ai_stopped only
  errorMessage?: string;
};

export { STOP_AI }; // defined in ./statuses (client-safe: the progress page counts these as page errors)
export type AiStop = { code: Code; message: string };
// Shared by fixAll's sections: once one hits the budget or a STOP_AI error, no section starts another round.
export type FixStop = { budget: boolean; ai?: AiStop };

const MAX_ROUNDS = 3;
const MAX_GENERATE_CALLS = 6; // per round; asTools already throws on the 6th tool call
const FOCUS_NODES = 20;
const MAX_FOCUS_CHARS = 20_000;
const MAX_OPS = 50;
const MAX_SUBTREE_DEPTH = 20;
const MAX_SUBTREE_NODES = 500;
const FIX_CONCURRENCY = 2;
const DEFAULT_THRESHOLD = 0.95;
const DEFAULT_CONTEXT_CHARS = 24_000;
const RM_OPTS = { recursive: true, force: true, maxRetries: 3 }; // Windows: a just-closed file can briefly refuse removal

const SYSTEM_PROMPT = `You fix one section of a static HTML clone so it renders like the original page.
Images: original crop, clone crop, heat map (red = differing pixels).
Reply with JSON only: {"ops": [...]} with at most ${MAX_OPS} ops, each one of
{"op":"setStyle","id":string,"style":{cssProp:value}} | {"op":"setAttr","id":string,"attrs":{name:value}} |
{"op":"setText","id":string,"text":string} | {"op":"replaceSubtree","id":string,"node":IRNode} | {"op":"setBehavior","id":string,"behavior":string}.
Only node ids inside this section are allowed. Before answering you may call the inspector tools on the clone (target "clone", at most 5 calls).`;

const str = z.string();
const nodeSchema: z.ZodType<IRNode> = z.lazy(() =>
  z.object({
    id: str.min(1),
    tag: tagSchema,
    attrs: attrsSchema,
    text: str.optional(),
    cls: z.array(str),
    hidden: z.boolean().optional(),
    states: z.object({ hover: str.optional(), focus: str.optional(), active: str.optional() }).optional(),
    behavior: str.optional(),
    children: z.array(nodeSchema),
  }),
);
const replySchema = z.object({
  ops: z
    .array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("setStyle"), id: str, style: z.record(str, str) }),
        z.object({ op: z.literal("setAttr"), id: str, attrs: attrsSchema }),
        z.object({ op: z.literal("setText"), id: str, text: str }),
        z.object({ op: z.literal("replaceSubtree"), id: str, node: nodeSchema }),
        z.object({ op: z.literal("setBehavior"), id: str, behavior: str }),
      ]),
    )
    .max(MAX_OPS),
});

const hasCode = (e: unknown, ...codes: Code[]): e is AppError => e instanceof AppError && codes.includes(e.code);
const errorText = (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`;
const pct = (score: number) => `${(score * 100).toFixed(1)}%`;
const selectorFor = (id: string) => `[data-ir-id=${JSON.stringify(id)}]`;

// Depth/size cap on a raw replaceSubtree node, checked before zod recurses into it.
function withinSubtreeLimits(raw: unknown): boolean {
  let count = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_SUBTREE_DEPTH || ++count > MAX_SUBTREE_NODES) return false;
    const kids = (node as { children?: unknown } | null)?.children;
    return !Array.isArray(kids) || kids.every((k) => walk(k, depth + 1));
  };
  return walk(raw, 1);
}

// Pure. AI reply -> ops, or AI_BAD_RESPONSE (bad JSON, bad shape, or an id outside `allowed`).
export function parseOps(text: string, allowed: Set<string>): PatchOp[] {
  const bad = (why: string) => new AppError(Codes.AI_BAD_RESPONSE, `fix reply rejected: ${why}`, { reply: text.slice(0, 200) });
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw bad("not JSON");
  }
  const rawOps = (raw as { ops?: unknown } | null)?.ops;
  if (Array.isArray(rawOps) && rawOps.length <= MAX_OPS && !rawOps.every((op) => withinSubtreeLimits((op as { node?: unknown } | null)?.node))) {
    throw bad(`replaceSubtree node deeper than ${MAX_SUBTREE_DEPTH} or larger than ${MAX_SUBTREE_NODES} nodes`);
  }
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) throw bad(parsed.error.message);
  const outside = parsed.data.ops.find((op) => !allowed.has(op.id));
  if (outside) throw bad(`op targets ${outside.id}, outside the section`);
  return parsed.data.ops;
}

function collectIds(node: IRNode, out: Set<string>): Set<string> {
  out.add(node.id);
  for (const child of node.children) collectIds(child, out);
  return out;
}

// Pure. Clone nodes ranked by red heat pixels inside their root-relative bbox (summed-area table:
// one pass over the heat, O(1) per node). Heat and clone crop share the top-left origin.
function topDiffNodes(heat: PNG, boxes: [string, number, number, number, number][], n: number): { id: string; diffPixels: number }[] {
  const { width: w, height: h, data } = heat;
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) row++;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1]! + row;
    }
  }
  const at = (x: number, y: number) => sat[y * (w + 1) + x]!;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), max);
  return boxes
    .map(([id, x, y, bw, bh]) => {
      const [x0, y0, x1, y1] = [clamp(x, w), clamp(y, h), clamp(x + bw, w), clamp(y + bh, h)];
      return { id, diffPixels: at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0) };
    })
    .filter((f) => f.diffPixels > 0)
    .sort((a, b) => b.diffPixels - a.diffPixels)
    .slice(0, n);
}

// Page context: every [data-ir-id] element of the section (root first), bbox relative to the root.
function cloneBoxesInPage(rootId: string): [string, number, number, number, number][] {
  const root = document.querySelector(`[data-ir-id="${CSS.escape(rootId)}"]`);
  if (!root) return [];
  const origin = root.getBoundingClientRect();
  return [root, ...root.querySelectorAll("[data-ir-id]")].map((el) => {
    const r = el.getBoundingClientRect();
    return [el.getAttribute("data-ir-id") ?? "", r.x - origin.x, r.y - origin.y, r.width, r.height];
  });
}

// Captured node for an IR id under the section root: the id's tree-path suffix walked from the root.
// ponytail: walks the same tree path at every bp, so a bp whose structure differs under the root yields the
// wrong (or no) captured node; match per bp by content hash if that shows up on real sites.
function capturedNode(root: CaptureNode | undefined, rootId: string, id: string): CaptureNode | undefined {
  if (id === rootId) return root;
  if (!id.startsWith(`${rootId}.`)) return undefined; // e.g. a node an earlier replaceSubtree invented
  let node = root;
  for (const step of id.slice(rootId.length + 1).split(".")) node = node?.children[Number(step)];
  return node;
}

type Scored = { scores: Record<Bp, number>; min: number; worst: SectionScore; files: Map<string, Buffer> };

// Emits `ir` into outDir and scores the one section at every bp; keeps its crops in memory
// (scoring the next candidate overwrites them on disk).
async function scoreIr(ctx: FixCtx, ir: IR, t: FixTarget, outDir: string): Promise<Scored> {
  const { workspaceDir } = ctx;
  await emitHtml(ir, { ...ctx.emit, outDir, workspaceDir });
  const rows = await scoreSections(ctx.handle, { workspaceDir, outDir, ir, captures: ctx.captures, pageIds: [t.pageId], sectionIds: [t.sectionId] });
  if (rows.length === 0) throw new Error(`qa-fix: section ${t.sectionId} is not scored on page ${t.pageId}`);
  const worst = rows.reduce((a, b) => (b.score < a.score ? b : a));
  const paths = rows.flatMap((r) => [r.origPath, r.clonePath, r.heatPath].filter((p): p is string => p !== null)); // <= 9
  const files = new Map(await Promise.all(paths.map(async (p) => [p, await readFile(join(workspaceDir, p))] as const)));
  return { scores: Object.fromEntries(rows.map((r) => [r.bp, r.score])) as Record<Bp, number>, min: worst.score, worst, files };
}

export type FocusNode = { id: string; diffPixels: number; captured: Record<string, string>; clone: Record<string, string> | string };

// PURE. FOCUS_NODES as sent (hardening spec §8, real run: 59 124 chars): per node only the props whose captured
// value differs from the clone's (a readStyle failure keeps its error text), the JSON cut to <= maxChars by
// dropping nodes from the end (the fewest diff pixels).
export function focusDiff(nodes: FocusNode[], maxChars = MAX_FOCUS_CHARS): FocusNode[] {
  const pick = (style: Record<string, string>, props: string[]) => Object.fromEntries(props.flatMap((p) => (p in style ? [[p, style[p]!]] : [])));
  const out = nodes.map((n) => {
    if (typeof n.clone === "string") return n;
    const clone = n.clone;
    const props = Object.keys(n.captured).filter((p) => n.captured[p] !== clone[p]);
    return { ...n, captured: pick(n.captured, props), clone: pick(clone, props) };
  });
  while (out.length > 0 && JSON.stringify(out).length > maxChars) out.pop();
  return out;
}

// Mandatory evidence on the best clone at its worst bp: a11y snapshot + the 20 nodes covering the most
// diff pixels, with their captured styles and the clone's computed values for the same props.
async function inspect(ctx: FixCtx, page: Page, t: FixTarget, best: Scored, rootId: string): Promise<{ a11y: string; focus: FocusNode[] }> {
  const { bp, heatPath } = best.worst;
  const capture = ctx.captures.find((c) => c.pageId === t.pageId);
  const root = capture && sectionNodes(capture, ctx.ir, t.pageId, bp).get(t.sectionId);
  const [a11y, boxes] = await Promise.all([snapshotA11y(page, selectorFor(rootId)).catch(errorText), evalWithTimeout(page, "Section node boxes", cloneBoxesInPage, rootId)]);
  const heat = heatPath ? best.files.get(heatPath) : undefined;
  const focus = heat ? topDiffNodes(PNG.sync.read(heat), boxes, FOCUS_NODES) : [];
  const captured = focus.map((f) => capturedNode(root, rootId, f.id)?.style ?? {});
  const props = [...new Set(captured.flatMap((s) => Object.keys(s)))];
  const clone = await Promise.all(focus.map(async (f): Promise<FocusNode["clone"]> => (props.length > 0 ? readStyle(page, selectorFor(f.id), props).catch(errorText) : {})));
  return { a11y, focus: focus.map((f, i) => ({ ...f, captured: captured[i]!, clone: clone[i]! })) };
}

// Generate <-> tool-call loop on the clone page; returns the final reply text. The evidence images go with the
// first call only; a later call carries just the screenshots the AI asked for with the tool, under the same caps
// (hardening spec §6, §8: every request's images <= 384 KiB base64). Exported for tests.
export async function ask(ctx: FixCtx, page: Page, prompt: (scale: number) => ChatMessage[], images: string[]): Promise<string> {
  const inspector = asTools({ clone: page });
  let attach = images;
  let turns: ChatMessage[] = [];
  for (let i = 0; i < MAX_GENERATE_CALLS; i++) {
    // hardening spec §8: each call <= MAX_REQUEST_TOKENS estimated (images dropped first, then the prompt rebuilt smaller)
    const req = fitRequest((scale) => [...prompt(scale), ...turns], attach);
    const res = await generate(ctx.db, { role: "code", projectId: ctx.projectId, messages: req.messages, tools: inspector.tools, ...(req.images.length ? { images: req.images } : {}), signal: ctx.signal, onRetry: ctx.onRetry });
    if (!res.toolCalls?.length) return res.text;
    const results: unknown[] = [];
    // Sequential on purpose: the calls act on one page in the order the AI asked (hover, then readStyle).
    for (const call of res.toolCalls) results.push({ name: call.name, result: await inspector.call(call.name, call.args) });
    const turn = `${res.text}
TOOL_CALLS ${JSON.stringify(res.toolCalls)}`.trim(); // the AI's own turn, then the results
    turns = [...turns, { role: "assistant", content: turn }, { role: "user", content: `TOOL_RESULTS ${JSON.stringify(results)}` }];
    const shots = inspector.takeImages().map((b64) => Buffer.from(b64, "base64"));
    attach = fitImages(shots, { maxWidth: MAX_IMAGE_WIDTH, maxTotalB64: MAX_IMAGES_B64 });
  }
  throw new AppError(Codes.AI_BAD_RESPONSE, `no patch after ${MAX_GENERATE_CALLS} generate calls`, { projectId: ctx.projectId });
}

// One round up to the AI's validated ops: evidence -> graph context -> AI. `reduced` (after an AI_TOO_LARGE, hardening
// spec §8): no images, CONTEXT and FOCUS_NODES at half their budgets.
async function proposeOps(ctx: FixCtx, t: FixTarget, best: Scored, bestDir: string, reduced: boolean): Promise<PatchOp[]> {
  const section = ctx.ir.sections.find((s) => s.id === t.sectionId);
  const file = pageFileNames(ctx.ir.pages).get(t.pageId);
  if (!section || !file) throw new Error(`qa-fix: unknown section ${t.sectionId} / page ${t.pageId}`);
  const rootId = section.root.id;
  const server = await serveDir(bestDir);
  try {
    return await withPage(ctx.handle, async (page) => {
      const { bp, bboxDelta, origPath, clonePath, heatPath } = best.worst;
      await prepareClonePage(page, `${server.url}/${file}`, bp);
      const evidence = await inspect(ctx, page, t, best, rootId);
      const focusIds = evidence.focus.map((f) => f.id);
      const base = reduced ? 0.5 : 1;
      const contextBudget = (ctx.contextBudgetChars ?? DEFAULT_CONTEXT_CHARS) * base;
      // Real-run evidence (hardening spec §6): three full-size crops made one fix request 5.1MB. Downscale to
      // <=1024px wide; if the total base64 is still over the cap, drop heat, then clone (fitImages drops from
      // the end, so [orig, clone, heat] order matters here).
      const buffers = [origPath, clonePath, heatPath].flatMap((p) => (p && best.files.has(p) ? [best.files.get(p)!] : []));
      const images = reduced ? [] : fitImages(buffers, { maxWidth: MAX_IMAGE_WIDTH, maxTotalB64: MAX_IMAGES_B64 });
      // CONTEXT and FOCUS_NODES budgets scale down when the request is over MAX_REQUEST_TOKENS (fitRequest).
      const prompt = (scale: number): ChatMessage[] => {
        const context = contextForFix(ctx.db, ctx.projectId, t.sectionId, Math.floor(contextBudget * scale), focusIds);
        const text = [
          `SECTION ${t.sectionId} page ${t.pageId}`,
          `SCORES ${JSON.stringify(best.scores)} threshold ${ctx.threshold ?? DEFAULT_THRESHOLD}; evidence at bp ${bp}, bbox delta ${bboxDelta}px`,
          `A11Y_SNAPSHOT (clone)\n${evidence.a11y}`,
          `FOCUS_NODES ${JSON.stringify(focusDiff(evidence.focus, Math.floor(MAX_FOCUS_CHARS * base * scale)))}`,
          `CONTEXT ${JSON.stringify(context)}`,
        ].join("\n\n");
        return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }];
      };
      const text = await ask(ctx, page, prompt, images);
      return parseOps(text, collectIds(section.root, new Set()));
    });
  } finally {
    await server.close();
  }
}

function tryApply(ir: IR, ops: PatchOp[]): IR | undefined {
  try {
    return applyPatch(ir, ops);
  } catch (e) {
    if (hasCode(e, Codes.IR_PATCH_INVALID)) return undefined;
    throw e;
  }
}

export async function fixSection(ctx: FixCtx, sectionId: string, pageId: string, stop: FixStop = { budget: false }): Promise<FixResult> {
  const t = { sectionId, pageId };
  const threshold = ctx.threshold ?? DEFAULT_THRESHOLD;
  const tmpDir = (round: number) => join(ctx.workspaceDir, "qa-tmp", `${pageId}-${sectionId}-r${round}`);
  let bestDir = tmpDir(0);
  let candidateDir = bestDir;
  let best: Scored | undefined;
  let diskIsBest = true;
  let rounds = 0;
  let patched = false;
  let failed = false;
  let reduced = false; // an AI_TOO_LARGE seen: this section's next rounds shrink (other sections unaffected)
  const log = (level: "info" | "warn", message: string) => ctx.log?.(level, `fix ${pageId}:${sectionId}${message}`);
  try {
    best = await scoreIr(ctx, ctx.ir, t, bestDir);
    const result = (status: FixResult["status"]): FixResult => ({
      ...t, finalScore: best!.min, scores: best!.scores, rounds, patched, status,
      ...(status === "ai_stopped" && stop.ai ? { errorCode: stop.ai.code, errorMessage: stop.ai.message } : {}),
    });
    while (best.min < threshold && rounds < MAX_ROUNDS) {
      if (stop.budget) return result("budget");
      if (stop.ai) return result("ai_stopped");
      rounds++;
      const round = ` vòng ${rounds}`;
      log("info", `${round}: bắt đầu (điểm ${pct(best.min)})`);
      let ops: PatchOp[];
      let candidateIr: IR | undefined;
      try {
        ops = await proposeOps(ctx, t, best, bestDir, reduced);
        candidateIr = tryApply(ctx.ir, ops);
      } catch (e) {
        if (ctx.signal?.aborted) throw e; // paused: never a budget / AI stop / spent round
        if (hasCode(e, Codes.BUDGET_EXCEEDED)) {
          stop.budget = true;
          return result("budget");
        }
        if (hasCode(e, ...STOP_AI_CODES)) {
          stop.ai ??= { code: e.code, message: e.message };
          return result("ai_stopped");
        }
        if (hasCode(e, Codes.AI_TOO_LARGE)) {
          reduced = true;
          log("warn", `${round}: request quá lớn (AI_TOO_LARGE), vòng sau bỏ ảnh và giảm ngữ cảnh`);
          continue; // the round is spent
        }
        if (hasCode(e, Codes.AI_BAD_RESPONSE)) {
          log("warn", `${round}: AI trả sai định dạng`);
          continue; // the round is spent
        }
        throw e;
      }
      if (!candidateIr) {
        log("warn", `${round}: ops bị IR từ chối`);
        continue; // round spent
      }

      candidateDir = tmpDir(rounds);
      const candidate = await scoreIr(ctx, candidateIr, t, candidateDir);
      // Re-apply onto the latest shared IR: a parallel section may have been accepted meanwhile.
      const merged = candidate.min > best.min ? tryApply(ctx.ir, ops) : undefined;
      if (!merged) {
        // better, but the latest shared IR (a sibling's accepted patch) rejects the ops: an IR rejection too
        if (candidate.min > best.min) log("warn", `${round}: ops bị IR từ chối`);
        else log("info", `${round}: ứng viên ${pct(candidate.min)} < ${pct(best.min)}, revert`);
        diskIsBest = false;
        await rm(candidateDir, RM_OPTS);
        continue;
      }
      ctx.ir = merged;
      writeGraph(ctx.db, ctx.projectId, ctx.ir, ctx.emit.assetMap); // next round's contextForFix sees the accepted patch
      await rm(bestDir, RM_OPTS);
      [bestDir, best, diskIsBest, patched] = [candidateDir, candidate, true, true];
      log("info", `${round}: nhận ứng viên (điểm ${pct(candidate.min)})`);
    }
    const pass = best.min >= threshold;
    log(pass ? "info" : "warn", `: ${pass ? "pass" : "đỏ"} điểm ${pct(best.min)} sau ${rounds} vòng`);
    return result(pass ? "pass" : "red");
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    try {
      // A reverted candidate left its crops under qa/; put the best's back.
      if (best && !diskIsBest) await Promise.all([...best.files].map(([rel, buf]) => writeFile(join(ctx.workspaceDir, rel), buf)));
      for (const dir of new Set([bestDir, candidateDir])) await rm(dir, RM_OPTS);
    } catch (cleanupErr) {
      if (!failed) throw cleanupErr; // never mask the error that got us here
    }
  }
}

// <=2 sections in parallel (spec §9). The caller re-emits out/ and rewrites the graph afterwards.
export async function fixAll(ctx: FixCtx, failing: FixTarget[]): Promise<FixResult[]> {
  const stop: FixStop = { budget: false };
  return mapLimit(failing, FIX_CONCURRENCY, (t) => fixSection(ctx, t.sectionId, t.pageId, stop));
}
