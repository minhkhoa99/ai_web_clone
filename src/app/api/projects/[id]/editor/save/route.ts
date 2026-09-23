import { z } from "zod";
import { grapesToPatch } from "@/core/grapes-adapter";
import { applyPatch } from "@/core/ir";
import { saveEdited } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { EDITABLE_STATUSES, handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The adapter validates the component tree itself (bounded, safe names only).
const bodySchema = z
  .object({ pageId: z.string().min(1).max(200), project: z.object({ components: z.array(z.unknown()), styles: z.array(z.unknown()).optional() }) })
  .strict();

// Editor JSON -> PatchOps -> applyPatch (+ effect keyframes) -> ir.json, out/ and graph rewritten. Bad patch -> 400.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { pageId, project } = bodySchema.parse(await req.json());
    const db = getDb();
    requireStatus(requireProject(db, id), EDITABLE_STATUSES, "edit");
    let ops = 0;
    await exclusive(id, () =>
      saveEdited(db, id, (ir) => {
        const patch = grapesToPatch(ir, pageId, project);
        ops = patch.ops.length;
        const next = applyPatch(ir, patch.ops);
        return { ...next, cssom: { ...next.cssom, keyframes: [...new Set([...next.cssom.keyframes, ...patch.keyframes])] } };
      }),
    );
    return Response.json({ ok: true, ops });
  });
}
