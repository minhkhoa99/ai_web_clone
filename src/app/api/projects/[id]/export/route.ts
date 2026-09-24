import { randomUUID } from "node:crypto";
import { cp, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { config } from "@/core/config";
import { emitHtml } from "@/core/emit-html";
import { loadEditable } from "@/core/jobs";
import { zipDir } from "@/core/zip";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripIds = z.boolean().optional();
const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("zip"), stripIds }).strict(),
  z.object({ mode: z.literal("folder"), dest: z.string().min(1).max(4096), stripIds }).strict(),
]);

const RM_OPTS = { recursive: true, force: true, maxRetries: 3 };

// The directory to export: out/ as is, or (stripIds) a fresh emit of the same IR without data-ir-id attributes.
async function exportDir(id: string, strip: boolean | undefined): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const ws = workspaceOf(id);
  if (!strip) return { dir: join(ws, "out"), cleanup: async () => {} };
  const { ir, emit } = await loadEditable(getDb(), id).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, "NO_IR", "the clone has no IR yet: nothing to re-emit");
    throw e;
  });
  const dir = join(ws, `export-${randomUUID()}`);
  const cleanup = () => rm(dir, RM_OPTS);
  await emitHtml(ir, { ...emit, stripIds: true, outDir: dir, workspaceDir: ws }).catch(async (e: unknown) => {
    await cleanup();
    throw e;
  });
  return { dir, cleanup };
}

// Holds the project's busy guard until `release` is called (the zip stream ended), so no emit can wipe out/ meanwhile.
async function holdBusy(id: string): Promise<() => void> {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const running = new Promise<void>((r) => (started = r));
  const done = exclusive(id, async () => {
    started();
    await held;
  });
  await Promise.race([running, done]); // busy -> exclusive rejects at once
  return release;
}

// out/ as a streamed ZIP, or copied into an absolute folder outside the workspace root (never overwriting a file
// there). Both under the busy guard; stripIds re-emits without data-ir-id.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const body = bodySchema.parse(await req.json());
    requireProject(getDb(), id);
    const out = join(workspaceOf(id), "out");
    if (!(await stat(out).catch(() => null))?.isDirectory()) throw new ApiError(404, "NOT_FOUND", "nothing emitted yet (no out/)");
    if (body.mode === "zip") {
      const release = await holdBusy(id);
      let src: Awaited<ReturnType<typeof exportDir>> | undefined;
      const finish = () => {
        release();
        void src?.cleanup().catch(() => {}); // a leftover export-* dir is harmless (never served, removed with the project)
      };
      try {
        src = await exportDir(id, body.stripIds);
        const zip = await zipDir(src.dir);
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await zip.next();
              if (next.done) {
                controller.close();
                finish();
              } else controller.enqueue(next.value);
            } catch (e) {
              finish();
              controller.error(e);
            }
          },
          async cancel() {
            await zip.return(undefined);
            finish();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${id}.zip"` } });
      } catch (e) {
        finish();
        throw e;
      }
    }
    if (!isAbsolute(body.dest)) throw new ApiError(400, "VALIDATION", "dest must be an absolute path");
    const root = resolve(config.workspaceRoot);
    const dest = resolve(body.dest);
    if (dest === root || dest.startsWith(root + sep)) throw new ApiError(400, "VALIDATION", "dest must be outside the workspace root");
    try {
      await exclusive(id, async () => {
        const src = await exportDir(id, body.stripIds);
        try {
          await cp(src.dir, dest, { recursive: true, force: false, errorOnExist: true });
        } finally {
          await src.cleanup();
        }
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ERR_FS_CP_EEXIST") throw new ApiError(409, "DEST_EXISTS", "dest already has a file with the same path");
      throw e;
    }
    return Response.json({ ok: true, dest });
  });
}
