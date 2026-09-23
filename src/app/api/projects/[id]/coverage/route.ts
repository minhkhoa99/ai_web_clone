import { coverage } from "@/core/graph";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    return Response.json({ coverage: coverage(db, id) });
  });
}
