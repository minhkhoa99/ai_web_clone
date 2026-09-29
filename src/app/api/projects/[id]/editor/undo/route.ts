import { z } from "zod";
import { projectDocuments } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0) });

// Server History (shared by every tab): stale -> 409 {revision}; nothing to undo -> 409 NOTHING_TO_UNDO.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusive(id, () => projectDocuments(db).undoDocument(id, baseRevision)));
  });
}
