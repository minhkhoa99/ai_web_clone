import { cp, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { config } from "@/core/config";
import { zipDir } from "@/core/zip";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("zip") }).strict(),
  z.object({ mode: z.literal("folder"), dest: z.string().min(1).max(4096) }).strict(),
]);

// out/ as a streamed ZIP, or copied into an absolute folder outside the workspace root (never overwriting a file there).
export function POST(req: Request, { params }: IdCtx) {
  return handle(async () => {
    const { id } = await params;
    const body = bodySchema.parse(await req.json());
    requireProject(getDb(), id);
    const out = join(workspaceOf(id), "out");
    if (!(await stat(out).catch(() => null))?.isDirectory()) throw new ApiError(404, "NOT_FOUND", "nothing emitted yet (no out/)");
    if (body.mode === "zip") {
      return new Response(Readable.toWeb(Readable.from(zipDir(out))) as ReadableStream<Uint8Array>, {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${id}.zip"` },
      });
    }
    if (!isAbsolute(body.dest)) throw new ApiError(400, "VALIDATION", "dest must be an absolute path");
    const root = resolve(config.workspaceRoot);
    const dest = resolve(body.dest);
    if (dest === root || dest.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "dest must be outside the workspace root");
    try {
      await cp(out, dest, { recursive: true, force: false, errorOnExist: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ERR_FS_CP_EEXIST") throw new ApiError(409, "DEST_EXISTS", "dest already has a file with the same path");
      throw e;
    }
    return Response.json({ ok: true, dest });
  });
}
