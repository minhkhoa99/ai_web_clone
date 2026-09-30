import { expect, test } from "vitest";
import type { FidelityItem } from "@/core/ir-v2";
import { checklistLabel, fidelityCounts, fidelityRows, filterFidelity, fixText, meanScore, nodeTarget, type Fix } from "@/app/p/[id]/preview/preview-model";

const fix = (status: Fix["status"], errorCode: string | null = null, errorMsg: string | null = null): Fix => ({ pageId: "home", sectionId: "s", status, errorCode, errorMsg });

test("fix card text from the fix task; \"Đang sửa…\" only while the project runs (hardening §4)", () => {
  expect(fixText(undefined, "completed")).toBe("Chưa qua vòng sửa tự động.");
  expect(fixText(fix("pending"), "running")).toBe("Đang sửa…");
  expect(fixText(fix("running"), "running")).toBe("Đang sửa…");
  expect(fixText(fix("pending"), "failed")).toBe("Chưa sửa (project failed)");
  expect(fixText(fix("running"), "paused")).toBe("Chưa sửa (project paused)");
  expect(fixText(fix("failed", "AI_AUTH"), "failed")).toBe("Vòng sửa lỗi: AI_AUTH.");
  expect(fixText(fix("done", "BUDGET_EXCEEDED"), "completed")).toBe("Dừng sửa: hết ngân sách token.");
  expect(fixText(fix("done", "AI_QUOTA", "provider \"apmix\" returned status 402"), "completed")).toBe("Dừng sửa: AI_QUOTA.");
  expect(fixText(fix("done"), "completed")).toBe("Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng.");
});

test("checklist labels are deterministic from kind + trigger (no AI), trigger cut at 60 chars", () => {
  expect(checklistLabel("menu", "nav > li:nth-child(2) > a")).toBe("Menu thả xuống · nav > li:nth-child(2) > a");
  expect(checklistLabel("sticky", "header")).toBe("Sticky/cuộn · header");
  const long = checklistLabel("hover", `button.${"x".repeat(100)}`);
  expect(long.startsWith("Hover · button.")).toBe(true);
  expect(long.length).toBe("Hover · ".length + 60);
  expect(long.endsWith("…")).toBe(true);
  expect(["hover", "menu", "tab", "accordion", "modal", "carousel", "sticky", "form"].map((k) => checklistLabel(k, "t").split(" · ")[0])).toEqual([
    "Hover", "Menu thả xuống", "Tab", "Accordion", "Modal", "Carousel", "Sticky/cuộn", "Form",
  ]);
});

test("D6: the overall match is the mean of the page × breakpoint section scores", () => {
  expect(meanScore([])).toBeNull();
  expect(meanScore([{ score: 1 }, { score: 0.9 }, { score: 0.986 }])).toBeCloseTo(0.962, 6);
});

// --- Fidelity report (E1 §5) ---

const fi = (pageId: string, feature: string, status: FidelityItem["status"], extra: Partial<FidelityItem> = {}): FidelityItem => ({ pageId, feature, status, note: `${feature} note`, ...extra });
const items: FidelityItem[] = [
  fi("home", "carousel", "partial", { nodeId: "home:0.1", sourceRef: "home:0.1" }),
  fi("home", "script", "unsupported", { note: "2 nguồn JS" }),
  fi("home", "hover", "unsupported", { sourceRef: "home:0.2" }), // its clone node was deleted: no nodeId
  fi("about", "sticky", "supported", { nodeId: "about:0.3" }),
  fi("about", "script", "unsupported", { note: "5 nguồn JS" }),
];

test("Fidelity: one count per status", () => {
  expect(fidelityCounts([{ pageId: "p", feature: "carousel", status: "partial", note: "runtime" }])).toEqual({ supported: 0, partial: 1, unsupported: 0 });
  expect(fidelityCounts(items)).toEqual({ supported: 1, partial: 1, unsupported: 3 });
  expect(fidelityCounts([])).toEqual({ supported: 0, partial: 0, unsupported: 0 });
});

test("Fidelity: filter by page and status; an item whose node is gone stays listed", () => {
  expect(filterFidelity(items, "all", "all")).toEqual(items);
  expect(filterFidelity(items, "home", "all").map((x) => x.feature)).toEqual(["carousel", "script", "hover"]);
  expect(filterFidelity(items, "all", "unsupported").map((x) => `${x.pageId}/${x.feature}`)).toEqual(["home/script", "home/hover", "about/script"]);
  expect(filterFidelity(items, "about", "partial")).toEqual([]);
  expect(filterFidelity(items, "home", "unsupported")).toContainEqual(items[2]);
});

test("Fidelity rows: the per-page script items collapse into one row with the page count; the rest stay one row each", () => {
  const rows = fidelityRows(items);
  expect(rows.map((r) => [r.item.feature, r.pages])).toEqual([["carousel", 1], ["script", 2], ["hover", 1], ["sticky", 1]]);
  expect(rows[1]!.item.note).toBe("JS không chạy trên 2 trang (xem từng trang để biết số nguồn)");
  // one page: its script item is shown as is
  expect(fidelityRows(filterFidelity(items, "home", "all"))[1]).toEqual({ item: items[1], pages: 1 });
});

test("Fidelity: a node link only for a node that exists in the loaded clone page (never a dead link)", () => {
  const present = new Set(["home:0.1"]);
  expect(nodeTarget(items[0]!, "home", present)).toBe("home:0.1");
  expect(nodeTarget(items[0]!, "about", present)).toBeUndefined(); // another page is loaded
  expect(nodeTarget(items[2]!, "home", present)).toBeUndefined(); // deleted node: sourceRef/note shown instead
  expect(nodeTarget(items[3]!, "about", new Set())).toBeUndefined(); // node id known but not in the page DOM
});

test("Fidelity never changes the pixel score: an unsupported item leaves meanScore as is", () => {
  expect(meanScore([{ score: 0.95 }])).toBe(0.95);
  expect(fidelityCounts([fi("p", "script", "unsupported")]).unsupported).toBe(1);
  expect(meanScore([{ score: 0.95 }])).toBe(0.95);
});
