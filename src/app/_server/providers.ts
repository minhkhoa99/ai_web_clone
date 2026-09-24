import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decrypt } from "@/core/crypto";
import type { ProviderKind } from "@/core/gateway";
import { ApiError } from "./http";

export const providerIdSchema = z.object({ providerId: z.string().min(1) }).strict();

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
