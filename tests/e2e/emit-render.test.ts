import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type CaptureNode, type PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { emitHtml } from "@/core/emit-html";

const site1Dir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));

let handle: BrowserHandle;
let tmp: string;
const servers: { close(): Promise<void> }[] = [];

// Servers close only after the browser: server.close() waits on Chromium's keep-alive sockets.
async function serve(dir: string): Promise<string> {
  const server = await serveDir(dir);
  servers.push(server);
  return server.url;
}

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  tmp = await mkdtemp(join(tmpdir(), "ai-web-clone-emit-"));
});

afterAll(async () => {
  await handle.close();
  await Promise.all(servers.map((s) => s.close()));
  await rm(tmp, { recursive: true, force: true });
});

function el(tag: string, attrs: Record<string, string>, children: CaptureNode[], style: Record<string, string> = {}): CaptureNode {
  return { tag, attrs, bbox: [0, 0, 100, 20], style, children };
}
const txt = (text: string): CaptureNode => ({ tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] });

function menuCapture(): PageCapture {
  const dom = el("html", {}, [
    el("head", {}, []),
    el("body", {}, [
      el("nav", {}, [
        el("button", { id: "menu", "aria-controls": "drop" }, [txt("Menu")]),
        el("ul", { id: "drop" }, [el("li", {}, [txt("Item")])], { display: "none" }),
      ]),
    ]),
  ]);
  return {
    url: "https://x.test/",
    pageId: "home",
    capturedAt: "2026-09-23T00:00:00.000Z",
    title: "Menu",
    meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: ([375, 768, 1440] as const).map((bp) => ({ bp, dom, truncated: false })),
    interactions: [{ id: "ix-menu", kind: "menu", trigger: "#menu", status: "captured" }],
    assets: {},
    skippedAssets: [],
    dynamic: [],
  };
}

// Loads `url`, returns console errors / page errors seen until load settles.
async function loadCollectingErrors(page: Page, url: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(url, { waitUntil: "load" });
  return errors;
}

test("emitted menu page: no console errors (http + file://), runtime toggles the menu", async () => {
  const outDir = join(tmp, "menu-out");
  await emitHtml(buildIR([menuCapture()]), { outDir, workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  expect((await stat(join(outDir, "js/runtime.js"))).size).toBeLessThan(3_500);
  const base = await serve(outDir);

  await withPage(handle, async (page) => {
    expect(await loadCollectingErrors(page, `${base}/index.html`)).toEqual([]);
    const drop = page.locator("#drop");
    await expect.poll(() => drop.isVisible()).toBe(false);
    await page.click("#menu");
    await expect.poll(() => drop.isVisible()).toBe(true);
    expect(await page.getAttribute("#menu", "aria-expanded")).toBe("true");
    await page.click("#menu");
    await expect.poll(() => drop.isVisible()).toBe(false);
  });
  await withPage(handle, async (page) => {
    expect(await loadCollectingErrors(page, pathToFileURL(join(outDir, "index.html")).href)).toEqual([]);
    await page.click("#menu");
    await expect.poll(() => page.locator("#drop").isVisible()).toBe(true);
  });
});

test("round trip: capture site1 -> buildIR -> emitHtml renders with no console errors", async () => {
  const workspaceDir = join(tmp, "ws");
  const outDir = join(tmp, "site1-out");
  const url = `${await serve(site1Dir)}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  await emitHtml(buildIR([cap]), { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });
  const base = await serve(outDir);

  await withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await loadCollectingErrors(page, `${base}/index.html`)).toEqual([]);
    await expect.poll(() => page.locator("h1").textContent()).toBe("Build faster sites");
    expect(await page.locator("h1").evaluate((h) => getComputedStyle(h).color)).toBe("rgb(200, 30, 60)");
    expect(await page.getByText("Hidden promo").isVisible()).toBe(false);
    expect(await page.locator("img[data-dynamic=canvas]").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });
});
