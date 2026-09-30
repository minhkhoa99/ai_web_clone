import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { capturePage, type PageCapture, type CaptureNode } from "@/core/capture";

const site1Dir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));
const site2Dir = fileURLToPath(new URL("../fixtures/site2", import.meta.url));
const authDir = fileURLToPath(new URL("../fixtures/auth", import.meta.url));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let handle: BrowserHandle;
let site1: { url: string; close(): Promise<void> };
let site2: { url: string; close(): Promise<void> };
let authSite: { url: string; close(): Promise<void> };
let workspaceDir: string;

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site1 = await serveDir(site1Dir);
  site2 = await serveDir(site2Dir);
  authSite = await serveDir(authDir);
});

afterAll(async () => {
  await handle.close();
  await site1.close();
  await site2.close();
  await authSite.close();
});

afterEach(async () => {
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

async function freshWorkspace(): Promise<string> {
  workspaceDir = await mkdtemp(join(tmpdir(), "ai-web-clone-capture-page-"));
  return workspaceDir;
}

function findNode(node: CaptureNode, pred: (n: CaptureNode) => boolean): CaptureNode | undefined {
  if (pred(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, pred);
    if (found) return found;
  }
  return undefined;
}

test("captures site1 and writes capture.json + shots for all 3 breakpoints", async () => {
  const dir = await freshWorkspace();
  const meta = await capturePage(handle, { url: `${site1.url}/index.html`, pageId: "home", workspaceDir: dir });

  expect(meta.pageId).toBe("home");
  expect(meta.capturePath).toBe("pages/home/capture.json");
  expect(Object.keys(meta.shots).map(Number).sort((a, b) => a - b)).toEqual([375, 768, 1440]);
  expect(meta.assetBytes).toBeGreaterThanOrEqual(0);

  const raw = JSON.parse(await readFile(join(dir, meta.capturePath), "utf8")) as PageCapture;
  expect(raw.url).toBe(`${site1.url}/index.html`);
  expect(raw.pageId).toBe("home");
  expect(typeof raw.capturedAt).toBe("string");
  expect(raw.title).toBe("Site One");
  expect(raw.breakpoints.map((b) => b.bp)).toEqual([375, 768, 1440]);
  expect(raw.breakpoints[0]!.dom.tag).toBe("html");
  expect(raw.cssom.vars["--brand-color"]).toBe("#ff6600");
  expect(Array.isArray(raw.interactions)).toBe(true);
  expect(typeof raw.assets).toBe("object");
  expect(Array.isArray(raw.skippedAssets)).toBe(true);
  // Counts only: 1 <script> + 1 inline onclick, 2 iframes, 1 canvas; no script text is kept.
  expect(raw.inventory).toEqual({ scripts: 2, iframes: 2, canvases: 1, skippedNodes: 0 });
  // Unused @font-face url() (never requested by the browser) is still downloaded.
  expect(raw.assets[`${site1.url}/unused-font.woff2`]).toMatch(/^assets\/[0-9a-f]+\.woff2$/);

  for (const bp of [375, 768, 1440]) {
    const shotPath = join(dir, meta.shots[bp]!);
    expect(meta.shots[bp]).toBe(`pages/home/shots/${bp}.png`);
    const bytes = await readFile(shotPath);
    expect(bytes.subarray(0, 4)).toEqual(PNG_MAGIC);
  }
});

test("captures site2 with captured hidden interactions", async () => {
  const dir = await freshWorkspace();
  const meta = await capturePage(handle, { url: `${site2.url}/index.html`, pageId: "s2", workspaceDir: dir });
  const raw = JSON.parse(await readFile(join(dir, meta.capturePath), "utf8")) as PageCapture;

  expect(raw.interactions.length).toBeGreaterThan(0);
  expect(raw.interactions.some((i) => i.status === "captured")).toBe(true);
});

test("a page requiring login throws AUTH_REQUIRED instead of capturing", async () => {
  const dir = await freshWorkspace();
  await expect(
    capturePage(handle, { url: `${authSite.url}/login.html`, pageId: "login", workspaceDir: dir }),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("rejects an unsafe pageId without touching the browser", async () => {
  const dir = await freshWorkspace();
  const url = `${site1.url}/index.html`;
  await expect(capturePage(handle, { url, pageId: "../escape", workspaceDir: dir })).rejects.toThrow();
  await expect(capturePage(handle, { url, pageId: "a/b", workspaceDir: dir })).rejects.toThrow();
  await expect(capturePage(handle, { url, pageId: "a\\b", workspaceDir: dir })).rejects.toThrow();
});

test("a page with a CAPTCHA widget throws CAPTCHA_REQUIRED instead of capturing", async () => {
  const dir = await freshWorkspace();
  await expect(
    capturePage(handle, { url: `${authSite.url}/captcha.html`, pageId: "captcha", workspaceDir: dir }),
  ).rejects.toMatchObject({ code: "CAPTCHA_REQUIRED" });
});

test("screenshots a canvas as a dynamic asset and flags the DOM node", async () => {
  const dir = await freshWorkspace();
  const meta = await capturePage(handle, { url: `${site1.url}/index.html`, pageId: "canvas-page", workspaceDir: dir });
  const raw = JSON.parse(await readFile(join(dir, meta.capturePath), "utf8")) as PageCapture;

  expect(raw.dynamic).toHaveLength(1);
  expect(raw.dynamic[0]!.order).toBe(0);
  const assetBytes = await readFile(join(dir, raw.dynamic[0]!.asset));
  expect(assetBytes.subarray(0, 4)).toEqual(PNG_MAGIC);

  const canvasNode = findNode(raw.breakpoints[0]!.dom, (n) => n.tag === "canvas");
  expect(canvasNode?.attrs["data-dynamic"]).toBe("canvas");
});
