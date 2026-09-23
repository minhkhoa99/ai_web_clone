// Once per e2e run: a scratch dir that coordinates the single shared `next build` (tests/e2e/next-app.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    nextBuildDir: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "next-build-"));
  project.provide("nextBuildDir", dir);
  return () => rm(dir, { recursive: true, force: true });
}
