import { expect, test } from "vitest";
import { tokenBudgetFrom } from "@/core/config";

test("TOKEN_BUDGET: a positive finite number is used, anything else falls back to 2_000_000 (never NaN/0/negative)", () => {
  expect(tokenBudgetFrom("500000")).toBe(500_000);
  expect(tokenBudgetFrom("1.5e6")).toBe(1_500_000);
  for (const bad of [undefined, "", "abc", "0", "-5", "Infinity", "NaN", " "]) expect(tokenBudgetFrom(bad), String(bad)).toBe(2_000_000);
});
