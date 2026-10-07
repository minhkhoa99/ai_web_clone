// E1 History (spec §3): one IR v2 snapshot per project in SQLite, at most 500 command steps, a cursor for Undo/Redo
// and an optimistic revision CAS. The step commits first (BEGIN IMMEDIATE, no file I/O inside); the injected
// materializer then writes ir.json/out/graph/QA, and only after it succeeds does materialized_revision catch up.
// A failed materialization leaves it behind: ensureMaterialized repairs from the snapshot before output is served.
// Fidelity (E1 §5) is derived data, not an edit: every step re-derives it against the new document (refreshFidelity),
// and updateFidelity rewrites it in place at the same revision — never a History step, never undone or redone.
// A pipeline job over an adopted document (resumed fix, naming) commits its IR through commitJob: a new revision
// with the History reset (see there), never a stale ir.json the next user step would overwrite.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PageCapture } from "./capture";
import { tx } from "./db";
import { AppError, Codes } from "./errors";
import { capFidelity, clearNotedFields, refreshFidelity } from "./fidelity";
import { applyCommands, prepareCommands, type EditorCommand, type HistoryCommand } from "./ir-command";
import type { FidelityItem, IRV2 } from "./ir-v2";

export const MAX_HISTORY_STEPS = 500;
export type EditSource = "user" | "ai_editor";
export type EditResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean };
export type Materialize = (projectId: string, ir: IRV2) => Promise<void>;
export type StoreHooks = {
  loadInitial: (projectId: string) => Promise<IRV2>; // the job's checkpoint (ir.json through migrateIR), adopted once
  isBusy?: (projectId: string) => boolean; // a queued/active job owns the project's files
  onUserEdit?: (projectId: string) => void; // runs inside the step's transaction
  captures?: (projectId: string) => Promise<PageCapture[]>; // the capture evidence Fidelity is re-derived from
  mirror?: (projectId: string, ir: IRV2) => Promise<void>; // writes the document file only (a Fidelity-only change); default: materialize
  onAdopt?: (projectId: string, ir: IRV2) => Promise<void>; // once, after the checkpoint became the document (serialized with output writes)
  upgrade?: (ir: IRV2) => IRV2; // pure, idempotent (E2 §9): applied to every snapshot read, committed once (commitUpgrade)
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

// E3b R3: `next` repeats the latest step's style fields exactly (same nodes, targets and property sets, nothing else)
function sameStyleFields(prev: unknown, next: readonly unknown[]): boolean {
  const key = (c: unknown) => {
    const s = c as { op?: unknown; id?: unknown; target?: unknown; changes?: unknown };
    return s?.op === "setStyle" && s.changes && typeof s.changes === "object" ? JSON.stringify([s.id, s.target, Object.keys(s.changes).sort()]) : undefined;
  };
  return Array.isArray(prev) && prev.length === next.length && next.every((c, i) => { const a = key(prev[i]); return a !== undefined && a === key(c); });
}

export function documentStore(db: DatabaseSync, materialize: Materialize, hooks: StoreHooks) {
  // the snapshot through the upgrade hook; `pending`: the hook changed it (not stored yet: commitUpgrade)
  const read = (json: string): { ir: IRV2; pending: boolean } => {
    const stored = JSON.parse(json) as IRV2, ir = hooks.upgrade ? hooks.upgrade(stored) : stored;
    return { ir, pending: ir !== stored && JSON.stringify(ir) !== json };
  };
  const parse = (json: string): IRV2 => read(json).ir;
  const stateOf = (id: string) =>
    db.prepare("SELECT ir_json,revision,cursor,materialized_revision FROM document_state WHERE project_id=?").get(id) as State | undefined;
  const stepAt = (id: string, seq: number) =>
    db.prepare("SELECT forward_json,inverse_json FROM document_history WHERE project_id=? AND seq=?").get(id, seq) as { forward_json: string; inverse_json: string } | undefined;
  const flags = (id: string, cursor: number) => ({ canUndo: stepAt(id, cursor) !== undefined, canRedo: stepAt(id, cursor + 1) !== undefined });
  const assertIdle = (id: string) => {
    if (hooks.isBusy?.(id)) throw new AppError(Codes.PROJECT_BUSY, "a job is queued or running for this project", { projectId: id });
  };
  const nothing = (code: "NOTHING_TO_UNDO" | "NOTHING_TO_REDO"): never => { throw new AppError(Codes[code], "the history has no step in that direction"); };

  // The first idle read adopts the job's checkpoint at its revision (0) with an empty history; its existing output is
  // that revision's, so nothing is re-emitted (onAdopt re-emits a checkpoint the loader converted). INSERT OR IGNORE keeps two concurrent first reads idempotent.
  async function ensureState(id: string): Promise<State> {
    const found = stateOf(id);
    if (found) return found;
    const ir = await hooks.loadInitial(id);
    assertIdle(id); // a job may have been queued during the await: it owns ir.json now
    const { changes } = db.prepare("INSERT OR IGNORE INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES(?,?,?,0,?)")
      .run(id, JSON.stringify(ir), ir.revision, ir.revision);
    // queued on the output chain: a job's own repair (ensureMaterialized(id, true)) waits for it before scoring. A
    // failed onAdopt (it may re-emit a converted checkpoint's output) leaves the output behind: the next read repairs it.
    if (changes > 0 && hooks.onAdopt) await serialized(id, () => hooks.onAdopt!(id, ir)).catch((e: unknown) => {
      db.prepare("UPDATE document_state SET materialized_revision=revision-1 WHERE project_id=?").run(id);
      throw e;
    });
    return stateOf(id)!;
  }

  const materializeLatest = (id: string) =>
    serialized(id, async () => {
      const s = stateOf(id);
      if (!s || s.materialized_revision >= s.revision) return;
      await materialize(id, parse(s.ir_json));
      // a newer step committed meanwhile: its own (queued) materialization marks it
      db.prepare("UPDATE document_state SET materialized_revision=? WHERE project_id=? AND revision=?").run(s.revision, id, s.revision);
    });
  const materializeOrThrow = (id: string, context: Record<string, unknown> = {}) =>
    materializeLatest(id).catch((e: unknown) => {
      const err = new AppError(Codes.DOCUMENT_MATERIALIZE_FAILED, "document saved but its output could not be written; it is repaired on the next read", { revision: stateOf(id)?.revision, ...context });
      throw Object.assign(err, { cause: e });
    });

  // E2 §9: a stored snapshot the upgrade hook changes (adopted before E2: v1 `behavior`s) is committed once like
  // commitJob — revision+1 (open tabs get STALE_REVISION and reload), the History reset (its inverses were recorded
  // against the pre-upgrade document: a restoreProps would drop `interactive`, a deleteNode stick on the role guard),
  // Fidelity re-derived, then materialized (ir.json, out/ with data-c + the new runtime, graph, qa.json stale).
  // Never while a job owns the project unless `job` is that job; a lost CAS means another writer already stored the
  // upgrade; upgraded == stored -> nothing (idempotent: no loop). true = committed.
  async function commitUpgrade(id: string, job: boolean): Promise<boolean> {
    const s = stateOf(id);
    if (!hooks.upgrade || !s || (!job && hooks.isBusy?.(id))) return false;
    const { ir, pending } = read(s.ir_json);
    if (!pending) return false;
    const captures = (await hooks.captures?.(id).catch(() => undefined)) ?? [];
    const revision = tx(db, () => {
      if ((!job && hooks.isBusy?.(id)) || stateOf(id)?.revision !== s.revision) return null;
      db.prepare("DELETE FROM document_history WHERE project_id=?").run(id);
      const fidelity = refreshFidelity(ir.fidelity ?? [], ir, captures);
      db.prepare("UPDATE document_state SET ir_json=?,revision=?,cursor=0 WHERE project_id=?").run(JSON.stringify({ ...ir, fidelity, revision: s.revision + 1 }), s.revision + 1, id);
      return s.revision + 1;
    }, true);
    if (revision === null) return false;
    await materializeOrThrow(id, { revision });
    return true;
  }

  async function change(id: string, baseRevision: number, source: EditSource, apply: (ir: IRV2, cursor: number) => Change): Promise<EditResult> {
    assertIdle(id);
    await ensureState(id);
    await commitUpgrade(id, false); // a pending upgrade moves the revision: this step's base is then stale
    // unreadable captures never block an edit: items are then only carried (a dead node unlinked); the preview's
    // next read re-derives them (jobs.previewFidelity)
    const captures = (await hooks.captures?.(id).catch(() => undefined)) ?? [];
    const result = tx(db, () => {
      assertIdle(id); // re-checked after the await above
      const s = stateOf(id)!;
      if (s.revision !== baseRevision) throw new AppError(Codes.STALE_REVISION, `document is at revision ${s.revision}, not ${baseRevision}`, { revision: s.revision });
      const out = apply(parse(s.ir_json), s.cursor);
      const revision = s.revision + 1;
      const fidelity = refreshFidelity(out.ir.fidelity ?? [], out.ir, captures);
      if (out.step) {
        db.prepare("DELETE FROM document_history WHERE project_id=? AND seq>?").run(id, s.cursor); // the Redo branch
        // OR REPLACE: a normal step's seq (cursor + 1) is free after the Redo branch is dropped; a coalesced one (R3) replaces the row at the cursor
        db.prepare("INSERT OR REPLACE INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES(?,?,?,?,?)").run(id, out.cursor, out.step.forward, out.step.inverse, source);
        db.prepare("DELETE FROM document_history WHERE project_id=? AND seq<=?").run(id, out.cursor - MAX_HISTORY_STEPS);
      }
      db.prepare("UPDATE document_state SET ir_json=?,revision=?,cursor=? WHERE project_id=?").run(JSON.stringify({ ...out.ir, fidelity, revision }), revision, out.cursor, id);
      if (source === "user") hooks.onUserEdit?.(id);
      return { revision, createdIds: out.createdIds, ...flags(id, out.cursor) };
    }, true);
    await materializeOrThrow(id, { revision: result.revision, createdIds: result.createdIds }); // the client keeps the step's result
    return result;
  }

  // The current document without adopting it: the snapshot once adopted, else the job's checkpoint.
  async function readDocument(id: string): Promise<IRV2> {
    const found = stateOf(id);
    return found ? parse(found.ir_json) : hooks.loadInitial(id);
  }

  async function loadDocument(id: string): Promise<IRV2> {
    if (!stateOf(id) && hooks.isBusy?.(id)) return readDocument(id); // a job may still rewrite ir.json: not adopted yet
    await ensureState(id);
    await commitUpgrade(id, false);
    return parse(stateOf(id)!.ir_json);
  }

  return {
    loadDocument,
    readDocument,
    // A pipeline job's IR over an adopted document (E1 §6: SQLite is the source of truth from adoption on). It becomes
    // the snapshot at revision+1 — every open tab's next step gets STALE_REVISION and reloads — and the History is
    // reset: its inverses were recorded against the document the job rewrote (IDs it deleted/created), so an Undo
    // across the job could not apply; a whole-document inverse could also exceed the 8 MB step cap. (In practice it
    // is empty: a user step closes the outstanding fix tasks, so a fix job only follows an adoption without edits.)
    // Materialized like a step. `baseRevision`: the revision the job read; edits are refused while it runs, so a
    // mismatch means another writer — refused, never overwritten. Not adopted -> null: ir.json is the job's own.
    async commitJob(id: string, baseRevision: number, ir: IRV2): Promise<number | null> {
      const revision = tx(db, () => {
        const s = stateOf(id);
        if (!s) return null;
        if (s.revision !== baseRevision) throw new AppError(Codes.STALE_REVISION, `document is at revision ${s.revision}, not ${baseRevision}`, { revision: s.revision });
        db.prepare("DELETE FROM document_history WHERE project_id=?").run(id);
        db.prepare("UPDATE document_state SET ir_json=?,revision=?,cursor=0 WHERE project_id=?").run(JSON.stringify({ ...ir, revision: s.revision + 1 }), s.revision + 1, id);
        return s.revision + 1;
      }, true);
      if (revision !== null) await materializeOrThrow(id, { revision });
      return revision;
    },
    async historyState(id: string): Promise<{ revision: number; canUndo: boolean; canRedo: boolean }> {
      const s = stateOf(id);
      if (s) return { revision: s.revision, ...flags(id, s.cursor) };
      return { revision: (await loadDocument(id)).revision, canUndo: false, canRedo: false };
    },
    // New node IDs come from randomUUID here; the normalized forward is stored, so Redo re-creates the same IDs.
    // E3b R3 `coalesce`: the same style fields again (the client's 1.5 s window) replace the latest step's forward and
    // keep its inverse — one Undo returns to the value before both; anything else is a normal new step. The revision
    // still moves (+1): every other tab's CAS goes stale as for any step.
    commitCommands: (id: string, baseRevision: number, commands: EditorCommand[], source: EditSource, opts: { coalesce?: boolean } = {}) =>
      change(id, baseRevision, source, (ir, cursor) => {
        const forward = prepareCommands(ir, commands, randomUUID);
        const done = applyCommands(ir, forward); // refuses a step over 8 MB (forward + inverse)
        const last = opts.coalesce && !stepAt(id, cursor + 1) ? stepAt(id, cursor) : undefined;
        const fold = last !== undefined && sameStyleFields(JSON.parse(last.forward_json), forward);
        return {
          ir: clearNotedFields(done.ir, forward), createdIds: done.createdIds, cursor: fold ? cursor : cursor + 1,
          step: { forward: JSON.stringify(forward), inverse: fold ? last.inverse_json : JSON.stringify(done.inverse) },
        };
      }),
    undoDocument: (id: string, baseRevision: number) =>
      change(id, baseRevision, "user", (ir, cursor) => {
        const row = stepAt(id, cursor) ?? nothing("NOTHING_TO_UNDO");
        const done = applyCommands(ir, JSON.parse(row.inverse_json) as HistoryCommand[]);
        return { ir: done.ir, createdIds: done.createdIds, cursor: cursor - 1 };
      }),
    redoDocument: (id: string, baseRevision: number) =>
      change(id, baseRevision, "user", (ir, cursor) => {
        const row = stepAt(id, cursor + 1) ?? nothing("NOTHING_TO_REDO");
        const done = applyCommands(ir, JSON.parse(row.forward_json) as HistoryCommand[]);
        return { ir: done.ir, createdIds: done.createdIds, cursor: cursor + 1 };
      }),
    // Fidelity rewritten in place (capped) at `revision` (null: the stored one): no History row, the revision (and so every
    // tab's CAS) unchanged, then only the document file is mirrored. Not adopted, a newer revision or a busy project
    // (the job owns the files) -> null, nothing written. A failed mirror marks the output behind: the next read repairs it.
    async updateFidelity(id: string, revision: number | null, update: (items: FidelityItem[], ir: IRV2) => FidelityItem[]): Promise<FidelityItem[] | null> {
      const done = tx(db, () => {
        const s = stateOf(id);
        if (!s || (revision !== null && s.revision !== revision) || hooks.isBusy?.(id)) return null;
        const { ir, pending } = read(s.ir_json);
        if (pending) return null; // a pending upgrade is stored as its own revision (commitUpgrade), never in place
        const items = capFidelity(update(ir.fidelity ?? [], ir));
        const changed = JSON.stringify(items) !== JSON.stringify(ir.fidelity ?? []);
        if (changed) db.prepare("UPDATE document_state SET ir_json=? WHERE project_id=?").run(JSON.stringify({ ...ir, fidelity: items }), id);
        return { items, changed };
      }, true);
      if (done?.changed) {
        await serialized(id, async () => {
          const s = stateOf(id);
          if (!s || s.materialized_revision < s.revision) return; // a pending repair writes the whole document
          const behind = () => db.prepare("UPDATE document_state SET materialized_revision=? WHERE project_id=? AND revision=?").run(s.revision - 1, id, s.revision);
          if (hooks.isBusy?.(id)) return void behind(); // a job queued meanwhile owns ir.json: the next idle read repairs it
          await (hooks.mirror ?? materialize)(id, parse(s.ir_json)).catch((e: unknown) => {
            behind();
            throw Object.assign(new AppError(Codes.DOCUMENT_MATERIALIZE_FAILED, "Fidelity saved but ir.json could not be written; it is repaired on the next read", { revision: s.revision }), { cause: e });
          });
        });
      }
      return done?.items ?? null;
    },
    // A queued/active job owns out/ (it re-emits it): no repair then, the output is served as the job left it —
    // unless the caller is that job (`job`: it repairs out/ before scoring it). A pending upgrade is committed first
    // (true: the document moved to a new revision, a job's cached IR is stale).
    ensureMaterialized: async (id: string, job = false): Promise<boolean> => {
      if (!job && hooks.isBusy?.(id)) return false;
      const upgraded = await commitUpgrade(id, job);
      await materializeOrThrow(id);
      return upgraded;
    },
  };
}
export type DocumentStore = ReturnType<typeof documentStore>;
