// Shared JobDeps for e2e suites that run the real pipeline with no network AI: naming keeps the
// deterministic fallback names, the fix loop reports every section red without patching.
import type { JobDeps } from "@/core/jobs";
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";

export const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) =>
    failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};
