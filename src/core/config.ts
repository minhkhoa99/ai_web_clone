import { join } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspace");

// P28: a non-numeric / zero / negative / infinite TOKEN_BUDGET falls back to the default instead of a NaN budget
export function tokenBudgetFrom(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2_000_000;
}

export const config = {
  workspaceRoot: root,
  dbPath: process.env.DB_PATH ?? join(process.cwd(), "sp1.db"),
  keyPath: process.env.KEY_PATH ?? join(process.cwd(), "secret.key"),
  tokenBudget: tokenBudgetFrom(process.env.TOKEN_BUDGET),
};
