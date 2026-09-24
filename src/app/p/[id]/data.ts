// Server-side reads shared by the /p/[id] screens (server components only).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { notFound } from "next/navigation";
import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE, type HistoryRates } from "@/core/estimate";
import { getDb } from "@/app/_server/db";
import { workspaceOf } from "@/app/_server/http";

// No auth_enc: the screens never need the (encrypted) credentials.
export type ProjectView = { id: string; url: string; status: string; progress: number; config_json: string; tokens_used: number };

export function loadProject(id: string): ProjectView {
  const row = getDb().prepare("SELECT id,url,status,progress,config_json,tokens_used FROM projects WHERE id=?").get(id) as ProjectView | undefined;
  if (!row) notFound();
  return row;
}

// A workspace checkpoint that doesn't exist yet reads as `empty`; a corrupt one is an error.
export async function readWorkspaceJson<T>(projectId: string, rel: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(workspaceOf(projectId), rel), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
}

const MIN_SAMPLE = 20; // below this a measured ratio is noise: the estimate's defaults are used

// The estimate's history-based rates (spec parity §4.6): 2 aggregate queries over the whole store.
export function historyRates(db: DatabaseSync = getDb()): HistoryRates {
  const all = db.prepare("SELECT COALESCE(SUM(type='Section'),0) sections, COALESCE(SUM(type='Page'),0) pages FROM nodes").get() as { sections: number; pages: number };
  const done = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.status='completed' AND t.phase='fix') fixes,
              (SELECT COUNT(*) FROM nodes n JOIN projects p ON p.id=n.project_id WHERE p.status='completed' AND n.type='Section') sections`,
    )
    .get() as { fixes: number; sections: number };
  return {
    sectionsPerPage: all.pages >= MIN_SAMPLE ? all.sections / all.pages : DEFAULT_SECTIONS_PER_PAGE,
    fixRate: done.sections >= MIN_SAMPLE ? done.fixes / done.sections : DEFAULT_FIX_RATE,
  };
}
