// Durable log (spec parity §7.4): a real site1 run leaves its events on disk; a fresh SSE replays them, also after
// the in-memory ring is gone (as after a restart).
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { forget, settled } from "@/core/event-log";
import { createProject, enqueue, runProject, type StampedEvent } from "@/core/jobs";
import { serveDir } from "@/core/serve";
import { getDb } from "@/app/_server/db";
import * as events from "@/app/api/projects/[id]/events/route";
import { offline } from "./offline-deps";

let site: { url: string; close(): Promise<void> } | undefined;
let id = "";

beforeAll(async () => {
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  id = createProject(getDb(), { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(getDb(), id, [`${site.url}/index.html`]);
  await runProject(getDb(), id, { deps: offline });
  await settled(id);
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (id) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

async function replay(): Promise<StampedEvent[]> {
  const ac = new AbortController();
  const res = await events.GET(new Request("http://127.0.0.1", { signal: ac.signal }), { params: Promise.resolve({ id }) });
  const chunk = new TextDecoder().decode((await res.body!.getReader().read()).value);
  ac.abort();
  const msg = JSON.parse(chunk.replace(/^data: /, "")) as { type: string; events: StampedEvent[] };
  expect(msg.type).toBe("history");
  return msg.events;
}

test("a finished run is replayed from RAM, then from disk once the ring is gone; `at` never goes backwards", async () => {
  const live = await replay();
  expect(live.some((e) => e.type === "status" && e.status === "running")).toBe(true);
  expect(live.at(-1)).toMatchObject({ type: "status", status: "completed" });
  expect(live.every((e, i) => i === 0 || e.at >= live[i - 1]!.at)).toBe(true);
  expect(live.some((e) => e.type === "progress")).toBe(false);
  const onDisk = (await readFile(join(config.workspaceRoot, id, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  expect(onDisk).toHaveLength(live.length);

  forget(id); // as after a process restart
  expect(await replay()).toEqual(live);
});
