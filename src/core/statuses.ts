// Dependency-free (errors.ts has no imports either) so client components can import it.
import { Codes } from "./errors";

// Project statuses a run can be resumed from: the resume route's guard and every "Tiếp tục" button.
export const RESUMABLE_STATUSES: readonly string[] = ["paused", "interrupted", "failed", "needs_auth"];

// The orchestrator's skip codes (core/jobs): a page left out on purpose, not a real failure — shared with the
// progress page's page-state derivation so the two never drift apart.
export const SKIP: ReadonlySet<string> = new Set(["ROBOTS_DISALLOWED", "ASSET_TOO_LARGE", "NODE_LIMIT", "PROJECT_SIZE_LIMIT"]);

// Persistent AI errors (hardening spec §1): no later call can succeed in this run, so AI stops like on
// BUDGET_EXCEEDED and the project still completes. The one definition core and app share.
export const STOP_AI_CODES = [Codes.AI_AUTH, Codes.AI_QUOTA, Codes.AI_BAD_CONFIG] as const;
export const STOP_AI: ReadonlySet<string> = new Set<string>(STOP_AI_CODES);
