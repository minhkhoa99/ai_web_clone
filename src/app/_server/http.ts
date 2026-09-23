// Route-handler plumbing: error -> JSON response mapping and the project lookup every [id] route needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import { config } from "@/core/config";
import { AppError, type Code } from "@/core/errors";
import { isLoopbackHost } from "./loopback";

export type IdCtx = { params: Promise<{ id: string }> };

// A client-facing error raised by the route layer itself (bad input the core doesn't check, missing project, wrong state).
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
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
};

// Messages come from our own code (never from request bodies), so they carry no secrets.
export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return Response.json({ code: e.code, message: e.message }, { status: e.status });
  if (e instanceof ZodError) return Response.json({ code: "VALIDATION", message: z.prettifyError(e) }, { status: 400 });
  if (e instanceof SyntaxError || e instanceof RangeError) return Response.json({ code: "VALIDATION", message: e.message }, { status: 400 });
  if (e instanceof AppError) {
    const status = STATUS[e.code] ?? (e.code.startsWith("AI_") ? 502 : 500);
    return Response.json({ code: e.code, message: e.message }, { status });
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
function guardMutation(req: Request, host: string): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  // an opaque origin ("null", e.g. a sandboxed frame) doesn't parse and is refused too
  if (origin && (!URL.canParse(origin) || new URL(origin).host !== host)) throw new ApiError(403, "FORBIDDEN", "cross-origin request refused");
  // on the wire a body always comes with Content-Length > 0 or Transfer-Encoding (Next gives bodiless requests an empty stream)
  const hasBody = Number(req.headers.get("content-length") ?? 0) > 0 || req.headers.has("transfer-encoding");
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (hasBody && type !== "application/json") throw new ApiError(403, "FORBIDDEN", "request body must be application/json");
}

export async function handle(req: Request, fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    guardMutation(req, hostOf(req));
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

export type ProjectRow = { id: string; url: string; status: string; auth_enc: string | null };

export function requireProject(db: DatabaseSync, id: string): ProjectRow {
  const row = db.prepare("SELECT id,url,status,auth_enc FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", `project ${id} not found`);
  return row;
}

export const workspaceOf = (projectId: string) => join(config.workspaceRoot, projectId);

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

// JSON body that may be omitted entirely (e.g. resume without new credentials).
export async function optionalJson(req: Request): Promise<unknown> {
  const text = await req.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

// The editor works on a finished clone only: a resumed run would build on checkpoints the edit made stale.
export const EDITABLE_STATUSES = ["completed"] as const;

export function requireStatus(project: ProjectRow, allowed: readonly string[], action: string): void {
  if (!allowed.includes(project.status)) throw new ApiError(409, "BAD_STATE", `cannot ${action} a ${project.status} project`);
}
