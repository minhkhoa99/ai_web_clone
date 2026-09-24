// Project statuses a run can be resumed from: the resume route's guard and every "Tiếp tục" button.
// Dependency-free so client components can import it.
export const RESUMABLE_STATUSES: readonly string[] = ["paused", "interrupted", "failed", "needs_auth"];
