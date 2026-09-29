import { z } from "zod";
import { AppError, Codes } from "@/core/errors";
import { grapesToCommands } from "@/core/grapes-adapter";
import { loadEditable } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A 60k-node page as GrapesJS JSON stays well under this; the adapter bounds the tree itself (nodes, depth, safe names).
const MAX_SAVE_BYTES = 32 * 1024 * 1024;
const bodySchema = z.strictObject({
  baseRevision: z.number().int().min(0),
  pageId: z.string().min(1).max(200),
  project: z.object({ components: z.array(z.unknown()), styles: z.array(z.unknown()).optional() }),
});

// Lưu: the editor's JSON diffed against the document at baseRevision into editor commands (grapesToCommands), committed
// as one History step (out/, graph re-emitted, qa.json stale). Stale -> 409 {revision}; a bad edit -> 400.
// `skipped`: style rules with no IR target (a state at a breakpoint…), reported, never guessed.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, pageId, project } = await jsonBody(req, bodySchema, MAX_SAVE_BYTES);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const skipped: string[] = [];
    let ops = 0;
    const result = await exclusiveEdit(db, id, async (store) => {
      const { doc, emit } = await loadEditable(db, id);
      if (doc.revision !== baseRevision) throw new AppError(Codes.STALE_REVISION, `document is at revision ${doc.revision}, not ${baseRevision}`, { revision: doc.revision });
      const commands = grapesToCommands(doc, pageId, project, { ...emit, skipped });
      ops = commands.length;
      if (ops === 0) return { createdIds: [], ...(await store.historyState(id)) }; // nothing changed: no History step
      return store.commitCommands(id, baseRevision, commands, "user");
    });
    return Response.json({ ...result, ops, skipped });
  });
}
