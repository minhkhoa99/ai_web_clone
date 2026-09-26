import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decrypt } from "@/core/crypto";
import type { ProviderKind } from "@/core/gateway";
import { ApiError } from "./http";

const model = z.string().min(1).max(200).optional();
export const rolesSchema = z.object({ vision: model, code: model, design: model }).strict();
export const baseUrlSchema = z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, ""));

// Decrypts a stored key for a server-side call only; the plaintext never leaves the process.
export function storedProvider(db: DatabaseSync, id: string): { kind: ProviderKind; baseUrl: string; apiKey: string } {
  const row = db.prepare("SELECT kind,base_url,api_key_enc FROM providers WHERE id=?").get(id) as
    | { kind: ProviderKind; base_url: string; api_key_enc: string }
    | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", `provider ${id} not found`);
  return { kind: row.kind, baseUrl: row.base_url, apiKey: decrypt(row.api_key_enc) };
}

// "sk-…abcd": first 3 + last 4; short keys show only the ellipsis so nothing meaningful leaks.
export const maskKey = (key: string) => (key.length < 12 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`);

const kindSchema = z.enum(["anthropic", "openai"]);

// /models and /test (D7): a form's unsaved values, or a saved provider (its key decrypted server-side only) with an
// optional kind/baseUrl override — an edited-but-unsaved base URL is what gets tested (P27); a typed key goes the
// first way.
export const providerBodySchema = z.union([
  z.object({ kind: kindSchema, baseUrl: baseUrlSchema, apiKey: z.string().min(1).max(4096) }).strict(),
  z.object({ providerId: z.string().min(1), kind: kindSchema.optional(), baseUrl: baseUrlSchema.optional() }).strict(),
]);

export function resolveProvider(db: DatabaseSync, body: z.infer<typeof providerBodySchema>): { kind: ProviderKind; baseUrl: string; apiKey: string } {
  if (!("providerId" in body)) return body;
  const stored = storedProvider(db, body.providerId);
  return { kind: body.kind ?? stored.kind, baseUrl: body.baseUrl ?? stored.baseUrl, apiKey: stored.apiKey };
}
