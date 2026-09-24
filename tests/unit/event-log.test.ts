import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "@/core/config";
import { forget, history, MAX_EVENTS, MAX_RINGS, record, retain, settled } from "@/core/event-log";
import { clearRunSecrets, emit, setRunSecrets, subscribe, type StampedEvent } from "@/core/jobs-base";

const wsOf = (id: string) => join(config.workspaceRoot, id);
async function newWs(): Promise<string> {
  const id = randomUUID();
  await mkdir(wsOf(id), { recursive: true });
  return id;
}
const ev = (i: number): StampedEvent => ({ type: "log", level: "info", message: `m${i}`, at: i });
const linesOf = async (id: string, f: string) => (await readFile(join(wsOf(id), f), "utf8").catch(() => "")).split("\n").filter(Boolean);

test("the ring keeps the newest MAX_EVENTS; the file rotates every MAX_EVENTS lines; a reload reads both files", async () => {
  const id = await newWs();
  for (let i = 0; i < MAX_EVENTS + 5; i++) record(id, ev(i));
  await settled(id);
  expect(history(id).map((e) => e.at)).toEqual(Array.from({ length: MAX_EVENTS }, (_, k) => k + 5));
  expect(await linesOf(id, "events.prev.jsonl")).toHaveLength(MAX_EVENTS);
  expect(await linesOf(id, "events.jsonl")).toHaveLength(5);
  forget(id); // as after a restart: rebuilt from disk
  const reloaded = history(id);
  expect(reloaded).toHaveLength(MAX_EVENTS);
  expect(reloaded.at(-1)?.at).toBe(MAX_EVENTS + 4);
});

test("load drops a torn last line (power loss mid-append)", async () => {
  const id = await newWs();
  await writeFile(join(wsOf(id), "events.jsonl"), `${JSON.stringify(ev(1))}\n${JSON.stringify(ev(2))}\n{"type":"log","le`);
  expect(history(id).map((e) => e.at)).toEqual([1, 2]);
});

test("an append after the workspace was deleted never recreates it", async () => {
  const id = await newWs();
  record(id, ev(1));
  await settled(id);
  await rm(wsOf(id), { recursive: true, force: true });
  record(id, ev(2));
  await settled(id);
  expect(existsSync(wsOf(id))).toBe(false);
});

test("eviction past MAX_RINGS spares a ring with a listener (retain) and drops an idle one", async () => {
  const pinned = await newWs();
  const idle = await newWs();
  record(pinned, ev(1));
  record(idle, ev(1));
  await Promise.all([settled(pinned), settled(idle)]);
  const release = retain(pinned);
  await rm(wsOf(pinned), { recursive: true, force: true }); // RAM is now the only copy
  await rm(wsOf(idle), { recursive: true, force: true });
  for (let i = 0; i < MAX_RINGS + 4; i++) history(randomUUID()); // touch many other projects
  expect(history(pinned)).toHaveLength(1);
  expect(history(idle)).toHaveLength(0); // evicted, reloaded from the (deleted) disk
  release();
});

test("emit stamps `at`, redacts the run's secrets, cuts strings at 2000 chars and never records progress", async () => {
  const id = await newWs();
  const got: StampedEvent[] = [];
  const off = subscribe(id, (e) => got.push(e));
  setRunSecrets(id, ["hunter2"]);
  emit(id, { type: "log", level: "warn", message: `pw=hunter2 ${"x".repeat(3000)}` });
  clearRunSecrets(id);
  emit(id, { type: "status", status: "running" });
  off();
  const [log] = got;
  expect(log?.type).toBe("log");
  const message = log?.type === "log" ? log.message : "";
  expect(message).toContain("[redacted]");
  expect(message).not.toContain("hunter2");
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(typeof log?.at).toBe("number");
  expect(history(id).map((e) => e.type)).toEqual(["log", "status"]);
});
