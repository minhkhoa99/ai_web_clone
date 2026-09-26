import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// mergeConfig concatenates array fields (e.g. test.include), so it can't
// replace the unit-test glob on its own — override it explicitly after merging.
const merged = mergeConfig(
  base,
  defineConfig({
    // hookTimeout: browser launch/close in hooks slows down while ui-smoke runs `next build` in parallel
    test: { testTimeout: 60_000, hookTimeout: 60_000 },
  }),
);

export default defineConfig({
  ...merged,
  test: { ...merged.test, include: ["tests/e2e/**/*.test.ts"], globalSetup: ["tests/e2e/global-setup.ts"], setupFiles: ["tests/e2e/per-file-db.ts"] },
});
