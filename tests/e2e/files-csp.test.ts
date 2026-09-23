// The files route's CSP in a real browser: an emitted page runs our runtime.js and nothing else, even when a
// "disguised" script sits in out/assets (e.g. an HTML/JS response saved under a media URL).
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { config } from "@/core/config";
import { createProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import * as files from "@/app/api/projects/[id]/files/[...path]/route";

let server: Server;
let base = "";
let browser: Browser;
let id = "";
const sha = "d".repeat(64);

beforeAll(async () => {
  id = createProject(getDb(), { url: "https://example.com/", mode: "single", config: {} });
  const out = join(config.workspaceRoot, id, "out");
  await mkdir(join(out, "assets"), { recursive: true });
  await mkdir(join(out, "js"), { recursive: true });
  await writeFile(
    join(out, "index.html"),
    `<!DOCTYPE html><html><head><script src="js/runtime.js"></script><script src="assets/${sha}.js"></script><script src="assets/${sha}.bin"></script></head>` +
      `<body><script>document.documentElement.dataset.inline = "1"</script><iframe src="assets/${sha}.svg"></iframe></body></html>`,
  );
  await writeFile(join(out, "js", "runtime.js"), `document.documentElement.dataset.runtime = "1";`);
  await writeFile(join(out, "assets", `${sha}.js`), `document.documentElement.dataset.asset = "1";`);
  await writeFile(join(out, "assets", `${sha}.bin`), `document.documentElement.dataset.bin = "1";`);
  await writeFile(join(out, "assets", `${sha}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><script>parent.document.documentElement.dataset.svg = "1"</script></svg>`);
  // node:http -> the route handler, exactly as Next would call it
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const m = /^\/api\/projects\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
      if (!m) return void res.writeHead(404).end();
      const r = await files.GET(new Request(url, { headers: { host: req.headers.host ?? "" } }), {
        params: Promise.resolve({ id: m[1]!, path: m[2]!.split("/").map(decodeURIComponent) }),
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

test("an out/ page runs js/runtime.js only: asset scripts, .bin, inline script and SVG script are all blocked", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/api/projects/${id}/files/out/index.html`, { waitUntil: "load" });
  const flags = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  expect(flags).toEqual({ runtime: "1" });
  // opened directly, an asset document is sandboxed: its script never runs
  const svg = await browser.newPage();
  const res = await svg.goto(`${base}/api/projects/${id}/files/out/assets/${sha}.svg`);
  expect(res?.headers()["content-security-policy"]).toContain("sandbox");
  await page.close();
  await svg.close();
});
