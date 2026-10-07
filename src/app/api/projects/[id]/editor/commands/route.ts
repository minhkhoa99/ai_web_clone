import { z } from "zod";
import { COMMAND_LIMITS, type EditorCommand, type NodeDraft } from "@/core/ir-command";
import { getDb } from "@/app/_server/db";
import { handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { withAffected } from "@/app/_server/editor";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

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
  z.strictObject({ op: z.literal("setName"), id: nodeId, name: z.string() }),
  z.strictObject({ op: z.literal("promoteLayout"), sectionIds: z.array(nodeId).max(100) }),
  z.strictObject({ op: z.literal("resetOverride"), instanceId: nodeId, path: z.string().optional() }),
  z.strictObject({ op: z.literal("detachComponent"), instanceId: nodeId }),
  z.strictObject({ op: z.literal("updateComponent"), id: nodeId, patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal("convertToComponent"), id: nodeId, kind: z.enum(["carousel", "tabs", "accordion", "modal", "dropdown", "menu", "video"]), roles: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal("unwrapComponent"), id: nodeId }),
  z.strictObject({ op: z.literal("addComponentItem"), id: nodeId, from: nodeId.optional(), index }),
  z.strictObject({ op: z.literal("removeComponentItem"), id: nodeId, itemId: nodeId }),
  z.strictObject({ op: z.literal("moveComponentItem"), id: nodeId, itemId: nodeId, index }),
  z.strictObject({ op: z.literal("updateCarousel"), id: nodeId, patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal("addCarouselSlide"), id: nodeId, from: nodeId.optional(), index }),
  z.strictObject({ op: z.literal("removeCarouselSlide"), id: nodeId, itemId: nodeId }),
  z.strictObject({ op: z.literal("moveNode"), id: nodeId, parentId: nodeId, index }),
  z.strictObject({ op: z.literal("deleteNode"), id: nodeId }),
  z.strictObject({ op: z.literal("createNode"), parentId: nodeId, index, draft: z.custom<NodeDraft>((v) => typeof v === "object" && v !== null && !Array.isArray(v)) }),
  z.strictObject({ op: z.literal("duplicateNode"), id: nodeId, parentId: nodeId, index }),
]) satisfies z.ZodType<EditorCommand>;
const pageId = z.string().min(1).max(200);
const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), commands: z.array(command).min(1).max(COMMAND_LIMITS.commands), pageId: pageId.optional() });

// One batch = one History step. Stale baseRevision -> 409 {revision}; returns { revision, createdIds, canUndo, canRedo }
// (+ `affected` when the editor names its page, E3 §5).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, commands, pageId: page } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusiveEdit(db, id, (store) => withAffected(db, id, store, page, () => store.commitCommands(id, baseRevision, commands, "user"))));
  });
}
