// E4 §5: the AI tab's pure rules — scope chip, input lock, "Hoàn tác lượt này", selection after a turn.
import type { ChatRow, ChatStatus } from "@/core/chat-store";
import type { DocIndex } from "./model";

export const VIEW_ONLY_TEXT = "Dùng màn hình ≥ 768px để chỉnh sửa";
export const STATUS_VI: Record<ChatStatus, string> = { ok: "Đã sửa", answer: "Trả lời", refused: "Bị từ chối", error: "Lỗi", cancelled: "Đã huỷ", stale: "Trang đã đổi" };

// The client's view of the server's scope (spec §2): the sections holding the selection, in page order.
export function scopeLabel(index: DocIndex, sections: readonly { id: string; name: string }[], selection: readonly string[]): string {
  const held = new Set(selection.flatMap((id) => { const s = index.get(id)?.sectionId; return s ? [s] : []; }));
  const names = sections.filter((s) => held.has(s.id)).map((s) => s.name);
  if (!names.length) return "Cả trang";
  return `Phạm vi: section ${names[0]}${names.length > 1 ? ` (+${names.length - 1})` : ""}`;
}

// Why the input is off (null = usable): view-only, edit main, a spent budget — in that order.
export function chatLock(s: { editable: boolean; editingMain: boolean; tokensUsed: number; tokenBudget: number }): string | null {
  if (!s.editable) return VIEW_ONLY_TEXT;
  if (s.editingMain) return "Đang sửa main component — bấm Xong để chat.";
  if (s.tokensUsed >= s.tokenBudget) return "Hết ngân sách token của project.";
  return null;
}

// "Hoàn tác lượt này": the turn's step is still the latest (the tab sits at the revision it produced).
export const canUndoTurn = (m: ChatRow, revision: number, canUndo: boolean): boolean =>
  m.role === "assistant" && m.status === "ok" && m.revision === revision && canUndo;

// R5: the selected nodes that still exist (the same array when none died), else the first created node that exists.
export function selectionAfter(prev: string[], alive: (id: string) => boolean, created: readonly string[]): string[] {
  const kept = prev.filter(alive);
  if (kept.length === prev.length) return prev;
  if (kept.length) return kept;
  const first = created.find(alive);
  return first ? [first] : [];
}
