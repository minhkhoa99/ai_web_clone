import { z } from "zod";
import { decrypt } from "@/core/crypto";
import { saveProvider } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { baseUrlSchema, maskKey, rolesSchema } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROVIDERS = 100;
const providerSchema = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(["anthropic", "openai"]),
    baseUrl: baseUrlSchema,
    apiKey: z.string().min(1).max(4096),
    roles: rolesSchema.default({}),
  })
  .strict();

export function POST(req: Request) {
  return handle(req, async () => {
    const input = providerSchema.parse(await req.json());
    return Response.json({ id: saveProvider(getDb(), input) }, { status: 201 });
  });
}

export function GET(req: Request) {
  return handle(req, () => {
    const rows = getDb().prepare("SELECT id,name,kind,base_url,api_key_enc,roles_json FROM providers ORDER BY rowid LIMIT ?").all(MAX_PROVIDERS) as {
      id: string;
      name: string;
      kind: string;
      base_url: string;
      api_key_enc: string;
      roles_json: string;
    }[];
    const providers = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      apiKey: maskKey(decrypt(r.api_key_enc)),
      roles: JSON.parse(r.roles_json) as Record<string, string>,
    }));
    return Response.json({ providers });
  });
}
