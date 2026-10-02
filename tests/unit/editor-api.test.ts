// E1 Task 8: thin command/Undo/Redo routes over the document store, and the out/ gate on the files route.
import { afterAll, expect, test, vi } from "vitest";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { config } from "@/core/config";
import { buildIR } from "@/core/ir";
import type { IRV2 } from "@/core/ir-v2";
import { createProject, enqueue, projectDocuments } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { exclusive } from "@/app/_server/session";
import * as commandsRoute from "@/app/api/projects/[id]/editor/commands/route";
import * as undoRoute from "@/app/api/projects/[id]/editor/undo/route";
import * as redoRoute from "@/app/api/projects/[id]/editor/redo/route";
import * as editorRoute from "@/app/api/projects/[id]/editor/route";
import * as saveRoute from "@/app/api/projects/[id]/editor/save/route";
import * as promoteRoute from "@/app/api/projects/[id]/editor/promote-layout/route";
import * as files from "@/app/api/projects/[id]/files/[...path]/route";

// a queued/active job, as the session guards see it (a real queue would start a browser pipeline)
const busy = vi.hoisted(() => new Set<string>());
vi.mock("@/core/jobs", async (orig) => {
  const real = await orig<typeof import("@/core/jobs")>();
  return { ...real, isQueuedOrActive: (id: string) => busy.has(id) || real.isQueuedOrActive(id) };
});

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
const defaultDom = () => el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("#text", [], "Body")])])]);
async function seed(dom: CaptureNode = defaultDom()): Promise<string> {
  const db = getDb();
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  created.push(id);
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-09-24T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  await writeFile(join(ws, "ir.json"), JSON.stringify(buildIR([capture])));
  await mkdir(join(ws, "out"), { recursive: true });
  await writeFile(join(ws, "out", "index.html"), "<p>emitted at revision 0</p>");
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", id);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(id);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(id);
  return id;
}
const textNodeId = async (id: string, text = "Top") => {
  const doc = await projectDocuments(getDb()).loadDocument(id);
  return doc.sections.flatMap((s) => [s.root, ...s.root.children]).find((x) => x.text === text)!.id;
};
const rootId = async (id: string) => (await projectDocuments(getDb()).loadDocument(id)).sections[0]!.root.id;

type Route = { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
const post = (route: Route, id: string, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return route.POST(
    new Request("http://127.0.0.1", { method: "POST", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers } }),
    { params: Promise.resolve({ id }) },
  );
};
const getFile = (id: string, ...path: string[]) => files.GET(new Request("http://127.0.0.1"), { params: Promise.resolve({ id, path }) });
const getEditor = (id: string) => editorRoute.GET(new Request("http://127.0.0.1"), { params: Promise.resolve({ id }) });
type Comp = { type?: string; content?: string; attributes?: Record<string, string>; components?: Comp[] };
type EditorData = { pageId: string; components: Comp[]; revision: number; canUndo: boolean; canRedo: boolean };
const editorData = async (id: string) => {
  const res = await getEditor(id);
  expect(res.status).toBe(200);
  return (await res.json()) as EditorData;
};
const findText = (comps: Comp[], text: string): Comp | undefined => {
  for (const c of comps) {
    if (c.type === "textnode" && c.content === text) return c;
    const hit = findText(c.components ?? [], text);
    if (hit) return hit;
  }
  return undefined;
};
const setText = (nodeId: string, text: string) => [{ op: "setText", id: nodeId, text }];

test("two tabs at the same revision: one commits, the other gets 409 STALE_REVISION with the current revision", async () => {
  const id = await seed();
  const t = await textNodeId(id);
  const ok = await post(commandsRoute, id, { baseRevision: 0, commands: setText(t, "first tab") });
  expect([ok.status, await ok.json()]).toEqual([200, { revision: 1, createdIds: [], canUndo: true, canRedo: false }]);
  const stale = await post(commandsRoute, id, { baseRevision: 0, commands: setText(t, "second tab secret-text") });
  expect(stale.status).toBe(409);
  const body = await stale.text();
  expect(JSON.parse(body)).toMatchObject({ code: "STALE_REVISION", revision: 1 });
  expect(body).not.toContain("secret-text");
  expect((await projectDocuments(getDb()).loadDocument(id)).revision).toBe(1);

  // sent together: exactly one is committed, the other is a 409 (stale, or busy while the first holds the project)
  const both = await Promise.all(["a", "b"].map((x) => post(commandsRoute, id, { baseRevision: 1, commands: setText(t, x) })));
  expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  const [winner, loser] = await Promise.all([both.find((r) => r.status === 200)!.json(), both.find((r) => r.status === 409)!.json()]);
  expect(winner.revision).toBe(2);
  expect(loser).toMatchObject({ code: expect.stringMatching(/^(PROJECT_BUSY|STALE_REVISION)$/), revision: 2 }); // reload at the winner's revision
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(2);

  // another exclusive operation (crawl, export…) holds the project: 409 PROJECT_BUSY still names the current revision
  let release!: () => void;
  const held = exclusive(id, () => new Promise<void>((r) => (release = r)));
  try {
    for (const route of [commandsRoute, undoRoute, redoRoute]) {
      const res = await post(route, id, { baseRevision: 2, ...(route === commandsRoute && { commands: setText(t, "c") }) });
      expect([res.status, await res.json()]).toEqual([409, expect.objectContaining({ code: "PROJECT_BUSY", revision: 2 })]);
    }
  } finally {
    release();
    await held;
  }
});

test("only client command ops are accepted; bodies are validated and capped before parsing, never echoed", async () => {
  const id = await seed();
  const t = await textNodeId(id);
  const bad = async (body: unknown, status = 400) => {
    const res = await post(commandsRoute, id, body);
    const text = await res.text();
    expect(res.status).toBe(status);
    expect(text).not.toContain("leak-me");
    return JSON.parse(text) as { code: string };
  };
  await bad({ baseRevision: 0, commands: [{ op: "restoreProps", id: t, props: { tag: "leak-me" } }] });
  await bad({ baseRevision: 0, commands: [{ op: "restoreNode", parentId: t, index: 0, node: { id: "leak-me" } }] });
  await bad({ baseRevision: 0, commands: [{ op: "replaceSubtree", id: t }] });
  await bad({ baseRevision: 0, commands: [{ op: "setText", id: t, text: "x", "leak-me": 1 }] });
  await bad({ baseRevision: 0, commands: [] });
  await bad({ baseRevision: 0, commands: Array.from({ length: 51 }, () => ({ op: "setText", id: t, text: "x" })) });
  await bad({ baseRevision: -1, commands: setText(t, "x") });
  await bad('{"baseRevision":0,"commands":[leak-me');
  expect((await bad({ baseRevision: 0, commands: setText(t, "leak-me".repeat(200_000)) }, 413)).code).toBe("PAYLOAD_TOO_LARGE");
  // the core still validates values: an unsafe CSS declaration is IR_PATCH_INVALID -> 400
  expect((await bad({ baseRevision: 0, commands: [{ op: "setStyle", id: t, target: "base", changes: { color: "url(javascript:leak-me)" } }] })).code).toBe("IR_PATCH_INVALID");
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(0);
});

test("the Origin/Host/JSON guards cover the new routes", async () => {
  const id = await seed();
  const body = { baseRevision: 0 };
  expect((await post(undoRoute, id, body, { origin: "http://evil.test" })).status).toBe(403);
  expect((await post(commandsRoute, id, body, { "content-type": "text/plain" })).status).toBe(403);
  expect((await post(redoRoute, id, body, { host: "evil.test" })).status).toBe(403);
});

test("Undo/Redo: server history with revision CAS; nothing to undo/redo is 409; a queued job blocks them", async () => {
  const id = await seed();
  const t = await textNodeId(id);
  expect(await (await post(undoRoute, id, { baseRevision: 0 })).json()).toMatchObject({ code: "NOTHING_TO_UNDO" });
  const r = await rootId(id);
  const made = (await (await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "createNode", parentId: r, index: 0, draft: { tag: "p" } }] })).json()) as { createdIds: string[] };
  expect(made.createdIds).toHaveLength(1);

  const undone = await post(undoRoute, id, { baseRevision: 1 });
  expect([undone.status, await undone.json()]).toEqual([200, { revision: 2, createdIds: [], canUndo: false, canRedo: true }]);
  const stale = await post(redoRoute, id, { baseRevision: 1 });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 2 })]);
  const redone = await post(redoRoute, id, { baseRevision: 2 });
  expect([redone.status, await redone.json()]).toEqual([200, { revision: 3, createdIds: made.createdIds, canUndo: true, canRedo: false }]);
  const none = await post(redoRoute, id, { baseRevision: 3 });
  expect([none.status, (await none.json()).code]).toEqual([409, "NOTHING_TO_REDO"]);
  expect(await projectDocuments(getDb()).historyState(id)).toEqual({ revision: 3, canUndo: true, canRedo: false }); // GET editor over a v2 ir.json: Task 9

  busy.add(id);
  try {
    for (const res of [await post(undoRoute, id, { baseRevision: 3 }), await post(commandsRoute, id, { baseRevision: 3, commands: setText(t, "x") })])
      expect([res.status, (await res.json()).code]).toEqual([409, "BAD_STATE"]); // requireEditable: "Project đang chạy"
  } finally {
    busy.delete(id);
  }
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(3);
});

test("GET editor adopts the document and reports revision + history flags", async () => {
  const id = await seed();
  const res = await getEditor(id);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ revision: 0, canUndo: false, canRedo: false, pages: expect.any(Array) });
});

test("output gate: a failed materialization never serves out/; the next read repairs from the snapshot", async () => {
  const id = await seed();
  const ws = join(config.workspaceRoot, id);
  const r = await rootId(id); // adopts revision 0
  await rename(join(ws, "pages.json"), join(ws, "pages.hidden")); // the materializer can't read its inputs

  const failed = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "createNode", parentId: r, index: 0, draft: { tag: "p", children: [{ tag: "#text", text: "Added" }] } }] });
  const body = (await failed.json()) as { code: string; revision: number; createdIds: string[] };
  expect([failed.status, body.code, body.revision, body.createdIds.length]).toEqual([500, "DOCUMENT_MATERIALIZE_FAILED", 1, 1]);

  const gated = await getFile(id, "out", "index.html");
  expect(gated.status).toBe(503);
  const text = await gated.text();
  expect(text).not.toContain("emitted at revision 0");
  expect(JSON.parse(text)).toMatchObject({ code: "DOCUMENT_MATERIALIZE_FAILED" });
  expect(gated.headers.get("content-security-policy")).toContain("sandbox");
  expect(gated.headers.get("retry-after")).toBeTruthy();
  expect((await getFile(id, "pages", "home", "capture.json")).status).toBe(404); // non-out paths: unchanged rules
  const editor = await getEditor(id); // the editor reads behind the same gate: a retryable 503, not a 500
  expect([editor.status, ((await editor.json()) as { code: string }).code]).toEqual([503, "DOCUMENT_MATERIALIZE_FAILED"]);

  await rename(join(ws, "pages.hidden"), join(ws, "pages.json"));
  const repaired = await getFile(id, "out", "index.html");
  expect(repaired.status).toBe(200);
  expect(await repaired.text()).toContain("Added");
  expect((JSON.parse(await readFile(join(ws, "ir.json"), "utf8")) as IRV2).revision).toBe(1);
});

test("Lưu (legacy save URL) commits through the document store: GET editor works on the v2 document, Undo/Redo keep the history", async () => {
  const id = await seed();
  const ws = join(config.workspaceRoot, id);
  const data = await editorData(id);
  expect(data.revision).toBe(0);
  findText(data.components, "Top")!.content = "Saved title";
  const noBase = await post(saveRoute, id, { pageId: data.pageId, project: { components: data.components } });
  expect(noBase.status).toBe(400); // baseRevision is required
  const saved = await post(saveRoute, id, { baseRevision: 0, pageId: data.pageId, project: { components: data.components } });
  expect([saved.status, await saved.json()]).toEqual([200, { revision: 1, createdIds: [], canUndo: true, canRedo: false, ops: 1, skipped: [] }]);
  expect(await readFile(join(ws, "out", "index.html"), "utf8")).toContain("Saved title");

  // ir.json is the v2 mirror now: GET editor builds the canvas from the document (was a 500)
  const reloaded = await editorData(id);
  expect(reloaded).toMatchObject({ revision: 1, canUndo: true, canRedo: false });
  expect(findText(reloaded.components, "Saved title")).toBeDefined();
  // a second tab still at revision 0: 409 with the current revision, nothing written
  const stale = await post(saveRoute, id, { baseRevision: 0, pageId: data.pageId, project: { components: data.components } });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 1 })]);
  // an unchanged canvas: no History step
  const same = await post(saveRoute, id, { baseRevision: 1, pageId: reloaded.pageId, project: { components: reloaded.components } });
  expect(await same.json()).toMatchObject({ revision: 1, ops: 0 });

  expect((await post(undoRoute, id, { baseRevision: 1 })).status).toBe(200);
  const undone = await editorData(id);
  expect(undone).toMatchObject({ revision: 2, canUndo: false, canRedo: true });
  expect(findText(undone.components, "Top")).toBeDefined();
  expect(await readFile(join(ws, "out", "index.html"), "utf8")).not.toContain("Saved title");
  expect((await post(redoRoute, id, { baseRevision: 2 })).status).toBe(200);
  expect(findText((await editorData(id)).components, "Saved title")).toBeDefined();
  // an invalid edit is refused as a whole: 400, the document untouched
  const bad = await post(saveRoute, id, { baseRevision: 3, pageId: "nope", project: { components: [] } });
  expect([bad.status, (await bad.json()).code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(3);
});

test("Lưu whose materialization fails still records the skipped style targets as Fidelity at the committed revision", async () => {
  const id = await seed();
  const ws = join(config.workspaceRoot, id);
  const data = await editorData(id);
  const top = findText(data.components, "Top")!;
  top.content = "Saved title";
  const host = (function find(cs: Comp[]): Comp | undefined {
    for (const c of cs) if (c.attributes?.["data-ir-id"] && c.components?.includes(top)) return c; else { const hit = find(c.components ?? []); if (hit) return hit; }
    return undefined;
  })(data.components)!;
  host.attributes!.id = "ihost";
  const styles = [{ selectors: ["#ihost"], style: { color: "red" }, state: "hover", mediaText: "(max-width: 767.98px)", atRuleType: "media" }];
  await mkdir(join(ws, "qa.json", "x"), { recursive: true }); // the materializer can't mark QA stale
  const saved = await post(saveRoute, id, { baseRevision: 0, pageId: data.pageId, project: { components: data.components, styles } });
  expect([saved.status, ((await saved.json()) as { code: string }).code]).toEqual([500, "DOCUMENT_MATERIALIZE_FAILED"]);
  const doc = await projectDocuments(getDb()).readDocument(id);
  expect(doc.revision).toBe(1);
  expect(doc.fidelity.filter((x) => x.feature === "style-target")).toEqual([expect.objectContaining({ status: "unsupported", nodeId: host.attributes!["data-ir-id"] })]);
});

test("Gộp layout (legacy promote URL) is a promoteLayout command: baseRevision required, stale -> 409, invalid -> 400", async () => {
  const id = await seed();
  expect((await post(promoteRoute, id, { sectionIds: ["a", "b"] })).status).toBe(400);
  const stale = await post(promoteRoute, id, { baseRevision: 5, sectionIds: ["a", "b"] });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 0 })]);
  const invalid = await post(promoteRoute, id, { baseRevision: 0, sectionIds: ["a", "b"] });
  expect([invalid.status, (await invalid.json()).code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(0);
});

test("commands route accepts the E2 component ops; private restoreSpec is refused as an unknown op", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const bad = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "restoreSpec", id: "x" }] });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { code: string }).code).toBe("VALIDATION"); // zod: unknown op
  const root = doc.sections[0]!.root.id;
  const shape = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "unwrapComponent", id: root }] });
  expect(((await shape.json()) as { code: string }).code).toBe("IR_PATCH_INVALID"); // accepted by zod, refused by the core: no component there
});

test("commands route: item ops and carousel aliases pass zod (the core judges them); restoreItems is refused", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const root = doc.sections[0]!.root.id;
  for (const command of [{ op: "addCarouselSlide", id: root, index: 0 }, { op: "moveComponentItem", id: root, itemId: root, index: 0 }, { op: "removeComponentItem", id: root, itemId: root }]) {
    const res = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [command] });
    expect(((await res.json()) as { code: string }).code).toBe("IR_PATCH_INVALID");
  }
  const bad = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "restoreItems", id: root }] });
  expect(((await bad.json()) as { code: string }).code).toBe("VALIDATION");
});

test("Lưu: a slide deleted on the canvas is refused (400 IR_PATCH_INVALID) naming the role and the panel action; nothing committed", async () => {
  const slides = ["A", "B", "C"].map((t) => el("div", [el("#text", [], t)]));
  const id = await seed(el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("section", [el("div", [el("div", slides)])])])])]));
  const doc = await projectDocuments(getDb()).loadDocument(id);
  type N = IRV2["sections"][number]["root"];
  const walk = (n: N): N[] => [n, ...n.children.flatMap(walk)];
  const all = doc.sections.flatMap((s) => walk(s.root));
  const slideNode = all.find((n) => n.children[0]?.text === "A")!;
  const track = all.find((n) => n.children.includes(slideNode))!;
  const viewport = all.find((n) => n.children.includes(track))!;
  const root = all.find((n) => n.children.includes(viewport))!;
  const convert = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "convertToComponent", id: root.id, kind: "carousel", roles: { viewport: viewport.id, track: track.id, slides: track.children.map((c) => c.id) } }] });
  expect(convert.status).toBe(200);
  const data = await editorData(id);
  const drop = (cs: Comp[]): boolean => cs.some((c, i) => (c.attributes?.["data-ir-id"] === slideNode.id ? (cs.splice(i, 1), true) : drop(c.components ?? [])));
  expect(drop(data.components)).toBe(true);
  const res = await post(saveRoute, id, { baseRevision: data.revision, pageId: data.pageId, project: { components: data.components } });
  const body = (await res.json()) as { code: string; message: string };
  expect([res.status, body.code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect(body.message).toContain(`slide ${slideNode.id} thuộc carousel ${root.id} — dùng nút Xoá trong panel Component hoặc Bỏ hành vi`);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(data.revision);
});

test("GET editor: the page's components for the panel and the 1440 capture shot", async () => {
  const id = await seed();
  const res = (await (await getEditor(id)).json()) as { interactives: unknown[]; shot: string; pageId: string };
  expect(res.interactives).toEqual([]);
  expect(res.shot).toBe(`/api/projects/${id}/files/pages/${res.pageId}/shots/1440.png`);
});
