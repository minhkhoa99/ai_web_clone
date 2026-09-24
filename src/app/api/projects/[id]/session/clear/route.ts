import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { config } from "@/core/config";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Xóa phiên" (spec §3): the project's browser profile (cookies, localStorage) is removed; the next run starts logged out.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    requireProject(getDb(), id);
    const root = resolve(config.workspaceRoot);
    const profile = resolve(workspaceOf(id), "profile");
    if (!profile.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "profile path escapes the workspace root");
    await exclusive(id, () => rm(profile, { recursive: true, force: true, maxRetries: 3 }));
    return Response.json({ ok: true });
  });
}
