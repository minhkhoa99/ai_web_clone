import { canvasPayload } from "@/core/editor-canvas";
import { panelComponents } from "@/core/interactive";
import { loadEditable, projectDocuments } from "@/core/jobs";
import { assetLibrary } from "@/core/upload";
import { canvasUrlsFor } from "@/app/_server/editor";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { ensureOutput, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One page of the document for the visual editor (E3 §5): the canvas payload, the Component panel's view, the 1440
// shot, the asset library, the revision and the Undo/Redo flags (?page=<pageId>, default the first page; read after
// any pending output repair). `allSections` (every page) feeds the Section card's "Gộp thành layout" (E3b R10).
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
    // the revision of the document shown (commands go against exactly that revision)
    // + the Component panel's view of this page (E2 §7) and the 1440 shot for item thumbnails
    const shot = `/api/projects/${encodeURIComponent(id)}/files/pages/${encodeURIComponent(pageId)}/shots/1440.png`;
    const canvas = canvasPayload(doc, pageId, emit, canvasUrlsFor(req, id), ir);
    const assets = await assetLibrary(workspaceOf(id), emit.assetMap, (file) => `/api/projects/${encodeURIComponent(id)}/files/${file}`);
    return Response.json({ ...(await store.historyState(id)), revision: doc.revision, interactives: panelComponents(doc, pageId), shot, ...canvas, assets });
  });
}
