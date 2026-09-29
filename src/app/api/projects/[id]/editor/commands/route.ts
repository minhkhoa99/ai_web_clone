import { z } from "zod";
import { COMMAND_LIMITS, type EditorCommand, type NodeDraft } from "@/core/ir-command";
import { projectDocuments } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { exclusive, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only the client ops (E1 §2): the private restore* inverses are History-internal and refused as unknown ops.
// Shapes only — the core (prepareCommands/applyCommands) validates targets, CSS, attributes and drafts.
const nodeId = z.string().min(1).max(200);
const index = z.number().int().min(0);
const command = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("setStyle"), id: nodeId, target: z.union([z.enum(["base", "hover", "focus", "active", "before", "after"]), z.literal(768), z.literal(375)]), changes: z.record(z.string(), z.string().nullable()) }),
  z.strictObject({ op: z.literal("setText"), id: nodeId, text: z.string() }),
  z.strictObject({ op: z.literal("setAttribute"), id: nodeId, name: z.string(), value: z.string().nullable() }),
  z.strictObject({ op: z.literal("setHidden"), id: nodeId, hidden: z.boolean() }),
  z.strictObject({ op: z.literal("promoteLayout"), sectionIds: z.array(nodeId).max(100) }),
  z.strictObject({ op: z.literal("resetOverride"), instanceId: nodeId, path: z.string().optional() }),
  z.strictObject({ op: z.literal("detachComponent"), instanceId: nodeId }),
  z.strictObject({ op: z.literal("moveNode"), id: nodeId, parentId: nodeId, index }),
  z.strictObject({ op: z.literal("deleteNode"), id: nodeId }),
  z.strictObject({ op: z.literal("createNode"), parentId: nodeId, index, draft: z.custom<NodeDraft>((v) => typeof v === "object" && v !== null && !Array.isArray(v)) }),
  z.strictObject({ op: z.literal("duplicateNode"), id: nodeId, parentId: nodeId, index }),
]) satisfies z.ZodType<EditorCommand>;
const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), commands: z.array(command).min(1).max(COMMAND_LIMITS.commands) });

// One batch = one History step. Stale baseRevision -> 409 {revision}; returns { revision, createdIds, canUndo, canRedo }.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, commands } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusive(id, () => projectDocuments(db).commitCommands(id, baseRevision, commands, "user")));
  });
}
