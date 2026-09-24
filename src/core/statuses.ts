// Project statuses a run can be resumed from: the resume route's guard and every "Tiếp tục" button.
// Dependency-free so client components can import it.
export const RESUMABLE_STATUSES: readonly string[] = ["paused", "interrupted", "failed", "needs_auth"];

// The orchestrator's skip codes (core/jobs): a page left out on purpose, not a real failure — shared with the
// progress page's page-state derivation so the two never drift apart.
export const SKIP: ReadonlySet<string> = new Set(["ROBOTS_DISALLOWED", "ASSET_TOO_LARGE", "NODE_LIMIT", "PROJECT_SIZE_LIMIT"]);
