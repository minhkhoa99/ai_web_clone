import { expect, test } from "vitest";
import { AppError, Codes } from "@/core/errors";

test("AppError carries code + context", () => {
  const e = new AppError(Codes.NAV_TIMEOUT, "nav timed out", { url: "x" });
  expect(e.code).toBe("NAV_TIMEOUT");
  expect(e.context?.url).toBe("x");
  expect(e).toBeInstanceOf(Error);
});
