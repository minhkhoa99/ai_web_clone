import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFileNames } from "@/core/emit-html";
import { coverage } from "@/core/graph";
import type { IR } from "@/core/ir";
import type { SectionScore } from "@/core/qa";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A checkpoint that doesn't exist yet (before ir / qa ran) reads as empty; any other failure is an error.
async function readJsonIfExists<T>(path: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
}

// Pages (each with its out/ file, servable via /files/out/<file>), QA scores (qa.json) and interaction coverage.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    const ws = workspaceOf(id);
    const [ir, scores] = await Promise.all([
      readJsonIfExists<Pick<IR, "pages"> | null>(join(ws, "ir.json"), null),
      readJsonIfExists<SectionScore[]>(join(ws, "qa.json"), []),
    ]);
    const irPages = ir?.pages ?? [];
    const files = pageFileNames(irPages);
    const pages = irPages.map((p) => ({ pageId: p.id, path: p.path, file: files.get(p.id) }));
    return Response.json({ pages, scores, coverage: coverage(db, id) });
  });
}
