// Per-project text log (hardening spec §4): workspace/<id>/run.log, one `ISO LEVEL [phase] message` entry per line,
// rotated at MAX_RUN_LOG_BYTES to run.prev.log (2 files max). Callers redact first (jobs-base). Deleted with the
// workspace; never served by /files, never exported. No app/ import.
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { workspaceOf } from "./fsx";

export const MAX_RUN_LOG_BYTES = 5 * 1024 * 1024;
export type LogLevel = "info" | "warn" | "error";

type Chain = { writes: Promise<void>; pending: number };
const chains = new Map<string, Chain>(); // only projects with a write in flight
const warned = new Set<string>(); // ponytail: grows by one id per project whose log can't be written; tiny in practice

const filesOf = (id: string) => ({ current: join(workspaceOf(id), "run.log"), prev: join(workspaceOf(id), "run.prev.log") });

export function appendRunLog(projectId: string, level: LogLevel, phase: string, message: string): void {
  // continuation lines (a stack trace) are indented, so every entry still starts with its timestamp
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${phase}] ${message.replace(/\r?\n/g, "\n\t")}\n`;
  const chain = chains.get(projectId) ?? { writes: Promise.resolve(), pending: 0 };
  chains.set(projectId, chain);
  chain.pending++;
  // one write chain per project: appends never interleave, rotation happens between two appends
  chain.writes = chain.writes.then(async () => {
    const { current, prev } = filesOf(projectId);
    try {
      await appendFile(current, line); // creates the file, never the directory (a deleted project stays deleted)
      if ((await stat(current)).size >= MAX_RUN_LOG_BYTES) await rename(current, prev); // atomic, replaces the older segment
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !warned.has(projectId)) {
        warned.add(projectId); // once per project: a log write failure never breaks a job
        console.error(`run-log: cannot write ${current}: ${(e as Error).message}`);
      }
    } finally {
      if (--chain.pending === 0) chains.delete(projectId);
    }
  });
}

const readOr = (path: string) => readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "" : Promise.reject(e)));

// prev + current, after the writes already queued (a download right after an event includes it).
export async function readRunLog(projectId: string): Promise<string> {
  await chains.get(projectId)?.writes;
  const { current, prev } = filesOf(projectId);
  return (await readOr(prev)) + (await readOr(current));
}
