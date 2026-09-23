import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { trackResponses, downloadAssets } from "@/core/assets";
import { Codes } from "@/core/errors";

const fixtureDir = fileURLToPath(new URL("../fixtures/assets-download", import.meta.url));

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };
let destDir: string;

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
});

afterAll(async () => {
  await handle.close();
  await site.close();
});

afterEach(async () => {
  if (destDir) await rm(destDir, { recursive: true, force: true });
});

async function freshDestDir() {
  destDir = await mkdtemp(join(tmpdir(), "ai-web-clone-assets-"));
  return destDir;
}

test("trackResponses records image responses and stop() detaches the listener", async () => {
  await withPage(handle, async (page) => {
    const tracker = trackResponses(page);
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    expect(tracker.urls()).toEqual([`${site.url}/logo.png`]);

    tracker.stop();
    await page.reload({ waitUntil: "load" }); // fetches logo.png again
    expect(tracker.urls()).toEqual([`${site.url}/logo.png`]); // unchanged: listener detached
  });
});

test("downloadAssets: two URLs with identical content dedupe to one file on disk", async () => {
  const dir = await freshDestDir();
  const urls = [`${site.url}/a.png`, `${site.url}/b.png`];
  const result = await downloadAssets(handle.context, urls, dir);

  expect(result.skipped).toEqual([]);
  const relA = result.assets.get(urls[0]!);
  const relB = result.assets.get(urls[1]!);
  expect(relA).toBeDefined();
  expect(relA).toBe(relB);
  expect(relA).toMatch(/^assets\/[0-9a-f]{64}\.png$/);

  const { readdir } = await import("node:fs/promises");
  expect(await readdir(dir)).toHaveLength(1);
});

test("downloadAssets: a file over the 25MB per-file cap is skipped, not thrown", async () => {
  const bigDir = await mkdtemp(join(tmpdir(), "ai-web-clone-assets-src-"));
  try {
    await writeFile(join(bigDir, "huge.bin"), Buffer.alloc(26 * 1024 * 1024, 1));
    const bigSite = await serveDir(bigDir);
    try {
      const dir = await freshDestDir();
      const result = await downloadAssets(handle.context, [`${bigSite.url}/huge.bin`], dir);
      expect(result.assets.size).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]!.code).toBe(Codes.ASSET_TOO_LARGE);
    } finally {
      await bigSite.close();
    }
  } finally {
    await rm(bigDir, { recursive: true, force: true });
  }
});

test("downloadAssets: exceeding the project budget skips remaining URLs without throwing", async () => {
  const dir = await freshDestDir();
  const result = await downloadAssets(handle.context, [`${site.url}/a.png`, `${site.url}/b.png`], dir, {
    budgetBytes: 10, // smaller than a single (identical, ~75-byte) asset
  });

  expect(result.assets.size).toBe(0);
  expect(result.skipped).toHaveLength(2);
  for (const s of result.skipped) expect(s.code).toBe(Codes.PROJECT_SIZE_LIMIT);
  expect(result.bytes).toBe(0);
});

test("downloadAssets: a 404 is skipped, not thrown, and other downloads still succeed", async () => {
  const dir = await freshDestDir();
  const urls = [`${site.url}/missing.png`, `${site.url}/logo.png`];
  const result = await downloadAssets(handle.context, urls, dir);

  expect(result.assets.get(urls[1]!)).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
  expect(result.assets.has(urls[0]!)).toBe(false);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]!.url).toBe(urls[0]);
  expect(result.skipped[0]!.reason).toContain("404");
});

test("downloadAssets: an <img src=/x.html> answered as octet-stream (or html/js) is stored as .bin, never .html/.js", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const type = req.url === "/x.html" ? "application/octet-stream" : req.url === "/y.js" ? "text/javascript" : "text/html";
    res.writeHead(200, { "content-type": type }).end(`<script>/*${req.url}*/</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const urls = [`${base}/x.html`, `${base}/y.js`, `${base}/z.css`];
    const result = await downloadAssets(handle.context, urls, await freshDestDir());
    expect(result.skipped).toEqual([]);
    for (const url of urls) expect(result.assets.get(url)).toMatch(/^assets\/[0-9a-f]{64}\.bin$/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
