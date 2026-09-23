// Job orchestrator (spec §4): discover -> capture -> ir -> name -> emit -> qa -> fix -> done over durable
// per-task checkpoints (output renamed into place, then `done` + output_path in one transaction), an
// in-memory event bus for SSE, and a bounded FIFO queue (1 running, <=5 waiting).
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { detectNeedsAuth, autoLogin } from "./auth";
import { openBrowser, withPage, type BrowserHandle } from "./browser";
import { capturePage, type PageCapture } from "./capture";
import { config } from "./config";
import { crawl, type CrawlPage } from "./crawl";
import { tx } from "./db";
import { emitHtml, type RenderOpts } from "./emit-html";
import { AppError, Codes } from "./errors";
import { writeGraph } from "./graph";
import { buildIR, type IR } from "./ir";
import { mapLimit } from "./limit";
import { applySectionNames, nameSections } from "./naming";
import { scoreSections, type SectionScore } from "./qa";
import { fixAll, type FixCtx, type FixResult } from "./qa-fix";
import { createSchema, emit, pageIdsFor, type ProjectConfig, type ProjectStatus, type TaskStatus } from "./jobs-base";

export { pageIdsFor, projectConfigSchema, subscribe, type JobEvent, type ProjectConfig, type ProjectStatus } from "./jobs-base";

// --- db helpers --------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const AI_CIRCUIT_LIMIT = 5;
const MAX_WAITING = 5;
const MAX_PROJECT_ASSET_BYTES = 500 * 1024 * 1024;
const FS_CONCURRENCY = 8;
const RETRY_IN_RUN = new Set<string>([Codes.NAV_TIMEOUT, Codes.BROWSER_CRASH]);
const SKIP = new Set<string>([Codes.ROBOTS_DISALLOWED, Codes.ASSET_TOO_LARGE, Codes.NODE_LIMIT, Codes.PROJECT_SIZE_LIMIT]);
const NO_RETRY = new Set<string>([...SKIP, Codes.LOGIN_FAILED]);

type TaskRow = { id: string; phase: string; key: string; status: TaskStatus; attempts: number; error_code: string | null; output_path: string | null };
type ProjectRow = { url: string; mode: "single" | "crawl"; config_json: string };
type PageRef = { pageId: string; url: string };

const codeOf = (e: unknown): string | null => (e instanceof AppError ? e.code : null);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const runnable = (t: TaskRow) => t.status === "pending" || (t.status === "failed" && t.attempts < MAX_ATTEMPTS && !NO_RETRY.has(t.error_code ?? ""));
const workspaceOf = (projectId: string) => join(config.workspaceRoot, projectId);

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

function setStatus(db: DatabaseSync, projectId: string, status: ProjectStatus, reason?: string): void {
  db.prepare("UPDATE projects SET status=?,updated_at=unixepoch() WHERE id=?").run(status, projectId);
  emit(projectId, reason ? { type: "status", status, reason } : { type: "status", status });
}

function updateProgress(db: DatabaseSync, projectId: string): number {
  const { total, done } = db
    .prepare("SELECT COUNT(*) total, COALESCE(SUM(status='done'),0) done FROM tasks WHERE project_id=?")
    .get(projectId) as { total: number; done: number };
  const progress = total ? Math.round((done * 100) / total) : 0;
  db.prepare("UPDATE projects SET progress=?,updated_at=unixepoch() WHERE id=?").run(progress, projectId);
  return progress;
}

function startTask(db: DatabaseSync, projectId: string, t: TaskRow): void {
  db.prepare("UPDATE tasks SET status='running',attempts=attempts+1,error_code=NULL,error_msg=NULL,updated_at=unixepoch() WHERE id=?").run(t.id);
  t.attempts++;
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status: "running" });
}

// The checkpoint: only called once `outputPath` exists (renamed into place). `marker` records a
// non-fatal code on a done task (BUDGET_EXCEEDED, an AI error answered by fallback names).
function finishTask(db: DatabaseSync, projectId: string, t: TaskRow, outputPath: string, marker?: string, alsoInTx?: () => void): void {
  const progress = tx(db, () => {
    db.prepare("UPDATE tasks SET status='done',output_path=?,error_code=?,updated_at=unixepoch() WHERE id=?").run(outputPath, marker ?? null, t.id);
    alsoInTx?.();
    return updateProgress(db, projectId);
  });
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status: "done", ...(marker ? { errorCode: marker } : {}) });
  emit(projectId, { type: "progress", progress });
}

function failTask(db: DatabaseSync, projectId: string, t: TaskRow, e: unknown, status: "failed" | "needs_auth" = "failed"): void {
  const errorCode = codeOf(e);
  db.prepare("UPDATE tasks SET status=?,error_code=?,error_msg=?,updated_at=unixepoch() WHERE id=?").run(status, errorCode, messageOf(e), t.id);
  emit(projectId, { type: "task", phase: t.phase, key: t.key, status, ...(errorCode ? { errorCode } : {}), error: messageOf(e) });
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data));
  await rename(`${path}.tmp`, path);
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
  const own = handle ?? (await openBrowser({ profileDir: join(ws, "profile") }));
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

// --- run -----------------------------------------------------------------------------

export type JobDeps = {
  openBrowser?: typeof openBrowser;
  capturePage?: typeof capturePage;
  nameSections?: typeof nameSections;
  fixAll?: typeof fixAll;
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
};

const paused = new Set<string>();
const running = new Set<string>(); // projects with a live runProject in this process
const runnableOf = (run: Run, phase: string) => tasksOf(run.db, run.projectId, phase).filter(runnable);
const log = (run: Run, level: "info" | "warn" | "error", message: string) => emit(run.projectId, { type: "log", level, message });

async function loadCaptures(run: Run): Promise<PageCapture[]> {
  if (run.captures) return run.captures;
  const done = new Map(tasksOf(run.db, run.projectId, "capture").filter((t) => t.status === "done").map((t) => [t.key, t.output_path!]));
  const paths = run.pages.filter((p) => done.has(p.pageId)).map((p) => join(run.ws, done.get(p.pageId)!));
  run.captures = await mapLimit(paths, FS_CONCURRENCY, async (p) => JSON.parse(await readFile(p, "utf8")) as PageCapture);
  return run.captures;
}

async function loadIr(run: Run): Promise<IR> {
  run.ir ??= JSON.parse(await readFile(join(run.ws, "ir.json"), "utf8")) as IR;
  return run.ir;
}

async function emitOpts(run: Run): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">> {
  const captures = await loadCaptures(run);
  return {
    assetMap: Object.assign({}, ...captures.map((c) => c.assets)) as Record<string, string>,
    pageUrls: Object.fromEntries(captures.map((c) => [c.pageId, c.url])),
  };
}

// out/ (wiped + rewritten by emitHtml) and the graph, from `ir`.
async function emitOut(run: Run, ir: IR): Promise<void> {
  const opts = await emitOpts(run);
  await emitHtml(ir, { ...opts, outDir: join(run.ws, "out"), workspaceDir: run.ws });
  writeGraph(run.db, run.projectId, ir, opts.assetMap);
}

// Scores every section x bp of out/ and writes qa.json (tmp -> rename).
async function scoreAll(run: Run, ir: IR): Promise<SectionScore[]> {
  const scores = await scoreSections(run.handle, { workspaceDir: run.ws, outDir: join(run.ws, "out"), ir, captures: await loadCaptures(run) });
  await writeJsonAtomic(join(run.ws, "qa.json"), scores);
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
    while (!paused.has(run.projectId)) {
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
        const code = codeOf(e) ?? "";
        const auth = code === Codes.AUTH_REQUIRED || code === Codes.CAPTCHA_REQUIRED;
        failTask(run.db, run.projectId, t, e, auth ? "needs_auth" : "failed");
        if (RETRY_IN_RUN.has(code) && t.attempts < MAX_ATTEMPTS) continue;
        if (!auth && (RETRY_IN_RUN.has(code) || SKIP.has(code))) return log(run, "warn", `capture ${t.key} skipped: ${messageOf(e)}`);
        throw e; // auth wall or unexpected: stop starting captures, let in-flight ones finish
      }
    }
  };
  try {
    await mapLimit(tasks, run.cfg.concurrency, captureOne);
  } catch (e) {
    const code = codeOf(e);
    if (code !== Codes.AUTH_REQUIRED && code !== Codes.CAPTCHA_REQUIRED) throw e;
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
  run.ir = buildIR(captures);
  await writeJsonAtomic(join(run.ws, "ir.json"), run.ir);
  finishTask(run.db, run.projectId, t, "ir.json");
  return true;
}

// Per page, sequential (one AI call at a time keeps the circuit breaker exact). An AI error keeps the
// fallback names nameSections returns; 5 in a row opens the circuit and fails the project.
async function runNames(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "name");
  if (tasks.length > 0) emit(run.projectId, { type: "phase", phase: "name" });
  for (const t of tasks) {
    if (paused.has(run.projectId)) return true;
    startTask(run.db, run.projectId, t);
    const ir = await loadIr(run);
    if (run.budgetHit || !ir.pages.some((p) => p.id === t.key)) {
      // budget spent, or the page's capture was skipped: nothing to name, no AI call, no breaker count
      finishTask(run.db, run.projectId, t, "ir.json", run.budgetHit ? Codes.BUDGET_EXCEEDED : undefined);
      continue;
    }
    const { names, error } = await run.deps.nameSections(run.db, run.projectId, ir, t.key);
    if (error && error !== Codes.BUDGET_EXCEEDED && ++run.aiFailures >= AI_CIRCUIT_LIMIT) {
      failTask(run.db, run.projectId, t, new AppError(Codes.AI_CIRCUIT_OPEN, `${AI_CIRCUIT_LIMIT} AI failures in a row (last: ${error})`));
      setStatus(run.db, run.projectId, "failed", Codes.AI_CIRCUIT_OPEN);
      return false;
    }
    if (!error) run.aiFailures = 0;
    if (error === Codes.BUDGET_EXCEEDED) run.budgetHit = true;
    if (error) log(run, "warn", `naming ${t.key}: ${error}, fallback names kept`);
    run.ir = applySectionNames(ir, names);
    await writeJsonAtomic(join(run.ws, "ir.json"), run.ir);
    finishTask(run.db, run.projectId, t, "ir.json", error);
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
async function runQa(run: Run): Promise<boolean> {
  const [t] = runnableOf(run, "qa");
  if (!t) return true;
  emit(run.projectId, { type: "phase", phase: "qa" });
  startTask(run.db, run.projectId, t);
  const scores = await scoreAll(run, await loadIr(run));
  const minBy = new Map<string, number>();
  for (const s of scores) {
    const k = `${s.pageId}:${s.sectionId}`;
    minBy.set(k, Math.min(minBy.get(k) ?? 1, s.score));
  }
  const failing = [...minBy].filter(([, min]) => min < run.cfg.threshold).map(([k]) => k);
  finishTask(run.db, run.projectId, t, "qa.json", undefined, () => {
    for (const k of failing) insertTask(run.db, run.projectId, "fix", k);
  });
  return true;
}

async function runFixes(run: Run): Promise<boolean> {
  const tasks = runnableOf(run, "fix");
  if (tasks.length === 0 || paused.has(run.projectId)) return true;
  emit(run.projectId, { type: "phase", phase: "fix" });
  for (const t of tasks) startTask(run.db, run.projectId, t);
  if (run.budgetHit) {
    for (const t of tasks) finishTask(run.db, run.projectId, t, "qa.json", Codes.BUDGET_EXCEEDED);
    return true;
  }
  const targets = tasks.map((t) => {
    const i = t.key.indexOf(":");
    return { pageId: t.key.slice(0, i), sectionId: t.key.slice(i + 1) };
  });
  const ctx: FixCtx = {
    db: run.db,
    projectId: run.projectId,
    handle: run.handle,
    workspaceDir: run.ws,
    ir: await loadIr(run),
    captures: await loadCaptures(run),
    emit: await emitOpts(run),
    threshold: run.cfg.threshold,
  };
  let results: FixResult[];
  try {
    results = await run.deps.fixAll(ctx, targets);
  } catch (e) {
    for (const t of tasks) failTask(run.db, run.projectId, t, e);
    if (!codeOf(e)?.startsWith("AI_")) throw e;
    const reason = ++run.aiFailures >= AI_CIRCUIT_LIMIT ? Codes.AI_CIRCUIT_OPEN : codeOf(e)!;
    setStatus(run.db, run.projectId, "failed", reason);
    return false;
  }
  run.aiFailures = 0;
  run.ir = ctx.ir;
  await writeJsonAtomic(join(run.ws, "ir.json"), run.ir);
  await emitOut(run, run.ir);
  await scoreAll(run, run.ir);
  tasks.forEach((t, i) => finishTask(run.db, run.projectId, t, "qa.json", results[i]?.status === "budget" ? Codes.BUDGET_EXCEEDED : undefined));
  return true;
}

const PHASES = [runCaptures, runIr, runNames, runEmit, runQa, runFixes];

// Runs every pending task (+ failed ones with attempts < 3 and a retryable code), skipping done ones.
// Stops early on pause, needs_auth, LOGIN_FAILED or an open AI circuit (status set accordingly).
export async function runProject(db: DatabaseSync, projectId: string, opts: RunOpts = {}): Promise<void> {
  const { url, cfg } = loadProject(db, projectId);
  const ws = workspaceOf(projectId);
  const deps = { openBrowser, capturePage, nameSections, fixAll, ...opts.deps };
  setStatus(db, projectId, "running");
  running.add(projectId);
  let handle: BrowserHandle | undefined;
  try {
    const pages = JSON.parse(await readFile(join(ws, "pages.json"), "utf8").catch(() => "[]")) as PageRef[];
    handle = await deps.openBrowser({ profileDir: join(ws, "profile"), maxPages: cfg.concurrency });
    const run: Run = { db, projectId, url, cfg, ws, handle, deps, credentials: opts.credentials, pages, aiFailures: 0, budgetHit: false };
    for (const phase of PHASES) {
      if (paused.has(projectId)) return setStatus(db, projectId, "paused");
      if (!(await phase(run))) return;
    }
    if (paused.has(projectId)) return setStatus(db, projectId, "paused");
    tx(db, () => db.prepare("UPDATE projects SET status='completed',progress=100,updated_at=unixepoch() WHERE id=?").run(projectId));
    emit(projectId, { type: "progress", progress: 100 });
    emit(projectId, { type: "status", status: "completed" });
  } catch (e) {
    // The task that threw (ir/emit/qa/fix) is still `running`: make it failed so a resume retries it.
    db.prepare("UPDATE tasks SET status='failed',error_code=?,error_msg=?,updated_at=unixepoch() WHERE project_id=? AND status='running'")
      .run(codeOf(e), messageOf(e), projectId);
    setStatus(db, projectId, "failed", codeOf(e) ?? messageOf(e));
    throw e;
  } finally {
    running.delete(projectId);
    paused.delete(projectId);
    await handle?.close();
  }
}

// Running: no new task starts, running ones finish, then the run sets `paused`. Waiting in the queue:
// leaves the queue and becomes `paused` now. Otherwise a no-op (never a stale flag for a later run).
export function pauseProject(projectId: string): void {
  if (running.has(projectId)) {
    paused.add(projectId);
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
    db.prepare("UPDATE projects SET status='interrupted',updated_at=unixepoch() WHERE status='running'").run();
  });
  for (const { id } of running) emit(id, { type: "status", status: "interrupted" });
}

// --- queue -----------------------------------------------------------------------------

const waiting: { projectId: string; db: DatabaseSync; run: () => Promise<void> }[] = [];
const queued = new Set<string>(); // running + waiting
let active: string | null = null;

// 1 job runs, <=5 wait (FIFO); beyond that QUEUE_FULL (API -> 429). A project already queued is a no-op.
export function startProject(db: DatabaseSync, projectId: string, opts: RunOpts = {}): void {
  if (queued.has(projectId)) return;
  if (active && waiting.length >= MAX_WAITING) throw new AppError(Codes.QUEUE_FULL, `job queue full (${MAX_WAITING} waiting)`, { projectId });
  queued.add(projectId);
  waiting.push({ projectId, db, run: () => resumeProject(db, projectId, opts) });
  drain();
}

export const isQueuedOrActive = (projectId: string): boolean => queued.has(projectId);
// Whether startProject would accept a new project now (lets callers refuse before doing prep work).
export const queueHasRoom = (): boolean => !active || waiting.length < MAX_WAITING;

function drain(): void {
  if (active) return;
  const job = waiting.shift();
  if (!job) return;
  active = job.projectId;
  job
    .run()
    .catch((e: unknown) => emit(job.projectId, { type: "log", level: "error", message: messageOf(e) }))
    .finally(() => {
      queued.delete(job.projectId);
      active = null;
      drain();
    });
}

