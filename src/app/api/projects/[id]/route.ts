import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { config } from "@/core/config";
import { tx } from "@/core/db";
import { pauseProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, type IdCtx } from "@/app/_server/http";
import { closeAuthWindow, forgetCredentials } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deletes the workspace, then the rows (a failed rm leaves the project listed, so delete can be retried).
// A running job must be paused first; a queued one is dropped from the queue.
export function DELETE(_req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();
    const project = requireProject(db, id);
    if (project.status === "running") throw new ApiError(409, "BAD_STATE", "pause the project before deleting it");
    const root = resolve(config.workspaceRoot);
    const ws = resolve(root, id);
    if (!ws.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "workspace path escapes the workspace root");
    pauseProject(id);
    await closeAuthWindow(id);
    forgetCredentials(db, id);
    await rm(ws, { recursive: true, force: true, maxRetries: 3 });
    tx(db, () => {
      for (const table of ["tasks", "nodes", "edges"]) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      db.prepare("DELETE FROM projects WHERE id=?").run(id);
    });
    return Response.json({ ok: true });
  });
}
