import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, workspaceOf, type IdCtx, type ProjectRow } from "@/app/_server/http";
import { assertIdle, openAuthWindow } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The page behind the auth wall: a login task's key is its URL, a capture task's key is a pageId (pages.json).
async function authUrl(db: DatabaseSync, project: ProjectRow): Promise<string> {
  const task = db.prepare("SELECT phase,key FROM tasks WHERE project_id=? AND status='needs_auth' ORDER BY rowid LIMIT 1").get(project.id) as
    | { phase: string; key: string }
    | undefined;
  if (!task) return project.url;
  if (task.phase !== "capture") return task.key;
  const pages = JSON.parse(await readFile(join(workspaceOf(project.id), "pages.json"), "utf8")) as { pageId: string; url: string }[];
  return pages.find((p) => p.pageId === task.key)?.url ?? project.url;
}

// Manual login (spec §3 option 1): a real headed window; the user logs in / solves the CAPTCHA, then calls auth/continue.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, ["needs_auth"], "open a login window for");
    const url = await authUrl(db, project);
    // same tick as openAuthWindow registering the window: nothing can start in between. Re-opening is idempotent.
    assertIdle(id, { ignoreAuthWindow: true });
    await openAuthWindow(db, id, url);
    return Response.json({ ok: true, url });
  });
}
