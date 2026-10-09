import { z } from "zod";
import { CHAT_LIMITS } from "@/core/ai-chat";
import { clearChat, listMessages } from "@/core/chat-store";
import { beginTurn, chatBudget, chatBusy, endTurn, runTurn } from "@/app/_server/chat";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, jsonBody, requireProject, type IdCtx } from "@/app/_server/http";
import { requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const nodeId = z.string().min(1).max(200);
const bodySchema = z.strictObject({
  text: z.string().trim().min(1).max(CHAT_LIMITS.textChars),
  baseRevision: z.number().int().min(0),
  pageId: nodeId,
  selection: z.array(nodeId).max(CHAT_LIMITS.selection),
  breakpoint: z.union([z.literal(1440), z.literal(768), z.literal(375)]),
});

// E4 §4: the chat log (newest 50 before ?before=<seq>, oldest first) + the token budget + whether a turn runs.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireProject(db, id);
    const raw = new URL(req.url).searchParams.get("before");
    const before = raw === null ? undefined : Number(raw);
    if (before !== undefined && !(Number.isInteger(before) && before > 0)) throw new ApiError(400, "VALIDATION", "before must be a positive integer");
    return Response.json({ messages: listMessages(db, id, before), ...chatBudget(db, id), busy: chatBusy(id) });
  });
}

// One turn (R2: 200 with its status for every turn that ran; 400/404/409 only for a bad or refused request).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const body = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const controller = beginTurn(id);
    try {
      return Response.json(await runTurn(db, id, body, controller, req.signal));
    } finally {
      endTurn(id, controller);
    }
  });
}

// "Xoá hội thoại": the chat only, never the History.
export function DELETE(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    if (chatBusy(id)) throw new ApiError(409, "CHAT_BUSY", "Đang có một lượt chat — chờ xong hoặc Huỷ rồi xoá.");
    clearChat(db, id);
    return Response.json({ ok: true });
  });
}
