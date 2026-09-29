import { irToGrapes } from "@/core/grapes-adapter";
import { loadEditable, projectDocuments } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, type IdCtx } from "@/app/_server/http";
import { requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One page of the IR as GrapesJS JSON (?page=<pageId>, default the first page), plus the project's sections as blocks,
// and the document's revision + Undo/Redo flags (read after any pending output repair).
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const store = projectDocuments(db);
    await store.ensureMaterialized(id);
    const { ir, emit } = await loadEditable(db, id).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, "NO_IR", "the clone has no IR yet: resume it first");
      throw e;
    });
    const pageId = new URL(req.url).searchParams.get("page") ?? ir.pages[0]?.id ?? "";
    if (!ir.pages.some((p) => p.id === pageId)) throw new ApiError(404, "NOT_FOUND", `page ${pageId} not found`);
    return Response.json({ ...irToGrapes(ir, pageId, emit), ...(await store.historyState(id)) });
  });
}
