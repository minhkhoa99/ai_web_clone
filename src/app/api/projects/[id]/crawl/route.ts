import { discoverPages } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sitemap for the page picker (bounded by the project's maxPages/depth).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireStatus(requireProject(db, id), ["draft"], "crawl");
    return Response.json({ pages: await exclusive(id, () => discoverPages(db, id)) });
  });
}
