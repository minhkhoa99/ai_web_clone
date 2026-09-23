// A real `next build` + `next start` for UI e2e tests. The build runs once per vitest run: the first test
// file to take the lock builds, the others wait for its result (two builds in one .next would clash).
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inject } from "vitest";

export type NextEnv = { DB_PATH: string; WORKSPACE_ROOT: string; KEY_PATH: string };

const root = fileURLToPath(new URL("../..", import.meta.url));
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const BUILD_WAIT_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

async function waitReady(url: string, deadline = Date.now() + 60_000): Promise<void> {
  while (Date.now() < deadline) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await sleep(250);
  }
  throw new Error(`next start not ready at ${url}`);
}

async function buildOnce(env: NextEnv): Promise<void> {
  const dir = inject("nextBuildDir");
  const result = join(dir, "result");
  const took = await mkdir(join(dir, "lock")).then(() => true, () => false);
  if (took) {
    const outcome = await promisify(execFile)(process.execPath, [nextBin, "build"], { cwd: root, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }).then(
      () => "ok",
      (e: unknown) => `next build failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    await writeFile(`${result}.tmp`, outcome);
    await rename(`${result}.tmp`, result);
    if (outcome !== "ok") throw new Error(outcome);
    return;
  }
  for (const deadline = Date.now() + BUILD_WAIT_MS; Date.now() < deadline; await sleep(500)) {
    const outcome = await readFile(result, "utf8").catch(() => null);
    if (outcome === "ok") return;
    if (outcome !== null) throw new Error(outcome);
  }
  throw new Error("timed out waiting for another test file's next build");
}

// stop("SIGKILL") = a crash: no shutdown hook runs (on Windows every kill is TerminateProcess anyway).
export async function startNextApp(env: NextEnv): Promise<{ base: string; stop(signal?: NodeJS.Signals): void }> {
  await buildOnce(env);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  try {
    await waitReady(`${base}/api/providers`);
  } catch (e) {
    server.kill();
    throw e;
  }
  return { base, stop: (signal) => server.kill(signal) };
}
