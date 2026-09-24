// Rough run estimate for the sitemap picker (spec parity §4.6): tokens and wall time for the selected pages.
// Pure and dependency-free: client components import it. Every constant is a coarse heuristic, not a measurement —
// recalibrate when real runs are timed. No money anywhere.
export type EstimateInput = { pages: number; concurrency: number; delayMs: number; tokenBudget: number; sectionsPerPage: number; fixRate: number };
export type Estimate = { tokens: number; cappedByBudget: boolean; seconds: number; fixSections: number };
export type HistoryRates = Pick<EstimateInput, "sectionsPerPage" | "fixRate">;

// naming: outline (depth-3 tag tree + 200 chars of text per section, ~8 sections ≈ 1 200 tokens) + thumbnail
// <= 400×1200 px (≈ w·h/750 ≈ 640 tokens) + prompt/answer ≈ 500
export const NAME_TOKENS_PER_PAGE = 3_000;
// 1 fix call ≈ 24 000 chars of context / 4 ≈ 6 000 + 3 crops ≈ 4 800 + answer <= 4 096 ≈ 15 000; assumed 2 rounds × 2
// calls on average (hard ceiling 3 rounds × 6 calls, always cut by the budget)
export const FIX_TOKENS_PER_SECTION = 60_000;
export const DEFAULT_SECTIONS_PER_PAGE = 8; // no history yet
export const DEFAULT_FIX_RATE = 0.25; // share of sections needing a fix, no history yet
const CAPTURE_S_PER_PAGE = 45; // load + lazy scroll + 3 breakpoints + interaction scan (the 5 min/page cap not counted)
const NAME_S_PER_PAGE = 10; // 1 AI call
const QA_S_PER_PAGE_BP = 4; // render + shoot 1 page × 1 breakpoint
const FIX_S_PER_SECTION = 120; // 2 rounds × (2 AI calls + re-score)
const FIX_CONCURRENCY = 2; // spec SP1 §1
const BPS = 3;

export function estimateRun(i: EstimateInput): Estimate {
  const fixSections = Math.ceil(i.pages * i.sectionsPerPage * i.fixRate);
  const raw = i.pages * NAME_TOKENS_PER_PAGE + fixSections * FIX_TOKENS_PER_SECTION;
  const qa = i.pages * BPS * QA_S_PER_PAGE_BP;
  const seconds =
    Math.ceil(i.pages / i.concurrency) * CAPTURE_S_PER_PAGE +
    (i.pages * i.delayMs) / 1000 +
    i.pages * NAME_S_PER_PAGE +
    qa +
    Math.ceil(fixSections / FIX_CONCURRENCY) * FIX_S_PER_SECTION +
    (fixSections > 0 ? qa : 0);
  return { tokens: Math.min(raw, i.tokenBudget), cappedByBudget: raw > i.tokenBudget, seconds, fixSections };
}
