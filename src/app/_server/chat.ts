// E4 §1/§4: one AI chat turn per project (in-process, on globalThis like session.ts), its cancel (R3), the project's
// token budget, and the turn itself: AI outside any lock, then one ai_editor step under exclusiveEdit + withAffected.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chatScope, type ChatBp } from "@/core/ai-chat-scope";
import { CANCELLED_TEXT, CHAT_LIMITS, runChatTurn, type ChatTurnResult, type TurnOutcome } from "@/core/ai-chat";
import { appendTurn, recentTurns, type ChatStatus } from "@/core/chat-store";
import { config } from "@/core/config";
import type { Affected } from "@/core/editor-canvas";
import { generate } from "@/core/gateway";
import { applyCommands, prepareCommands, type EditorCommand } from "@/core/ir-command";
import type { EditResult } from "@/core/ir-store";
import { projectDocuments } from "@/core/jobs";
import { withAffected } from "./editor";
import { ApiError } from "./http";
import { exclusiveEdit } from "./session";

const g = globalThis as { __sp1Chat?: Map<string, AbortController> };
const turns = (g.__sp1Chat ??= new Map());

export function beginTurn(projectId: string): AbortController {
  if (turns.has(projectId)) throw new ApiError(409, "CHAT_BUSY", "Đang có một lượt chat khác cho project này.");
  const c = new AbortController();
  turns.set(projectId, c);
  return c;
}
export function endTurn(projectId: string, c: AbortController): void {
  if (turns.get(projectId) === c) turns.delete(projectId);
}
export const chatBusy = (projectId: string): boolean => turns.has(projectId);
export function cancelTurn(projectId: string): boolean {
  const c = turns.get(projectId);
  c?.abort(new Error("cancelled"));
  return !!c;
}

// The budget the gateway enforces (gateway.ts usageOf, R1: that file is not touched): config_json.tokenBudget, else the default.
export function chatBudget(db: DatabaseSync, projectId: string): { tokensUsed: number; tokenBudget: number } {
  const row = db.prepare("SELECT tokens_used,config_json FROM projects WHERE id=?").get(projectId) as { tokens_used: number; config_json: string | null } | undefined;
  const cfg = row?.config_json ? (JSON.parse(row.config_json) as { tokenBudget?: unknown }) : {};
  return { tokensUsed: row?.tokens_used ?? 0, tokenBudget: typeof cfg.tokenBudget === "number" ? cfg.tokenBudget : config.tokenBudget };
}

export type ChatBody = { text: string; baseRevision: number; pageId: string; selection: string[]; breakpoint: ChatBp };
const STALE_TEXT = "Trang đã đổi trong lúc AI làm — tải lại rồi gửi lại.";
const RELOAD = new Set(["STALE_REVISION", "PROJECT_BUSY", "BAD_STATE"]);
type Outcome = { status: ChatStatus; reply: string; tokens: number; code?: string; commands: EditorCommand[] };

// `requestSignal` (the POST's req.signal): a closed tab or dropped connection aborts the turn like Huỷ does.
export async function runTurn(db: DatabaseSync, projectId: string, body: ChatBody, controller: AbortController, requestSignal?: AbortSignal): Promise<ChatTurnResult> {
  const store = projectDocuments(db);
  const doc = await store.loadDocument(projectId);
  const page = doc.pages.find((p) => p.id === body.pageId);
  if (!page) throw new ApiError(404, "NOT_FOUND", `page ${body.pageId} not found`);
  let outcome: Outcome = { status: "stale", reply: STALE_TEXT, tokens: 0, commands: [] };
  let step: (EditResult & { affected?: Affected }) | undefined;
  if (doc.revision === body.baseRevision) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CHAT_LIMITS.turnMs), ...(requestSignal ? [requestSignal] : [])]);
    const ran: TurnOutcome = await runChatTurn(
      { scope: chatScope(doc, body.pageId, body.selection), bp: body.breakpoint, pagePath: page.path, text: body.text, history: recentTurns(db, projectId, CHAT_LIMITS.historyTurns) },
      {
        generate: (o) => generate(db, { ...o, role: "code", projectId }),
        dryRun: (commands) => { applyCommands(doc, prepareCommands(doc, commands, randomUUID)); },
        signal,
      },
    );
    outcome = ran;
    if (ran.status === "ok" && signal.aborted) outcome = { ...ran, status: "cancelled", reply: CANCELLED_TEXT, commands: [] };
    else if (ran.status === "ok") {
      try {
        step = await exclusiveEdit(db, projectId, (s) => withAffected(db, projectId, s, body.pageId, () => s.commitCommands(projectId, body.baseRevision, ran.commands, "ai_editor")));
      } catch (e) {
        const err = e as { code?: string; message?: string; context?: { revision?: number; createdIds?: string[] } };
        if (err.code && RELOAD.has(err.code)) outcome = { ...ran, status: "stale", reply: STALE_TEXT, commands: [] };
        else if (err.code === "IR_PATCH_INVALID") outcome = { ...ran, status: "refused", reply: `AI chưa tạo được thay đổi hợp lệ: ${(err.message ?? "").slice(0, 500)}`, commands: [] };
        else if (err.code === "DOCUMENT_MATERIALIZE_FAILED" && typeof err.context?.revision === "number") {
          // committed, only the output is behind: the client reloads the page (the next read repairs it)
          step = { ...(await store.historyState(projectId)), revision: err.context.revision, createdIds: err.context.createdIds ?? [], affected: { sections: [], css: "", shellChanged: true, interactives: [] } };
        } else throw e;
      }
    }
  }
  // the project was deleted under the turn: no orphan chat rows (the delete route cancels the turn first, this covers its tail)
  if (!db.prepare("SELECT 1 AS x FROM projects WHERE id=?").get(projectId)) throw new ApiError(404, "NOT_FOUND", `project ${projectId} not found`);
  const count = step ? outcome.commands.length : 0;
  const rows = appendTurn(db, projectId, { pageId: body.pageId, text: body.text, reply: outcome.reply, status: outcome.status, ...(step && { revision: step.revision }), commands: count, tokens: outcome.tokens });
  console.info(`chat: ${count} lệnh, ${outcome.tokens} token, ${outcome.status}`); // never the texts (spec §4)
  const flags = step ?? (await store.historyState(projectId));
  return {
    status: outcome.status, reply: outcome.reply, ...(outcome.code && { code: outcome.code }), tokens: outcome.tokens, ...chatBudget(db, projectId),
    user: rows.user, message: rows.assistant, revision: flags.revision, createdIds: step?.createdIds ?? [], canUndo: flags.canUndo, canRedo: flags.canRedo,
    ...(step?.affected && { affected: step.affected }),
  };
}
