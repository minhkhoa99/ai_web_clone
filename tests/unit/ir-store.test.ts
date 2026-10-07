import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { config } from "@/core/config";
import { openDb } from "@/core/db";
import { AppError } from "@/core/errors";
import { buildLegacyIR } from "@/core/ir";
import { documentStore, type StoreHooks } from "@/core/ir-store";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import type { BrowserHandle } from "@/core/browser";
import { refreshFidelity } from "@/core/fidelity";
import { applyCommands } from "@/core/ir-command";
import { createProject, enqueue, previewDocument, projectDocuments, runProject } from "@/core/jobs";
import type { FixCtx, FixTarget } from "@/core/qa-fix";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const fixture = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1"], shell: n("html", "html", [n("body", "body", [n("ph1", "#section", [], { attrs: { "data-section": "s1" } })])]) }],
  sections: [{ id: "s1", pageId: "pg", name: "one", role: "main", hash: "h1", origin: "capture", root: n("r", "div", [n("t", "#text", [], { text: "old" })]) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const textOf = (ir: IRV2) => ir.sections[0]!.root.children[0]!.text;
const dbFile = () => join(mkdtempSync(join(tmpdir(), "ir-store-")), "t.db");
const stateOf = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT revision,cursor,materialized_revision FROM document_state WHERE project_id=?").get(id) as { revision: number; cursor: number; materialized_revision: number } | undefined;
const historyRows = (db: DatabaseSync, id: string) => (db.prepare("SELECT COUNT(*) n FROM document_history WHERE project_id=?").get(id) as { n: number }).n;
const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

function setup(path = ":memory:", hooks: Partial<StoreHooks> = {}) {
  const db = openDb(path);
  const written: number[] = [];
  const ctl = { fail: false, loads: 0 };
  const materialize = async (_id: string, ir: IRV2) => {
    if (ctl.fail) throw new Error("disk full");
    written.push(ir.revision);
  };
  const store = documentStore(db, materialize, { loadInitial: async () => (ctl.loads++, fixture()), ...hooks });
  return { db, store, written, ctl };
}
const setText = (text: string) => [{ op: "setText" as const, id: "t", text }];

test("a batch commits as one step: revision + cursor move, the snapshot and output follow", async () => {
  const { db, store, written } = setup();
  const r = await store.commitCommands("p", 0, [...setText("new"), { op: "setAttribute", id: "r", name: "title", value: "x" }], "user");
  expect(r).toEqual({ revision: 1, createdIds: [], canUndo: true, canRedo: false });
  expect(stateOf(db, "p")).toEqual({ revision: 1, cursor: 1, materialized_revision: 1 });
  expect(historyRows(db, "p")).toBe(1);
  const doc = await store.loadDocument("p");
  expect([textOf(doc), doc.revision, doc.sections[0]!.root.attrs.title]).toEqual(["new", 1, "x"]);
  expect(written).toEqual([1]);
});

test("Undo/Redo survive a reopened db; Redo reuses the created IDs; a new edit after Undo drops the Redo tail", async () => {
  const path = dbFile();
  const first = setup(path);
  await first.store.commitCommands("p", 0, setText("new"), "user");
  const created = await first.store.commitCommands("p", 1, [{ op: "createNode", parentId: "r", index: 1, draft: { tag: "p" } }], "user");
  expect(created.createdIds).toHaveLength(1);
  first.db.close();

  const { db, store } = setup(path);
  const undone = await store.undoDocument("p", 2);
  expect(undone).toMatchObject({ revision: 3, canUndo: true, canRedo: true });
  expect((await store.loadDocument("p")).sections[0]!.root.children).toHaveLength(1);
  const redone = await store.redoDocument("p", 3);
  expect(redone).toEqual({ revision: 4, createdIds: created.createdIds, canUndo: true, canRedo: false });
  expect((await store.loadDocument("p")).sections[0]!.root.children[1]!.id).toBe(created.createdIds[0]);

  await store.undoDocument("p", 4);
  await store.undoDocument("p", 5);
  expect(textOf(await store.loadDocument("p"))).toBe("old");
  expect(stateOf(db, "p")).toMatchObject({ revision: 6, cursor: 0 });
  expect(await codeOf(store.undoDocument("p", 6))).toBe("NOTHING_TO_UNDO");

  const edit = await store.commitCommands("p", 6, setText("other"), "user");
  expect(edit).toMatchObject({ revision: 7, canUndo: true, canRedo: false });
  expect(historyRows(db, "p")).toBe(1);
  expect(await codeOf(store.redoDocument("p", 7))).toBe("NOTHING_TO_REDO");
  db.close();
});

test("a stale baseRevision is refused with the current revision; nothing is written", async () => {
  const { db, store } = setup();
  await store.commitCommands("p", 0, setText("a"), "user");
  for (const attempt of [() => store.commitCommands("p", 0, setText("b"), "user"), () => store.undoDocument("p", 0), () => store.redoDocument("p", 0)]) {
    const e = await attempt().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([(e as AppError).code, (e as AppError).context?.revision]).toEqual(["STALE_REVISION", 1]);
  }
  expect(stateOf(db, "p")).toEqual({ revision: 1, cursor: 1, materialized_revision: 1 });
  expect(textOf(await store.loadDocument("p"))).toBe("a");
});

test("501 steps keep the newest 500; the document is unchanged by the prune and 500 Undo steps remain", async () => {
  const { db, store } = setup();
  for (let i = 0; i < 501; i++) await store.commitCommands("p", i, setText(`v${i + 1}`), "user");
  expect(historyRows(db, "p")).toBe(500);
  expect(textOf(await store.loadDocument("p"))).toBe("v501");
  let revision = 501;
  for (let i = 0; i < 500; i++) revision = (await store.undoDocument("p", revision)).revision;
  expect(textOf(await store.loadDocument("p"))).toBe("v1"); // the oldest step was dropped, not its effect
  expect(await store.historyState("p")).toEqual({ revision: 1001, canUndo: false, canRedo: true });
});

test("a materializer exception keeps the commit, leaves materialized_revision behind; ensureMaterialized repairs", async () => {
  const { db, store, written, ctl } = setup();
  await store.ensureMaterialized("p"); // no document yet: nothing to do
  ctl.fail = true;
  const e = await store.commitCommands("p", 0, [{ op: "createNode", parentId: "r", index: 0, draft: { tag: "p" } }], "user").catch((x: unknown) => x);
  expect([(e as AppError).code, (e as AppError).context?.revision]).toEqual(["DOCUMENT_MATERIALIZE_FAILED", 1]);
  expect((e as AppError).context?.createdIds).toEqual([(await store.loadDocument("p")).sections[0]!.root.children[0]!.id]); // the client still learns its new IDs
  expect(stateOf(db, "p")).toEqual({ revision: 1, cursor: 1, materialized_revision: 0 });
  expect(await codeOf(store.ensureMaterialized("p"))).toBe("DOCUMENT_MATERIALIZE_FAILED");
  ctl.fail = false;
  await store.ensureMaterialized("p");
  expect(stateOf(db, "p")!.materialized_revision).toBe(1);
  await store.ensureMaterialized("p"); // up to date: no second write
  expect(written).toEqual([1]);
});

test("concurrent repairs of one project materialize once, never overlapping", async () => {
  const db = openDb(":memory:");
  let active = 0, calls = 0, fail = true;
  const store = documentStore(db, async () => {
    if (fail) throw new Error("x");
    calls++;
    if (++active > 1) throw new Error("overlap");
    await new Promise((r) => setTimeout(r, 10));
    active--;
  }, { loadInitial: async () => fixture() });
  await store.commitCommands("p", 0, setText("new"), "user").catch(() => {});
  fail = false;
  await Promise.all([store.ensureMaterialized("p"), store.ensureMaterialized("p"), store.ensureMaterialized("p")]);
  expect(calls).toBe(1);
});

test("a queued/active job blocks commit, Undo and Redo with PROJECT_BUSY; an uninitialized read stays in memory", async () => {
  let busy = true;
  const { db, store } = setup(":memory:", { isBusy: () => busy });
  expect(textOf(await store.loadDocument("p"))).toBe("old");
  expect(stateOf(db, "p")).toBeUndefined(); // the job may still rewrite ir.json: not adopted yet
  expect(await codeOf(store.commitCommands("p", 0, setText("x"), "user"))).toBe("PROJECT_BUSY");
  busy = false;
  await store.commitCommands("p", 0, setText("x"), "user");
  busy = true;
  expect(await codeOf(store.undoDocument("p", 1))).toBe("PROJECT_BUSY");
  expect(await codeOf(store.redoDocument("p", 1))).toBe("PROJECT_BUSY");
  expect(stateOf(db, "p")).toMatchObject({ revision: 1, cursor: 1 });
});

test("busy: a job queued while the first read loads is not adopted over; a job's out/ is never repaired", async () => {
  let busy = false;
  const { db, store } = setup(":memory:", { isBusy: () => busy, loadInitial: async () => ((busy = true), fixture()) });
  expect(await codeOf(store.commitCommands("p", 0, setText("x"), "user"))).toBe("PROJECT_BUSY");
  expect(stateOf(db, "p")).toBeUndefined();
  busy = false;
  const other = setup(":memory:", { isBusy: () => busy });
  other.ctl.fail = true;
  await other.store.commitCommands("p", 0, setText("x"), "user").catch(() => {});
  busy = true;
  await other.store.ensureMaterialized("p"); // the job owns out/: served as is, no repair and no error
  expect(other.written).toEqual([]);
  busy = false;
  other.ctl.fail = false;
  await other.store.ensureMaterialized("p");
  expect(other.written).toEqual([1]);
});

test("the first idle read adopts revision 0 once; later reads never reload or change IDs", async () => {
  const { db, store, ctl, written } = setup();
  const a = await store.loadDocument("p");
  const b = await store.loadDocument("p");
  expect([a.revision, b.revision, ctl.loads, historyRows(db, "p")]).toEqual([0, 0, 1, 0]);
  expect(b.sections[0]!.root.id).toBe(a.sections[0]!.root.id);
  expect(stateOf(db, "p")).toEqual({ revision: 0, cursor: 0, materialized_revision: 0 });
  expect(await store.historyState("p")).toEqual({ revision: 0, canUndo: false, canRedo: false });
  await store.ensureMaterialized("p");
  expect(written).toEqual([]); // the existing output is revision 0's
});

test("E2 §9: a stored snapshot the upgrade hook changes is committed once on load — revision+1, History reset, materialized; never while busy, never in place", async () => {
  const upgrade = (ir: IRV2): IRV2 => (ir.tokens["--u"] ? ir : { ...ir, tokens: { ...ir.tokens, "--u": "1" } });
  const busy = { on: false };
  const { db, store, written } = setup(":memory:", { upgrade, isBusy: () => busy.on });
  // as a pre-E2 build stored it: revision 2, one History step recorded against the pre-upgrade document
  db.prepare("INSERT INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES('p',?,2,1,2)").run(JSON.stringify({ ...fixture(), revision: 2 }));
  db.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES('p',1,'[]','[]','user')").run();
  busy.on = true; // a job owns the project: upgraded in memory only
  expect((await store.loadDocument("p")).tokens).toEqual({ "--u": "1" });
  await store.ensureMaterialized("p");
  expect([stateOf(db, "p"), historyRows(db, "p"), written]).toEqual([{ revision: 2, cursor: 1, materialized_revision: 2 }, 1, []]);
  busy.on = false;
  expect(await store.updateFidelity("p", 2, (items) => [...items, styleItem])).toBeNull(); // the upgrade is never stored in place
  const doc = await store.loadDocument("p");
  expect([doc.revision, doc.tokens]).toEqual([3, { "--u": "1" }]);
  expect([stateOf(db, "p"), historyRows(db, "p"), written]).toEqual([{ revision: 3, cursor: 0, materialized_revision: 3 }, 0, [3]]);
  expect(await store.historyState("p")).toEqual({ revision: 3, canUndo: false, canRedo: false });
  // idempotent: upgraded == stored -> no new revision, nothing re-emitted
  await store.loadDocument("p");
  await store.ensureMaterialized("p");
  expect([stateOf(db, "p")!.revision, written]).toEqual([3, [3]]);
  expect(await codeOf(store.commitCommands("p", 2, setText("x"), "user"))).toBe("STALE_REVISION");
});

test("E2 §9: a step at the pre-upgrade revision commits the upgrade first and is refused STALE; a job's own ensureMaterialized commits it while busy", async () => {
  const upgrade = (ir: IRV2): IRV2 => (ir.tokens["--u"] ? ir : { ...ir, tokens: { ...ir.tokens, "--u": "1" } });
  const seed = (db: DatabaseSync) => db.prepare("INSERT INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES('p',?,0,0,0)").run(JSON.stringify(fixture()));
  const a = setup(":memory:", { upgrade });
  seed(a.db);
  expect(await codeOf(a.store.commitCommands("p", 0, setText("x"), "user"))).toBe("STALE_REVISION");
  expect([stateOf(a.db, "p")!.revision, a.written]).toEqual([1, [1]]);
  await a.store.commitCommands("p", 1, setText("x"), "user"); // the reloaded tab's step lands on the upgraded document
  expect((await a.store.loadDocument("p")).tokens).toEqual({ "--u": "1" });
  const b = setup(":memory:", { upgrade, isBusy: () => true });
  seed(b.db);
  expect(await b.store.ensureMaterialized("p", true)).toBe(true);
  expect(await b.store.ensureMaterialized("p", true)).toBe(false);
  expect(stateOf(b.db, "p")!.revision).toBe(1);
});

test("updateComponent through the store drops the noted field from its component-note (E2 §5); Undo keeps it dropped (Fidelity is never undone)", async () => {
  const doc = fixture();
  doc.sections[0]!.root.children.push(n("dd", "div", [n("tg", "button"), n("pn", "div")], { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "tg", panel: "pn", openOn: "click" } }));
  doc.fidelity = [{ pageId: "pg", feature: "component-note", status: "partial", nodeId: "dd", sourceRef: "dd", note: "Nhận diện khi clone: openOn: giá trị mặc định" }];
  const { store } = setup(":memory:", { loadInitial: async () => doc });
  await store.commitCommands("p", 0, [{ op: "updateComponent", id: "dd", patch: { openOn: "hover" } }], "user");
  const notes = (d: IRV2) => d.fidelity.filter((x) => x.feature === "component-note");
  expect(notes(await store.loadDocument("p"))).toEqual([]);
  await store.undoDocument("p", 1);
  expect(notes(await store.loadDocument("p"))).toEqual([]);
});

test("invalid or oversized steps are refused before anything is written", async () => {
  const { db, store } = setup();
  expect(await codeOf(store.commitCommands("p", 0, [{ op: "setText", id: "missing", text: "x" }], "user"))).toBe("IR_PATCH_INVALID");
  expect(await codeOf(store.commitCommands("p", 0, setText("x".repeat(9 * 1024 * 1024)), "user"))).toBe("IR_PATCH_INVALID"); // > 8 MB step
  expect(stateOf(db, "p")).toEqual({ revision: 0, cursor: 0, materialized_revision: 0 });
  expect(historyRows(db, "p")).toBe(0);
});

test("user commits and Undo/Redo run the manual-edit hook inside the commit; ai_editor commits do not", async () => {
  const seen: string[] = [];
  const { store } = setup(":memory:", { onUserEdit: (id) => seen.push(id) });
  await store.commitCommands("p", 0, setText("a"), "ai_editor");
  expect(seen).toEqual([]);
  await store.commitCommands("p", 1, setText("b"), "user");
  await store.undoDocument("p", 2);
  await store.redoDocument("p", 3);
  expect(seen).toEqual(["p", "p", "p"]);
});

const fakeOpen = async (): Promise<BrowserHandle> => ({ context: {} as BrowserHandle["context"], close: async () => {} });
const captureOf = async (ws: string) => JSON.parse(await readFile(join(ws, "pages", "home", "capture.json"), "utf8")) as PageCapture;

// A failed project with a v1 ir.json, one capture (site "home") and one pending fix task, as the pipeline leaves it.
async function seedJobsProject(inventory?: PageCapture["inventory"]) {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
  const dom = el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("#text", [], "Body")])])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [], ...(inventory && { inventory }),
  } as PageCapture;
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "ir.json"), JSON.stringify(buildLegacyIR([capture]))); // a pre-v2 checkpoint
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [{ score: 0.5 }] }));
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", id);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(id);
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES('fx',?,'fix','home:s','pending')").run(id);
  db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(id);
  return { db, id, ws };
}

test("jobs wiring: a v1 ir.json is migrated once; a commit writes the v2 mirror, out/, stale QA and closes fix tasks", async () => {
  const { db, id, ws } = await seedJobsProject();
  const store = projectDocuments(db);
  const doc = await store.loadDocument(id);
  expect([doc.version, doc.revision]).toEqual([2, 0]);
  // re-reading (a fresh store too) never re-migrates: same revision, same IDs; the QA of the v1 output is stale
  const again = await projectDocuments(db).loadDocument(id);
  expect(again.revision).toBe(doc.revision);
  expect(again.sections[0]!.root.id).toBe(doc.sections[0]!.root.id);
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toEqual({ scores: [{ score: 0.5 }], stale: true });
  const text = doc.sections.flatMap((s) => [s.root, ...s.root.children]).find((x) => x.text === "Top")!;
  await store.commitCommands(id, 0, [{ op: "setText", id: text.id, text: "Changed" }], "user");

  const mirror = JSON.parse(await readFile(join(ws, "ir.json"), "utf8")) as IRV2;
  expect([mirror.version, mirror.revision]).toEqual([2, 1]);
  expect(await readFile(join(ws, "out", "index.html"), "utf8")).toContain("Changed");
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toEqual({ scores: [{ score: 0.5 }], stale: true });
  expect(db.prepare("SELECT status FROM tasks WHERE id='fx'").get()).toEqual({ status: "done" });
  expect(stateOf(db, id)).toMatchObject({ revision: 1, materialized_revision: 1 });
});

test("v1 ir.json: a plain read (preview, a job) never marks QA stale; adoption marks it once and writes the v2 mirror", async () => {
  const { db, id, ws } = await seedJobsProject();
  const file = (name: string) => readFile(join(ws, name), "utf8").then((t) => JSON.parse(t) as Record<string, unknown>);
  const store = projectDocuments(db);
  expect((await store.readDocument(id)).version).toBe(2);
  const preview = await previewDocument(db, id);
  expect(preview.doc?.version).toBe(2);
  expect(preview.fidelity.length).toBeGreaterThan(0);
  expect(await file("qa.json")).toEqual({ scores: [{ score: 0.5 }] }); // e.g. fresh scores of a rescore: left alone
  expect([stateOf(db, id), (await file("ir.json")).version]).toEqual([undefined, undefined]); // still the v1 checkpoint

  const doc = await store.loadDocument(id); // the editor's first read adopts the migrated document
  expect(await file("qa.json")).toEqual({ scores: [{ score: 0.5 }], stale: true });
  expect(await file("ir.json")).toEqual(doc); // migrated once: ir.json is now the v2 mirror
  // rescored afterwards: re-reading, a fresh store and a re-adoption of the v2 mirror never re-mark it
  await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [{ score: 0.9 }] }));
  await projectDocuments(db).loadDocument(id);
  await previewDocument(db, id);
  db.prepare("DELETE FROM document_state WHERE project_id=?").run(id);
  expect((await projectDocuments(db).loadDocument(id)).sections[0]!.root.id).toBe(doc.sections[0]!.root.id);
  expect(await file("qa.json")).toEqual({ scores: [{ score: 0.9 }] });
});

// A pre-E2 v2 document as E1 stored it: a captured v1 tab interaction bound as `behavior`, no `interactive` yet.
function preE2(revision = 0): IRV2 {
  const tab = (id: string, selected: boolean, panel: string) => n(id, "button", [n(`${id}x`, "#text", [], { text: id })], { attrs: { role: "tab", "aria-selected": String(selected), "aria-controls": panel } });
  const root = n("tabs", "section", [
    n("tl", "div", [tab("t1", true, "panel-1"), tab("t2", false, "panel-2")], { attrs: { role: "tablist" } }),
    n("pn1", "div", [n("p1x", "#text", [], { text: "one" })], { attrs: { role: "tabpanel", id: "panel-1" } }),
    n("pn2", "div", [n("p2x", "#text", [], { text: "two" })], { attrs: { role: "tabpanel", id: "panel-2", hidden: "" } }),
  ]);
  root.children[0]!.children[0]!.behavior = "ix-tab";
  return {
    ...fixture(), revision,
    pages: [{ id: "home", path: "/", title: "", meta: {}, sectionIds: ["s1"], shell: n("html", "html", [n("body", "body", [n("ph1", "#section", [], { attrs: { "data-section": "s1" } })])]) }],
    sections: [{ id: "s1", pageId: "home", name: "tabs", role: "main", hash: "h1", origin: "capture", root }],
    interactions: [{ id: "ix-tab", kind: "tab", trigger: "#t1", status: "captured", pageId: "home" }],
  };
}
const RUNTIME = fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url));
async function staleOutput(ws: string) {
  await mkdir(join(ws, "out", "js"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), '<button data-behavior="ix-tab">t1</button>');
  await writeFile(join(ws, "out", "js", "runtime.js"), "/* pre-E2 runtime */");
}
const outputOf = async (ws: string) => [await readFile(join(ws, "out", "index.html"), "utf8"), await readFile(join(ws, "out", "js", "runtime.js"), "utf8")];

test("E2 §9 jobs wiring: an adopted pre-E2 snapshot (+ History) is committed upgraded on the first load — revision+1, History reset, out/ data-c + new runtime, QA stale; once", async () => {
  const { db, id, ws } = await seedJobsProject();
  await writeFile(join(ws, "ir.json"), JSON.stringify(preE2(2))); // the mirror the pre-E2 build wrote
  db.prepare("INSERT INTO document_state(project_id,ir_json,revision,cursor,materialized_revision) VALUES(?,?,2,1,2)").run(id, JSON.stringify(preE2(2)));
  db.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES(?,1,?,?,'user')").run(id, JSON.stringify([{ op: "setText", id: "p1x", text: "one" }]), JSON.stringify([{ op: "restoreProps", id: "tabs", props: {} }]));
  await staleOutput(ws);
  const doc = await projectDocuments(db).loadDocument(id);
  expect(doc.revision).toBe(3);
  expect(doc.sections[0]!.root.interactive).toMatchObject({ kind: "tabs", confidence: "guessed" });
  expect(JSON.stringify(doc)).not.toContain('"behavior"');
  expect([stateOf(db, id), historyRows(db, id)]).toEqual([{ revision: 3, cursor: 0, materialized_revision: 3 }, 0]);
  const [html, runtime] = await outputOf(ws);
  expect(html).toContain('data-c="tabs"');
  expect(runtime).toBe(await readFile(RUNTIME, "utf8"));
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toEqual({ scores: [{ score: 0.5 }], stale: true });
  expect((JSON.parse(await readFile(join(ws, "ir.json"), "utf8")) as IRV2).revision).toBe(3);
  // a second load (a fresh store) and a repair find nothing to upgrade: no new revision
  await projectDocuments(db).loadDocument(id);
  await projectDocuments(db).ensureMaterialized(id);
  expect(stateOf(db, id)!.revision).toBe(3);
});

test("E2 §9 jobs wiring: adopting a not-yet-adopted pre-E2 v2 checkpoint re-emits out/ (data-c, new runtime) and marks QA stale; the mirror never converts again", async () => {
  const { db, id, ws } = await seedJobsProject();
  await writeFile(join(ws, "ir.json"), JSON.stringify(preE2()));
  await staleOutput(ws);
  const doc = await projectDocuments(db).loadDocument(id);
  expect([doc.revision, stateOf(db, id)]).toEqual([0, { revision: 0, cursor: 0, materialized_revision: 0 }]);
  const [html, runtime] = await outputOf(ws);
  expect(html).toContain('data-c="tabs"');
  expect(runtime).toBe(await readFile(RUNTIME, "utf8"));
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toMatchObject({ stale: true });
  expect(JSON.stringify(JSON.parse(await readFile(join(ws, "ir.json"), "utf8")))).not.toContain('"behavior"');
});

// --- Fidelity (E1 §5): derived data, never a History step ---
const styleItem = { pageId: "pg", feature: "style-target", status: "unsupported" as const, nodeId: "t", sourceRef: "t", note: "Style :hover @media 768 không lưu" };
const legacyCapture = { pageId: "pg", url: "http://x.test/", capturedAt: "", title: "", meta: {}, breakpoints: [], interactions: [], assets: {}, skippedAssets: [], dynamic: [] } as unknown as PageCapture;

test("every commit/Undo/Redo re-derives Fidelity: a deleted node keeps its item by sourceRef; capture items follow the document", async () => {
  const withItem = (): IRV2 => ({ ...fixture(), fidelity: [styleItem] });
  const { db, store } = setup(":memory:", { loadInitial: async () => withItem(), captures: async () => [legacyCapture] });
  await store.commitCommands("p", 0, [{ op: "deleteNode", id: "t" }], "user");
  let doc = await store.loadDocument("p");
  expect(doc.fidelity).toContainEqual({ pageId: "pg", feature: "style-target", status: "unsupported", sourceRef: "t", note: styleItem.note }); // nodeId dropped only
  expect(doc.fidelity.map((x) => x.feature)).toContain("capture-inventory"); // analyzer item derived from the captures
  expect(historyRows(db, "p")).toBe(1);
  await store.undoDocument("p", 1);
  doc = await store.loadDocument("p");
  expect(doc.sections[0]!.root.children.map((c) => c.id)).toEqual(["t"]);
  expect(doc.fidelity.filter((x) => x.feature === "style-target")).toHaveLength(1); // never restored or duplicated by Undo
  expect(doc.fidelity.filter((x) => x.feature === "capture-inventory")).toHaveLength(1);
});

test("updateFidelity rewrites only ir.fidelity at the same revision: no History row, the CAS still accepts that revision, ir.json mirrored", async () => {
  const mirrored: IRV2[] = [];
  const { db, store, written } = setup(":memory:", { mirror: async (_id, ir) => void mirrored.push(ir) });
  await store.commitCommands("p", 0, setText("a"), "user");
  const items = await store.updateFidelity("p", 1, (cur) => [...cur, styleItem]);
  expect(items).toEqual([styleItem]);
  expect(stateOf(db, "p")).toEqual({ revision: 1, cursor: 1, materialized_revision: 1 });
  expect(historyRows(db, "p")).toBe(1);
  expect((await store.loadDocument("p")).fidelity).toEqual([styleItem]);
  expect(mirrored.map((x) => [x.revision, x.fidelity])).toEqual([[1, [styleItem]]]);
  expect(written).toEqual([1]); // no out/ re-emit, no stale QA: only the mirror
  // unchanged -> no write; null revision = whatever is stored
  expect(await store.updateFidelity("p", null, (cur) => cur)).toEqual([styleItem]);
  expect(mirrored).toHaveLength(1);
  // a tab at revision 1 still commits (the revision did not move), and Undo does not touch Fidelity
  await store.commitCommands("p", 1, setText("b"), "user");
  await store.undoDocument("p", 2);
  expect((await store.loadDocument("p")).fidelity).toEqual([styleItem]);
});

test("updateFidelity: a stale revision, no stored document or a busy project writes nothing; a failed mirror is repaired on the next read", async () => {
  let busy = false;
  const { db, store, written, ctl } = setup(":memory:", { isBusy: () => busy });
  expect(await store.updateFidelity("p", null, () => [styleItem])).toBeNull(); // not adopted: never adopts here
  expect(stateOf(db, "p")).toBeUndefined();
  await store.commitCommands("p", 0, setText("a"), "user");
  expect(await store.updateFidelity("p", 0, () => [styleItem])).toBeNull();
  busy = true;
  expect(await store.updateFidelity("p", 1, () => [styleItem])).toBeNull();
  busy = false;
  expect((await store.loadDocument("p")).fidelity).toEqual([]);
  ctl.fail = true; // no mirror hook: the materializer writes the document
  expect(await codeOf(store.updateFidelity("p", 1, () => [styleItem]))).toBe("DOCUMENT_MATERIALIZE_FAILED");
  expect((await store.loadDocument("p")).fidelity).toEqual([styleItem]); // SQLite holds it
  ctl.fail = false;
  await store.ensureMaterialized("p");
  expect(written).toEqual([1, 1]);
});

test("updateFidelity caps the list at 2000 items", async () => {
  const { store } = setup();
  await store.loadDocument("p");
  const many = Array.from({ length: 2100 }, (_, i) => ({ ...styleItem, nodeId: undefined, sourceRef: `r${i}` }));
  const items = await store.updateFidelity("p", 0, () => many);
  expect(items).toHaveLength(2000);
  expect(items!.at(-1)!.feature).toBe("fidelity-overflow");
});

test("preview Fidelity: ir.json analyzed in memory without adopting; a stored v2 document without analyzer items is backfilled once in place", async () => {
  const { db, id, ws } = await seedJobsProject({ scripts: 3, iframes: 0, canvases: 0, skippedNodes: 0 });
  const raw = () => readFile(join(ws, "ir.json"), "utf8").then((t) => JSON.parse(t) as IRV2);
  const v1 = (await previewDocument(db, id)).fidelity;
  expect(v1.find((x) => x.feature === "script")).toMatchObject({ pageId: "home", status: "unsupported" });
  expect(stateOf(db, id)).toBeUndefined(); // the preview never adopts the document

  const store = projectDocuments(db);
  const doc = await store.loadDocument(id);
  // a document stored before the analyzer existed: only migration items
  const old = { ...doc, fidelity: doc.fidelity.filter((x) => x.feature === "capture-box") };
  db.prepare("UPDATE document_state SET ir_json=? WHERE project_id=?").run(JSON.stringify(old), id);
  const items = (await previewDocument(db, id)).fidelity;
  expect(items.filter((x) => x.feature === "script")).toHaveLength(1);
  expect((await store.loadDocument(id)).fidelity).toEqual(items);
  expect((await raw()).fidelity).toEqual(items); // ir.json mirrored
  expect([stateOf(db, id), historyRows(db, id)]).toEqual([{ revision: 0, cursor: 0, materialized_revision: 0 }, 0]);
  // adopting the v1 checkpoint marked the pixel QA stale (E1 §6); the Fidelity backfill leaves it alone
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toEqual({ scores: [{ score: 0.5 }], stale: true });
  expect((await previewDocument(db, id)).fidelity).toEqual(items); // idempotent
});

test("preview: a missing or corrupt capture.json is no capture evidence for a v2 document; a v1 checkpoint that cannot migrate says so", async () => {
  const { db, id, ws } = await seedJobsProject();
  const capture = join(ws, "pages", "home", "capture.json");
  const good = await readFile(capture, "utf8");
  await writeFile(capture, "{"); // v1: the migration needs the capture (box): refused, said, never a broken preview
  expect(await previewDocument(db, id)).toEqual({ doc: null, fidelity: [expect.objectContaining({ feature: "fidelity-unavailable", status: "partial" })] });
  await writeFile(capture, good);
  const doc = await projectDocuments(db).loadDocument(id);
  await writeFile(capture, "{");
  expect((await previewDocument(db, id)).doc).toEqual(doc);
  await rm(capture);
  expect((await previewDocument(db, id)).fidelity.length).toBeGreaterThan(0); // carried
});

// --- pipeline jobs over an adopted document (E1 §6: SQLite is the source of truth once adopted) ---

test("commitJob: not adopted -> null; adopted -> the job IR at revision+1, History reset, materialized; a stale base is refused", async () => {
  let busy = false;
  const { db, store, written } = setup(":memory:", { isBusy: () => busy });
  expect(await store.commitJob("p", 0, fixture())).toBeNull(); // ir.json stays the job checkpoint
  expect(stateOf(db, "p")).toBeUndefined();
  await store.commitCommands("p", 0, setText("edited"), "user");
  const doc = await store.loadDocument("p");
  const job = { ...doc, sections: doc.sections.map((x) => ({ ...x, name: "named-by-job" })) };
  busy = true; // the job itself holds the project
  expect(await codeOf(store.commitJob("p", 0, job))).toBe("STALE_REVISION");
  expect(await store.commitJob("p", 1, job)).toBe(2);
  expect(stateOf(db, "p")).toEqual({ revision: 2, cursor: 0, materialized_revision: 2 });
  expect(historyRows(db, "p")).toBe(0);
  busy = false;
  const after = await store.loadDocument("p");
  expect([after.revision, after.sections[0]!.name, textOf(after)]).toEqual([2, "named-by-job", "edited"]);
  expect(await store.historyState("p")).toEqual({ revision: 2, canUndo: false, canRedo: false });
  expect(await codeOf(store.commitCommands("p", 1, setText("from an open tab"), "user"))).toBe("STALE_REVISION");
  expect(written).toEqual([1, 2]);
});

test("updateFidelity: a job queued while the mirror waits -> ir.json not written, the output marked behind and repaired later", async () => {
  let busy = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const db = openDb(":memory:");
  const written: number[] = [];
  const mirrored: number[] = [];
  const store = documentStore(db, async (_id, ir) => (await gate, void written.push(ir.revision)), {
    loadInitial: async () => fixture(),
    isBusy: () => busy,
    mirror: async (_id, ir) => void mirrored.push(ir.revision),
  });
  await store.loadDocument("p");
  const commit = store.commitCommands("p", 0, setText("a"), "user"); // its materialization waits on the gate
  await expect.poll(() => stateOf(db, "p")?.revision).toBe(1);
  const update = store.updateFidelity("p", 1, () => [styleItem]); // queued behind the materialization
  busy = true;
  release();
  await commit;
  expect(await update).toEqual([styleItem]);
  expect(mirrored).toEqual([]);
  expect(stateOf(db, "p")).toMatchObject({ revision: 1, materialized_revision: 0 });
  busy = false;
  await store.ensureMaterialized("p");
  expect(written).toEqual([1, 1]);
});

test("a resumed fix over an adopted document: the fixed IR becomes the next revision (History reset, Fidelity re-derived), ir.json + out/ follow", async () => {
  const { db, id, ws } = await seedJobsProject();
  const store = projectDocuments(db);
  const adopted = await store.loadDocument(id);
  const top = adopted.sections.flatMap((x) => [x.root, ...x.root.children]).find((x) => x.text === "Top")!;
  let seen: IRV2 | undefined;
  const fixAll = async (ctx: FixCtx, targets: FixTarget[]) => {
    seen = ctx.ir;
    ctx.ir = { ...applyCommands(ctx.ir, [{ op: "setText", id: top.id, text: "Fixed" }]).ir, fidelity: [] };
    return targets.map((t) => ({ ...t, finalScore: 1, scores: { 375: 1, 768: 1, 1440: 1 }, rounds: 1, patched: true, status: "pass" as const }));
  };
  await runProject(db, id, { deps: { openBrowser: fakeOpen, scoreSections: async () => [], fixAll } });
  expect(seen).toEqual(adopted); // the fix loop started from the SQLite snapshot
  expect(stateOf(db, id)).toEqual({ revision: 1, cursor: 0, materialized_revision: 1 });
  expect(historyRows(db, id)).toBe(0);
  const doc = await store.loadDocument(id);
  expect(JSON.stringify(doc)).toContain('"Fixed"');
  expect(doc.fidelity).toEqual(refreshFidelity([], doc, [await captureOf(ws)]));
  expect(doc.fidelity.length).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(ws, "ir.json"), "utf8"))).toEqual(doc);
  expect(await readFile(join(ws, "out", "index.html"), "utf8")).toContain("Fixed");
  expect(JSON.parse(await readFile(join(ws, "qa.json"), "utf8"))).toEqual({ scores: [], behavior: [] }); // rescored after the fix (no component: no behaviour check)
  expect(await codeOf(store.commitCommands(id, 0, [{ op: "setText", id: top.id, text: "tab" }], "user"))).toBe("STALE_REVISION");
  expect((db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status).toBe("completed");
});

test("a user edit before the resume wins: the fix tasks are closed, no fix runs, the edit stays", async () => {
  const { db, id } = await seedJobsProject();
  const store = projectDocuments(db);
  const doc = await store.loadDocument(id);
  const top = doc.sections.flatMap((x) => [x.root, ...x.root.children]).find((x) => x.text === "Top")!;
  await store.commitCommands(id, 0, [{ op: "setText", id: top.id, text: "Mine" }], "user");
  const fixAll = async (): Promise<never> => {
    throw new Error("no fix may run over a manual edit");
  };
  await runProject(db, id, { deps: { openBrowser: fakeOpen, scoreSections: async () => [], fixAll } });
  expect((db.prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status).toBe("completed");
  const after = await store.loadDocument(id);
  expect(after.revision).toBe(1);
  expect(JSON.stringify(after)).toContain('"Mine"');
});

test("E3b R3: coalesce folds a repeat of the latest step's style fields into that step — one Undo restores the value before both; anything else is a new step", async () => {
  const { db, store } = setup();
  const color = (c: string) => [{ op: "setStyle" as const, id: "r", target: "base" as const, changes: { color: c } }];
  const colorOf = async () => (await store.loadDocument("p")).sections[0]!.root.styles.base.color;
  await store.commitCommands("p", 0, color("red"), "user");
  expect(await store.commitCommands("p", 1, color("blue"), "user", { coalesce: true })).toEqual({ revision: 2, createdIds: [], canUndo: true, canRedo: false });
  expect([historyRows(db, "p"), stateOf(db, "p")]).toEqual([1, { revision: 2, cursor: 1, materialized_revision: 2 }]);
  await store.undoDocument("p", 2);
  expect(await colorOf()).toBeUndefined();
  await store.redoDocument("p", 3);
  expect(await colorOf()).toBe("blue");
  // another property: a new step
  await store.commitCommands("p", 4, [{ op: "setStyle", id: "r", target: "base", changes: { "font-size": "20px" } }], "user", { coalesce: true });
  expect(historyRows(db, "p")).toBe(2);
  // a Redo branch (the latest step undone) is never rewritten: a new step that drops the branch
  await store.undoDocument("p", 5);
  await store.commitCommands("p", 6, color("green"), "user", { coalesce: true });
  expect([historyRows(db, "p"), stateOf(db, "p")!.cursor]).toEqual([2, 2]);
  // a non-style batch never coalesces
  await store.commitCommands("p", 7, setText("x"), "user", { coalesce: true });
  expect(historyRows(db, "p")).toBe(3);
});
