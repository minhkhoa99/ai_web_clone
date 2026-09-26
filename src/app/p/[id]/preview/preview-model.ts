// Preview & QA screen model (spec parity §3.6). Pure, client-safe.
import type { TaskStatus } from "@/core/jobs-base";

export type Fix = { pageId: string; sectionId: string; status: TaskStatus; errorCode: string | null; errorMsg: string | null };

// The "cần sửa" card: what the automatic fix loop did for this section (no diagnostic numbers; the task's
// error message is shown under it). A pending/running task only means "being fixed" while the project runs.
export function fixText(fix: Fix | undefined, projectStatus: string): string {
  if (!fix) return "Chưa qua vòng sửa tự động.";
  if (fix.status === "pending" || fix.status === "running") return projectStatus === "running" ? "Đang sửa…" : `Chưa sửa (project ${projectStatus})`;
  if (fix.status !== "done") return `Vòng sửa lỗi: ${fix.errorCode ?? fix.status}.`;
  if (fix.errorCode === "BUDGET_EXCEEDED") return "Dừng sửa: hết ngân sách token.";
  if (fix.errorCode) return `Dừng sửa: ${fix.errorCode}.`;
  return "Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng.";
}

const KIND: Record<string, string> = {
  hover: "Hover",
  menu: "Menu thả xuống",
  tab: "Tab",
  accordion: "Accordion",
  modal: "Modal",
  carousel: "Carousel",
  sticky: "Sticky/cuộn",
  form: "Form",
};
const MAX_TRIGGER = 60;

export function checklistLabel(kind: string, trigger: string): string {
  const t = trigger.replace(/\s+/g, " ").trim();
  return `${KIND[kind] ?? kind} · ${t.length > MAX_TRIGGER ? `${t.slice(0, MAX_TRIGGER - 1)}…` : t}`;
}

// D6: the overall "khớp" = mean of the section scores; the pass gate stays per section (spec SP1 §9).
export const meanScore = (scores: { score: number }[]): number | null => (scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : null);
