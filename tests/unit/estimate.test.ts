import { expect, test } from "vitest";
import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE, estimateRun } from "@/core/estimate";

const base = { concurrency: 3, delayMs: 500, tokenBudget: 2_000_000, sectionsPerPage: DEFAULT_SECTIONS_PER_PAGE, fixRate: DEFAULT_FIX_RATE };

test("1 page: 2 fix sections, naming + fix tokens, capture/name/qa/fix/re-qa seconds", () => {
  expect(estimateRun({ ...base, pages: 1 })).toEqual({ tokens: 123_000, cappedByBudget: false, seconds: 199.5, fixSections: 2 });
});

test("100 pages hit the token budget; seconds follow the concurrency and the fix concurrency 2", () => {
  expect(estimateRun({ ...base, pages: 100 })).toEqual({ tokens: 2_000_000, cappedByBudget: true, seconds: 16_980, fixSections: 200 });
});

test("fixSections rounds up; no fix section -> no re-score pass; 0 pages -> 0", () => {
  expect(estimateRun({ ...base, pages: 3, fixRate: 0.1 }).fixSections).toBe(3); // 2.4 -> 3
  expect(estimateRun({ ...base, pages: 2, fixRate: 0 })).toEqual({ tokens: 6_000, cappedByBudget: false, seconds: 45 + 1 + 20 + 24, fixSections: 0 });
  expect(estimateRun({ ...base, pages: 0 })).toEqual({ tokens: 0, cappedByBudget: false, seconds: 0, fixSections: 0 });
});
