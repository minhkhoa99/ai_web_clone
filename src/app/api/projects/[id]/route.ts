import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { config } from "@/core/config";
import { tx } from "@/core/db";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, forgetCredentials } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deletes the workspace, then the rows (a failed rm leaves the project listed, so delete can be retried).
// A queued/running job, a crawl or an open login window -> 409 PROJECT_BUSY (pause / close it first).
export function DELETE(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    const root = resolve(config.workspaceRoot);
    const ws = resolve(root, id);
    if (!ws.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "workspace path escapes the workspace root");
    await exclusive(id, async () => {
      forgetCredentials(db, id);
      await rm(ws, { recursive: true, force: true, maxRetries: 3 });
      tx(db, () => {
        for (const table of ["tasks", "nodes", "edges"]) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
        db.prepare("DELETE FROM projects WHERE id=?").run(id);
      });
    });
    return Response.json({ ok: true });
  });
}
