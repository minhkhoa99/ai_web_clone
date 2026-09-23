import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type PageCapture } from "@/core/capture";
import { applyPatch, buildIR } from "@/core/ir";
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
  const patched = applyPatch(ir, [{ op: "setStyle", id: hero.root.id, style: { "background-color": "rgb(255, 0, 0)" } }]);
  await emitHtml(patched, emitOpts);
  const after = new Map((await scoreSections(handle, { workspaceDir, outDir, ir: patched, captures: [cap] })).map((s) => [key(s), s.score]));

  for (const s of before) {
    const now = after.get(key(s))!;
    if (s.sectionId === hero.id) expect(now).toBeLessThan(s.score);
    else expect(Math.abs(now - s.score)).toBeLessThanOrEqual(0.001);
  }
});
