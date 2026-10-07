import { expect, test } from "vitest";
import { CommandBus, type BusEvent, type Op, type SendBody, type StepResult } from "@/app/p/[id]/editor/visual/command-bus";

const deferred = () => {
  let resolve!: (v: StepResult) => void, reject!: (e: unknown) => void;
  const promise = new Promise<StepResult>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function harness(revision = 5) {
  const calls: { op: Op; body: SendBody; d: ReturnType<typeof deferred> }[] = [];
  const events: BusEvent[] = [];
  const bus = new CommandBus(revision, "pg", (op, body) => { const d = deferred(); calls.push({ op, body, d }); return d.promise; }, (e) => events.push(e));
  return { bus, calls, events };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ok = (revision: number): StepResult => ({ revision, createdIds: [], canUndo: true, canRedo: false });
const cmd = (label: string, log: string[] = []): Op => ({ kind: "commands", label, commands: [{ op: "setName", id: "a", name: label }], apply: () => log.push(`apply ${label}`), rollback: () => log.push(`rollback ${label}`) });
const fail = (code: string, revision?: number) => Object.assign(new Error(`${code} message`), { code, revision });

test("one request in flight; the next goes with the revision the previous produced; 20 may wait, the 22nd push is refused", async () => {
  const { bus, calls, events } = harness();
  expect(bus.push(cmd("a"))).toBe(true);
  for (let i = 0; i < 20; i++) expect(bus.push(cmd(`q${i}`))).toBe(true);
  expect(bus.push(cmd("over"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "full" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ baseRevision: 5, pageId: "pg", commands: [{ op: "setName", id: "a", name: "a" }] });
  expect(bus.pending).toBe(21);
  calls[0]!.d.resolve(ok(6));
  await tick();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.baseRevision).toBe(6);
  expect(events).toContainEqual({ type: "done", op: calls[0]!.op, result: ok(6) });
  expect(bus.pending).toBe(20);
});

test("optimistic apply at push; a 400 undoes that op (queued ops unwound + replayed so they stay on top), reports it and the queue goes on", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  bus.push(cmd("a", log));
  bus.push(cmd("b", log));
  expect(log).toEqual(["apply a", "apply b"]);
  calls[0]!.d.reject(fail("IR_PATCH_INVALID"));
  await tick();
  expect(log).toEqual(["apply a", "apply b", "rollback b", "rollback a", "apply b"]); // b may sit on the same element: unwound, then replayed
  expect(events).toContainEqual({ type: "refused", op: calls[0]!.op, message: "IR_PATCH_INVALID message" });
  expect(calls[1]!.body.baseRevision).toBe(5);
});

test("409 rolls back the op in flight and every queued op (newest first), drops the queue and refuses pushes", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  for (const x of ["a", "b", "c"]) bus.push(cmd(x, log));
  calls[0]!.d.reject(fail("STALE_REVISION", 9));
  await tick();
  expect(log.slice(3)).toEqual(["rollback c", "rollback b", "rollback a"]);
  expect(events.at(-1)).toEqual({ type: "stale", revision: 9 });
  expect(bus.pending).toBe(0);
  expect(bus.push(cmd("d"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "stale" });
  expect(calls).toHaveLength(1);
});

test("500 DOCUMENT_MATERIALIZE_FAILED: the step committed — its revision is taken, queued ops rolled back, halted (reload)", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  bus.push(cmd("a", log));
  bus.push(cmd("b", log));
  calls[0]!.d.reject(fail("DOCUMENT_MATERIALIZE_FAILED", 6));
  await tick();
  expect(log).toEqual(["apply a", "apply b", "rollback b"]);
  expect(bus.revision).toBe(6);
  expect(events.at(-1)).toEqual({ type: "unwritten", revision: 6 });
  expect(bus.push(cmd("c"))).toBe(false);
});

test("a network error keeps the op at the head; retry() resends it with the same baseRevision; NOTHING_TO_UNDO is a refusal", async () => {
  const { bus, calls, events } = harness();
  bus.push({ kind: "undo", label: "Hoàn tác" });
  calls[0]!.d.reject(new TypeError("fetch failed"));
  await tick();
  expect(events.at(-1)).toMatchObject({ type: "failed", message: "fetch failed" });
  expect(bus.pending).toBe(1);
  bus.retry();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toEqual({ baseRevision: 5, pageId: "pg" });
  calls[1]!.d.reject(fail("NOTHING_TO_UNDO"));
  await tick();
  expect(events.at(-1)).toMatchObject({ type: "refused" });
  expect(bus.push({ kind: "redo", label: "Làm lại" })).toBe(true);
});

test("a throwing done handler does not re-queue the committed step: no resend, revision advanced, queue goes on", async () => {
  const calls: { body: SendBody; d: ReturnType<typeof deferred> }[] = [];
  const bus = new CommandBus(5, "pg", (_op, body) => { const d = deferred(); calls.push({ body, d }); return d.promise; }, (e) => { if (e.type === "done") throw new Error("ui bug"); });
  const errorLog = console.error;
  console.error = () => {};
  try {
    bus.push(cmd("a"));
    bus.push(cmd("b"));
    calls[0]!.d.resolve(ok(6));
    await tick();
  } finally { console.error = errorLog; }
  expect(bus.revision).toBe(6);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toMatchObject({ baseRevision: 6, commands: [{ name: "b" }] });
});

test("pushes during a retry stop are applied and queued but not sent until retry(), then go out in order", async () => {
  const log: string[] = [];
  const { bus, calls } = harness();
  bus.push(cmd("a", log));
  calls[0]!.d.reject(new TypeError("fetch failed"));
  await tick();
  expect(bus.push(cmd("b", log))).toBe(true);
  expect(log).toEqual(["apply a", "apply b"]);
  expect(calls).toHaveLength(1);
  expect(bus.pending).toBe(2);
  bus.retry();
  expect(calls[1]!.body).toMatchObject({ baseRevision: 5, commands: [{ name: "a" }] });
  calls[1]!.d.resolve(ok(6));
  await tick();
  expect(calls[2]!.body).toMatchObject({ baseRevision: 6, commands: [{ name: "b" }] });
});
