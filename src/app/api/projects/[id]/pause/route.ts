import { pauseProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Running: in-flight tasks finish, then the status becomes paused (see /events). Queued: paused now. Else a no-op.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    requireProject(getDb(), id);
    pauseProject(id);
    return Response.json({ ok: true }, { status: 202 });
  });
}
