// Route-handler plumbing: error -> JSON response mapping and the project lookup every [id] route needs.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import { config } from "@/core/config";
import { AppError, type Code } from "@/core/errors";

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
  console.error("api: unexpected error", e);
  return Response.json({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
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

// JSON body that may be omitted entirely (e.g. resume without new credentials).
export async function optionalJson(req: Request): Promise<unknown> {
  const text = await req.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

export function requireStatus(project: ProjectRow, allowed: readonly string[], action: string): void {
  if (!allowed.includes(project.status)) throw new ApiError(409, "BAD_STATE", `cannot ${action} a ${project.status} project`);
}
