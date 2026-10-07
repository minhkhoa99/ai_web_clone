// E3 §1/§6/§7 command bus (pure: the transport is injected): one request in flight, at most 20 user actions waiting,
// each action one batch = one Undo step, sent with the revision the previous step produced. Light edits are applied
// optimistically at push and rolled back when the server refuses them (R16).
import type { Affected } from "@/core/editor-canvas";
import type { EditorCommand } from "@/core/ir-command";

export const BUS_LIMITS = { queue: 20 } as const;
export type StepResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected };
export type Op =
  | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; apply?(): void; rollback?(): void }
  | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[] };
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
  constructor(private rev: number, private readonly pageId: string, private readonly send: Send, private readonly emit: (e: BusEvent) => void) {}
  get pending(): number { return this.queue.length + (this.busy ? 1 : 0); }
  get revision(): number { return this.rev; }

  push(op: Op): boolean {
    if (this.stop === "reload") return false;
    if (this.queue.length >= BUS_LIMITS.queue) { this.emit({ type: "full" }); return false; }
    if (op.kind === "commands") op.apply?.();
    this.queue.push(op);
    this.emit({ type: "saving", pending: this.pending });
    void this.pump();
    return true;
  }
  retry(): void {
    if (this.stop !== "retry") return;
    this.stop = "none";
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stop !== "none") return;
    const op = this.queue.shift();
    if (!op) return;
    this.busy = true;
    try {
      const result = await this.send(op, { baseRevision: this.rev, pageId: this.pageId, ...(op.kind === "commands" && { commands: op.commands }) });
      this.rev = result.revision;
      this.busy = false;
      this.emit({ type: "done", op, result });
    } catch (e) {
      this.busy = false;
      const err = e as SendError, message = err.message ?? String(e);
      if (err.code && RELOAD.has(err.code)) {
        undo([op, ...this.queue]);
        this.queue = [];
        this.stop = "reload";
        this.emit({ type: "stale", ...(typeof err.revision === "number" && { revision: err.revision }) });
      } else if (err.code === "DOCUMENT_MATERIALIZE_FAILED" && typeof err.revision === "number") {
        this.rev = err.revision; // committed: only the output is behind
        undo(this.queue);
        this.queue = [];
        this.stop = "reload";
        this.emit({ type: "unwritten", revision: err.revision });
      } else if (err.code && REFUSED.has(err.code)) {
        if (op.kind === "commands") op.rollback?.();
        this.emit({ type: "refused", op, message });
      } else {
        this.queue.unshift(op);
        this.stop = "retry";
        this.emit({ type: "failed", op, message });
      }
    }
    void this.pump();
  }
}
