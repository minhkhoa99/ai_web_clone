import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "@/core/config";
import { openDb } from "@/core/db";

// One connection per process; kept on globalThis so dev HMR (module re-evaluation) doesn't open another.
const g = globalThis as { __sp1Db?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (g.__sp1Db) return g.__sp1Db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  g.__sp1Db = openDb(config.dbPath);
  return g.__sp1Db;
}
