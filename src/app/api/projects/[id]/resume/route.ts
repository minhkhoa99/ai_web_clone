import { z } from "zod";
import { isWaiting, startProject } from "@/core/jobs";
import { RESUMABLE_STATUSES } from "@/core/statuses";
import { getDb } from "@/app/_server/db";
import { handle, optionalJson, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { assertIdle, closeAuthWindow, credentialsFor, credentialsSchema } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ credentials: credentialsSchema.optional() }).strict();

// Done tasks are never re-run. On needs_auth an open login window is closed first (same as auth/continue). After LOGIN_FAILED only new credentials in the body can log in again.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { credentials } = bodySchema.parse(await optionalJson(req));
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, RESUMABLE_STATUSES, "resume");
    if (project.status === "needs_auth") await closeAuthWindow(id);
    assertIdle(id);
    startProject(db, id, { credentials: credentialsFor(db, project, credentials) });
    return Response.json({ ok: true, queued: isWaiting(id) }, { status: 202 });
  });
}
