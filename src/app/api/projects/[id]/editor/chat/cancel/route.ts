import { cancelTurn } from "@/app/_server/chat";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// E4 R3: aborts the project's running turn; before its commit nothing is written (the turn's POST answers "cancelled").
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    requireProject(getDb(), id);
    return Response.json({ cancelled: cancelTurn(id) });
  });
}
