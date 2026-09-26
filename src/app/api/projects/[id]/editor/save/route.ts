import { z } from "zod";
import { applyGrapesSave } from "@/core/grapes-adapter";
import { saveEdited } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The adapter validates the component tree itself (bounded, safe names only).
const bodySchema = z
  .object({ pageId: z.string().min(1).max(200), project: z.object({ components: z.array(z.unknown()), styles: z.array(z.unknown()).optional() }) })
  .strict();

// Editor JSON -> PatchOps -> applyPatch (+ effect keyframes, section references) -> ir.json, out/ and graph
// rewritten, qa.json marked stale. Bad patch -> 400.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { pageId, project } = bodySchema.parse(await req.json());
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    let ops = 0;
    await exclusive(id, () =>
      saveEdited(db, id, (ir, emit) => {
        const saved = applyGrapesSave(ir, pageId, project, emit);
        ops = saved.ops;
        return saved.ir;
      }),
    );
    return Response.json({ ok: true, ops });
  });
}
