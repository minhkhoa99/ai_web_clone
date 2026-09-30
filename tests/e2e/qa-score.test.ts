import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { applyCommands } from "@/core/ir-command";
import { emitHtml } from "@/core/emit-html";
import { scoreSections, type SectionScore } from "@/core/qa";

const site1Dir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));

let handle: BrowserHandle;
let tmp: string;
let server: { url: string; close(): Promise<void> };

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  tmp = await mkdtemp(join(tmpdir(), "ai-web-clone-qa-"));
  server = await serveDir(site1Dir);
});

afterAll(async () => {
  await handle.close();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

const key = (s: SectionScore) => `${s.pageId}/${s.sectionId}@${s.bp}`;

test("site1: every section x bp is scored with files on disk; a recolored section drops, the rest stay put", async () => {
  const workspaceDir = join(tmp, "ws");
  const outDir = join(tmp, "out");
  const url = `${server.url}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  const emitOpts = { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } };
  const ir = buildIR([cap]);
  await emitHtml(ir, emitOpts);

  const before = await scoreSections(handle, { workspaceDir, outDir, ir, captures: [cap] });
  expect(before.map(key).sort()).toEqual(ir.sections.flatMap((s) => [375, 768, 1440].map((bp) => `home/${s.id}@${bp}`)).sort());
  for (const s of before) {
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
    for (const rel of [s.origPath, s.clonePath, s.heatPath]) await access(join(workspaceDir, rel!));
  }

  const hero = ir.sections.find((s) => JSON.stringify(s.root).includes("Build faster sites"))!;
  const patched = applyCommands(ir, [{ op: "setStyle", id: hero.root.id, target: "base", changes: { "background-color": "rgb(255, 0, 0)" } }]).ir;
  await emitHtml(patched, emitOpts);
  const after = new Map((await scoreSections(handle, { workspaceDir, outDir, ir: patched, captures: [cap] })).map((s) => [key(s), s.score]));

  for (const s of before) {
    const now = after.get(key(s))!;
    if (s.sectionId === hero.id) expect(now).toBeLessThan(s.score);
    else expect(Math.abs(now - s.score)).toBeLessThanOrEqual(0.001);
  }

  // Clone without data-ir-id (every root missing) + a capture with the footer gone (unresolvable at every bp).
  const footer = ir.sections.find((s) => s.root.tag === "footer")!;
  const drop = (dom: PageCapture["breakpoints"][number]["dom"]) => {
    const body = dom.children.find((c) => c.tag === "body")!;
    return { ...dom, children: dom.children.map((c) => (c === body ? { ...body, children: body.children.slice(0, body.children.findIndex((k) => k.tag === "footer")) } : c)) };
  };
  const trimmed: PageCapture = { ...cap, breakpoints: cap.breakpoints.map((b) => ({ ...b, dom: drop(b.dom) })) };
  await emitHtml(ir, { ...emitOpts, stripIds: true });
  const broken = await scoreSections(handle, { workspaceDir, outDir, ir, captures: [trimmed], bps: [1440], sectionIds: [hero.id, footer.id] });
  expect(broken).toEqual([
    expect.objectContaining({ sectionId: hero.id, score: 0, clonePath: null, bboxDelta: 0 }),
    expect.objectContaining({ sectionId: footer.id, score: 0, origPath: null, heatPath: null, clonePath: null, bboxDelta: 0 }),
  ]);
});

// Hardening spec §8: a 0-height clone crop was written as a PNG, and reading it back ("bad png - invalid inflate
// data") failed the project. A zero-area crop is scored as before but never written: its path is null.
test("a section whose clone box has zero height: no clone PNG written, clonePath null, still scored", async () => {
  const workspaceDir = join(tmp, "ws0");
  const outDir = join(tmp, "out0");
  const url = `${server.url}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  const ir = buildIR([cap]);
  const hero = ir.sections.find((s) => JSON.stringify(s.root).includes("Build faster sites"))!;
  const flat = { height: "0px", "min-height": "0px", "padding-top": "0px", "padding-bottom": "0px", "border-width": "0px", overflow: "hidden" };
  const squashed = applyCommands(ir, [{ op: "setStyle", id: hero.root.id, target: "base", changes: flat }]).ir;
  await emitHtml(squashed, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });

  const [row] = await scoreSections(handle, { workspaceDir, outDir, ir: squashed, captures: [cap], bps: [1440], sectionIds: [hero.id] });
  expect(row).toMatchObject({ sectionId: hero.id, bp: 1440, clonePath: null });
  expect(row!.score).toBeGreaterThanOrEqual(0);
  expect(row!.score).toBeLessThan(0.95);
  await expect(access(join(workspaceDir, "qa", "home", hero.id, "1440-clone.png"))).rejects.toThrow();
  for (const rel of [row!.origPath, row!.heatPath]) await access(join(workspaceDir, rel!)); // the non-empty ones still are
});
