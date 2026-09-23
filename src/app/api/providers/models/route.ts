import { z } from "zod";
import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerIdSchema, storedProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Either an unsaved form's values or a saved provider (its key decrypted server-side).
const bodySchema = z.union([
  z
    .object({
      kind: z.enum(["anthropic", "openai"]),
      baseUrl: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
      apiKey: z.string().min(1).max(4096),
    })
    .strict(),
  providerIdSchema,
]);

export function POST(req: Request) {
  return handle(async () => {
    const body = bodySchema.parse(await req.json());
    const p = "providerId" in body ? storedProvider(getDb(), body.providerId) : body;
    return Response.json({ models: await fetchModels(p.kind, p.baseUrl, p.apiKey) });
  });
}
