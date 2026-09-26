import { readRunLog } from "@/core/run-log";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Tải log" (hardening spec §4): run.prev.log + run.log as a download. Loopback only (handle); a GET, so no CSRF.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    requireProject(getDb(), id);
    return new Response(await readRunLog(id), {
      headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="run-${id.slice(0, 8)}.log"` },
    });
  });
}
