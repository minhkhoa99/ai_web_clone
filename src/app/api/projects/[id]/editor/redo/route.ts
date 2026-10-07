import { z } from "zod";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { withAffected } from "@/app/_server/editor";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), pageId: z.string().min(1).max(200).optional() });

// Server History (shared by every tab): stale -> 409 {revision}; nothing to redo -> 409 NOTHING_TO_REDO.
// + `affected` when the editor names its page (E3 §5).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, pageId } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusiveEdit(db, id, (store) => withAffected(db, id, store, pageId, () => store.redoDocument(id, baseRevision))));
  });
}
