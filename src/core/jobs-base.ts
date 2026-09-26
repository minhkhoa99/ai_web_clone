// Job orchestrator support: the frozen project config schema, pageId derivation (both pure) and the
// in-memory per-project event bus behind SSE.
import { z } from "zod";
import { config } from "./config";
import { pathSlug } from "./url";
import { MAX_FIELD_CHARS, record, retain } from "./event-log";
import { appendRunLog, type LogLevel } from "./run-log";

// --- config, page ids -----------------------------------------------------------

const selectorsSchema = z.object({ user: z.string().optional(), pass: z.string().optional(), submit: z.string().optional() }).strict();
// .strict(): unknown keys (a password, an API key) are rejected, never frozen into config_json.
export const projectConfigSchema = z
  .object({
    depth: z.number().int().min(0).max(5).default(2),
    maxPages: z.number().int().min(1).max(100).default(20),
    concurrency: z.number().int().min(1).max(5).default(3),
    delayMs: z.number().int().min(0).max(10_000).default(500),
    headed: z.boolean().default(false), // true: launch Chromium headed so the user can watch the run live (session/login window is unaffected)
    threshold: z.number().min(0).max(1).default(0.95),
    tokenBudget: z.number().int().positive().default(config.tokenBudget),
    providerId: z.string().optional(),
    auth: z
      .object({ mode: z.enum(["none", "manual", "auto"]).default("none"), selectors: selectorsSchema.optional() })
      .strict()
      .default({ mode: "none" }),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export const createSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  mode: z.enum(["single", "crawl"]),
  config: projectConfigSchema,
});

// "/" -> home, "/a/b" -> a-b, "/x.html" -> x; lowercased (case-insensitive file systems), dupes -2, -3 in URL order.
export function pageIdsFor(urls: string[]): string[] {
  const used = new Set<string>();
  return urls.map((url) => {
    const slug = pathSlug(new URL(url).pathname).toLowerCase() || "home";
    let id = slug;
    for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
    used.add(id);
    return id;
  });
}

// --- event bus -------------------------------------------------------------------

export type ProjectStatus = "draft" | "running" | "paused" | "interrupted" | "needs_auth" | "failed" | "completed";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "needs_auth";
export type JobEvent =
  | { type: "status"; status: ProjectStatus; reason?: string; queued?: boolean } // queued: only on the SSE's snapshot message
  | { type: "phase"; phase: string }
  | { type: "task"; phase: string; key: string; status: TaskStatus; errorCode?: string; error?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "needs_auth"; url: string; code: string }
  | { type: "progress"; progress: number; tokensUsed: number };
// Server-stamped (epoch ms) in emit: log times and the run clock are real, not the client's receive time.
export type StampedEvent = JobEvent & { at: number };

const listeners = new Map<string, Set<(e: StampedEvent) => void>>();

// A listener pins the project's event ring in RAM (never evicted while an SSE stream is open).
export function subscribe(projectId: string, cb: (e: StampedEvent) => void): () => void {
  const set = listeners.get(projectId) ?? new Set();
  listeners.set(projectId, set.add(cb));
  const release = retain(projectId);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(projectId);
    release();
  };
}

// --- secrets of live runs ------------------------------------------------------------
// Login credentials of each running project: never in an event (SSE, events.jsonl) nor in error_msg (a Playwright
// error can echo a filled value). Longest first, so a user name inside the password can't leave part of it.
const secretsOf = new Map<string, string[]>();

export function setRunSecrets(projectId: string, secrets: string[]): void {
  secretsOf.set(projectId, secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length));
}

export function clearRunSecrets(projectId: string): void {
  secretsOf.delete(projectId);
}

export function redact(projectId: string, text: string): string {
  let out = text;
  for (const secret of secretsOf.get(projectId) ?? []) out = out.split(secret).join("[redacted]");
  return out;
}

// --- run.log + server console (hardening spec §4) -------------------------------------------

// The phase the project's last phase/task event named: the `[phase]` of its status/log lines. Dropped once a run ends.
const phaseOf = new Map<string, string>();

function print(projectId: string, level: LogLevel, phase: string, message: string): void {
  if (level === "info") return;
  (level === "error" ? console.error : console.warn)(`[job ${projectId.slice(0, 8)}] [${phase}] ${message}`);
}

// Server-only detail (a stack trace, a gateway retry): run.log + console for warn/error, never an SSE event.
export function logDetail(projectId: string, level: LogLevel, phase: string, message: string): void {
  const text = redact(projectId, message);
  appendRunLog(projectId, level, phase, text);
  print(projectId, level, phase, text);
}

// One human line per (already redacted) event; the console gets log warn/error, task failed and status failed.
function toRunLog(projectId: string, e: StampedEvent): void {
  if (e.type === "phase" || e.type === "task") phaseOf.set(projectId, e.phase);
  const phase = phaseOf.get(projectId) ?? "job";
  let level: LogLevel = "info";
  let message: string;
  let loud = false;
  switch (e.type) {
    case "status":
      if (e.status !== "running") phaseOf.delete(projectId);
      level = e.status === "failed" ? "error" : e.status === "needs_auth" ? "warn" : "info";
      message = `status ${e.status}${e.reason ? ` (${e.reason})` : ""}`;
      loud = e.status === "failed";
      break;
    case "phase":
      message = `phase ${e.phase}`;
      break;
    case "task":
      level = e.status === "failed" ? "error" : e.status === "needs_auth" || e.errorCode ? "warn" : "info";
      message = `task ${e.key} ${e.status}${e.errorCode ? ` ${e.errorCode}` : ""}${e.error ? `: ${e.error}` : ""}`;
      loud = e.status === "failed";
      break;
    case "log":
      level = e.level;
      message = e.message;
      loud = true;
      break;
    case "needs_auth":
      level = "warn";
      message = `needs_auth ${e.code} ${e.url}`;
      break;
    default:
      return;
  }
  appendRunLog(projectId, level, phase, message);
  if (loud) print(projectId, level, phase, message);
}

const REDACTED_FIELDS = ["message", "reason", "error", "url"] as const;

// Fixed order, synchronous: stamp + redact + cut, record (all but progress: noisy, derivable), then notify.
export function emit(projectId: string, e: JobEvent): void {
  const stamped: StampedEvent = { ...e, at: Date.now() };
  const bag: Record<string, unknown> = stamped;
  for (const k of REDACTED_FIELDS) {
    const v = bag[k];
    if (typeof v === "string") bag[k] = redact(projectId, v).slice(0, MAX_FIELD_CHARS);
  }
  if (stamped.type !== "progress") {
    record(projectId, stamped);
    toRunLog(projectId, stamped);
  }
  for (const cb of listeners.get(projectId) ?? []) {
    try {
      cb(stamped);
    } catch {
      // a broken subscriber (closed SSE stream) must never break the job
    }
  }
}
