// Hardening spec §2: QA never waits on a font or request that never answers.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { emitHtml } from "@/core/emit-html";
import { buildIR } from "@/core/ir";
import { prepareClonePage, scoreSections } from "@/core/qa";
import { serveDir } from "@/core/serve";

const site1Dir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));

let handle: BrowserHandle;
let tmp: string;
let cap: PageCapture;

// The capture (the slow part) happens here so the tests' own 30 s bounds only cover the QA side.
beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  tmp = await mkdtemp(join(tmpdir(), "ai-web-clone-qa-hang-"));
  const site = await serveDir(site1Dir);
  try {
    const meta = await capturePage(handle, { url: `${site.url}/index.html`, pageId: "home", workspaceDir: join(tmp, "ws") });
    cap = JSON.parse(await readFile(join(tmp, "ws", meta.capturePath), "utf8")) as PageCapture;
  } finally {
    await site.close();
  }
});

afterAll(async () => {
  await handle.close();
  await rm(tmp, { recursive: true, force: true });
});

// Answers `pages` right away; every other request hangs until the server closes.
async function hangingServer(pages: Record<string, string> = {}): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const html = pages[(req.url ?? "").split("?")[0]!]; // the clone is loaded with ?qa=1
    if (html !== undefined) res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

test("prepareClonePage: a same-origin font that never loads stops blocking after the 10 s fonts cap", { timeout: 30_000 }, async () => {
  const html = `<!doctype html><p style="font-family:Hang">x</p><script>
addEventListener("load", () => { const f = new FontFace("Hang", "url(/hang.woff2)"); document.fonts.add(f); f.load().catch(() => {}); });
</script>`;
  const server = await hangingServer({ "/": html });
  try {
    const t0 = Date.now();
    const status = await withPage(handle, async (page) => {
      await prepareClonePage(page, `${server.base}/`, 1440);
      return page.evaluate(() => document.fonts.status);
    });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(status).toBe("loading"); // the font really never loaded: the cap, not the font, ended the wait
  } finally {
    await server.close();
  }
});

test("scoring: the clone's requests off its own server (a hanging font + image) are aborted, scoring completes", { timeout: 30_000 }, async () => {
  const other = await hangingServer();
  try {
    const workspaceDir = join(tmp, "ws");
    const outDir = join(tmp, "out");
    const ir = buildIR([cap]);
    await emitHtml(ir, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: cap.url } });
    const index = join(outDir, "index.html");
    const live = `<style>@font-face{font-family:Live;src:url(${other.base}/x.woff2)}body{font-family:Live}</style><img src="${other.base}/x.png" alt="">`;
    await writeFile(index, (await readFile(index, "utf8")).replace("</body>", `${live}</body>`));

    const t0 = Date.now();
    const scores = await scoreSections(handle, { workspaceDir, outDir, ir, captures: [cap], bps: [1440] });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(scores.length).toBe(ir.sections.length);
  } finally {
    await other.close();
  }
});
