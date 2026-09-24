import { z } from "zod";
import { updateProvider } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, type IdCtx } from "@/app/_server/http";
import { baseUrlSchema, rolesSchema } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every field optional: an omitted apiKey keeps the stored (encrypted) one; roles replace the old roles.
const patchSchema = z
  .object({ name: z.string().min(1).max(100).optional(), baseUrl: baseUrlSchema.optional(), apiKey: z.string().min(1).max(4096).optional(), roles: rolesSchema.optional() })
  .strict();

const notFound = (id: string) => new ApiError(404, "NOT_FOUND", `provider ${id} not found`);

export function PATCH(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const patch = patchSchema.parse(await req.json());
    if (!updateProvider(getDb(), id, patch)) throw notFound(id);
    return Response.json({ ok: true });
  });
}

export function DELETE(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { changes } = getDb().prepare("DELETE FROM providers WHERE id=?").run(id);
    if (!changes) throw notFound(id);
    return Response.json({ ok: true });
  });
}
