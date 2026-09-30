// Preview & QA screen model (spec parity §3.6). Pure, client-safe.
import type { FidelityItem } from "@/core/ir-v2";
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

// --- Fidelity report (E1 §5): its own counts, never mixed into the pixel score above ---
export type FidelityStatus = FidelityItem["status"];
export const FIDELITY_STATUSES: FidelityStatus[] = ["supported", "partial", "unsupported"];
export const FIDELITY_LABEL: Record<FidelityStatus, string> = { supported: "Hỗ trợ", partial: "Một phần", unsupported: "Không hỗ trợ" };

export function fidelityCounts(items: FidelityItem[]): Record<FidelityStatus, number> {
  const out = { supported: 0, partial: 0, unsupported: 0 };
  for (const x of items) out[x.status]++;
  return out;
}

export const filterFidelity = (items: FidelityItem[], page: string, status: FidelityStatus | "all"): FidelityItem[] =>
  items.filter((x) => (page === "all" || x.pageId === page) && (status === "all" || x.status === status));

// Almost every real page has one "script" item (analytics, JSON-LD…): across pages they collapse into one row
// that says on how many pages (the per-page counts show with a page filter).
const GROUPED = new Set(["script"]);
export type FidelityRow = { item: FidelityItem; pages: number };
export function fidelityRows(items: FidelityItem[]): FidelityRow[] {
  const rows: FidelityRow[] = [];
  const groups = new Map<string, FidelityRow>();
  for (const item of items) {
    const key = GROUPED.has(item.feature) ? `${item.feature}:${item.status}` : undefined;
    const row = key ? groups.get(key) : undefined;
    if (row) row.pages++;
    else {
      const next = { item, pages: 1 };
      rows.push(next);
      if (key) groups.set(key, next);
    }
  }
  return rows.map((r) => (r.pages > 1 ? { ...r, item: { ...r.item, pageId: "", note: `JS không chạy trên ${r.pages} trang (xem từng trang để biết số nguồn)` } } : r));
}

// The node to scroll to: only one the loaded clone page really has ([data-ir-id]); else the row shows sourceRef/note.
export const nodeTarget = (item: FidelityItem, loadedPage: string, present: ReadonlySet<string>): string | undefined =>
  item.nodeId !== undefined && item.pageId === loadedPage && present.has(item.nodeId) ? item.nodeId : undefined;
