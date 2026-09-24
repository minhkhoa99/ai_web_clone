// The one atomic-write helper (spec §4 checkpoint invariant): write a tmp file, then rename it into place, so a
// reader or a crash never sees a half-written file. The tmp name is unique: concurrent writers of the same path
// (two pages sharing an asset) never write into each other's tmp.
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";

// A project's workspace dir (captures, assets, out/, profile) — the one definition, core and app alike.
// (Not in config.ts: next build would trace `join(process.cwd(), …)` + a dynamic segment as the whole project.)
export const workspaceOf = (projectId: string): string => join(config.workspaceRoot, projectId);

export async function atomicWrite(path: string, write: (tmp: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await write(tmp);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export const writeFileAtomic = (path: string, data: string | Uint8Array): Promise<void> => atomicWrite(path, (tmp) => writeFile(tmp, data));

export const writeJsonAtomic = (path: string, data: unknown): Promise<void> => writeFileAtomic(path, JSON.stringify(data));

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
