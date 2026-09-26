import { expect, test } from "vitest";
import { checklistLabel, fixText, meanScore, type Fix } from "@/app/p/[id]/preview/preview-model";

const fix = (status: Fix["status"], errorCode: string | null = null): Fix => ({ pageId: "home", sectionId: "s", status, errorCode });

test("fix card text from the fix task", () => {
  expect(fixText(undefined)).toBe("Chưa qua vòng sửa tự động.");
  expect(fixText(fix("pending"))).toBe("Đang sửa…");
  expect(fixText(fix("running"))).toBe("Đang sửa…");
  expect(fixText(fix("failed", "AI_AUTH"))).toBe("Vòng sửa lỗi: AI_AUTH.");
  expect(fixText(fix("done", "BUDGET_EXCEEDED"))).toBe("Dừng sửa: hết ngân sách token.");
  expect(fixText(fix("done"))).toBe("Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng.");
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
