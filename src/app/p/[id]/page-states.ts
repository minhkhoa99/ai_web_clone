// Progress screen model (spec parity §3.5). Pure and client-safe (type-only core import).
import type { StampedEvent } from "@/core/jobs-base";
import { SKIP, STOP_AI } from "@/core/statuses";
import { hintFor } from "@/app/_ui/error-hints";

export type TaskView = { phase: string; key: string; status: string; errorCode: string | null; errorMsg?: string | null };
export type PageRef = { pageId: string; url: string };
export type PageState = { pageId: string; path: string; state: "done" | "running" | "needs_auth" | "failed" | "skipped" | "pending"; phase?: string; code?: string };
export type RunSpan = { start: number | null; end: number | null };

// A page's tasks: capture:<pageId>, name:<pageId>, fix:<pageId>:<sectionId>.
function pageOf(t: TaskView): string | null {
  if (t.phase === "capture" || t.phase === "name") return t.key;
  if (t.phase !== "fix") return null;
  const i = t.key.indexOf(":");
  return i > 0 ? t.key.slice(0, i) : t.key;
}

// Done but degraded (hardening §4): AI stopped, budget spent, or the AI failed and a fallback was used.
const TROUBLE: ReadonlySet<string> = new Set([...STOP_AI, "BUDGET_EXCEEDED", "AI_BAD_RESPONSE", "AI_RATE_LIMIT"]);
const isTrouble = (t: TaskView) => t.status === "failed" || (t.status === "done" && TROUBLE.has(t.errorCode ?? ""));

export function pageStates(tasks: TaskView[], pages: PageRef[]): PageState[] {
  const byPage = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const id = pageOf(t);
    if (id === null) continue;
    const list = byPage.get(id);
    if (list) list.push(t);
    else byPage.set(id, [t]);
  }
  return pages.map(({ pageId, url }): PageState => {
    const own = byPage.get(pageId) ?? [];
    const u = new URL(url);
    const path = u.pathname + u.search;
    const capture = own.find((t) => t.phase === "capture");
    const name = own.find((t) => t.phase === "name");
    const running = own.find((t) => t.status === "running");
    if (own.some((t) => t.status === "needs_auth")) return { pageId, path, state: "needs_auth" };
    if (running) return { pageId, path, state: "running", phase: running.phase };
    if (capture?.status === "failed") {
      const code = capture.errorCode ?? undefined;
      return { pageId, path, state: code && SKIP.has(code) ? "skipped" : "failed", code };
    }
    const bad = own.find(isTrouble);
    if (bad) return { pageId, path, state: "failed", code: bad.errorCode ?? undefined };
    if (capture?.status === "done" && (!name || name.status === "done")) return { pageId, path, state: "done" };
    return { pageId, path, state: "pending" };
  });
}

// The "Lỗi & cảnh báo" panel rows: every task with an error code, failed first, otherwise in load (rowid) order.
export const errorRows = (tasks: TaskView[]): TaskView[] =>
  tasks.filter((t) => t.errorCode).sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));

// The status reason banner: `<code> — <hint>` (a free-text reason, e.g. an unexpected error's message, as is) and
// the latest task message of that code.
export function reasonOf(reason: string | null, tasks: TaskView[]): { title: string; message: string | undefined } | null {
  if (!reason) return null;
  const hint = hintFor(reason);
  const message = tasks.findLast((t) => t.errorCode === reason && t.errorMsg)?.errorMsg ?? undefined;
  return { title: hint ? `${reason} — ${hint}` : reason, message };
}

export function stateLabel(p: PageState): string {
  switch (p.state) {
    case "done":
      return "xong";
    case "running":
      return `đang chạy · ${p.phase ?? ""}`;
    case "needs_auth":
      return "cần đăng nhập";
    case "failed":
      return `lỗi · ${p.code ?? "?"}`;
    case "skipped":
      return `bỏ qua · ${p.code ?? "?"}`;
    case "pending":
      return "chờ";
  }
}

// Run clock from server stamps: the last `running` status starts it, the next status (paused, failed, …) ends it.
export function spanAfter(s: RunSpan, e: StampedEvent): RunSpan {
  if (e.type !== "status") return s;
  if (e.status === "running") return { start: e.at, end: null };
  return s.start !== null && s.end === null ? { start: s.start, end: e.at } : s;
}

export const runSpan = (events: StampedEvent[]): RunSpan => events.reduce(spanAfter, { start: null, end: null });

export function describe(e: StampedEvent): { level: "info" | "warn" | "error"; text: string } | null {
  switch (e.type) {
    case "status":
      return { level: e.status === "failed" ? "error" : "info", text: `trạng thái → ${e.status}${e.reason ? ` (${e.reason})` : ""}` };
    case "phase":
      return { level: "info", text: `pha ${e.phase}` };
    case "task": {
      const level = e.status === "failed" ? "error" : e.status === "needs_auth" ? "warn" : "info";
      const detail = [e.errorCode, e.error].filter(Boolean).join(": ");
      return { level, text: `[${e.phase}] ${e.key} → ${e.status}${detail ? ` — ${detail}` : ""}` };
    }
    case "log":
      return { level: e.level, text: e.message };
    case "needs_auth":
      return { level: "warn", text: `cần đăng nhập: ${e.url} (${e.code})` };
    case "progress":
      return null;
  }
}
