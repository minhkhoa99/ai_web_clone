import { join } from "node:path";
import { z } from "zod";
import { importStorageState } from "@/core/auth";
import { openBrowser } from "@/core/browser";
import { AppError } from "@/core/errors";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A Playwright/Chrome storageState export (unknown keys dropped). Cookie values are secrets: never logged or echoed.
const cookieSchema = z
  .object({
    name: z.string().min(1).max(4096),
    value: z.string().max(8192),
    url: z.string().max(4096).optional(),
    domain: z.string().max(255).optional(),
    path: z.string().max(4096).optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  })
  .refine((c) => c.url || c.domain, "a cookie needs url or domain");
const originSchema = z.object({
  origin: z.url({ protocol: /^https?$/ }),
  localStorage: z.array(z.object({ name: z.string().max(4096), value: z.string().max(1_000_000) })).max(1000).default([]),
});
const bodySchema = z
  .object({ storageState: z.object({ cookies: z.array(cookieSchema).max(1000).default([]), origins: z.array(originSchema).max(50).default([]) }) })
  .strict();

// "Import cookie / storageState JSON" (spec §3): applied into the project's persistent profile (headless, then closed).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { storageState } = bodySchema.parse(await req.json());
    requireProject(getDb(), id);
    await exclusive(id, async () => {
      const browser = await openBrowser({ profileDir: join(workspaceOf(id), "profile") });
      try {
        await importStorageState(browser.context, storageState);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new ApiError(400, "VALIDATION", "the browser rejected the storage state"); // no echo of cookie values
      } finally {
        await browser.close();
      }
    });
    return Response.json({ ok: true, cookies: storageState.cookies.length, origins: storageState.origins.length });
  });
}
