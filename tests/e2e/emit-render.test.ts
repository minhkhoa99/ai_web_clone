import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type CaptureNode, type PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import { emitHtml, renderSite, renderSiteV2 } from "@/core/emit-html";
import { migrateIR } from "@/core/ir-migrate";

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
function findById(node: CaptureNode, id: string): CaptureNode | undefined {
  if (node.attrs.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return undefined;
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

test("re-emit replaces outDir: stale files from a previous emit are gone", async () => {
  const outDir = join(tmp, "stale-out");
  await mkdir(join(outDir, "assets"), { recursive: true });
  await writeFile(join(outDir, "old-page.html"), "stale");
  await writeFile(join(outDir, "assets", "old.png"), "stale");
  await emitHtml(buildIR([menuCapture()]), { outDir, workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  expect((await readdir(outDir)).sort()).toEqual(["css", "index.html", "js"]);
  const wipesWorkspace = { outDir: tmp, workspaceDir: join(tmp, "ws"), assetMap: {}, pageUrls: {} };
  await expect(emitHtml(buildIR([menuCapture()]), wipesWorkspace)).rejects.toThrow(/must not contain workspaceDir/);
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

    // Post-hero blocks sit where the original put them (no margin-collapse shift).
    const dom = cap.breakpoints.find((b) => b.bp === 1440)!.dom;
    for (const id of ["features", "contact"]) {
      const [x, y, w, h] = findById(dom, id)!.bbox;
      const clone = (await page.locator(`#${id}`).boundingBox())!;
      for (const [a, b] of [[x, clone.x], [y, clone.y], [w, clone.width], [h, clone.height]] as const) expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    }
  });
});

test("site1: v2 emit renders the same text, attributes and computed styles as v1 at 1440/768/375", async () => {
  const workspaceDir = join(tmp, "ws-v2");
  const url = `${await serve(site1Dir)}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  const v1 = buildIR([cap]);
  const v2 = migrateIR(v1, [cap]);
  const opts = { assetMap: cap.assets, pageUrls: { home: url } };
  const [dirV1, dirV2] = [join(tmp, "site1-v1"), join(tmp, "site1-v2")];
  await emitHtml(v1, { ...opts, outDir: dirV1, workspaceDir });
  await emitHtml(v1, { ...opts, outDir: dirV2, workspaceDir });
  const v2Files = renderSiteV2(v2, opts);
  expect(Object.keys(v2Files).sort()).toEqual(Object.keys(renderSite(v1, opts)).sort());
  for (const [rel, text] of Object.entries(v2Files)) await writeFile(join(dirV2, rel), text);
  const [baseV1, baseV2] = [await serve(dirV1), await serve(dirV2)];

  // Per element: own text, attributes (order-free, class names excluded) and every computed style property.
  const snapshot = (page: Page) =>
    page.$$eval("[data-ir-id]", (els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return {
          id: el.getAttribute("data-ir-id"),
          text: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""),
          attrs: [...el.attributes].filter((a) => a.name !== "class").map((a) => `${a.name}=${a.value}`).sort(),
          style: [...cs].map((prop) => `${prop}:${cs.getPropertyValue(prop)}`),
        };
      }),
    );
  for (const width of [1440, 768, 375]) {
    const shots = [];
    for (const base of [baseV1, baseV2]) {
      shots.push(
        await withPage(handle, async (page) => {
          await page.setViewportSize({ width, height: 900 });
          expect(await loadCollectingErrors(page, `${base}/index.html`)).toEqual([]);
          return snapshot(page);
        }),
      );
    }
    expect(shots[0]!.length).toBeGreaterThan(10);
    expect(shots[1]).toEqual(shots[0]);
  }
});
