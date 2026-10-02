import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("js/runtime.js stays <= 15 KB (E2 §10)", () => {
  expect(statSync(fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url))).size).toBeLessThanOrEqual(15 * 1024);
});
