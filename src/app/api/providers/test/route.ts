import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerIdSchema, storedProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One short request (GET /models) proves base URL + key; failures map to AI_* -> 502.
export function POST(req: Request) {
  return handle(async () => {
    const { providerId } = providerIdSchema.parse(await req.json());
    const p = storedProvider(getDb(), providerId);
    const models = await fetchModels(p.kind, p.baseUrl, p.apiKey);
    return Response.json({ ok: true, models: models.length });
  });
}
