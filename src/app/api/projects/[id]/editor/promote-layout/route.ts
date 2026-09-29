import { z } from "zod";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), sectionIds: z.array(z.string().min(1).max(200)).max(100) });

// "Gộp thành layout": the promoteLayout command (one History step, undoable): the first section becomes the shared
// layout of the others' pages. Stale -> 409 {revision}; an invalid selection -> 400.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, sectionIds } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusiveEdit(db, id, (store) => store.commitCommands(id, baseRevision, [{ op: "promoteLayout", sectionIds }], "user")));
  });
}
