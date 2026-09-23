import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { MIME } from "@/core/serve";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only the clone output, the capture screenshots and the QA crops/heatmaps are servable.
const ALLOWED = /^(out|qa)\/.+|^pages\/[^/]+\/shots\/.+/;
// Cloned pages run on the app origin: no foreign/inline scripts, no forms, no plugins, framable only by the app.
const CSP =
  "default-src 'self' data: blob: http: https:; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

// Security headers go on every response, errors included.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const res = await handle(req, async () => {
    const { id, path } = await params;
    requireProject(getDb(), id);
    const ws = resolve(workspaceOf(id));
    const abs = resolve(ws, ...path);
    const rel = relative(ws, abs).split(sep).join("/");
    const notFound = new ApiError(404, "NOT_FOUND", "file not found");
    if (!abs.startsWith(ws + sep) || !ALLOWED.test(rel)) throw notFound;
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw notFound;
    const body = Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(info.size),
      },
    });
  });
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("content-security-policy", CSP);
  return res;
}
