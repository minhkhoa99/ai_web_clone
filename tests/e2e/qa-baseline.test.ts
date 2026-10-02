// E2 §5: pixel scores of site1-3 on the QA page never drop below the pre-E2 baseline (tests/fixtures/qa-baseline.json).
// WRITE_QA_BASELINE=1 records it (run once at the pre-E2 commit); otherwise every section x bp must stay >= baseline - 0.001.
import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { emitHtml } from "@/core/emit-html";
import { buildIR } from "@/core/ir";
import { scoreSections } from "@/core/qa";
import { serveDir } from "@/core/serve";

const BASELINE = fileURLToPath(new URL("../fixtures/qa-baseline.json", import.meta.url));
const SITES = ["site1", "site2", "site3"] as const;
let handle: BrowserHandle;
let tmp = "";
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "qa-baseline-")); });
afterAll(async () => { await handle.close(); await rm(tmp, { recursive: true, force: true }); });

async function scores(site: (typeof SITES)[number]): Promise<Record<string, number>> {
  const server = await serveDir(fileURLToPath(new URL(`../fixtures/${site}`, import.meta.url)));
  try {
    const workspaceDir = join(tmp, site, "ws"), outDir = join(tmp, site, "out"), url = `${server.url}/index.html`;
    const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
    const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
    const ir = buildIR([cap]);
    await emitHtml(ir, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });
    const rows = await scoreSections(handle, { workspaceDir, outDir, ir, captures: [cap] });
    return Object.fromEntries(rows.map((r) => [`${site}/${r.sectionId}@${r.bp}`, r.score]));
  } finally {
    await server.close();
  }
}

test("site1-3: no section x bp scores below the pre-E2 baseline", { timeout: 300_000 }, async () => {
  const now: Record<string, number> = {};
  for (const site of SITES) Object.assign(now, await scores(site)); // sequential: one browser page at a time
  if (process.env.WRITE_QA_BASELINE === "1") {
    await writeFile(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  expect(existsSync(BASELINE)).toBe(true);
  const base = JSON.parse(await readFile(BASELINE, "utf8")) as Record<string, number>;
  expect(Object.keys(now).sort()).toEqual(Object.keys(base).sort());
  for (const [key, score] of Object.entries(base)) expect(now[key], key).toBeGreaterThanOrEqual(score - 0.001);
});
