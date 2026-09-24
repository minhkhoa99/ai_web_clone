// Seeds app state straight into the next app's db (WAL: the server sees committed rows at once) + workspace files.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { projectConfigSchema } from "@/core/jobs-base";

export type SeedTask = { phase: string; key: string; status: string; errorCode?: string; errorMsg?: string; updatedAt?: number };
export type SeedProject = { url: string; status: string; mode?: "single" | "crawl"; progress?: number; config?: Record<string, unknown>; tasks?: SeedTask[] };

export function seedProject(db: DatabaseSync, p: SeedProject): string {
  const id = randomUUID();
  const cfg = projectConfigSchema.parse(p.config ?? {}); // the frozen config every screen reads, defaults filled in
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status,progress) VALUES(?,?,?,?,?,?)").run(id, p.url, p.mode ?? "single", JSON.stringify(cfg), p.status, p.progress ?? 0);
  const ins = db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code,error_msg,updated_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,unixepoch()))");
  for (const t of p.tasks ?? []) ins.run(randomUUID(), id, t.phase, t.key, t.status, t.errorCode ?? null, t.errorMsg ?? null, t.updatedAt ?? null);
  return id;
}

export async function writeWs(root: string, id: string, rel: string, data: string | Uint8Array): Promise<void> {
  const path = join(root, id, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export function pngOf(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([r, g, b, 255], i * 4);
  return PNG.sync.write(png);
}
