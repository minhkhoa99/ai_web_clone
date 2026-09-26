import { expect, test, vi } from "vitest";
import { openDb } from "@/core/db";
import { createProject, enqueue, startProject, subscribe, type JobEvent } from "@/core/jobs";
import { readRunLog } from "@/core/run-log";

// Own file: the job queue is module state, and jobs.test.ts leaves it full of never-ending runs.
test("a non-Error throw is scrubbed before the run's secrets are cleared: the queue's log line and run.log never see them", async () => {
  const quiet = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const creds = { user: "bob@example.test", pass: "s3cret-NonError!" };
  const events: JobEvent[] = [];
  const off = subscribe(id, (e) => events.push(e));
  const openBrowser = async (): Promise<never> => {
    throw `login ${creds.user} / ${creds.pass} refused`; // a thrown string, not an Error
  };
  startProject(db, id, { credentials: creds, deps: { openBrowser } });
  await expect.poll(() => events.filter((e) => e.type === "log" && e.level === "error").length).toBeGreaterThan(0);
  off();
  quiet.forEach((s) => s.mockRestore());
  const log = await readRunLog(id);
  for (const secret of [creds.user, creds.pass]) {
    expect(log).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  }
  expect(log.match(/ERROR \[job\] Error: login \[redacted\]/g)).toHaveLength(1); // the stack: written once, by runProject
});
