// E1 History (spec §3): one IR v2 snapshot per project in SQLite, at most 500 command steps, a cursor for Undo/Redo
// and an optimistic revision CAS. The step commits first (BEGIN IMMEDIATE, no file I/O inside); the injected
// materializer then writes ir.json/out/graph/QA, and only after it succeeds does materialized_revision catch up.
// A failed materialization leaves it behind: ensureMaterialized repairs from the snapshot before output is served.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db";
import { AppError, Codes } from "./errors";
import { applyCommands, prepareCommands, type EditorCommand, type HistoryCommand } from "./ir-command";
import type { IRV2 } from "./ir-v2";

export const MAX_HISTORY_STEPS = 500;
export type EditSource = "user" | "ai_editor";
export type EditResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean };
export type Materialize = (projectId: string, ir: IRV2) => Promise<void>;
export type StoreHooks = {
  loadInitial: (projectId: string) => Promise<IRV2>; // the job's checkpoint (ir.json, v1 migrated), adopted once
  isBusy?: (projectId: string) => boolean; // a queued/active job owns the project's files
  onUserEdit?: (projectId: string) => void; // runs inside the step's transaction
};
type State = { ir_json: string; revision: number; cursor: number; materialized_revision: number };
type Change = { ir: IRV2; createdIds: string[]; cursor: number; step?: { forward: string; inverse: string } };

// One materialization per project at a time, module-wide (a route may build a store per request).
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => chains.get(key) === tail && chains.delete(key));
  return run;
}

export function documentStore(db: DatabaseSync, materialize: Materialize, hooks: StoreHooks) {
  const stateOf = (id: string) =>
    db.prepare("SELECT ir_json,revision,cursor,materialized_revision FROM document_state WHERE project_id=?").get(id) as State | undefined;
  const stepAt = (id: string, seq: number) =>
    db.prepare("SELECT forward_json,inverse_json FROM document_history WHERE project_id=? AND seq=?").get(id, seq) as { forward_json: string; inverse_json: string } | undefined;
  const flags = (id: string, cursor: number) => ({ canUndo: stepAt(id, cursor) !== undefined, canRedo: stepAt(id, cursor + 1) !== undefined });
  const assertIdle = (id: string) => {
    if (hooks.isBusy?.(id)) throw new AppError(Codes.PROJECT_BUSY, "a job is queued or running for this project", { projectId: id });
  };
  const nothing = (what: string): never => { throw new AppError(Codes.IR_PATCH_INVALID, `nothing to ${what}`); };

  // The first idle read adopts the job's checkpoint at its revision (0) with an empty history; its existing output is
  // that revision's, so nothing is re-emitted. INSERT OR IGNORE keeps two concurrent first reads idempotent.
  async function ensureState(id: string): Promise<State> {
    const found = stateOf(id);
    if (found) return found;
    const ir = await hooks.loadInitial(id);
    db.prepare("INSERT OR IGNORE INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES(?,?,?,0,?)")
      .run(id, JSON.stringify(ir), ir.revision, ir.revision);
    return stateOf(id)!;
  }

  const materializeLatest = (id: string) =>
    serialized(id, async () => {
      const s = stateOf(id);
      if (!s || s.materialized_revision >= s.revision) return;
      await materialize(id, JSON.parse(s.ir_json) as IRV2);
      // a newer step committed meanwhile: its own (queued) materialization marks it
      db.prepare("UPDATE document_state SET materialized_revision=? WHERE project_id=? AND revision=?").run(s.revision, id, s.revision);
    });
  const materializeOrThrow = (id: string) =>
    materializeLatest(id).catch((e: unknown) => {
      const err = new AppError(Codes.DOCUMENT_MATERIALIZE_FAILED, "document saved but its output could not be written; it is repaired on the next read", { revision: stateOf(id)?.revision });
      throw Object.assign(err, { cause: e });
    });

  async function change(id: string, baseRevision: number, source: EditSource, apply: (ir: IRV2, cursor: number) => Change): Promise<EditResult> {
    assertIdle(id);
    await ensureState(id);
    const result = tx(db, () => {
      assertIdle(id); // re-checked after the await above
      const s = stateOf(id)!;
      if (s.revision !== baseRevision) throw new AppError(Codes.STALE_REVISION, `document is at revision ${s.revision}, not ${baseRevision}`, { revision: s.revision });
      const out = apply(JSON.parse(s.ir_json) as IRV2, s.cursor);
      const revision = s.revision + 1;
      if (out.step) {
        db.prepare("DELETE FROM document_history WHERE project_id=? AND seq>?").run(id, s.cursor); // the Redo branch
        db.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES(?,?,?,?,?)").run(id, out.cursor, out.step.forward, out.step.inverse, source);
        db.prepare("DELETE FROM document_history WHERE project_id=? AND seq<=?").run(id, out.cursor - MAX_HISTORY_STEPS);
      }
      db.prepare("UPDATE document_state SET ir_json=?,revision=?,cursor=? WHERE project_id=?").run(JSON.stringify({ ...out.ir, revision }), revision, out.cursor, id);
      if (source === "user") hooks.onUserEdit?.(id);
      return { revision, createdIds: out.createdIds, ...flags(id, out.cursor) };
    }, true);
    await materializeOrThrow(id);
    return result;
  }

  async function loadDocument(id: string): Promise<IRV2> {
    const found = stateOf(id);
    if (!found && hooks.isBusy?.(id)) return hooks.loadInitial(id); // a job may still rewrite ir.json: not adopted yet
    return JSON.parse((found ?? (await ensureState(id))).ir_json) as IRV2;
  }

  return {
    loadDocument,
    async historyState(id: string): Promise<{ revision: number; canUndo: boolean; canRedo: boolean }> {
      const s = stateOf(id);
      if (s) return { revision: s.revision, ...flags(id, s.cursor) };
      return { revision: (await loadDocument(id)).revision, canUndo: false, canRedo: false };
    },
    // New node IDs come from randomUUID here; the normalized forward is stored, so Redo re-creates the same IDs.
    commitCommands: (id: string, baseRevision: number, commands: EditorCommand[], source: EditSource) =>
      change(id, baseRevision, source, (ir, cursor) => {
        const forward = prepareCommands(ir, commands, randomUUID);
        const done = applyCommands(ir, forward); // refuses a step over 8 MB (forward + inverse)
        return { ir: done.ir, createdIds: done.createdIds, cursor: cursor + 1, step: { forward: JSON.stringify(forward), inverse: JSON.stringify(done.inverse) } };
      }),
    undoDocument: (id: string, baseRevision: number) =>
      change(id, baseRevision, "user", (ir, cursor) => {
        const row = stepAt(id, cursor) ?? nothing("undo");
        const done = applyCommands(ir, JSON.parse(row.inverse_json) as HistoryCommand[]);
        return { ir: done.ir, createdIds: done.createdIds, cursor: cursor - 1 };
      }),
    redoDocument: (id: string, baseRevision: number) =>
      change(id, baseRevision, "user", (ir, cursor) => {
        const row = stepAt(id, cursor + 1) ?? nothing("redo");
        const done = applyCommands(ir, JSON.parse(row.forward_json) as HistoryCommand[]);
        return { ir: done.ir, createdIds: done.createdIds, cursor: cursor + 1 };
      }),
    ensureMaterialized: (id: string): Promise<void> => materializeOrThrow(id),
  };
}
export type DocumentStore = ReturnType<typeof documentStore>;
