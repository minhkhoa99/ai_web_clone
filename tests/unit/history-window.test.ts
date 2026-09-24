import { expect, test } from "vitest";
import { pageWindow } from "@/app/history";

test("pagination window: <= 7 entries, 1 … k-1 k k+1 … N", () => {
  expect(pageWindow(1, 1)).toEqual([1]);
  expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(pageWindow(1, 10)).toEqual([1, 2, "gap", 10]);
  expect(pageWindow(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
  expect(pageWindow(10, 10)).toEqual([1, "gap", 9, 10]);
  expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, "gap", 10]);
  for (let n = 1; n <= 30; n++) for (let k = 1; k <= n; k++) expect(pageWindow(k, n).length).toBeLessThanOrEqual(7);
});
