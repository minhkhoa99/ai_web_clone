// Job orchestrator (spec §4): discover -> capture -> ir -> name -> emit -> qa -> fix -> done over durable
// per-task checkpoints (output renamed into place, then `done` + output_path in one transaction), an
// in-memory event bus for SSE, and a bounded FIFO queue (1 running, <=5 waiting).
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { detectNeedsAuth, autoLogin } from "./auth";
import { openBrowser, withPage, type BrowserHandle } from "./browser";
import { capturePage, type PageCapture } from "./capture";
import { crawl, type CrawlPage } from "./crawl";
import { tx } from "./db";
import { compileV2, emitHtml, type RenderOpts } from "./emit-html";
import { AppError, Codes } from "./errors";
import { workspaceOf, writeJsonAtomic } from "./fsx";
import { writeGraph } from "./graph";
import { buildIR, type IR } from "./ir";
import type { LegacyIR } from "./ir-legacy";
import { migrateIR } from "./ir-migrate";
import { upgradeDocument } from "./interactive-guess";
import { documentStore } from "./ir-store";
import type { FidelityItem } from "./ir-v2";
import { refreshFidelity, type BehaviorResult } from "./fidelity";
import { mapLimit } from "./limit";
import { applySectionNames, fitImages, MAX_IMAGES_B64, MAX_IMAGE_WIDTH, nameSections, thumbnailOf } from "./naming";
import { scoreSections, type SectionScore } from "./qa";
import { checkBehavior } from "./qa-behavior";
import { fixAll, STOP_AI, type AiStop, type FixCtx, type FixResult } from "./qa-fix";
import { SKIP } from "./statuses";
import { readUploads } from "./upload";
import { clearRunSecrets, createSchema, emit, logDetail, pageIdsFor, redact, setRunSecrets, type ProjectConfig, type ProjectStatus, type TaskStatus } from "./jobs-base";
import type { GenerateOptions } from "./gateway";

export { pageIdsFor, projectConfigSchema, subscribe, type JobEvent, type ProjectConfig, type ProjectStatus, type StampedEvent } from "./jobs-base";

// --- db helpers --------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const AI_CIRCUIT_LIMIT = 5;
const MAX_WAITING = 5;
const MAX_PROJECT_ASSET_BYTES = 500 * 1024 * 1024;
const FS_CONCURRENCY = 8;
const RETRY_IN_RUN = new Set<string>([Codes.NAV_TIMEOUT, Codes.BROWSER_CRASH]);
const NO_RETRY = new Set<string>([...SKIP, Codes.LOGIN_FAILED]);
const BUDGET_MSG = "token budget spent: no more AI calls in this run";

type TaskRow = { id: string; phase: string; key: string; status: TaskStatus; attempts: number; error_code: string | null; output_path: string | null };
type ProjectRow = { url: string; mode: "single" | "crawl"; config_json: string };
type PageRef = { pageId: string; url: string };
// qa.json: the last scores + behaviour QA (E2 §5); stale once the IR was edited after scoring
export type QaFile = { scores: SectionScore[]; behavior?: BehaviorResult[]; stale?: true };

const codeOf = (e: unknown): string | null => (e instanceof AppError ? e.code : null);
const rawMessageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const messageFor = (projectId: string, e: unknown): string => redact(projectId, rawMessageOf(e));
const runnable = (t: TaskRow) => t.status === "pending" || (t.status === "failed" && t.attempts < MAX_ATTEMPTS && !NO_RETRY.has(t.error_code ?? ""));

function loadProject(db: DatabaseSync, projectId: string): ProjectRow & { cfg: ProjectConfig } {
  const row = db.prepare("SELECT url,mode,config_json FROM projects WHERE id=?").get(projectId) as ProjectRow | undefined;
  if (!row) throw new Error(`jobs: project ${projectId} not found`);
  return { ...row, cfg: JSON.parse(row.config_json) as ProjectConfig };
}

function tasksOf(db: DatabaseSync, projectId: string, phase: string): TaskRow[] {
  return db
    .prepare("SELECT id,phase,key,status,attempts,error_code,output_path FROM tasks WHERE project_id=? AND phase=? ORDER BY rowid")
    .all(projectId, phase) as TaskRow[];
}

function insertTask(db: DatabaseSync, projectId: string, phase: string, key: string): void {
  db.prepare("INSERT OR IGNORE INTO tasks(id,project_id,phase,key,status) VALUES(?,?,?,?,'pending')").run(randomUUID(), projectId, phase, key);
}

// status_reason follows the status: a new status without a reason clears the old one.
function setStatus(db: DatabaseSync, projectId: string, status: ProjectStatus, reason?: string): void {
  const why = reason ? redact(projectId, reason) : null;
  db.prepare("UPDATE projects SET status=?,status_reason=?,updated_at=unixepoch() WHERE id=?").run(status, why, projectId);
  emit(projectId, why ? { type: "status", status, reason: why } : { type: "status", status });
}

// discover is the sitemap step before the page selection: a draft (only discover done) is 0%, not 100%.
function updateProgress(db: DatabaseSync, projectId: string): { progress: number; tokensUsed: number } {
  const { total, done } = db
    .prepare("SELECT COUNT(*) total, COALESCE(SUM(status='done'),0) done FROM tasks WHERE project_id=? AND phase<>'discover'")
    .get(projectId) as { total: number; done: number };
  const progress = total ? Math.round((done * 100) / total) : 0;
  db.prepare("UPDATE projects SET progress=?,updated_at=unixepoch() WHERE id=?").run(progress, projectId);
  return { progress, tokensUsed: tokensUsedOf(db, projectId) };
}

const tokensUsedOf = (db: DatabaseSync, projectId: string): number =>
  (db.prepare("SELECT tokens_used FROM projects WHERE id=?").get(projectId) as { tokens_used: number } | undefined)?.tokens_used ?? 0;

function startTask(db: DatabaseSync, projectId: string, t: TaskRow): void {
  db.prepare("UPDATE tasks SET status='running',attempts=attempts+1,error_code=NULL,error_msg=NULL,updated_at=unixepoch() WHERE id=?").run(t.id);
  t.attempts++;
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status: "running" });
}

// The checkpoint: only called once `outputPath` exists (renamed into place). `marker` + `message` record a
// non-fatal code on a done task (BUDGET_EXCEEDED, AI stopped, an AI error answered by fallback names).
function finishTask(db: DatabaseSync, projectId: string, t: TaskRow, outputPath: string, marker?: string, message?: string, alsoInTx?: () => void): void {
  const error = message === undefined ? null : redact(projectId, message);
  const p = tx(db, () => {
    db.prepare("UPDATE tasks SET status='done',output_path=?,error_code=?,error_msg=?,updated_at=unixepoch() WHERE id=?").run(outputPath, marker ?? null, error, t.id);
    alsoInTx?.();
    return updateProgress(db, projectId);
  });
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status: "done", ...(marker ? { errorCode: marker } : {}), ...(error ? { error } : {}) });
  emit(projectId, { type: "progress", ...p });
}

function failTask(db: DatabaseSync, projectId: string, t: TaskRow, e: unknown, status: "failed" | "needs_auth" = "failed"): void {
  const errorCode = codeOf(e);
  const message = messageFor(projectId, e);
  db.prepare("UPDATE tasks SET status=?,error_code=?,error_msg=?,updated_at=unixepoch() WHERE id=?").run(status, errorCode, message, t.id);
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status, ...(errorCode ? { errorCode } : {}), error: message });
}

async function dirBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const sizes = await mapLimit(names, FS_CONCURRENCY, async (n) => (await stat(join(dir, n))).size);
  return sizes.reduce((a, b) => a + b, 0);
}

// --- project setup -------------------------------------------------------------------

export function createProject(db: DatabaseSync, input: { url: string; mode: "single" | "crawl"; config: unknown }): string {
  const { url, mode, config: cfg } = createSchema.parse(input);
  const id = randomUUID();
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,'draft')").run(id, url, mode, JSON.stringify(cfg));
  mkdirSync(workspaceOf(id), { recursive: true }); // events.jsonl lives here (the event log never creates the dir)
  return id;
}

// Crawls from the start URL (mode single => depth 0) and checkpoints the result as discover.json.
export async function discoverPages(db: DatabaseSync, projectId: string, handle?: BrowserHandle): Promise<CrawlPage[]> {
  const { url, mode, cfg } = loadProject(db, projectId);
  const ws = workspaceOf(projectId);
  insertTask(db, projectId, "discover", url);
  const t = tasksOf(db, projectId, "discover").find((x) => x.key === url)!;
  emit(projectId, { type: "phase", phase: "discover" });
  startTask(db, projectId, t);
  const own = handle ?? (await openBrowser({ profileDir: join(ws, "profile"), headed: cfg.headed }));
  try {
    const pages = await crawl(own, { start: url, depth: mode === "single" ? 0 : cfg.depth, maxPages: cfg.maxPages, sameOriginOnly: true, delayMs: cfg.delayMs });
    await writeJsonAtomic(join(ws, "discover.json"), pages);
    finishTask(db, projectId, t, "discover.json");
    return pages;
  } catch (e) {
    failTask(db, projectId, t, e);
    throw e;
  } finally {
    if (!handle) await own.close();
  }
}

// Draft only: (re)places the page selection. pages.json maps pageId -> url for the capture tasks.
export async function enqueue(db: DatabaseSync, projectId: string, pageUrls: string[]): Promise<void> {
  const { cfg } = loadProject(db, projectId);
  const { status } = db.prepare("SELECT status FROM projects WHERE id=?").get(projectId) as { status: string };
  if (status !== "draft") throw new Error(`jobs: enqueue needs a draft project, ${projectId} is ${status}`);
  const urls = [...new Set(pageUrls)];
  if (urls.length === 0 || urls.length > cfg.maxPages) throw new RangeError(`jobs: enqueue needs 1..${cfg.maxPages} pages, got ${urls.length}`);
  const ids = pageIdsFor(urls);
  const pages: PageRef[] = ids.map((pageId, i) => ({ pageId, url: urls[i]! }));
  await writeJsonAtomic(join(workspaceOf(projectId), "pages.json"), pages);
  tx(db, () => {
    db.prepare("DELETE FROM tasks WHERE project_id=? AND phase<>'discover'").run(projectId);
    for (const { pageId } of pages) insertTask(db, projectId, "capture", pageId);
    insertTask(db, projectId, "ir", "all");
    for (const { pageId } of pages) insertTask(db, projectId, "name", pageId);
    insertTask(db, projectId, "emit", "all");
    insertTask(db, projectId, "qa", "all");
  });
}

// "Chạy lại QA" only scores: a task of an earlier phase still to run (discover is never run by runProject) would make
// the rescore job a full resume, AI included — the route refuses then (hardening final review #1).
export const pipelineUnfinished = (db: DatabaseSync, projectId: string): boolean =>
  (db.prepare("SELECT id,phase,key,status,attempts,error_code,output_path FROM tasks WHERE project_id=? AND phase NOT IN ('discover','qa','fix')").all(projectId) as TaskRow[]).some(runnable);

const RESCORE_OVERRIDE_MSG = "Đã chạy lại QA — bỏ vòng sửa AI còn dở.";

// "Chạy lại QA" (spec parity §4.3): one qa task keyed `rescore` (re-armed on every press), run through the queue like any
// job. runQa scores and rewrites qa.json (no `stale`) but creates no fix task: a manual edit is never auto-patched.
// A recovered project's outstanding fix tasks are closed (no AI round), and a still-runnable qa:all is done once
// qa.json exists, so qa:rescore is the one that runs.
export function requeueRescore(db: DatabaseSync, projectId: string): void {
  const scored = existsSync(join(workspaceOf(projectId), "qa.json"));
  tx(db, () => {
    closeOutstandingFixes(db, projectId, RESCORE_OVERRIDE_MSG);
    const all = tasksOf(db, projectId, "qa").find((t) => t.key === "all");
    if (scored && all && runnable(all))
      db.prepare("UPDATE tasks SET status='done',output_path='qa.json',error_code=NULL,error_msg=NULL,updated_at=unixepoch() WHERE id=?").run(all.id);
    db.prepare(
      "INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'qa','rescore','pending') ON CONFLICT(project_id,phase,key) DO UPDATE SET status='pending',attempts=0,error_code=NULL,error_msg=NULL,updated_at=unixepoch()",
    ).run(randomUUID(), projectId);
  });
}

// --- run -----------------------------------------------------------------------------

export type JobDeps = {
  openBrowser?: typeof openBrowser;
  capturePage?: typeof capturePage;
  nameSections?: typeof nameSections;
  fixAll?: typeof fixAll;
  scoreSections?: typeof scoreSections;
  checkBehavior?: typeof checkBehavior;
};
export type RunOpts = { credentials?: { user: string; pass: string }; deps?: JobDeps };

type Run = {
  db: DatabaseSync;
  projectId: string;
  url: string;
  cfg: ProjectConfig;
  ws: string;
  handle: BrowserHandle;
  deps: Required<JobDeps>;
  credentials?: RunOpts["credentials"];
  pages: PageRef[];
  captures?: PageCapture[];
  ir?: IR;
  aiFailures: number;
  budgetHit: boolean;
  aiStopped?: AiStop; // a STOP_AI error: no AI call for the rest of the run, the project still completes
  signal: AbortSignal; // aborted = paused: whatever fails after that is the pause, not an error
};

// Projects with a live runProject in this process. Pause aborts the run's AI calls and closes its browser.
type Live = { controller: AbortController; handle?: BrowserHandle };
const running = new Map<string, Live>();
const detailed = new WeakSet<Error>(); // errors whose stack runProject already wrote to run.log
const runnableOf = (run: Run, phase: string) => tasksOf(run.db, run.projectId, phase).filter(runnable);
const log = (run: Run, level: "info" | "warn" | "error", message: string) => emit(run.projectId, { type: "log", level, message: redact(run.projectId, message) });
// A gateway retry (backoff after a 429/5xx/network error): run.log + console only.
const retryLogger = (run: Run, phase: string): GenerateOptions["onRetry"] => (i) =>
  logDetail(run.projectId, "warn", phase, `AI retry ${i.attempt}${i.status ? ` (HTTP ${i.status})` : ""}${i.error ? ` (${i.error})` : ""}, chờ ${i.delayMs}ms`);

function stopAi(run: Run, stop: AiStop): void {
  run.aiStopped = stop;
  log(run, "warn", `AI dừng: ${stop.code} — ${stop.message}`);
}
// Why AI is off for the rest of the run (the marker + message each skipped task gets), if it is.
const aiSkip = (run: Run): { code: string; message: string } | undefined =>
  run.aiStopped ?? (run.budgetHit ? { code: Codes.BUDGET_EXCEEDED, message: BUDGET_MSG } : undefined);

// What loading captures and re-emitting needs: a run, or the editor's view of a finished project.
type EmitSource = Pick<Run, "db" | "projectId" | "ws" | "pages" | "captures">;

async function loadCaptures(run: EmitSource): Promise<PageCapture[]> {
  if (run.captures) return run.captures;
  const done = new Map(tasksOf(run.db, run.projectId, "capture").filter((t) => t.status === "done").map((t) => [t.key, t.output_path!]));
  const paths = run.pages.filter((p) => done.has(p.pageId)).map((p) => join(run.ws, done.get(p.pageId)!));
  run.captures = await mapLimit(paths, FS_CONCURRENCY, async (p) => JSON.parse(await readFile(p, "utf8")) as PageCapture);
  return run.captures;
}

// The job's document through the central loader (E1 §6): the SQLite snapshot once the editor adopted it, else ir.json
// through migrateIR (a v1 checkpoint migrated in memory; the job's next checkpoint writes it as v2). Never adopts.
async function loadIr(run: Run): Promise<IR> {
  run.ir ??= await projectDocuments(run.db).readDocument(run.projectId);
  return run.ir;
}

// A job's IR checkpoint. Adopted: through the store (commitJob: new revision, History reset, ir.json/out/graph
// materialized) so the editor never shows a stale snapshot nor overwrites the job's result. Otherwise ir.json
// (tmp -> rename). true = out/ and the graph already match `ir`.
async function checkpointIr(run: Run, ir: IR): Promise<boolean> {
  const revision = await projectDocuments(run.db).commitJob(run.projectId, ir.revision, ir);
  run.ir = revision === null ? ir : { ...ir, revision };
  if (revision === null) await writeJsonAtomic(join(run.ws, "ir.json"), ir);
  return revision !== null;
}

async function emitOpts(run: EmitSource): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">> {
  const [captures, uploads] = await Promise.all([loadCaptures(run), readUploads(run.ws)]);
  return {
    // R7: editor uploads (uploads.json) join the captured asset map: canvas, out/, export and graph all map them
    assetMap: Object.assign({}, ...captures.map((c) => c.assets), uploads) as Record<string, string>,
    pageUrls: Object.fromEntries(captures.map((c) => [c.pageId, c.url])),
  };
}

// out/ (wiped + rewritten by emitHtml) and the graph, from `ir`.
async function emitOut(run: EmitSource, ir: IR): Promise<void> {
  const opts = await emitOpts(run);
  await emitHtml(ir, { ...opts, outDir: join(run.ws, "out"), workspaceDir: run.ws });
  writeGraph(run.db, run.projectId, ir, opts.assetMap);
}

// --- editor (spec §10): same ir.json checkpoint, emit and graph write as the pipeline ------------

async function editSource(db: DatabaseSync, projectId: string): Promise<EmitSource> {
  const ws = workspaceOf(projectId);
  return { db, projectId, ws, pages: JSON.parse(await readFile(join(ws, "pages.json"), "utf8")) as PageRef[] };
}

// The emit options the editor renders its canvas and partial updates with (asset map incl. uploads, page urls).
export async function editorEmit(db: DatabaseSync, projectId: string): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">> {
  return emitOpts(await editSource(db, projectId));
}

// The editor's document (SQLite snapshot once adopted, else ir.json migrated) and its display view (compileV2).
// `adopt` false (export): read through the loader without adopting.
export async function loadEditable(db: DatabaseSync, projectId: string, adopt = true): Promise<{ doc: IR; ir: LegacyIR; emit: Pick<RenderOpts, "assetMap" | "pageUrls"> }> {
  const src = await editSource(db, projectId);
  const store = projectDocuments(db);
  const [doc, emit] = await Promise.all([adopt ? store.loadDocument(projectId) : store.readDocument(projectId), emitOpts(src)]);
  return { doc, ir: compileV2(doc), emit };
}

// Recovery (hardening spec §3 review): a resume's fix phase loads ir.json and overwrites it (+ out/, qa.json)
// with the AI's patch for each outstanding fix task — silently clobbering a manual edit made while the project
// sat failed/interrupted/paused. The manual edit wins: closing every pending/failed fix task here (status='done',
// no error) makes runnable() skip them, so a later resume never re-fixes (and re-overwrites) that section.
const FIX_OVERRIDE_MSG = "Đã sửa tay trong Editor — bỏ vòng sửa AI.";

function closeOutstandingFixes(db: DatabaseSync, projectId: string, message = FIX_OVERRIDE_MSG): void {
  const { status } = db.prepare("SELECT status FROM projects WHERE id=?").get(projectId) as { status: string };
  if (status === "completed") return; // the editor already requires the fix phase to be idle (not queued/active)
  db.prepare(
    "UPDATE tasks SET status='done',output_path='qa.json',error_code=NULL,error_msg=?,updated_at=unixepoch() WHERE project_id=? AND phase='fix' AND status IN ('pending','failed')",
  ).run(message, projectId);
}

// The QA scores are not recomputed after an edit: qa.json keeps them, marked stale.
async function markQaStale(ws: string): Promise<void> {
  const qa = await readFile(join(ws, "qa.json"), "utf8").then(
    (t) => JSON.parse(t) as QaFile,
    (e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { scores: [] } as QaFile;
      throw e;
    },
  );
  await writeJsonAtomic(join(ws, "qa.json"), { scores: qa.scores, stale: true } satisfies QaFile);
}

// The editor document (E1 §3): SQLite holds the IR v2 snapshot + History; these files are its materialization.
// The first idle read adopts ir.json (a v1 one migrated; the file becomes the v2 mirror: onAdopt). Every step
// marks qa.json stale (first: a crash mid-way never leaves fresh-looking scores over a new out/), rewrites ir.json,
// out/ and the graph. A user step closes the outstanding fix tasks in its transaction (the manual edit wins).
async function materializeDocument(db: DatabaseSync, projectId: string, ir: IR): Promise<void> {
  const src = await editSource(db, projectId);
  await markQaStale(src.ws);
  await writeJsonAtomic(join(src.ws, "ir.json"), ir);
  await emitOut(src, ir);
}

// The job's checkpoint (ir.json) through migrateIR: v2 is only validated (no capture evidence needed) and upgraded
// (E2 §9), v1 is migrated — in memory, a plain read writes nothing. `converted`: the loader changed it (v1, or v2 with
// pre-E2 behaviors), so ir.json, out/ (old data-behavior HTML, old runtime) and the graph are not this document's yet.
async function readCheckpoint(src: EmitSource): Promise<{ ir: IR; converted: boolean }> {
  const raw: unknown = JSON.parse(await readFile(join(src.ws, "ir.json"), "utf8"));
  if ((raw as { version?: unknown } | null)?.version !== 2) return { ir: migrateIR(raw, await loadCaptures(src)), converted: true };
  const ir = migrateIR(raw, []);
  return { ir, converted: ir !== raw }; // upgradeDocument returns the same object when there is nothing to upgrade
}

export function projectDocuments(db: DatabaseSync) {
  const converted = new Set<string>(); // projects whose last loadInitial (this store) read a converted checkpoint
  return documentStore(db, (projectId, ir) => materializeDocument(db, projectId, ir), {
    loadInitial: async (projectId) => {
      const read = await readCheckpoint(await editSource(db, projectId));
      if (read.converted) converted.add(projectId); else converted.delete(projectId);
      return read.ir;
    },
    // Adopting a converted checkpoint is its one-time migration (E1 §6, E2 §9), materialized like a step: the QA
    // scored on the old output goes stale until "Chạy lại QA", ir.json becomes the v2 mirror (so it never converts
    // again), out/ + the graph are re-emitted (data-c, the new runtime).
    onAdopt: async (projectId, ir) => {
      if (converted.has(projectId)) await materializeDocument(db, projectId, ir);
    },
    isBusy: isQueuedOrActive,
    onUserEdit: (projectId) => closeOutstandingFixes(db, projectId),
    // ponytail: each step parses the capture.json files twice (here and in materialize); cache per project if steps get slow
    captures: async (projectId) => loadCaptures(await editSource(db, projectId)),
    mirror: async (projectId, ir) => writeJsonAtomic(join(workspaceOf(projectId), "ir.json"), ir),
    upgrade: upgradeDocument,
  });
}

// The Preview & QA document and its Fidelity report (E1 §5), read through the central loader without adopting (that
// stays the editor's first read): the SQLite snapshot once adopted, else the job's checkpoint (v1 migrated in memory).
// An adopted document's Fidelity is re-derived against the captures and stored in place when idle — this backfills
// documents stored before the analyzer existed and picks up anything since the last step (the preview reloads after
// "Chạy lại QA"); unchanged -> nothing written. Otherwise it is derived in memory, never written.
// No IR yet -> null; a checkpoint the loader refuses (the editor refuses it too) -> null and one item saying so.
export async function previewDocument(db: DatabaseSync, projectId: string): Promise<{ doc: IR | null; fidelity: FidelityItem[] }> {
  const store = projectDocuments(db);
  let doc: IR;
  try {
    doc = await store.readDocument(projectId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { doc: null, fidelity: [] };
    return { doc: null, fidelity: [{ pageId: "", feature: "fidelity-unavailable", status: "partial", note: `Chưa đọc được ir.json (${codeOf(e) ?? "lỗi"})` }] };
  }
  // no pages.json yet, or a missing/corrupt capture.json: no capture evidence (items are then only carried)
  const captures = await editSource(db, projectId).then(loadCaptures).catch((): PageCapture[] => []);
  const stored = await store.updateFidelity(projectId, doc.revision, (items, ir) => refreshFidelity(items, ir, captures));
  return { doc, fidelity: stored ?? refreshFidelity(doc.fidelity ?? [], doc, captures) };
}

// Scores every section x bp of out/, then the behaviour pass of the same qa task (R3), and writes qa.json (tmp -> rename).
async function scoreAll(run: Run, ir: IR): Promise<SectionScore[]> {
  const outDir = join(run.ws, "out");
  const scores = await run.deps.scoreSections(run.handle, { workspaceDir: run.ws, outDir, ir, captures: await loadCaptures(run) });
  const behavior = await run.deps.checkBehavior(run.handle, { outDir, ir, signal: run.signal }); // a pause throws: nothing written
  if (behavior.length) log(run, "info", `QA hành vi: ${behavior.filter((b) => b.ok).length}/${behavior.length} component đạt`);
  await writeJsonAtomic(join(run.ws, "qa.json"), { scores, behavior } satisfies QaFile);
  return scores;
}

// auth mode auto: task `login:<start url>`, run only when credentials are supplied (in memory, never stored).
// A LOGIN_FAILED login is never retried with the same (absent) credentials. false => run stopped.
async function autoLoginIfNeeded(run: Run): Promise<boolean> {
  const creds = run.credentials;
  if (run.cfg.auth.mode !== "auto") return true;
  const find = () => tasksOf(run.db, run.projectId, "login").find((x) => x.key === run.url);
  if (!creds) {
    const prior = find();
    if (prior?.error_code === Codes.LOGIN_FAILED) {
      setStatus(run.db, run.projectId, "failed", Codes.LOGIN_FAILED);
      log(run, "error", "login failed earlier: resume with new credentials");
      return false;
    }
    // needs_auth -> pending on resume: the user logged in by hand in the browser window.
    if (prior?.status === "pending") finishTask(run.db, run.projectId, prior, "profile");
    return true;
  }
  insertTask(run.db, run.projectId, "login", run.url);
  const t = find()!;
  startTask(run.db, run.projectId, t);
  try {
    await withPage(run.handle, async (page) => {
      await page.goto(run.url, { waitUntil: "domcontentloaded" });
      const state = await detectNeedsAuth(page, { requestedUrl: run.url });
      if (state === "captcha") throw new AppError(Codes.CAPTCHA_REQUIRED, `captcha on login page ${run.url}`, { url: run.url });
      if (state === "auth") await autoLogin(page, { user: creds.user, pass: creds.pass, selectors: run.cfg.auth.selectors });
    });
    finishTask(run.db, run.projectId, t, "profile"); // the session lives in the persistent profile
    return true;
  } catch (e) {
    if (run.signal.aborted) throw e;
    const code = codeOf(e);
    failTask(run.db, run.projectId, t, e, code === Codes.CAPTCHA_REQUIRED ? "needs_auth" : "failed");
    if (code === Codes.CAPTCHA_REQUIRED) {
      setStatus(run.db, run.projectId, "needs_auth", code);
      emit(run.projectId, { type: "needs_auth", url: run.url, code });
      return false;
    }
    if (code === Codes.LOGIN_FAILED) {
      setStatus(run.db, run.projectId, "failed", code);
      return false;
    }
    throw e;
  }
}

async function runCaptures(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "capture");
  if (tasks.length === 0) return true;
  emit(run.projectId, { type: "phase", phase: "capture" });
  if (!(await autoLoginIfNeeded(run))) return false;
  const urlOf = new Map(run.pages.map((p) => [p.pageId, p.url]));
  let usedBytes = await dirBytes(join(run.ws, "assets"));
  const captureOne = async (t: TaskRow) => {
    while (!run.signal.aborted) {
      startTask(run.db, run.projectId, t);
      try {
        const meta = await run.deps.capturePage(run.handle, {
          url: urlOf.get(t.key)!,
          pageId: t.key,
          workspaceDir: run.ws,
          budgetBytes: Math.max(0, MAX_PROJECT_ASSET_BYTES - usedBytes),
        });
        usedBytes += meta.assetBytes;
        for (const w of meta.warnings) log(run, "warn", `${t.key}: ${w}`);
        finishTask(run.db, run.projectId, t, meta.capturePath);
        return;
      } catch (e) {
        if (run.signal.aborted) throw e; // paused mid-capture: the task goes back to pending, not failed
        const code = codeOf(e) ?? "";
        const auth = code === Codes.AUTH_REQUIRED || code === Codes.CAPTCHA_REQUIRED;
        failTask(run.db, run.projectId, t, e, auth ? "needs_auth" : "failed");
        if (RETRY_IN_RUN.has(code) && t.attempts < MAX_ATTEMPTS) continue;
        if (!auth && (RETRY_IN_RUN.has(code) || SKIP.has(code))) return log(run, "warn", `capture ${t.key} skipped: ${rawMessageOf(e)}`);
        throw e; // auth wall or unexpected: stop starting captures, let in-flight ones finish
      }
    }
  };
  try {
    await mapLimit(tasks, run.cfg.concurrency, captureOne);
  } catch (e) {
    const code = codeOf(e);
    if (run.signal.aborted || (code !== Codes.AUTH_REQUIRED && code !== Codes.CAPTCHA_REQUIRED)) throw e;
    setStatus(run.db, run.projectId, "needs_auth", code);
    emit(run.projectId, { type: "needs_auth", url: (e as AppError).context?.url as string, code });
    return false;
  }
  return true;
}

async function runIr(run: Run): Promise<boolean> {
  const [t] = runnableOf(run, "ir");
  if (!t) return true;
  emit(run.projectId, { type: "phase", phase: "ir" });
  startTask(run.db, run.projectId, t);
  const captures = await loadCaptures(run);
  if (captures.length === 0) {
    failTask(run.db, run.projectId, t, new Error("no page was captured"));
    setStatus(run.db, run.projectId, "failed", "no page was captured");
    return false;
  }
  await checkpointIr(run, buildIR(captures));
  finishTask(run.db, run.projectId, t, "ir.json");
  return true;
}

// The page's 1440 shot, downscaled, for the naming call; none when the shot is missing.
async function thumbnailFor(run: Run, pageId: string): Promise<{ thumbnail?: string }> {
  const shot = await readFile(join(run.ws, "pages", pageId, "shots", "1440.png")).catch(() => null);
  if (!shot) return {};
  const thumb = PNG.sync.write(thumbnailOf(PNG.sync.read(shot)));
  return { thumbnail: fitImages([thumb], { maxWidth: MAX_IMAGE_WIDTH, maxTotalB64: MAX_IMAGES_B64 })[0] };
}

// Per page, sequential (one AI call at a time keeps the circuit breaker exact). An AI error keeps the
// fallback names nameSections returns; 5 in a row opens the circuit and fails the project. A STOP_AI
// error or the budget ends the AI calls: the remaining pages keep their fallback names.
async function runNames(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "name");
  if (tasks.length > 0) emit(run.projectId, { type: "phase", phase: "name" });
  for (const t of tasks) {
    if (run.signal.aborted) return true;
    startTask(run.db, run.projectId, t);
    const ir = await loadIr(run);
    const skip = aiSkip(run);
    if (skip || !ir.pages.some((p) => p.id === t.key)) {
      // AI off, or the page's capture was skipped: nothing to name, no AI call, no breaker count
      finishTask(run.db, run.projectId, t, "ir.json", skip?.code, skip?.message);
      continue;
    }
    const { names, error, errorMessage } = await run.deps.nameSections(run.db, run.projectId, ir, t.key, {
      ...(await thumbnailFor(run, t.key)),
      signal: run.signal,
      onRetry: retryLogger(run, "name"),
    });
    if (run.signal.aborted) return true; // paused mid-call: the aborted call's fallback is not an answer, no breaker count
    const stops = error !== undefined && STOP_AI.has(error);
    if (error && error !== Codes.BUDGET_EXCEEDED && !stops && ++run.aiFailures >= AI_CIRCUIT_LIMIT) {
      failTask(run.db, run.projectId, t, new AppError(Codes.AI_CIRCUIT_OPEN, `${AI_CIRCUIT_LIMIT} AI failures in a row (last: ${error})`));
      setStatus(run.db, run.projectId, "failed", Codes.AI_CIRCUIT_OPEN);
      return false;
    }
    if (!error) run.aiFailures = 0;
    if (error === Codes.BUDGET_EXCEEDED) run.budgetHit = true;
    if (stops) stopAi(run, { code: error as AiStop["code"], message: errorMessage ?? error });
    else if (error) log(run, "warn", `naming ${t.key}: ${error}, fallback names kept`);
    await checkpointIr(run, applySectionNames(ir, names));
    finishTask(run.db, run.projectId, t, "ir.json", error, errorMessage);
  }
  return true;
}

async function runEmit(run: Run): Promise<boolean> {
  const [t] = runnableOf(run, "emit");
  if (!t) return true;
  emit(run.projectId, { type: "phase", phase: "emit" });
  startTask(run.db, run.projectId, t);
  await emitOut(run, await loadIr(run));
  finishTask(run.db, run.projectId, t, "out");
  return true;
}

// Scores every section; the fix tasks for sections below the threshold are created in the same transaction as qa's done.
// qa:all and qa:rescore both runnable (paused in the first scoring, then "Chạy lại QA"): one scoring, rescore semantics.
async function runQa(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "qa"); // <= 2: keys all, rescore
  if (tasks.length === 0) return true;
  const rescore = tasks.some((t) => t.key === "rescore"); // the key is in the db: also right after an interrupt + resume
  emit(run.projectId, { type: "phase", phase: "qa" });
  for (const t of tasks) startTask(run.db, run.projectId, t);
  // adopted: a failed step's out/ repaired first, a pre-E2 snapshot committed upgraded (a new revision: re-read)
  if (await projectDocuments(run.db).ensureMaterialized(run.projectId, true)) run.ir = undefined;
  const ir = await loadIr(run);
  // not adopted: a converted checkpoint (E2 §9) gets its ir.json and out/ first — both QA passes score the document's
  // own output (data-c, the new runtime), never the old one
  if ((await readCheckpoint(run)).converted && !(await checkpointIr(run, ir))) await emitOut(run, ir);
  const scores = await scoreAll(run, run.ir!);
  const minBy = new Map<string, number>();
  for (const s of scores) {
    const k = `${s.pageId}:${s.sectionId}`;
    minBy.set(k, Math.min(minBy.get(k) ?? 1, s.score));
  }
  const failing = [...minBy].filter(([, min]) => min < run.cfg.threshold).map(([k]) => k);
  for (const t of tasks)
    finishTask(run.db, run.projectId, t, "qa.json", undefined, undefined, () => {
      if (!rescore) for (const k of failing) insertTask(run.db, run.projectId, "fix", k);
    });
  return true;
}

// The fixed document (its Fidelity re-derived) -> ir.json, out/, graph, qa.json: done before the fix tasks'
// checkpoint. A pipeline checkpoint, not a History step (checkpointIr).
async function persistFixes(run: Run, ctx: FixCtx): Promise<void> {
  const ir = { ...ctx.ir, fidelity: refreshFidelity(ctx.ir.fidelity ?? [], ctx.ir, ctx.captures) };
  if (!(await checkpointIr(run, ir))) await emitOut(run, ir);
  await scoreAll(run, run.ir!);
}

async function runFixes(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "fix");
  if (tasks.length === 0 || run.signal.aborted) return true;
  emit(run.projectId, { type: "phase", phase: "fix" });
  for (const t of tasks) startTask(run.db, run.projectId, t);
  const skip = aiSkip(run);
  if (skip) {
    for (const t of tasks) finishTask(run.db, run.projectId, t, "qa.json", skip.code, skip.message);
    return true;
  }
  const targets = tasks.map((t) => {
    const i = t.key.indexOf(":");
    return { pageId: t.key.slice(0, i), sectionId: t.key.slice(i + 1) };
  });
  const captures = await loadCaptures(run);
  const doc = await loadIr(run); // the fix loop edits the v2 document through the command core
  const ctx: FixCtx = {
    db: run.db,
    projectId: run.projectId,
    handle: run.handle,
    workspaceDir: run.ws,
    ir: doc,
    captures,
    emit: await emitOpts(run),
    threshold: run.cfg.threshold,
    signal: run.signal,
    log: (level, message) => log(run, level, message),
    onRetry: retryLogger(run, "fix"),
  };
  // The graph from the persisted IR: after a crash mid-fix it may hold an accepted-but-unsaved patch.
  writeGraph(run.db, run.projectId, ctx.ir, ctx.emit.assetMap);
  let results: FixResult[];
  try {
    results = await run.deps.fixAll(ctx, targets);
  } catch (e) {
    if (run.signal.aborted) throw e; // paused: not an AI failure
    const code = codeOf(e);
    const ai = code?.startsWith("AI_") ? code : undefined;
    if (!ai || (!STOP_AI.has(ai) && (ai === Codes.AI_CIRCUIT_OPEN || ++run.aiFailures >= AI_CIRCUIT_LIMIT))) {
      for (const t of tasks) failTask(run.db, run.projectId, t, e);
      if (!ai) throw e;
      setStatus(run.db, run.projectId, "failed", Codes.AI_CIRCUIT_OPEN);
      return false;
    }
    // An AI error below the breaker: the tasks finish red (never retried), so keep what a sibling section
    // already merged into ctx.ir; the project completes.
    const message = messageFor(run.projectId, e);
    await persistFixes(run, ctx);
    if (STOP_AI.has(ai)) stopAi(run, { code: ai as AiStop["code"], message });
    for (const t of tasks) finishTask(run.db, run.projectId, t, "qa.json", ai, message);
    return true;
  }
  run.aiFailures = 0;
  await persistFixes(run, ctx);
  const stopped = results.find((r) => r.status === "ai_stopped" && r.errorCode);
  // fixSection already logged "AI dừng" through ctx.log the moment it stopped: only the marker here
  if (stopped) run.aiStopped = { code: stopped.errorCode!, message: stopped.errorMessage ?? stopped.errorCode! };
  tasks.forEach((t, i) => {
    const r = results[i];
    if (r?.status === "budget") finishTask(run.db, run.projectId, t, "qa.json", Codes.BUDGET_EXCEEDED, BUDGET_MSG);
    else if (r?.status === "ai_stopped") finishTask(run.db, run.projectId, t, "qa.json", r.errorCode, r.errorMessage);
    else finishTask(run.db, run.projectId, t, "qa.json");
  });
  return true;
}

const PHASES = [runCaptures, runIr, runNames, runEmit, runQa, runFixes];

// Pause = stop now: the tasks it cut off never reached their checkpoint, so they go back to pending, and
// the cut-off attempt is not counted.
function setPaused(db: DatabaseSync, projectId: string): void {
  db.prepare("UPDATE tasks SET status='pending',attempts=MAX(attempts-1,0),updated_at=unixepoch() WHERE project_id=? AND status='running'").run(projectId);
  setStatus(db, projectId, "paused");
}

// Runs every pending task (+ failed ones with attempts < 3 and a retryable code), skipping done ones.
// Stops early on pause, needs_auth, LOGIN_FAILED or an open AI circuit (status set accordingly).
export async function runProject(db: DatabaseSync, projectId: string, opts: RunOpts = {}): Promise<void> {
  const { url, cfg } = loadProject(db, projectId);
  const ws = workspaceOf(projectId);
  const deps = { openBrowser, capturePage, nameSections, fixAll, scoreSections, checkBehavior, ...opts.deps };
  const { user, pass } = opts.credentials ?? {};
  setRunSecrets(projectId, [user ?? "", pass ?? ""]);
  setStatus(db, projectId, "running");
  const live: Live = { controller: new AbortController() };
  const { signal } = live.controller;
  running.set(projectId, live);
  let handle: BrowserHandle | undefined;
  try {
    const pages = JSON.parse(await readFile(join(ws, "pages.json"), "utf8").catch(() => "[]")) as PageRef[];
    handle = live.handle = await deps.openBrowser({ profileDir: join(ws, "profile"), maxPages: cfg.concurrency, headed: cfg.headed });
    const run: Run = { db, projectId, url, cfg, ws, handle, deps, credentials: opts.credentials, pages, aiFailures: 0, budgetHit: false, signal };
    for (const phase of PHASES) {
      if (signal.aborted) return setPaused(db, projectId);
      if (!(await phase(run))) return;
    }
    if (signal.aborted) return setPaused(db, projectId);
    // Completed with AI stopped or the budget spent in this run: the reason says why some output is degraded.
    const reason = run.aiStopped?.code ?? (run.budgetHit ? Codes.BUDGET_EXCEEDED : null);
    tx(db, () => db.prepare("UPDATE projects SET status='completed',status_reason=?,progress=100,updated_at=unixepoch() WHERE id=?").run(reason, projectId));
    emit(projectId, { type: "progress", progress: 100, tokensUsed: tokensUsedOf(db, projectId) });
    emit(projectId, reason ? { type: "status", status: "completed", reason } : { type: "status", status: "completed" });
  } catch (e) {
    if (signal.aborted) return setPaused(db, projectId); // the closed browser / aborted AI call is the pause, not a failure
    // Scrubbed in place: the caller (queue log, tests) sees the same error without the credentials. A non-Error
    // throw is wrapped now: after clearRunSecrets below nothing could scrub its raw value any more.
    const err = e instanceof Error ? e : new Error(messageFor(projectId, e));
    err.message = messageFor(projectId, err);
    if (err.stack) err.stack = redact(projectId, err.stack);
    detailed.add(err);
    logDetail(projectId, "error", "job", err.stack ?? err.message);
    // The task that threw (ir/emit/qa/fix) is still `running`: make it failed so a resume retries it.
    db.prepare("UPDATE tasks SET status='failed',error_code=?,error_msg=?,updated_at=unixepoch() WHERE project_id=? AND status='running'")
      .run(codeOf(err), err.message, projectId);
    setStatus(db, projectId, "failed", codeOf(err) ?? err.message);
    throw err;
  } finally {
    clearRunSecrets(projectId);
    running.delete(projectId);
    await handle?.close().catch(() => {}); // a pause may have closed it already
  }
}

// Running: stops now (hardening spec §2): the AI call in flight is aborted and the browser closed; the run
// then puts its running tasks back to pending and sets `paused`. Waiting in the queue: leaves the queue and
// becomes `paused` now. Otherwise a no-op (never a stale flag for a later run).
export function pauseProject(projectId: string): void {
  const live = running.get(projectId);
  if (live) {
    live.controller.abort();
    void live.handle?.close().catch(() => {});
    return;
  }
  const i = waiting.findIndex((j) => j.projectId === projectId);
  if (i < 0) return;
  const [job] = waiting.splice(i, 1);
  queued.delete(projectId);
  setStatus(job!.db, projectId, "paused");
}

// needs_auth tasks go back to pending (the user handled the login window); done tasks are never re-run.
export async function resumeProject(db: DatabaseSync, projectId: string, opts: RunOpts = {}): Promise<void> {
  db.prepare("UPDATE tasks SET status='pending',updated_at=unixepoch() WHERE project_id=? AND status='needs_auth'").run(projectId);
  await runProject(db, projectId, opts);
}

// On process start: nothing is auto-run, the user presses Resume.
export function recoverOnStartup(db: DatabaseSync): void {
  const running = db.prepare("SELECT id FROM projects WHERE status='running'").all() as { id: string }[];
  tx(db, () => {
    db.prepare("UPDATE tasks SET status='pending',updated_at=unixepoch() WHERE status='running'").run();
    db.prepare("UPDATE projects SET status='interrupted',status_reason=NULL,updated_at=unixepoch() WHERE status='running'").run();
  });
  for (const { id } of running) emit(id, { type: "status", status: "interrupted" });
}

// --- queue -----------------------------------------------------------------------------

const waiting: { projectId: string; db: DatabaseSync; run: () => Promise<void> }[] = [];
const queued = new Set<string>(); // running + waiting
let active: string | null = null;
let activeRun: Promise<void> = Promise.resolve(); // settles once `active` has left the queue

// 1 job runs, <=5 wait (FIFO); beyond that QUEUE_FULL (API -> 429). A project already queued is a no-op.
export function startProject(db: DatabaseSync, projectId: string, opts: RunOpts = {}): void {
  if (queued.has(projectId)) return;
  if (active && waiting.length >= MAX_WAITING) throw new AppError(Codes.QUEUE_FULL, `job queue full (${MAX_WAITING} waiting)`, { projectId });
  queued.add(projectId);
  waiting.push({ projectId, db, run: () => resumeProject(db, projectId, opts) });
  drain();
}

export const isQueuedOrActive = (projectId: string): boolean => queued.has(projectId);
// Waiting in the queue behind the active job (not started yet: its status is still the pre-run one).
export const isWaiting = (projectId: string): boolean => waiting.some((j) => j.projectId === projectId);
// Whether startProject would accept a new project now (lets callers refuse before doing prep work).
export const queueHasRoom = (): boolean => !active || waiting.length < MAX_WAITING;

// DELETE of a busy project: pause it (see pauseProject) and wait up to `ms` for its run to leave the queue.
// true = neither running nor waiting any more. Only queued runs are awaited: the app starts every run via startProject.
export async function stopAndWait(projectId: string, ms: number): Promise<boolean> {
  const wasActive = active === projectId;
  pauseProject(projectId);
  if (wasActive) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([activeRun, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }
  return !queued.has(projectId);
}

function drain(): void {
  if (active) return;
  const job = waiting.shift();
  if (!job) return;
  active = job.projectId;
  activeRun = job
    .run()
    .catch((e: unknown) => {
      emit(job.projectId, { type: "log", level: "error", message: rawMessageOf(e) }); // already scrubbed by runProject
      // thrown before runProject's try (no secrets set yet): its stack is not in run.log yet
      if (!(e instanceof Error && detailed.has(e))) logDetail(job.projectId, "error", "job", e instanceof Error ? (e.stack ?? e.message) : rawMessageOf(e));
    })
    .finally(() => {
      queued.delete(job.projectId);
      active = null;
      drain();
    });
}

