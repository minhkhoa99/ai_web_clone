import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "@/core/config";
import { appendRunLog, MAX_RUN_LOG_BYTES, readRunLog } from "@/core/run-log";
import { clearRunSecrets, emit, logDetail, setRunSecrets } from "@/core/jobs-base";

const wsOf = (id: string) => join(config.workspaceRoot, id);
async function newWs(): Promise<string> {
  const id = randomUUID();
  await mkdir(wsOf(id), { recursive: true });
  return id;
}

afterEach(() => vi.restoreAllMocks());

test("one `ISO LEVEL [phase] message` line per entry; rotation at 5 MB to run.prev.log; readRunLog = prev + current", async () => {
  const id = await newWs();
  appendRunLog(id, "info", "capture", "first");
  appendRunLog(id, "warn", "fix", "x".repeat(MAX_RUN_LOG_BYTES));
  appendRunLog(id, "error", "qa", "after rotation");
  const all = await readRunLog(id);
  const lines = all.split("\n").filter(Boolean);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO \[capture\] first$/);
  expect(lines[2]).toMatch(/ ERROR \[qa\] after rotation$/);
  const prev = await readFile(join(wsOf(id), "run.prev.log"), "utf8");
  expect(prev.split("\n").filter(Boolean)).toHaveLength(2);
  expect(await readFile(join(wsOf(id), "run.log"), "utf8")).toMatch(/after rotation\n$/);
});

test("an append after the workspace was deleted never recreates it; no log reads as empty", async () => {
  const id = await newWs();
  expect(await readRunLog(id)).toBe("");
  await rm(wsOf(id), { recursive: true, force: true });
  appendRunLog(id, "info", "job", "late");
  expect(await readRunLog(id)).toBe("");
  expect(existsSync(wsOf(id))).toBe(false);
});

test("emit writes every non-progress event to run.log and the console, redacted; logDetail skips SSE", async () => {
  const id = await newWs();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setRunSecrets(id, ["hunter2"]);
  emit(id, { type: "phase", phase: "capture" });
  emit(id, { type: "log", level: "warn", message: "pw=hunter2 leaked" });
  emit(id, { type: "task", phase: "capture", key: "home", status: "failed", errorCode: "NAV_TIMEOUT", error: "goto hunter2 timed out" });
  emit(id, { type: "progress", progress: 10, tokensUsed: 0 });
  emit(id, { type: "status", status: "failed", reason: "NAV_TIMEOUT" });
  logDetail(id, "error", "job", "Error: boom hunter2\n    at x (y.ts:1:1)");
  clearRunSecrets(id);
  const log = await readRunLog(id);
  expect(log).not.toContain("hunter2");
  expect(log).toContain("[redacted]");
  expect(log).toMatch(/ INFO \[capture\] phase capture\n/);
  expect(log).toMatch(/ WARN \[capture\] pw=\[redacted\] leaked\n/);
  expect(log).toMatch(/ ERROR \[capture\] task home failed NAV_TIMEOUT: goto \[redacted\] timed out\n/);
  expect(log).toMatch(/ ERROR \[capture\] status failed \(NAV_TIMEOUT\)\n/);
  expect(log).toMatch(/ ERROR \[job\] Error: boom \[redacted\]\n\s+at x/);
  expect(log).not.toContain("progress");
  const printed = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(" "));
  expect(printed).toHaveLength(4); // log warn, task failed, status failed, logDetail error (never info / phase)
  for (const p of printed) {
    expect(p.startsWith(`[job ${id.slice(0, 8)}]`)).toBe(true);
    expect(p).not.toContain("hunter2");
  }
});
