import { join } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspace");

export const config = {
  workspaceRoot: root,
  dbPath: process.env.DB_PATH ?? join(process.cwd(), "sp1.db"),
  keyPath: process.env.KEY_PATH ?? join(process.cwd(), "secret.key"),
  tokenBudget: Number(process.env.TOKEN_BUDGET ?? 2_000_000),
};

// A project's workspace dir (captures, assets, out/, profile) — the one definition, core and app alike.
export const workspaceOf = (projectId: string): string => join(config.workspaceRoot, projectId);
