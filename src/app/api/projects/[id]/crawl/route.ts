import { discoverPages } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { closeAuthWindow, exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sitemap for the page picker (bounded by the project's maxPages/depth), crawled on the project profile. A login
// window opened before the crawl is closed first: the user is done logging in, and it holds the profile.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireStatus(requireProject(db, id), ["draft"], "crawl");
    await closeAuthWindow(id);
    return Response.json({ pages: await exclusive(id, () => discoverPages(db, id)) });
  });
}
