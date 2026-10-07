// Route-handler plumbing: error -> JSON response mapping and the project lookup every [id] route needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import { workspaceOf } from "@/core/fsx";
import { AppError, type Code } from "@/core/errors";
import { isLoopbackHost } from "./loopback";

export type IdCtx = { params: Promise<{ id: string }> };

// A client-facing error raised by the route layer itself (bad input the core doesn't check, missing project, wrong state).
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: { revision?: number }) {
    super(message);
  }
}

const STATUS: Partial<Record<Code, number>> = {
  QUEUE_FULL: 429,
  GRAPH_NOT_FOUND: 404,
  AUTH_REQUIRED: 409,
  CAPTCHA_REQUIRED: 409,
  LOGIN_FAILED: 409,
  IR_PATCH_INVALID: 400,
  IR_VERSION_UNSUPPORTED: 409,
  PROJECT_BUSY: 409,
  STALE_REVISION: 409,
  NOTHING_TO_UNDO: 409,
  NOTHING_TO_REDO: 409,
  DOCUMENT_MATERIALIZE_FAILED: 500, // the step is committed: the client keeps its revision/createdIds, the next read repairs
  UPLOAD_INVALID: 400,
  ASSET_TOO_LARGE: 413,
  PROJECT_SIZE_LIMIT: 413,
};
// Context the client needs to recover (reload at `revision`, keep `createdIds`); nothing else of the context leaves.
const CLIENT_CONTEXT = ["revision", "createdIds"] as const;

// Messages come from our own code (never from request bodies), so they carry no secrets.
export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return Response.json({ code: e.code, message: e.message, ...e.extra }, { status: e.status });
  if (e instanceof ZodError) return Response.json({ code: "VALIDATION", message: z.prettifyError(e) }, { status: 400 });
  if (e instanceof SyntaxError || e instanceof RangeError) return Response.json({ code: "VALIDATION", message: e.message }, { status: 400 });
  if (e instanceof AppError) {
    const status = STATUS[e.code] ?? (e.code.startsWith("AI_") ? 502 : 500);
    const extra = Object.fromEntries(CLIENT_CONTEXT.filter((k) => e.context?.[k] !== undefined).map((k) => [k, e.context![k]]));
    return Response.json({ code: e.code, message: e.message, ...extra }, { status });
  }
  console.error("api: unexpected error", e); // server-side only; core error messages carry no secrets
  return Response.json({ code: "INTERNAL", message: "internal error" }, { status: 500 });
}

// Every request: the Host must be loopback (any port). src/proxy.ts checks the same for pages; this keeps
// the API safe when a handler is called without the proxy (tests, a misconfigured matcher).
function hostOf(req: Request): string {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!isLoopbackHost(host)) throw new ApiError(403, "FORBIDDEN", "requests must target a loopback host");
  return host;
}

// CSRF guard for every mutation: a page on another origin can't drive the local API. Origin must be absent
// (non-browser client) or this host; a body must be JSON (text/plain & form posts skip CORS preflight).
function guardMutation(req: Request, host: string, body: "json" | "multipart"): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  // an opaque origin ("null", e.g. a sandboxed frame) doesn't parse and is refused too
  if (origin && (!URL.canParse(origin) || new URL(origin).host !== host)) throw new ApiError(403, "FORBIDDEN", "cross-origin request refused");
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (body === "multipart") {
    // R8: a form post skips the CORS preflight: an upload needs the editor's own Origin (browsers always send it on POST)
    if (!origin) throw new ApiError(403, "FORBIDDEN", "an upload needs the Origin header");
    if (type !== "multipart/form-data") throw new ApiError(403, "FORBIDDEN", "an upload must be multipart/form-data");
    return;
  }
  // on the wire a body always comes with Content-Length > 0 or Transfer-Encoding (Next gives bodiless requests an empty stream)
  const hasBody = Number(req.headers.get("content-length") ?? 0) > 0 || req.headers.has("transfer-encoding");
  if (hasBody && type !== "application/json") throw new ApiError(403, "FORBIDDEN", "request body must be application/json");
}

export async function handle(req: Request, fn: () => Promise<Response> | Response, opts: { body?: "json" | "multipart" } = {}): Promise<Response> {
  try {
    guardMutation(req, hostOf(req), opts.body ?? "json");
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

export type ProjectRow = { id: string; url: string; status: string; status_reason: string | null; auth_enc: string | null };

export function requireProject(db: DatabaseSync, id: string): ProjectRow {
  const row = db.prepare("SELECT id,url,status,status_reason,auth_enc FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", `project ${id} not found`);
  return row;
}

export { workspaceOf } from "@/core/fsx";

// The page behind the auth wall: a login task's key is its URL, a capture task's key is a pageId (pages.json).
export async function authUrl(db: DatabaseSync, project: Pick<ProjectRow, "id" | "url">): Promise<string> {
  const task = db.prepare("SELECT phase,key FROM tasks WHERE project_id=? AND status='needs_auth' ORDER BY rowid LIMIT 1").get(project.id) as
    | { phase: string; key: string }
    | undefined;
  if (!task) return project.url;
  if (task.phase !== "capture") return task.key;
  const pages = JSON.parse(await readFile(join(workspaceOf(project.id), "pages.json"), "utf8")) as { pageId: string; url: string }[];
  return pages.find((p) => p.pageId === task.key)?.url ?? project.url;
}

export const MAX_JSON_BYTES = 1_000_000;

// A request body refused while streaming once past `max` (never buffered past the cap).
async function readCapped(req: Request, max: number): Promise<Buffer> {
  const tooLarge = new ApiError(413, "PAYLOAD_TOO_LARGE", `request body over ${max} bytes`);
  if (Number(req.headers.get("content-length") ?? 0) > max) throw tooLarge;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    size += r.value.byteLength;
    if (size > max) {
      await reader!.cancel();
      throw tooLarge;
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}

// A capped multipart/form-data body (the upload route); the parts are judged by the caller.
export async function multipartBody(req: Request, max: number): Promise<FormData> {
  const buf = await readCapped(req, max);
  try {
    // Buffer.concat allocates a plain ArrayBuffer; the cast only narrows the DOM BodyInit typing
    return await new Response(buf as Uint8Array<ArrayBuffer>, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ApiError(400, "VALIDATION", "request body is not valid multipart/form-data");
  }
}

// A capped JSON body validated by `schema`: the size is refused while streaming (never buffered past the cap), and
// errors name only the failing field path (schema key + command index), never the sent values or keys.
export async function jsonBody<T>(req: Request, schema: z.ZodType<T>, max = MAX_JSON_BYTES): Promise<T> {
  const text = (await readCapped(req, max)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "VALIDATION", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // safe only because callers pass a top-level strictObject: path[0] is then always a schema key, never a sent key
  const at = parsed.error.issues[0]!.path.slice(0, 2).filter((p, i) => i === 0 || typeof p === "number");
  throw new ApiError(400, "VALIDATION", `invalid request body${at.length ? ` at ${at.join(".")}` : ""}`);
}

// JSON body that may be omitted entirely (e.g. resume without new credentials).
export async function optionalJson(req: Request): Promise<unknown> {
  const text = await req.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

export function requireStatus(project: ProjectRow, allowed: readonly string[], action: string): void {
  if (!allowed.includes(project.status)) throw new ApiError(409, "BAD_STATE", `cannot ${action} a ${project.status} project`);
}
