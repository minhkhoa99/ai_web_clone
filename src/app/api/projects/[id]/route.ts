import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { config } from "@/core/config";
import { clearChat } from "@/core/chat-store";
import { tx } from "@/core/db";
import { forget } from "@/core/event-log";
import { stopAndWait } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, forgetCredentials } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_WAIT_MS = 15_000;

// Deletes the workspace, then the rows (a failed rm leaves the project listed, so delete can be retried).
// A queued/running job is stopped first (<= 15 s, else 409 PROJECT_BUSY); a crawl or an open login window -> 409.
export function DELETE(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    const root = resolve(config.workspaceRoot);
    const ws = resolve(root, id);
    if (!ws.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "workspace path escapes the workspace root");
    if (!(await stopAndWait(id, STOP_WAIT_MS))) throw new ApiError(409, "PROJECT_BUSY", "Đang dừng project, thử xoá lại sau vài giây.");
    await exclusive(id, async () => {
      forgetCredentials(db, id);
      await rm(ws, { recursive: true, force: true, maxRetries: 3 });
      tx(db, () => {
        for (const table of ["tasks", "nodes", "edges", "document_state", "document_history"]) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
        clearChat(db, id);
        db.prepare("DELETE FROM projects WHERE id=?").run(id);
      });
      forget(id); // the event ring of a deleted project
    });
    return Response.json({ ok: true });
  });
}
