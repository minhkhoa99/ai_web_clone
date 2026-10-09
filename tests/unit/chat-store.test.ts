import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { appendTurn, CHAT_STORE_LIMITS, clearChat, listMessages, recentTurns } from "@/core/chat-store";

const turn = (i: number) => ({ pageId: "home", text: `hỏi ${i}`, reply: `đáp ${i}`, status: "answer" as const, commands: 0, tokens: i });

test("appendTurn writes the user + assistant pair with consecutive seqs and returns both rows", () => {
  const db = openDb(":memory:");
  const { user, assistant } = appendTurn(db, "p", { pageId: "home", text: "đổi màu", reply: "Đã đổi", status: "ok", revision: 7, commands: 2, tokens: 120 });
  expect(user).toMatchObject({ seq: 1, role: "user", text: "đổi màu", pageId: "home", status: null, revision: null, commands: 0, tokens: 0 });
  expect(assistant).toMatchObject({ seq: 2, role: "assistant", text: "Đã đổi", status: "ok", revision: 7, commands: 2, tokens: 120 });
  expect(typeof assistant.createdAt).toBe("number");
});

test("texts are capped: user 2 000, reply 1 000", () => {
  const db = openDb(":memory:");
  const { user, assistant } = appendTurn(db, "p", { ...turn(1), text: "a".repeat(2500), reply: "b".repeat(1500) });
  expect(user.text).toHaveLength(CHAT_STORE_LIMITS.userChars);
  expect(assistant.text).toHaveLength(CHAT_STORE_LIMITS.replyChars);
});

test("at most 200 messages a project: the oldest go, other projects untouched", () => {
  const db = openDb(":memory:");
  appendTurn(db, "other", turn(0));
  for (let i = 1; i <= 101; i++) appendTurn(db, "p", turn(i)); // 202 messages
  const all: number[] = [];
  for (let before: number | undefined; ; ) {
    const page = listMessages(db, "p", before);
    if (!page.length) break;
    all.unshift(...page.map((m) => m.seq));
    before = page[0]!.seq;
  }
  expect(all).toHaveLength(CHAT_STORE_LIMITS.messages);
  expect(all[0]).toBe(3);
  expect(all.at(-1)).toBe(202);
  expect(listMessages(db, "other")).toHaveLength(2);
});

test("listMessages pages newest-first by `before`, each page oldest-first, at most 50", () => {
  const db = openDb(":memory:");
  for (let i = 1; i <= 30; i++) appendTurn(db, "p", turn(i)); // seq 1..60
  const last = listMessages(db, "p");
  expect(last.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, k) => k + 11));
  expect(listMessages(db, "p", 11).map((m) => m.seq)).toEqual(Array.from({ length: 10 }, (_, k) => k + 1));
  expect(listMessages(db, "p", undefined, 500)).toHaveLength(50);
});

test("recentTurns returns the last n turns (2n messages) oldest-first; clearChat empties one project", () => {
  const db = openDb(":memory:");
  for (let i = 1; i <= 8; i++) appendTurn(db, "p", turn(i));
  appendTurn(db, "q", turn(9));
  expect(recentTurns(db, "p", 6).map((m) => m.text)).toEqual([3, 4, 5, 6, 7, 8].flatMap((i) => [`hỏi ${i}`, `đáp ${i}`]));
  clearChat(db, "p");
  expect(listMessages(db, "p")).toEqual([]);
  expect(listMessages(db, "q")).toHaveLength(2);
  appendTurn(db, "p", turn(10)); // seq starts over after a clear
  expect(listMessages(db, "p")[0]!.seq).toBe(1);
});
