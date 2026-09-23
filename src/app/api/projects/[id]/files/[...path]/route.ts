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
// The emitted pages (flat out/*.html) are the only documents allowed to run anything.
const PAGE = /^out\/[^/]+\.html$/;
// Cloned pages run on the app origin: the one script is our own runtime (exact URL, never a downloaded asset),
// no forms, no plugins, framable only by the app.
const pageCsp = (runtimeUrl: string) =>
  `default-src 'self' data: blob: http: https:; script-src ${runtimeUrl}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
// Everything else (assets, SVG, shots, crops, errors) opened directly is inert: sandboxed, no script, no fetches.
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'";

// Security headers go on every response, errors included.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  let csp = FILE_CSP;
  const res = await handle(req, async () => {
    const { id, path } = await params;
    requireProject(getDb(), id);
    const ws = resolve(workspaceOf(id));
    const abs = resolve(ws, ...path);
    const rel = relative(ws, abs).split(sep).join("/");
    const notFound = new ApiError(404, "NOT_FOUND", "file not found");
    if (!abs.startsWith(ws + sep) || !ALLOWED.test(rel)) throw notFound;
    // host: handle() already refused a non-loopback Host; the page loads js/runtime.js from this same origin
    if (PAGE.test(rel)) csp = pageCsp(`http://${req.headers.get("host") ?? new URL(req.url).host}/api/projects/${encodeURIComponent(id)}/files/out/js/runtime.js`);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw notFound;
    const ext = extname(abs).toLowerCase();
    const body = Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": String(info.size),
        // an unknown download (.bin) is never rendered
        "content-disposition": MIME[ext] ? "inline" : "attachment",
      },
    });
  });
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("content-security-policy", csp);
  return res;
}
