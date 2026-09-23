import { coverage } from "@/core/graph";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    return Response.json({ coverage: coverage(db, id) });
  });
}
