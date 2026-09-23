import { discoverPages } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sitemap for the page picker (bounded by the project's maxPages/depth).
export function POST(_req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();
    requireStatus(requireProject(db, id), ["draft"], "crawl");
    return Response.json({ pages: await discoverPages(db, id) });
  });
}
