import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,url TEXT,mode TEXT,config_json TEXT,status TEXT,progress INTEGER DEFAULT 0,tokens_used INTEGER DEFAULT 0,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,key TEXT,status TEXT,attempts INTEGER DEFAULT 0,output_path TEXT,error_code TEXT,error_msg TEXT,updated_at INTEGER DEFAULT (unixepoch()),UNIQUE(project_id,phase,key));`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_ps ON tasks(project_id,status);`,
  `CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT,kind TEXT,base_url TEXT,api_key_enc TEXT,roles_json TEXT);`,
  `CREATE TABLE IF NOT EXISTS nodes(id TEXT,project_id TEXT,type TEXT,key TEXT,data_json TEXT,PRIMARY KEY(project_id,id));`,
  `CREATE TABLE IF NOT EXISTS edges(project_id TEXT,src TEXT,dst TEXT,type TEXT);`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_pt ON nodes(project_id,type);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src,type);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst,type);`,
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // busy_timeout first: even the journal_mode switch can meet another connection's lock (e2e files run in parallel)
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  for (const m of MIGRATIONS) db.exec(m);
  // idempotent column add (SQLite has no ADD COLUMN IF NOT EXISTS): remembered login credentials, encrypted
  const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "auth_enc")) db.exec("ALTER TABLE projects ADD COLUMN auth_enc TEXT");
  // save order of providers (insert or update bumps it): the newest one with a role serves that role
  const providerCols = db.prepare("PRAGMA table_info(providers)").all() as { name: string }[];
  if (!providerCols.some((c) => c.name === "saved_seq")) db.exec("ALTER TABLE providers ADD COLUMN saved_seq INTEGER DEFAULT 0");
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
