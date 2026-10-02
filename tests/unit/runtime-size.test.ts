import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("js/runtime.js stays <= 20 KB (E2 §10, controller ruling: raised from 15 KB)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url)), "utf8");
  expect(src).not.toContain("data-behavior"); // the E1 runtime is gone (E2 Task 6)
  expect(Buffer.byteLength(src, "utf8")).toBeLessThanOrEqual(20 * 1024);
});
