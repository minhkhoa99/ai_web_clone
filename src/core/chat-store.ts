// E4 §4: the editor's AI chat log per project, in SQLite apart from the History (E1 §3: no prompt in document_history).
// Bounded: <= 200 messages a project (the oldest dropped on write), a user message <= 2 000 chars, a reply <= 1 000.
// The table is created on first use (R1: db.ts carries the user's unfinished edits). Nothing here reaches logs or the graph.
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db";

export const CHAT_STORE_LIMITS = { messages: 200, page: 50, userChars: 2000, replyChars: 1000 } as const;
export type ChatStatus = "ok" | "answer" | "refused" | "error" | "cancelled" | "stale";
export type ChatRow = { seq: number; role: "user" | "assistant"; text: string; pageId: string; status: ChatStatus | null; revision: number | null; commands: number; tokens: number; createdAt: number };
export type TurnRecord = { pageId: string; text: string; reply: string; status: ChatStatus; revision?: number; commands: number; tokens: number };

type Raw = { seq: number; role: "user" | "assistant"; text: string; page_id: string; status: ChatStatus | null; revision: number | null; commands: number; tokens: number; created_at: number };
const COLS = "seq,role,text,page_id,status,revision,commands,tokens,created_at";
const toRow = (r: Raw): ChatRow => ({ seq: r.seq, role: r.role, text: r.text, pageId: r.page_id, status: r.status, revision: r.revision, commands: r.commands, tokens: r.tokens, createdAt: r.created_at });

const ready = new WeakSet<DatabaseSync>();
function ensure(db: DatabaseSync): DatabaseSync {
  if (!ready.has(db)) {
    db.exec("CREATE TABLE IF NOT EXISTS chat_messages(project_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, page_id TEXT NOT NULL, status TEXT, revision INTEGER, commands INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(project_id,seq));");
    ready.add(db);
  }
  return db;
}

// One finished turn: the user's message and the assistant's in one transaction, then the oldest beyond 200 go.
export function appendTurn(db: DatabaseSync, projectId: string, t: TurnRecord): { user: ChatRow; assistant: ChatRow } {
  ensure(db);
  return tx(db, () => {
    const { next } = db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS next FROM chat_messages WHERE project_id=?").get(projectId) as { next: number };
    const insert = db.prepare("INSERT INTO chat_messages(project_id,seq,role,text,page_id,status,revision,commands,tokens) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run(projectId, next, "user", t.text.slice(0, CHAT_STORE_LIMITS.userChars), t.pageId, null, null, 0, 0);
    insert.run(projectId, next + 1, "assistant", t.reply.slice(0, CHAT_STORE_LIMITS.replyChars), t.pageId, t.status, t.revision ?? null, t.commands, t.tokens);
    db.prepare("DELETE FROM chat_messages WHERE project_id=? AND seq<=?").run(projectId, next + 1 - CHAT_STORE_LIMITS.messages);
    const rows = db.prepare(`SELECT ${COLS} FROM chat_messages WHERE project_id=? AND seq>=? ORDER BY seq`).all(projectId, next) as Raw[];
    return { user: toRow(rows[0]!), assistant: toRow(rows[1]!) };
  }, true);
}

// The newest `limit` (<= 50) messages before `before`, oldest first.
export function listMessages(db: DatabaseSync, projectId: string, before = Number.MAX_SAFE_INTEGER, limit: number = CHAT_STORE_LIMITS.page): ChatRow[] {
  const rows = ensure(db).prepare(`SELECT ${COLS} FROM chat_messages WHERE project_id=? AND seq<? ORDER BY seq DESC LIMIT ?`)
    .all(projectId, before, Math.min(limit, CHAT_STORE_LIMITS.page)) as Raw[];
  return rows.reverse().map(toRow);
}

export const recentTurns = (db: DatabaseSync, projectId: string, turns: number): ChatRow[] => listMessages(db, projectId, undefined, turns * 2);

export function clearChat(db: DatabaseSync, projectId: string): void {
  ensure(db).prepare("DELETE FROM chat_messages WHERE project_id=?").run(projectId);
}
