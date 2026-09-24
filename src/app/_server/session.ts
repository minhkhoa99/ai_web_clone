// Process-wide session state (on globalThis so dev HMR keeps it): the headed browser windows opened for
// manual login / CAPTCHA, each auto-closed after 10 minutes (spec §1), and the projects with an exclusive
// route operation in flight (crawl, enqueue+start, delete, folder export). Login credentials: ./credentials.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { isQueuedOrActive } from "@/core/jobs";
import { emit } from "@/core/jobs-base";
import { ApiError, workspaceOf } from "./http";

export { credentialsFor, credentialsSchema, forgetCredentials, holdCredentials, needsCredentials, needsCredentialsFrom, type CredentialsInput } from "./credentials";

type AuthWindow = { handle: BrowserHandle; timer: NodeJS.Timeout };

const AUTH_WAIT_MS = 10 * 60_000;
const g = globalThis as { __sp1Session?: { windows: Map<string, Promise<AuthWindow>>; inflight: Set<string> } };
const state = (g.__sp1Session ??= { windows: new Map(), inflight: new Set() });

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
