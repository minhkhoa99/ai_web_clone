import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFileNames } from "@/core/emit-html";
import { coverage } from "@/core/graph";
import type { IR } from "@/core/ir";
import type { QaFile } from "@/core/jobs";
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

// Pages (each with its out/ file, servable via /files/out/<file>), sections (name + root node id for scrolling the
// clone), QA scores (qa.json, `stale` after an editor save), interaction rows and per-page coverage — the preview screen's data.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    const ws = workspaceOf(id);
    const [ir, qa] = await Promise.all([
      readJsonIfExists<Pick<IR, "pages" | "sections" | "interactions"> | null>(join(ws, "ir.json"), null),
      readJsonIfExists<QaFile>(join(ws, "qa.json"), { scores: [] }),
    ]);
    const irPages = ir?.pages ?? [];
    const files = pageFileNames(irPages);
    const pages = irPages.map((p) => ({ pageId: p.id, path: p.path, file: files.get(p.id) }));
    const sections = (ir?.sections ?? []).map((s) => ({ id: s.id, pageId: s.pageId, name: s.name, rootId: s.root.id }));
    const interactions = (ir?.interactions ?? []).map((i) => ({ id: i.id, pageId: i.pageId, kind: i.kind, trigger: i.trigger, status: i.status }));
    return Response.json({ pages, sections, scores: qa.scores, stale: qa.stale === true, interactions, coverage: coverage(db, id) });
  });
}
