import { z } from "zod";
import { AppError, Codes } from "@/core/errors";
import { enqueue, queueHasRoom, startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { closeAuthWindow, credentialsFor, credentialsSchema, exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({ pages: z.array(z.url({ protocol: /^https?$/ })).min(1).max(100), credentials: credentialsSchema.optional() })
  .strict();

// Fixes the page selection and queues the job (QUEUE_FULL -> 429). The run is async: follow it via /events.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { pages, credentials } = bodySchema.parse(await req.json());
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, ["draft"], "start");
    // D8: the sitemap's login banner may have opened the window; the user is done logging in, and it holds the profile
    await closeAuthWindow(id);
    // busy (already queued, crawling) -> 409 before the page selection is rewritten
    await exclusive(id, async () => {
      // a full queue -> 429 before the page selection is rewritten (startProject re-checks after the await)
      if (!queueHasRoom()) throw new AppError(Codes.QUEUE_FULL, "job queue full", { projectId: id });
      await enqueue(db, id, pages);
      startProject(db, id, { credentials: credentialsFor(db, project, credentials) });
    });
    return Response.json({ ok: true }, { status: 202 });
  });
}
