import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerBodySchema, resolveProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(req, async () => {
    const p = resolveProvider(getDb(), providerBodySchema.parse(await req.json()));
    const { models } = await fetchModels(p.kind, p.baseUrl, p.apiKey);
    return Response.json({ models });
  });
}
