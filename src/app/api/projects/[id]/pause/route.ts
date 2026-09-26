import { pauseProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Running: stops now (hardening spec §2): the AI call in flight is aborted and the browser closed, the running tasks
// go back to pending and the status becomes paused (see /events). Queued: paused now. Else a no-op.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    requireProject(getDb(), id);
    pauseProject(id);
    return Response.json({ ok: true }, { status: 202 });
  });
}
