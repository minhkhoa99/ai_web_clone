import { expect, test } from "vitest";
import { intervalOf } from "@/core/interactive-scan";

test("intervalOf: median gap between observed changes, clamped to the schema range, 100 ms steps", () => {
  expect(intervalOf([])).toBeUndefined();
  expect(intervalOf([1490])).toBe(1500);
  expect(intervalOf([1500, 3010, 4490])).toBe(1500);
  expect(intervalOf([200, 400, 600])).toBe(1000);
  expect(intervalOf([90_000])).toBe(60_000);
});
