import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Until E2 Task 6 the E1 [data-behavior] runtime lives between /* legacy:start */ and /* legacy:end */ and is not
// counted. Task 6 deletes that block and this exclusion (then the whole file is measured).
test("js/runtime.js stays <= 15 KB (E2 §10)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url)), "utf8");
  expect(src).toContain("/* legacy:end */");
  const counted = src.replace(/\/\* legacy:start \*\/[\s\S]*\/\* legacy:end \*\//, "");
  expect(Buffer.byteLength(counted, "utf8")).toBeLessThanOrEqual(15 * 1024);
});
