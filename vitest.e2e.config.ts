import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// mergeConfig concatenates array fields (e.g. test.include), so it can't
// replace the unit-test glob on its own — override it explicitly after merging.
const merged = mergeConfig(
  base,
  defineConfig({
    test: { testTimeout: 60_000 },
  }),
);

export default defineConfig({
  ...merged,
  test: { ...merged.test, include: ["tests/e2e/**/*.test.ts"] },
});
