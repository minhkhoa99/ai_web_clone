import { z } from "zod";
import { startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, optionalJson, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { credentialsFor, credentialsSchema } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ credentials: credentialsSchema.optional() }).strict();
const RESUMABLE = ["paused", "interrupted", "failed", "needs_auth"] as const;

// Done tasks are never re-run. After LOGIN_FAILED only new credentials in the body can log in again.
export function POST(req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const { credentials } = bodySchema.parse(await optionalJson(req));
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, RESUMABLE, "resume");
    startProject(db, id, { credentials: credentialsFor(db, project, credentials) });
    return Response.json({ ok: true }, { status: 202 });
  });
}
