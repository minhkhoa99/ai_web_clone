import { irToGrapes } from "@/core/grapes-adapter";
import { panelComponents } from "@/core/interactive";
import { loadEditable, projectDocuments } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, type IdCtx } from "@/app/_server/http";
import { ensureOutput, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One page of the document's display view (components resolved, classes derived) as GrapesJS JSON (?page=<pageId>,
// default the first page), plus the project's sections as blocks, the revision that view is at and the Undo/Redo
// flags (read after any pending output repair).
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const store = projectDocuments(db);
    await ensureOutput(db, id);
    const { doc, ir, emit } = await loadEditable(db, id).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, "NO_IR", "the clone has no IR yet: resume it first");
      throw e;
    });
    const pageId = new URL(req.url).searchParams.get("page") ?? ir.pages[0]?.id ?? "";
    if (!ir.pages.some((p) => p.id === pageId)) throw new ApiError(404, "NOT_FOUND", `page ${pageId} not found`);
    // the revision of the document shown (a Save diffs against exactly that revision)
    // + the Component panel's view of this page (E2 §7; `components` is GrapesJS') and the 1440 shot for item thumbnails
    const shot = `/api/projects/${encodeURIComponent(id)}/files/pages/${encodeURIComponent(pageId)}/shots/1440.png`;
    return Response.json({ ...irToGrapes(ir, pageId, emit), ...(await store.historyState(id)), revision: doc.revision, interactives: panelComponents(doc, pageId), shot });
  });
}
