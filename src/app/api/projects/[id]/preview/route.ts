import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFileNames } from "@/core/emit-html";
import { withBehavior } from "@/core/fidelity";
import { coverage } from "@/core/graph";
import { previewDocument, type QaFile } from "@/core/jobs";
import type { TaskStatus } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { ensureOutput, isRescorable } from "@/app/_server/session";

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

// The preview screen's data, from the document through the central loader (never adopted, no job started): pages
// (each with its out/ file, servable via /files/out/<file>), sections (name + root node id for scrolling the clone),
// QA scores + behaviour results (qa.json, `stale` after an editor save), interaction rows, per-page coverage and the Fidelity report
// (E1 §5, at most 2000 items; a separate measure: the pixel scores are untouched).
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    const project = requireProject(db, id);
    await ensureOutput(db, id); // a pending repair first: the pages below and out/ are the same revision
    const [{ doc: ir, fidelity }, qa] = await Promise.all([previewDocument(db, id), readJsonIfExists<QaFile>(join(workspaceOf(id), "qa.json"), { scores: [] })]);
    const irPages = ir?.pages ?? [];
    const files = pageFileNames(irPages);
    const pages = irPages.map((p) => ({ pageId: p.id, path: p.path, file: files.get(p.id) }));
    const sections = (ir?.sections ?? []).map((s) => ({ id: s.id, pageId: s.pageId, name: s.name, rootId: s.root.id }));
    const interactions = (ir?.interactions ?? []).map((i) => ({ id: i.id, pageId: i.pageId, kind: i.kind, trigger: i.trigger, status: i.status }));
    // the fix-loop outcome per section (key pageId:sectionId) for the preview's "cần sửa" cards
    const fixes = (
      db.prepare("SELECT key,status,error_code,error_msg FROM tasks WHERE project_id=? AND phase='fix' ORDER BY rowid LIMIT 2000").all(id) as {
        key: string;
        status: TaskStatus;
        error_code: string | null;
        error_msg: string | null;
      }[]
    ).map((t) => {
      const i = t.key.indexOf(":");
      return { pageId: t.key.slice(0, i), sectionId: t.key.slice(i + 1), status: t.status, errorCode: t.error_code, errorMsg: t.error_msg };
    });
    // E2 §5 / R5: the behaviour QA of a non-stale qa.json upgrades the component items at read time (never stored)
    const behavior = qa.stale ? [] : qa.behavior ?? [];
    // "Chạy lại QA" is offered whenever the API would accept it (spec §3): not only completed+stale.
    return Response.json({ pages, sections, scores: qa.scores, stale: qa.stale === true, rescoreAvailable: isRescorable(db, project), interactions, coverage: coverage(db, id), fixes, behavior, fidelity: withBehavior(fidelity, behavior) });
  });
}
