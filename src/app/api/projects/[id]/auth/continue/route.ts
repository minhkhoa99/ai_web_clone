import { z } from "zod";
import { startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, optionalJson, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { assertIdle, closeAuthWindow, credentialsFor, credentialsSchema } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ credentials: credentialsSchema.optional() }).strict();

// The user finished in the window: close it (releases the profile), then resume through the queue.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { credentials } = bodySchema.parse(await optionalJson(req));
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, ["needs_auth"], "continue");
    await closeAuthWindow(id);
    assertIdle(id);
    startProject(db, id, { credentials: credentialsFor(db, project, credentials) });
    return Response.json({ ok: true }, { status: 202 });
  });
}
