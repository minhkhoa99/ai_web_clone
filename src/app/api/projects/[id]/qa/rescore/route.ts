import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError, Codes } from "@/core/errors";
import { isWaiting, queueHasRoom, requeueRescore, startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, optionalJson, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusive, requireEditable, requirePipelineDone } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({}).strict();

// "Chạy lại QA" (spec §3): completed, or failed/interrupted/paused with the clone already emitted -> running ->
// completed through the job queue (1 running, <=5 waiting), scoring only — no fix loop, no AI call: refused while an
// earlier phase still has work; a fix round left over from the recovered run is closed (requeueRescore).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    bodySchema.parse(await optionalJson(req));
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    if (!(await stat(join(workspaceOf(id), "out")).catch(() => null))?.isDirectory()) throw new ApiError(409, "NO_OUTPUT", "nothing emitted yet");
    await exclusive(id, async () => {
      requirePipelineDone(db, id); // else the job would be a full resume, AI included
      // a full queue -> 429 before the task is re-armed
      if (!queueHasRoom()) throw new AppError(Codes.QUEUE_FULL, "job queue full", { projectId: id });
      requeueRescore(db, id);
      startProject(db, id);
    });
    return Response.json({ ok: true, queued: isWaiting(id) }, { status: 202 });
  });
}
