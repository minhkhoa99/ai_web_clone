// Process-wide auth state (on globalThis so dev HMR keeps it): login credentials held in RAM for a
// project's runs (spec §3; "remember" additionally stores them encrypted), and the headed browser
// windows opened for manual login / CAPTCHA, each auto-closed after 10 minutes (spec §1), and the
// projects with an exclusive route operation in flight (crawl, enqueue+start, delete, folder export).
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { decrypt, encrypt } from "@/core/crypto";
import { Codes } from "@/core/errors";
import { isQueuedOrActive } from "@/core/jobs";
import { emit } from "@/core/jobs-base";
import { ApiError, workspaceOf, type ProjectRow } from "./http";

type Creds = { user: string; pass: string };
type AuthWindow = { handle: BrowserHandle; timer: NodeJS.Timeout };

const AUTH_WAIT_MS = 10 * 60_000;
const g = globalThis as { __sp1Session?: { creds: Map<string, Creds>; windows: Map<string, Promise<AuthWindow>>; inflight: Set<string> } };
const state = (g.__sp1Session ??= { creds: new Map(), windows: new Map(), inflight: new Set() });

// Busy = a queued/active job, an exclusive op in flight, or an open auth window (unless the caller handles it).
export function assertIdle(projectId: string, opts: { ignoreAuthWindow?: boolean } = {}): void {
  const busy = isQueuedOrActive(projectId) || state.inflight.has(projectId) || (!opts.ignoreAuthWindow && state.windows.has(projectId));
  if (busy) throw new ApiError(409, "PROJECT_BUSY", `project ${projectId} is busy (job, crawl or login window in progress)`);
}

// Runs fn with the project marked busy; the check and the mark happen in the same tick (no race).
export async function exclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  assertIdle(projectId);
  state.inflight.add(projectId);
  try {
    return await fn();
  } finally {
    state.inflight.delete(projectId);
  }
}

export const credentialsSchema = z
  .object({ user: z.string().min(1).max(256), pass: z.string().min(1).max(1024), remember: z.boolean().optional() })
  .strict();
export type CredentialsInput = z.infer<typeof credentialsSchema>;

// Fresh credentials replace the held ones; "remember" is decided per submission (unticked clears the stored copy).
export function holdCredentials(db: DatabaseSync, projectId: string, c: CredentialsInput): Creds {
  const creds = { user: c.user, pass: c.pass };
  state.creds.set(projectId, creds);
  db.prepare("UPDATE projects SET auth_enc=? WHERE id=?").run(c.remember ? encrypt(JSON.stringify(creds)) : null, projectId);
  return creds;
}

export function forgetCredentials(db: DatabaseSync, projectId: string): void {
  state.creds.delete(projectId);
  db.prepare("UPDATE projects SET auth_enc=NULL WHERE id=?").run(projectId);
}

// Credentials for a run: fresh ones from the request win; else the held/remembered ones, unless the last
// login failed with them (a wrong password is never retried: account lockout).
export function credentialsFor(db: DatabaseSync, project: ProjectRow, fresh?: CredentialsInput): Creds | undefined {
  if (fresh) return holdCredentials(db, project.id, fresh);
  const failed = db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND phase='login' AND error_code=?").get(project.id, Codes.LOGIN_FAILED);
  if (failed) {
    forgetCredentials(db, project.id);
    return undefined;
  }
  return state.creds.get(project.id) ?? (project.auth_enc ? (JSON.parse(decrypt(project.auth_enc)) as Creds) : undefined);
}

// Opens (once) a real headed browser on the project's profile at `url`; the user logs in / solves the CAPTCHA by hand.
export async function openAuthWindow(db: DatabaseSync, projectId: string, url: string): Promise<void> {
  if (state.windows.has(projectId)) return;
  const opening = (async (): Promise<AuthWindow> => {
    const handle = await openBrowser({ profileDir: join(workspaceOf(projectId), "profile"), headed: true });
    const timer = setTimeout(() => void timeOut(db, projectId), AUTH_WAIT_MS);
    timer.unref();
    handle.context.once("close", () => {
      clearTimeout(timer);
      state.windows.delete(projectId); // the user closed the window: a later open starts a fresh one
    });
    const page = await handle.context.newPage();
    // not awaited: the window is usable even if the first navigation is slow or fails
    page.goto(url, { waitUntil: "domcontentloaded" }).catch((e: unknown) =>
      emit(projectId, { type: "log", level: "warn", message: `auth window: ${e instanceof Error ? e.message : String(e)}` }),
    );
    return { handle, timer };
  })();
  state.windows.set(projectId, opening);
  opening.catch(() => state.windows.delete(projectId));
  await opening;
}

export async function closeAuthWindow(projectId: string): Promise<void> {
  const opening = state.windows.get(projectId);
  if (!opening) return;
  state.windows.delete(projectId);
  const w = await opening.catch(() => null);
  if (!w) return;
  clearTimeout(w.timer);
  await w.handle.close();
}

async function timeOut(db: DatabaseSync, projectId: string): Promise<void> {
  await closeAuthWindow(projectId);
  const reason = "manual login not completed within 10 minutes";
  const { changes } = db.prepare("UPDATE projects SET status='failed',updated_at=unixepoch() WHERE id=? AND status='needs_auth'").run(projectId);
  if (changes) emit(projectId, { type: "status", status: "failed", reason });
}
