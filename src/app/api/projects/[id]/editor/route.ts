import { irToGrapes } from "@/core/grapes-adapter";
import { loadEditable } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, EDITABLE_STATUSES, handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One page of the IR as GrapesJS JSON (?page=<pageId>, default the first page), plus the project's sections as blocks.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireStatus(requireProject(db, id), EDITABLE_STATUSES, "edit");
    const { ir, emit } = await loadEditable(db, id).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, "NO_IR", "the clone has no IR yet: resume it first");
      throw e;
    });
    const pageId = new URL(req.url).searchParams.get("page") ?? ir.pages[0]?.id ?? "";
    if (!ir.pages.some((p) => p.id === pageId)) throw new ApiError(404, "NOT_FOUND", `page ${pageId} not found`);
    return Response.json(irToGrapes(ir, pageId, emit));
  });
}
