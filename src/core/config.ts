import { join } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspace");

export const config = {
  workspaceRoot: root,
  dbPath: process.env.DB_PATH ?? join(process.cwd(), "sp1.db"),
  keyPath: process.env.KEY_PATH ?? join(process.cwd(), "secret.key"),
};
