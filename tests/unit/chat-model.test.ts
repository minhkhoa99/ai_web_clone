import { expect, test } from "vitest";
import type { ChatRow } from "@/core/chat-store";
import type { DocIndex, Entry } from "@/app/p/[id]/editor/visual/model";
import { canUndoTurn, chatLock, scopeLabel, selectionAfter, VIEW_ONLY_TEXT } from "@/app/p/[id]/editor/visual/chat-model";

const entry = (sectionId?: string) => ({ sectionId } as Entry);
const index: DocIndex = new Map([["a", entry("S1")], ["b", entry("S1")], ["c", entry("S2")], ["shell", entry(undefined)]]);
const sections = [{ id: "S1", name: "Hero" }, { id: "S2", name: "Footer" }];
const row = (over: Partial<ChatRow>): ChatRow => ({ seq: 2, role: "assistant", text: "", pageId: "home", status: "ok", revision: 7, commands: 1, tokens: 1, createdAt: 0, ...over });

test("scopeLabel: none / shell-only -> whole page; one or more sections in page order", () => {
  expect(scopeLabel(index, sections, [])).toBe("Cả trang");
  expect(scopeLabel(index, sections, ["shell"])).toBe("Cả trang");
  expect(scopeLabel(index, sections, ["a", "b"])).toBe("Phạm vi: section Hero");
  expect(scopeLabel(index, sections, ["c", "a"])).toBe("Phạm vi: section Hero (+1)");
});

test("chatLock: view-only, then edit main, then budget; null when the input is usable", () => {
  expect(chatLock({ editable: false, editingMain: true, tokensUsed: 9, tokenBudget: 1 })).toBe(VIEW_ONLY_TEXT);
  expect(chatLock({ editable: true, editingMain: true, tokensUsed: 0, tokenBudget: 1 })).toBe("Đang sửa main component — bấm Xong để chat.");
  expect(chatLock({ editable: true, editingMain: false, tokensUsed: 10, tokenBudget: 10 })).toBe("Hết ngân sách token của project.");
  expect(chatLock({ editable: true, editingMain: false, tokensUsed: 9, tokenBudget: 10 })).toBeNull();
});

test("canUndoTurn: only an ok turn whose revision is the tab's current one, with Undo available", () => {
  expect(canUndoTurn(row({}), 7, true)).toBe(true);
  expect(canUndoTurn(row({}), 8, true)).toBe(false);
  expect(canUndoTurn(row({}), 7, false)).toBe(false);
  expect(canUndoTurn(row({ status: "answer", revision: null }), 7, true)).toBe(false);
  expect(canUndoTurn(row({ role: "user", status: null }), 7, true)).toBe(false);
});

test("selectionAfter: keeps live ids (same array when nothing died); none left -> the first created id that exists", () => {
  const prev = ["a", "b"];
  expect(selectionAfter(prev, () => true, ["n"])).toBe(prev);
  expect(selectionAfter(prev, (x) => x !== "b", ["n"])).toEqual(["a"]);
  expect(selectionAfter(prev, (x) => x === "n", ["n", "m"])).toEqual(["n"]);
  expect(selectionAfter(prev, () => false, [])).toEqual([]);
});
