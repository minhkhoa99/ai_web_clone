// E3 §1/§6/§7 command bus (pure: the transport is injected): one request in flight, at most 20 user actions waiting,
// each action one batch = one Undo step, sent with the revision the previous step produced. Light edits are applied
// optimistically at push and rolled back when the server refuses them (R16).
// E3b R3: an op with a `coalesceKey` (`<id>|<target>|<prop>`) pushed ≤ 1.5 s after the previous op with the same key,
// once that one has committed and nothing else moved the revision (sliding window), asks the server to fold it into
// that History step. The clock is injected (tests).
import type { Affected } from "@/core/editor-canvas";
import type { EditorCommand } from "@/core/ir-command";

export const BUS_LIMITS = { queue: 20, coalesceMs: 1500 } as const;
export type StepResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected };
// mainRoot (R17, client only — never sent): the open instance of an edit-main batch; created ids map back through it.
// Op contract: apply() records its own "before" state and applies the edit; rollback() restores what the latest apply()
// recorded. A refusal rolls back the refused op and everything queued after it (newest first), then re-applies the queued ones.
export type Op =
  | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; keepSelection?: boolean; coalesceKey?: string; mainRoot?: string; apply?(): void; rollback?(): void }
  | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[]; coalesce?: true };
export type Send = (op: Op, body: SendBody) => Promise<StepResult>;
export type BusEvent =
  | { type: "saving"; pending: number }
  | { type: "done"; op: Op; result: StepResult }
  | { type: "refused"; op: Op; message: string }
  | { type: "stale"; revision?: number }
  | { type: "unwritten"; revision: number }
  | { type: "failed"; op: Op; message: string }
  | { type: "full" };
type SendError = { code?: string; revision?: number; message?: string };
const RELOAD = new Set(["STALE_REVISION", "PROJECT_BUSY", "BAD_STATE"]);
const REFUSED = new Set(["IR_PATCH_INVALID", "VALIDATION", "PAYLOAD_TOO_LARGE", "NOTHING_TO_UNDO", "NOTHING_TO_REDO", "NOT_FOUND"]);
const undo = (ops: Op[]) => [...ops].reverse().forEach((o) => o.kind === "commands" && o.rollback?.()); // newest first

export class CommandBus {
  private queue: Op[] = [];
  private busy = false;
  private stop: "none" | "retry" | "reload" = "none";
  // R3: the last committed op with a coalesce key — its key, the revision it produced, when the user pushed it
  private last: { key: string; revision: number; at: number } | undefined;
  private readonly pushedAt = new WeakMap<Op, number>();
  constructor(private rev: number, private readonly pageId: string, private readonly send: Send, private readonly emit: (e: BusEvent) => void, private readonly now: () => number = Date.now) {}
  get pending(): number { return this.queue.length + (this.busy ? 1 : 0); }
  get revision(): number { return this.rev; }

  // R4 (E4): resolved when the queue drains (true) or the bus stops for a reload / retry (false)
  private waiters: ((ok: boolean) => void)[] = [];
  settled(): Promise<boolean> {
    if (this.stop !== "none") return Promise.resolve(false);
    if (!this.pending) return Promise.resolve(true);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  // E4: an AI step committed outside the bus (one batch, revision +1): an idle bus continues from it. The coalesce
  // window ends (the step in between is not this cell's).
  adopt(revision: number): boolean {
    if (this.pending || this.stop !== "none") return false;
    this.rev = revision;
    this.last = undefined;
    return true;
  }
  private wake(): void {
    if (this.stop === "none" && this.pending) return;
    const ok = this.stop === "none";
    for (const w of this.waiters.splice(0)) w(ok);
  }

  push(op: Op): boolean {
    if (this.stop === "reload") { this.say({ type: "stale" }); return false; }
    if (this.queue.length >= BUS_LIMITS.queue) { this.say({ type: "full" }); return false; }
    if (op.kind === "commands") op.apply?.();
    this.pushedAt.set(op, this.now());
    this.queue.push(op);
    this.say({ type: "saving", pending: this.pending });
    void this.pump();
    return true;
  }
  retry(): void {
    if (this.stop !== "retry") return;
    this.stop = "none";
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stop !== "none") { if (!this.busy) this.wake(); return; }
    const op = this.queue.shift();
    if (!op) { this.wake(); return; }
    this.busy = true;
    const at = this.pushedAt.get(op) ?? this.now(), key = op.kind === "commands" ? op.coalesceKey : undefined;
    const coalesce = key !== undefined && this.last?.key === key && this.last.revision === this.rev && at - this.last.at <= BUS_LIMITS.coalesceMs;
    let result: StepResult;
    try {
      result = await this.send(op, { baseRevision: this.rev, pageId: this.pageId, ...(op.kind === "commands" && { commands: op.commands }), ...(coalesce && { coalesce: true as const }) });
    } catch (e) {
      this.busy = false;
      this.last = undefined;
      this.fail(op, e);
      void this.pump();
      return;
    }
    this.busy = false;
    this.rev = result.revision;
    this.last = key !== undefined ? { key, revision: result.revision, at } : undefined;
    this.say({ type: "done", op, result }); // outside the try: a throwing UI handler must not re-queue a committed step
    void this.pump();
  }

  private fail(op: Op, e: unknown): void {
    const err = (e ?? {}) as SendError, message = err.message ?? String(e);
    if (err.code && RELOAD.has(err.code)) {
      undo([op, ...this.queue]);
      this.queue = [];
      this.stop = "reload";
      this.say({ type: "stale", ...(typeof err.revision === "number" && { revision: err.revision }) });
    } else if (err.code === "DOCUMENT_MATERIALIZE_FAILED" && typeof err.revision === "number") {
      this.rev = err.revision; // committed: only the output is behind
      undo(this.queue);
      this.queue = [];
      this.stop = "reload";
      this.say({ type: "unwritten", revision: err.revision });
    } else if (err.code && REFUSED.has(err.code)) {
      if (op.kind === "commands") {
        undo([op, ...this.queue]); // later ops may sit on the same element: unwind them too, then replay them
        for (const o of this.queue) if (o.kind === "commands") o.apply?.();
      }
      this.say({ type: "refused", op, message });
    } else {
      this.queue.unshift(op);
      this.stop = "retry";
      this.say({ type: "failed", op, message });
    }
    this.wake();
  }
  private say(e: BusEvent): void {
    try { this.emit(e); } catch (err) { console.error(err); } // a UI handler bug must not wedge or replay the queue
  }
}
