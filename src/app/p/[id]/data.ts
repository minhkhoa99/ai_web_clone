// Server-side reads shared by the /p/[id] screens (server components only).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { getDb } from "@/app/_server/db";
import { workspaceOf } from "@/app/_server/http";

// No auth_enc: the screens never need the (encrypted) credentials.
export type ProjectView = { id: string; url: string; status: string; progress: number; config_json: string };

export function loadProject(id: string): ProjectView {
  const row = getDb().prepare("SELECT id,url,status,progress,config_json FROM projects WHERE id=?").get(id) as ProjectView | undefined;
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
