import { z } from "zod";
import { enqueue, startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { credentialsFor, credentialsSchema } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({ pages: z.array(z.url({ protocol: /^https?$/ })).min(1).max(100), credentials: credentialsSchema.optional() })
  .strict();

// Fixes the page selection and queues the job (QUEUE_FULL -> 429). The run is async: follow it via /events.
export function POST(req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const { pages, credentials } = bodySchema.parse(await req.json());
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, ["draft"], "start");
    await enqueue(db, id, pages);
    startProject(db, id, { credentials: credentialsFor(db, project, credentials) });
    return Response.json({ ok: true }, { status: 202 });
  });
}
