// Durable, bounded per-project event tail (spec parity §4.1): a RAM ring of the newest MAX_EVENTS stamped events,
// appended to workspace/<id>/events.jsonl and rotated to events.prev.jsonl every MAX_EVENTS lines, so the progress
// log survives a reload and a restart. A log, not a checkpoint: each line is complete or dropped on load.
// Never served by /files (ALLOWED stays out|qa|shots), never exported, never in the graph. No app/ import.
import { readFileSync } from "node:fs";
import { appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { workspaceOf } from "./fsx";
import type { StampedEvent } from "./jobs-base";

export const MAX_EVENTS = 2000; // ring per project, and the rotation threshold of the file
export const MAX_RINGS = 32; // rings kept in RAM
export const MAX_FIELD_CHARS = 2000; // string fields are cut at emit

type Ring = { events: StampedEvent[]; lines: number; writes: Promise<void>; pending: number; pins: number; warned: boolean };
const rings = new Map<string, Ring>(); // Map order = least recently used first

const filesOf = (id: string) => ({ current: join(workspaceOf(id), "events.jsonl"), prev: join(workspaceOf(id), "events.prev.jsonl") });

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return []; // no file yet
  }
}

function parse(lines: string[]): StampedEvent[] {
  const out: StampedEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as StampedEvent;
      if (typeof e === "object" && e !== null && typeof e.at === "number") out.push(e);
    } catch {
      // a torn line (crash mid-append): dropped
    }
  }
  return out;
}

// Loads once per project per process (bounded: <= 2 x MAX_EVENTS lines), then touches it as most recently used.
function ringOf(id: string): Ring {
  const hit = rings.get(id);
  if (hit) {
    rings.delete(id);
    rings.set(id, hit);
    return hit;
  }
  const { current, prev } = filesOf(id);
  const cur = readLines(current);
  const ring: Ring = { events: parse([...readLines(prev), ...cur]).slice(-MAX_EVENTS), lines: cur.length, writes: Promise.resolve(), pending: 0, pins: 0, warned: false };
  rings.set(id, ring);
  evict(id);
  return ring;
}

// Past MAX_RINGS: drop the least recently used rings that have no SSE listener and no write in flight.
function evict(keep: string): void {
  for (const [id, r] of rings) {
    if (rings.size <= MAX_RINGS) return;
    if (id !== keep && r.pins === 0 && r.pending === 0) rings.delete(id);
  }
}

export function record(id: string, ev: StampedEvent): void {
  const ring = ringOf(id);
  ring.events.push(ev);
  if (ring.events.length > MAX_EVENTS) ring.events.splice(0, ring.events.length - MAX_EVENTS);
  const line = `${JSON.stringify(ev)}\n`;
  ring.pending++;
  // one write chain per project: appends never interleave, rotation happens between two appends
  ring.writes = ring.writes.then(async () => {
    const { current, prev } = filesOf(id);
    try {
      await appendFile(current, line); // creates the file, never the directory (a deleted project stays deleted)
      if (++ring.lines >= MAX_EVENTS) {
        await rename(current, prev); // atomic, replaces the older segment
        ring.lines = 0;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !ring.warned) {
        ring.warned = true; // once per project: a log write failure never breaks a job
        console.error(`event-log: cannot write ${current}: ${(e as Error).message}`);
      }
    } finally {
      ring.pending--;
    }
  });
}

export const history = (id: string): StampedEvent[] => [...ringOf(id).events];

export const settled = (id: string): Promise<void> => rings.get(id)?.writes ?? Promise.resolve();

export function retain(id: string): () => void {
  const ring = ringOf(id);
  ring.pins++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ring.pins--;
  };
}

// After DELETE /api/projects/[id] removed the workspace and rows.
export function forget(id: string): void {
  rings.delete(id);
}
