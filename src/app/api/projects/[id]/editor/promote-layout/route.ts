import { z } from "zod";
import { promoteLayout } from "@/core/ir";
import { saveEdited } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sectionIds: z.array(z.string().min(1).max(200)).max(100) }).strict();

// "Gộp thành layout": the first section becomes the shared layout of the others' pages. Invalid selection -> 400.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { sectionIds } = bodySchema.parse(await req.json());
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    await exclusive(id, () => saveEdited(db, id, (ir) => promoteLayout(ir, sectionIds)));
    return Response.json({ ok: true });
  });
}
