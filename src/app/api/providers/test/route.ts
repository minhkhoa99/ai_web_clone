import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerBodySchema, resolveProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One short request (GET /models) proves base URL + key, timed; failures map to AI_* -> 502 (message has the status).
export function POST(req: Request) {
  return handle(req, async () => {
    const p = resolveProvider(getDb(), providerBodySchema.parse(await req.json()));
    const t0 = performance.now();
    const { models, httpStatus } = await fetchModels(p.kind, p.baseUrl, p.apiKey);
    return Response.json({ ok: true, models: models.length, latencyMs: Math.round(performance.now() - t0), httpStatus });
  });
}
