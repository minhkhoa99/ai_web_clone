// E1 Task 8: thin command/Undo/Redo routes over the document store, and the out/ gate on the files route.
import { afterAll, expect, test, vi } from "vitest";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import * as files from "@/app/api/projects/[id]/files/[...path]/route";
import * as assetsRoute from "@/app/api/projects/[id]/assets/route";
import { canvasUrlsFor } from "@/app/_server/editor";

// a queued/active job, as the session guards see it (a real queue would start a browser pipeline)
const busy = vi.hoisted(() => new Set<string>());
vi.mock("@/core/jobs", async (orig) => {
  const real = await orig<typeof import("@/core/jobs")>();
  return { ...real, isQueuedOrActive: (id: string) => busy.has(id) || real.isQueuedOrActive(id) };
});

// forces affectedOf to throw after a committed step (withAffected must fall back to a page reload)
const failAffected = vi.hoisted(() => ({ on: false }));
vi.mock("@/core/editor-canvas", async (orig) => {
  const real = await orig<typeof import("@/core/editor-canvas")>();
  return { ...real, affectedOf: (...a: Parameters<typeof real.affectedOf>) => { if (failAffected.on) throw new Error("boom"); return real.affectedOf(...a); } };
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

test("Gộp layout is the promoteLayout command through the commands route: stale -> 409, invalid -> 400; the old save / promote-layout URLs are gone", async () => {
  const id = await seed();
  const stale = await post(commandsRoute, id, { baseRevision: 5, commands: [{ op: "promoteLayout", sectionIds: ["a", "b"] }] });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 0 })]);
  const invalid = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "promoteLayout", sectionIds: ["a", "b"] }] });
  expect([invalid.status, (await invalid.json()).code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(0);
  const { existsSync } = await import("node:fs");
  expect(existsSync("src/app/api/projects/[id]/editor/save/route.ts") || existsSync("src/app/api/projects/[id]/editor/promote-layout/route.ts")).toBe(false);
});

test("deleting a carousel slide through commands is refused naming the role and the panel action; nothing committed", async () => {
  const slides = ["A", "B", "C"].map((t) => el("div", [el("#text", [], t)]));
  const id = await seed(el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("section", [el("div", [el("div", slides)])])])])]));
  const doc = await projectDocuments(getDb()).loadDocument(id);
  type N = IRV2["sections"][number]["root"];
  const walkN = (x: N): N[] => [x, ...x.children.flatMap(walkN)];
  const all = doc.sections.flatMap((s) => walkN(s.root));
  const slideNode = all.find((x) => x.children[0]?.text === "A")!;
  const track = all.find((x) => x.children.includes(slideNode))!;
  const viewport = all.find((x) => x.children.includes(track))!;
  const root = all.find((x) => x.children.includes(viewport))!;
  expect((await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "convertToComponent", id: root.id, kind: "carousel", roles: { viewport: viewport.id, track: track.id, slides: track.children.map((c) => c.id) } }] })).status).toBe(200);
  const res = await post(commandsRoute, id, { baseRevision: doc.revision + 1, commands: [{ op: "deleteNode", id: slideNode.id }] });
  const body = (await res.json()) as { code: string; message: string };
  expect([res.status, body.code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect(body.message).toContain(`slide ${slideNode.id} thuộc carousel ${root.id} — dùng nút Xoá trong panel Component hoặc Bỏ hành vi`);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(doc.revision + 1);
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

test("GET editor: the page's components for the panel and the 1440 capture shot", async () => {
  const id = await seed();
  const res = (await (await getEditor(id)).json()) as { interactives: unknown[]; shot: string; page: { id: string } };
  expect(res.interactives).toEqual([]);
  expect(res.shot).toBe(`/api/projects/${id}/files/pages/${res.page.id}/shots/1440.png`);
});

test("E3 §5: setName passes zod and commits; a non-string name is a 400 VALIDATION", async () => {
  const id = await seed();
  const root = await rootId(id);
  const ok = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "setName", id: root, name: "Đầu trang" }] });
  expect([ok.status, await ok.json()]).toEqual([200, { revision: 1, createdIds: [], canUndo: true, canRedo: false }]);
  expect((await projectDocuments(getDb()).loadDocument(id)).sections[0]!.root.name).toBe("Đầu trang");
  const bad = await post(commandsRoute, id, { baseRevision: 1, commands: [{ op: "setName", id: root, name: 5 }] });
  expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "VALIDATION"]);
});

const upload = (id: string, form: FormData, headers: Record<string, string> = { origin: "http://127.0.0.1" }) =>
  assetsRoute.POST(new Request("http://127.0.0.1/api/projects/x/assets", { method: "POST", body: form, headers }), { params: Promise.resolve({ id }) });
const fileForm = (...files: File[]) => { const f = new FormData(); for (const x of files) f.append("file", x); return f; };
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("E3 §5 upload: one image per request -> { key, url }; served inert; an <img> naming the key is emitted with the local file", async () => {
  const id = await seed();
  const res = await upload(id, fileForm(new File([PNG_BYTES], "logo.png", { type: "image/png" })));
  expect(res.status).toBe(200);
  const { key, url } = (await res.json()) as { key: string; url: string };
  expect(key).toMatch(/^https:\/\/upload\.aiwc\.invalid\/[0-9a-f]{64}\.png$/);
  expect(url).toMatch(new RegExp(`^/api/projects/${id}/files/assets/[0-9a-f]{64}\.png$`));
  const rel = url.split("/files/")[1]!;
  const served = await getFile(id, ...rel.split("/"));
  expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(served.headers.get("content-security-policy")).toContain("sandbox");
  expect((await getFile(id, "assets", "x.html")).status).toBe(404);
  const root = await rootId(id);
  const created = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "createNode", parentId: root, index: 0, draft: { tag: "img", attrs: { src: key, alt: "logo" } } }] });
  expect(created.status).toBe(200);
  expect(await readFile(join(config.workspaceRoot, id, "out", "index.html"), "utf8")).toContain(`src="${rel}"`);
  expect(await readFile(join(config.workspaceRoot, id, "out", rel))).toEqual(PNG_BYTES);
});

test("E3 §5 upload guards: no Origin or a JSON body -> 403; two files, no file, a disguised file -> 400; a busy project -> 409", async () => {
  const id = await seed();
  const png = () => new File([PNG_BYTES], "a.png");
  expect((await upload(id, fileForm(png()), {})).status).toBe(403);
  expect((await upload(id, fileForm(png()), { origin: "http://evil.test" })).status).toBe(403);
  expect((await post(assetsRoute, id, { file: "x" })).status).toBe(403);
  const fake = await upload(id, fileForm(new File(["hello"], "a.png")));
  expect([fake.status, ((await fake.json()) as { code: string }).code]).toEqual([400, "UPLOAD_INVALID"]);
  expect((await upload(id, fileForm(png(), png()))).status).toBe(400);
  expect((await upload(id, new FormData())).status).toBe(400);
  busy.add(id);
  try { expect((await upload(id, fileForm(png()))).status).toBe(409); } finally { busy.delete(id); }
});

test("E3 §5 upload: an opaque/foreign Origin, a non-loopback Host, a non-multipart body and an oversized body are refused; a sanitized svg is served inert", async () => {
  const id = await seed();
  const png = () => new File([PNG_BYTES], "a.png");
  expect((await upload(id, fileForm(png()), { origin: "null" })).status).toBe(403);
  expect((await upload(id, fileForm(png()), { origin: "http://127.0.0.1:9999" })).status).toBe(403); // another local port is another origin
  expect((await upload(id, fileForm(png()), { origin: "http://evil.test", host: "evil.test" })).status).toBe(403);
  const text = await assetsRoute.POST(
    new Request("http://127.0.0.1/", { method: "POST", body: "file=x", headers: { origin: "http://127.0.0.1", "content-type": "application/x-www-form-urlencoded" } }),
    { params: Promise.resolve({ id }) },
  );
  expect(text.status).toBe(403);
  // raw multipart bytes (a FormData body source keeps enqueuing after the cap cancels it — an in-process artifact)
  const head = '--b\r\ncontent-disposition: form-data; name="file"; filename="a.png"\r\ncontent-type: image/png\r\n\r\n';
  const bigBody = Buffer.concat([Buffer.from(head), PNG_BYTES, Buffer.alloc(25 * 1024 * 1024 + 64 * 1024), Buffer.from("\r\n--b--\r\n")]);
  const big = await assetsRoute.POST(
    new Request("http://127.0.0.1/", { method: "POST", body: bigBody, headers: { origin: "http://127.0.0.1", "content-type": "multipart/form-data; boundary=b" } }),
    { params: Promise.resolve({ id }) },
  );
  expect([big.status, ((await big.json()) as { code: string }).code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
  expect(await readdir(join(config.workspaceRoot, id, "assets")).catch(() => [])).toEqual([]);
  const svg = await upload(id, fileForm(new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'], "../../x.svg", { type: "text/html" })));
  const { url } = (await svg.json()) as { url: string };
  const served = await getFile(id, ...url.split("/files/")[1]!.split("/"));
  expect([served.headers.get("content-type"), served.headers.get("content-security-policy")?.startsWith("sandbox;")]).toEqual(["image/svg+xml", true]);
  expect(await served.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
});

type AffectedBody = { revision: number; affected: { sections: { id: string; html: string; root: { id: string } }[]; css: string; shellChanged: boolean; interactives: unknown[] } };

test("E3 §5: commands / Undo with pageId return the changed sections (html + resolved root), the stylesheet and the panel components; without it the response is unchanged", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const section = doc.sections[0]!, root = section.root.id;
  const res = await post(commandsRoute, id, { baseRevision: 0, pageId: "home", commands: [{ op: "setStyle", id: root, target: "base", changes: { color: "rgb(1, 2, 3)" } }] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as AffectedBody;
  expect(body.revision).toBe(1);
  expect(body.affected.shellChanged).toBe(false);
  expect(body.affected.sections.map((s) => s.id)).toEqual([section.id]);
  expect(body.affected.sections[0]!.html).toContain(`data-ir-id="${root}"`);
  expect(body.affected.sections[0]!.root.id).toBe(root);
  expect(body.affected.css).toContain("color:rgb(1, 2, 3)");
  expect(body.affected.interactives).toEqual([]);
  const undo = (await (await post(undoRoute, id, { baseRevision: 1, pageId: "home" })).json()) as AffectedBody;
  expect(undo.affected.sections.map((s) => s.id)).toEqual([section.id]);
  expect(undo.affected.css).not.toContain("rgb(1, 2, 3)");
  const plain = await post(commandsRoute, id, { baseRevision: 2, commands: [{ op: "setName", id: root, name: "Đầu trang" }] });
  expect(await plain.json()).toEqual({ revision: 3, createdIds: [], canUndo: true, canRedo: false });
  expect((await post(commandsRoute, id, { baseRevision: 3, pageId: "", commands: [{ op: "setName", id: root, name: "x" }] })).status).toBe(400);
  expect((await post(redoRoute, id, { baseRevision: 3, pageId: 7 })).status).toBe(400);
});

test("E3 §5: Redo with pageId returns affected; a stale step keeps 409 STALE_REVISION + revision and no affected; an unknown pageId only reloads", async () => {
  const id = await seed();
  const root = await rootId(id);
  await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "setStyle", id: root, target: "base", changes: { color: "rgb(4, 5, 6)" } }] });
  await post(undoRoute, id, { baseRevision: 1 });
  const redo = await post(redoRoute, id, { baseRevision: 2, pageId: "home" });
  expect(redo.status).toBe(200);
  expect(((await redo.json()) as AffectedBody).affected.css).toContain("color:rgb(4, 5, 6)");
  const stale = await post(commandsRoute, id, { baseRevision: 0, pageId: "home", commands: [{ op: "setName", id: root, name: "x" }] });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 3 })]);
  const other = (await (await post(commandsRoute, id, { baseRevision: 3, pageId: "nope", commands: [{ op: "setName", id: root, name: "y" }] })).json()) as AffectedBody;
  expect(other.affected).toMatchObject({ sections: [], shellChanged: true });
});

test("E3 §5: GET editor adds the canvas page (html + resolved tree), css, fonts, effects, pages and the asset library; the old editor payload is gone", async () => {
  const id = await seed();
  const res = await editorRoute.GET(new Request("http://127.0.0.1/api/projects/x/editor?page=home"), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { page: { id: string; file: string; html: string; shell: { tag: string }; sections: { id: string; root: { id: string } }[] }; css: string; fonts: string[]; effects: string[]; pages: unknown[]; assets: unknown[]; components: unknown[] };
  expect(data.page.id).toBe("home");
  expect(data.page.file).toBe("index.html");
  expect(data.page.html).toContain(`<base href="http://127.0.0.1/api/projects/${id}/files/out/index.html">`);
  expect(data.page.html).toContain(`<script src="http://127.0.0.1/api/projects/${id}/files/out/js/runtime.js?edit=1"></script>`);
  expect(data.page.html).toContain("<style data-aiwc-css></style>");
  expect(data.page.shell.tag).toBe("html");
  expect(data.page.sections.length).toBeGreaterThan(0);
  expect(data.page.html).toContain(`data-ir-id="${data.page.sections[0]!.root.id}"`);
  expect(typeof data.css).toBe("string");
  expect(data.effects).toEqual(expect.arrayContaining(["sp1-fade-in"]));
  expect([Array.isArray(data.fonts), Array.isArray(data.assets), data.pages.length]).toEqual([true, true, 1]);
  expect(data).not.toHaveProperty("components"); // the old editor payload is gone (E3b R15)
  expect((data as unknown as { allSections: { id: string; pageId: string }[] }).allSections.length).toBeGreaterThan(0);
});

test("E3 §5: the canvas urls come only from a bare loopback Host (port kept); a Host smuggling a path / userinfo / CSP separator is refused before the canvas is built", async () => {
  const id = await seed();
  const get = (host: string) => editorRoute.GET(new Request("http://127.0.0.1/api/projects/x/editor", { headers: { host } }), { params: Promise.resolve({ id }) });
  const ok = (await (await get("localhost:3000")).json()) as { page: { html: string } };
  expect(ok.page.html).toContain(`<script src="http://localhost:3000/api/projects/${id}/files/out/js/runtime.js?edit=1"></script>`);
  expect(ok.page.html).toContain(`script-src http://localhost:3000/api/projects/${id}/files/out/js/runtime.js;`);
  for (const host of ["127.0.0.1/x;script-src *", "evil@localhost", "localhost:3000/a b", "localhost?x;y", "localhost#;"]) {
    const res = await get(host);
    expect([host, res.status, ((await res.json()) as { code: string }).code]).toEqual([host, 403, "FORBIDDEN"]);
  }
  expect(() => canvasUrlsFor(new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1/x;script-src *" } }), id)).toThrow();
  expect(canvasUrlsFor(new Request("http://127.0.0.1/"), "a'b(c)")("index.html").runtime).toBe("http://127.0.0.1/api/projects/a%27b%28c%29/files/out/js/runtime.js?edit=1");
});

test("E3 §5: an uploaded SVG reaches the canvas only by URL (css url() → assets/<sha>.svg), never inlined into the document", async () => {
  const id = await seed();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
  const { key } = (await (await upload(id, fileForm(new File([svg], "dot.svg", { type: "image/svg+xml" })))).json()) as { key: string };
  const root = await rootId(id);
  const res = await post(commandsRoute, id, { baseRevision: 0, pageId: "home", commands: [{ op: "setStyle", id: root, target: "base", changes: { "background-image": `url("${key}")` } }] });
  const { affected } = (await res.json()) as AffectedBody;
  const file = key.slice(key.lastIndexOf("/") + 1);
  expect(affected.css).toContain(`assets/${file}`);
  expect(affected.css).not.toContain("<rect");
  const data = (await (await getEditor(id)).json()) as { page: { html: string }; css: string; assets: { key: string }[] };
  expect(data.css).toContain(`assets/${file}`);
  expect(data.page.html).not.toMatch(/<svg|<rect/);
  expect(data.assets.map((a) => a.key)).toContain(key);
});

test("E3 §5: affected failing after the step committed is not a 500: 200 with the committed revision and a page reload (shellChanged)", async () => {
  const id = await seed();
  const root = await rootId(id);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failAffected.on = true;
  try {
    const res = await post(commandsRoute, id, { baseRevision: 0, pageId: "home", commands: [{ op: "setName", id: root, name: "x" }] });
    expect([res.status, await res.json()]).toEqual([200, { revision: 1, createdIds: [], canUndo: true, canRedo: false, affected: { sections: [], css: "", shellChanged: true, interactives: [] } }]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    failAffected.on = false;
    log.mockRestore();
  }
  expect((await projectDocuments(getDb()).loadDocument(id)).revision).toBe(1);
});

test("E3b R3: commands route accepts coalesce and folds a repeated style edit into one History step", async () => {
  const id = await seed();
  const root = await rootId(id);
  const color = (c: string) => [{ op: "setStyle", id: root, target: "base", changes: { color: c } }];
  expect((await post(commandsRoute, id, { baseRevision: 0, commands: color("red") })).status).toBe(200);
  expect((await post(commandsRoute, id, { baseRevision: 1, commands: color("blue"), coalesce: true })).status).toBe(200);
  expect((await post(undoRoute, id, { baseRevision: 2 })).status).toBe(200);
  expect((await projectDocuments(getDb()).loadDocument(id)).sections[0]!.root.styles.base.color).toBeUndefined();
  expect((await post(commandsRoute, id, { baseRevision: 3, commands: color("x"), coalesce: "yes" })).status).toBe(400);
});
