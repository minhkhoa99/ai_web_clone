"use client";
// E4 §5: the AI tab — the project's chat (paged from the newest), the scope chip, the input (Enter sends, Shift+Enter
// is a new line, IME-safe), Huỷ while a turn runs, "Hoàn tác lượt này", the token line and "Xoá hội thoại".
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChatTurnResult } from "@/core/ai-chat";
import type { ChatRow } from "@/core/chat-store";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { fmtInt } from "@/app/_ui/format";
import { canUndoTurn, chatLock, STATUS_VI } from "./chat-model";

type Listing = { messages: ChatRow[]; tokensUsed: number; tokenBudget: number; busy: boolean };
type Props = {
  projectId: string; revision: number; canUndo: boolean; scope: string; editable: boolean; editingMain: boolean; busy: boolean;
  onSend(text: string): Promise<ChatTurnResult | null>; onCancel(): void; onUndo(): void;
};
const MAX = 2000;
const TONE: Record<string, "success" | "warn" | "danger" | "neutral"> = { ok: "success", answer: "neutral", refused: "warn", error: "danger", cancelled: "neutral", stale: "warn" };

export function ChatPanel({ projectId, revision, canUndo, scope, editable, editingMain, busy, onSend, onCancel, onUndo }: Props) {
  const [messages, setMessages] = useState<ChatRow[]>([]);
  const [more, setMore] = useState(false);
  const [budget, setBudget] = useState({ tokensUsed: 0, tokenBudget: Number.POSITIVE_INFINITY });
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const loadingOlder = useRef(false);
  const mounted = useRef(true); // a turn can finish after the user left this tab: nothing is set on an unmounted panel
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let off = false;
    api<Listing>(`/api/projects/${projectId}/editor/chat`).then((l) => {
      if (off) return;
      setMessages(l.messages);
      setMore(l.messages.length >= 50);
      setBudget({ tokensUsed: l.tokensUsed, tokenBudget: l.tokenBudget });
      requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }));
    }, (e: unknown) => !off && setNote(errorText(e)));
    return () => { off = true; };
  }, [projectId]);

  // a turn ended (busy true -> false, also one that started before this panel mounted): its two rows come from the server
  const wasBusy = useRef(busy);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (!was || busy) return;
    let off = false;
    api<Listing>(`/api/projects/${projectId}/editor/chat`).then((l) => {
      if (off) return;
      setMessages((m) => { const first = l.messages[0]?.seq; return first === undefined ? m : [...m.filter((x) => x.seq < first), ...l.messages]; });
      setBudget({ tokensUsed: l.tokensUsed, tokenBudget: l.tokenBudget });
      requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }));
    }, () => undefined);
    return () => { off = true; };
  }, [busy, projectId]);

  const older = async () => {
    if (!more || loadingOlder.current || !messages[0]) return;
    loadingOlder.current = true;
    try {
      const l = await api<Listing>(`/api/projects/${projectId}/editor/chat?before=${messages[0].seq}`);
      setMessages((m) => [...l.messages, ...m]);
      setMore(l.messages.length >= 50);
    } catch (e) { setNote(errorText(e)); } finally { loadingOlder.current = false; }
  };
  const lock = chatLock({ editable, editingMain, ...budget });
  const send = async () => {
    const t = text.trim();
    if (!t || busy || lock) return;
    setNote("");
    const r = await onSend(t);
    if (r && mounted.current) setText(""); // the rows themselves arrive with the busy -> idle refetch above
  };
  const clear = async () => {
    if (!confirm("Xoá toàn bộ hội thoại AI của project này? Lịch sử Undo không bị ảnh hưởng.")) return;
    try { await api(`/api/projects/${projectId}/editor/chat`, { method: "DELETE" }); setMessages([]); setMore(false); } catch (e) { setNote(errorText(e)); }
  };
  const warn = budget.tokensUsed >= 0.9 * budget.tokenBudget; // the progress page's 90 % warning
  const tokenText = `Token: ${fmtInt(budget.tokensUsed)} / ${Number.isFinite(budget.tokenBudget) ? fmtInt(budget.tokenBudget) : "—"}`;
  return (
    <section className="ve-chat" aria-label="Chat AI">
      <ul ref={list} className="ve-chat-list" data-ui="ui_editor_ai_messages" onScroll={(e) => { if (e.currentTarget.scrollTop === 0) void older(); }}>
        {messages.map((m) => (
          <li key={m.seq} className={`ve-chat-msg is-${m.role}`}>
            <p className="t-body-sm">{m.text}</p>
            {m.role === "assistant" && (
              <div className="ve-chat-meta">
                {m.status && <Badge tone={TONE[m.status] ?? "neutral"}>{STATUS_VI[m.status]}</Badge>}
                {m.status === "error" && <Link href="/settings/ai" className="t-label-md">Cài đặt AI</Link>}
                {m.status === "ok" && <Badge tone="primary">{m.commands} thay đổi</Badge>}
                {m.tokens > 0 && <span className="t-label-md text-3">{fmtInt(m.tokens)} token</span>}
                {editable && canUndoTurn(m, revision, canUndo) && <Button data-ui="ui_editor_ai_undo" icon="undo" onClick={onUndo} disabled={busy}>Hoàn tác lượt này</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="t-label-md text-2" data-ui="ui_editor_ai_scope">{scope}</p>
      {lock && <p className="t-body-sm text-2">{lock}</p>}
      {busy && <p className="t-body-sm" aria-live="polite">AI đang sửa…</p>}
      <textarea className="ve-chat-input" data-ui="ui_editor_ai_input" aria-label="Yêu cầu cho AI" placeholder="Ví dụ: đổi màu tiêu đề thành đỏ"
        value={text} maxLength={MAX} disabled={!!lock || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="ve-chat-meta">
        <span className="t-label-md text-3">{text.length}/{MAX}</span>
        {busy
          ? <Button data-ui="ui_editor_ai_cancel" icon="close" onClick={onCancel}>Huỷ</Button>
          : <Button data-ui="ui_editor_ai_send" variant="primary" onClick={() => void send()} disabled={!!lock || !text.trim()}>Gửi</Button>}
        {warn
          ? <Badge tone="warn" data-ui="ui_editor_ai_tokens">{tokenText}</Badge>
          : <span className="t-label-md text-3" data-ui="ui_editor_ai_tokens">{tokenText}</span>}
        <Button data-ui="ui_editor_ai_clear" variant="ghost" icon="delete" onClick={() => void clear()} disabled={busy || !messages.length || !editable}>Xoá hội thoại</Button>
      </div>
      {note && <p role="alert" className="t-body-sm">{note}</p>}
    </section>
  );
}
