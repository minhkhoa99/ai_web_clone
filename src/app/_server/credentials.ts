// Login credentials held in RAM for a project's runs (spec §3; "remember" additionally stores them encrypted),
// on globalThis so dev HMR keeps them. No core/jobs import: server components (the progress page) use it too.
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decrypt, encrypt } from "@/core/crypto";
import { Codes } from "@/core/errors";
import type { ProjectRow } from "./http";

type Creds = { user: string; pass: string };

const g = globalThis as { __sp1Creds?: Map<string, Creds> };
const held = (g.__sp1Creds ??= new Map());

export const credentialsSchema = z
  .object({ user: z.string().min(1).max(256), pass: z.string().min(1).max(1024), remember: z.boolean().optional() })
  .strict();
export type CredentialsInput = z.infer<typeof credentialsSchema>;

// Fresh credentials replace the held ones; "remember" is decided per submission (unticked clears the stored copy).
export function holdCredentials(db: DatabaseSync, projectId: string, c: CredentialsInput): Creds {
  const creds = { user: c.user, pass: c.pass };
  held.set(projectId, creds);
  db.prepare("UPDATE projects SET auth_enc=? WHERE id=?").run(c.remember ? encrypt(JSON.stringify(creds)) : null, projectId);
  return creds;
}

export function forgetCredentials(db: DatabaseSync, projectId: string): void {
  held.delete(projectId);
  db.prepare("UPDATE projects SET auth_enc=NULL WHERE id=?").run(projectId);
}

// Credentials for a run: fresh ones from the request win; else the held/remembered ones, unless the last
// login failed with them (a wrong password is never retried: account lockout).
export function credentialsFor(db: DatabaseSync, project: ProjectRow, fresh?: CredentialsInput): Creds | undefined {
  if (fresh) return holdCredentials(db, project.id, fresh);
  const failed = db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND phase='login' AND error_code=?").get(project.id, Codes.LOGIN_FAILED);
  if (failed) {
    forgetCredentials(db, project.id);
    return undefined;
  }
  return held.get(project.id) ?? (project.auth_enc ? (JSON.parse(decrypt(project.auth_enc)) as Creds) : undefined);
}

type LoginInfo = { config_json: string; auth_enc: string | null; loginStatus: string | null; loginErrorCode: string | null };

// Auth mode auto and the next run can't log in by itself: the last login failed (never retried with the same
// password), or it hasn't succeeded yet and no credentials are held in RAM or remembered. The UI then asks.
// Pure over already-fetched columns (the list route folds these into its one row query instead of a query per
// project, keeping the request's query count constant regardless of row count); only `held` reads process state.
export function needsCredentialsFrom(projectId: string, row: LoginInfo): boolean {
  if ((JSON.parse(row.config_json || "{}") as { auth?: { mode?: string } }).auth?.mode !== "auto") return false;
  if (row.loginErrorCode === Codes.LOGIN_FAILED) return true;
  return row.loginStatus !== "done" && !held.has(projectId) && !row.auth_enc;
}

export function needsCredentials(db: DatabaseSync, projectId: string): boolean {
  const row = db.prepare("SELECT config_json,auth_enc FROM projects WHERE id=?").get(projectId) as { config_json: string; auth_enc: string | null } | undefined;
  const login = db.prepare("SELECT status,error_code FROM tasks WHERE project_id=? AND phase='login' ORDER BY rowid LIMIT 1").get(projectId) as
    | { status: string; error_code: string | null }
    | undefined;
  return needsCredentialsFrom(projectId, {
    config_json: row?.config_json ?? "{}",
    auth_enc: row?.auth_enc ?? null,
    loginStatus: login?.status ?? null,
    loginErrorCode: login?.error_code ?? null,
  });
}
