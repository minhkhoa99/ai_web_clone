import { getDb } from "@/app/_server/db";
import { authUrl, handle, requireProject, requireStatus, type IdCtx } from "@/app/_server/http";
import { assertIdle, openAuthWindow } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual login (spec §3 option 1): a real headed window; the user logs in / solves the CAPTCHA, then calls auth/continue.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    const project = requireProject(db, id);
    requireStatus(project, ["needs_auth"], "open a login window for");
    const url = await authUrl(db, project);
    // same tick as openAuthWindow registering the window: nothing can start in between. Re-opening is idempotent.
    assertIdle(id, { ignoreAuthWindow: true });
    await openAuthWindow(db, id, url);
    return Response.json({ ok: true, url });
  });
}
