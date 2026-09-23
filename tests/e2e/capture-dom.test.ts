import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { snapshotDom, type CaptureNode } from "@/core/capture";

const fixtureDir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };
let root: CaptureNode;

function snapshotOf(path: string): Promise<CaptureNode> {
  return withPage(handle, async (page) => {
    await page.goto(`${site.url}/${path}`, { waitUntil: "load" });
    return snapshotDom(page);
  });
}

function findAll(node: CaptureNode, pred: (n: CaptureNode) => boolean, out: CaptureNode[] = []): CaptureNode[] {
  if (pred(node)) out.push(node);
  for (const child of node.children) findAll(child, pred, out);
  return out;
}

function find(node: CaptureNode, pred: (n: CaptureNode) => boolean): CaptureNode | undefined {
  return findAll(node, pred)[0];
}

function hasText(node: CaptureNode, text: string): boolean {
  return find(node, (n) => n.tag === "#text" && n.text?.trim() === text) !== undefined;
}

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
  root = await snapshotOf("index.html");
});

afterAll(async () => {
  await handle.close();
  await site.close();
});

test("root is html, title text present, h1 color set, untouched defaults omitted", () => {
  expect(root.tag).toBe("html");
  const h1 = find(root, (n) => n.tag === "h1");
  expect(h1).toBeDefined();
  expect(hasText(h1!, "Build faster sites")).toBe(true);
  expect(h1!.style.color).toBe("rgb(200, 30, 60)");
  expect(h1!.bbox).toHaveLength(4);
  const plainP = find(root, (n) => n.tag === "p" && hasText(n, "Plain paragraph text."));
  expect(plainP).toBeDefined();
  expect(plainP!.style.display).toBeUndefined();
  expect(Object.keys(plainP!.style).some((k) => k.startsWith("--"))).toBe(false);
});

test("head keeps title/meta/icon without computed style; skips style/script", () => {
  const head = find(root, (n) => n.tag === "head")!;
  const title = find(head, (n) => n.tag === "title")!;
  expect(title.style).toEqual({});
  expect(hasText(title, "Site One")).toBe(true);
  expect(find(root, (n) => n.tag === "style" || n.tag === "script")).toBeUndefined();
  expect(find(head, (n) => n.tag === "link" && n.attrs.rel === "icon")).toBeDefined();
});

test("captures ::before content", () => {
  const badge = find(root, (n) => n.attrs.class === "badge")!;
  expect(badge.pseudo?.before?.content).toBe('"★"');
  expect(badge.pseudo?.before?.color).toBe("rgb(255, 180, 0)");
  const plainP = find(root, (n) => n.tag === "p" && hasText(n, "Plain paragraph text."))!;
  expect(plainP.pseudo).toBeUndefined();
});

test("display:none element is captured and flagged hidden", () => {
  const secret = find(root, (n) => n.attrs.class === "secret")!;
  expect(secret.hidden).toBe(true);
  expect(hasText(secret, "Hidden promo")).toBe(true);
  expect(find(root, (n) => n.tag === "h1")!.hidden).toBeUndefined();
});

test("open shadow DOM content is flattened into the host", () => {
  const host = find(root, (n) => n.tag === "shadow-card")!;
  expect(hasText(host, "Shadow content")).toBe(true);
});

test("same-origin iframe content is inlined", () => {
  const iframe = find(root, (n) => n.tag === "iframe" && n.attrs.src === "frame.html")!;
  expect(iframe.children).toHaveLength(1);
  expect(iframe.children[0]!.tag).toBe("html");
  expect(hasText(iframe, "Frame content")).toBe(true);
});

test("snapshot is deterministic", async () => {
  expect(await snapshotOf("index.html")).toEqual(root);
});

test("throws NODE_LIMIT past 20k nodes", async () => {
  await expect(snapshotOf("huge.html")).rejects.toMatchObject({
    code: "NODE_LIMIT",
    context: { limit: 20_000 },
  });
});

test("strips on* and inline style attrs, skips stylesheet links, flags visibility:hidden", () => {
  const ghost = find(root, (n) => n.attrs.class === "ghost")!;
  expect(ghost.attrs).toEqual({ class: "ghost" });
  expect(ghost.hidden).toBe(true);
  expect(ghost.style.visibility).toBe("hidden");
  expect(find(root, (n) => n.tag === "link" && n.attrs.rel === "stylesheet")).toBeUndefined();
});

test("cross-origin iframe keeps tag + attrs only", () => {
  const iframe = find(root, (n) => n.attrs.class === "xorigin")!;
  expect(iframe.attrs.src).toContain("data:text/html");
  expect(iframe.children).toEqual([]);
});

test("works under Trusted Types CSP and removes the sandbox iframe", async () => {
  const { snap, iframes } = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/trusted-types.html`, { waitUntil: "load" });
    const snap = await snapshotDom(page);
    return { snap, iframes: await page.evaluate(() => document.querySelectorAll("iframe").length) };
  });
  expect(hasText(snap, "Trusted types page")).toBe(true);
  expect(iframes).toBe(0);
});

test("auto-sized boxes drop width/height, explicit sizes are kept, page left unchanged", async () => {
  const { snap, styles } = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/sizes.html`, { waitUntil: "load" });
    const read = () => page.evaluate(() => [...document.querySelectorAll("body > div")].map((d) => d.getAttribute("style")));
    const before = await read();
    const snap = await snapshotDom(page);
    return { snap, styles: [before, await read()] };
  });
  const auto = find(snap, (n) => n.attrs.id === "auto")!;
  const fixed = find(snap, (n) => n.attrs.id === "fixed")!;
  expect(auto.style.height).toBeUndefined();
  expect(auto.style["block-size"]).toBeUndefined();
  expect(auto.style.width).toBeUndefined();
  expect(auto.style["padding-top"]).toBe("8px");
  expect(fixed.style.height).toBe("200px");
  expect(fixed.style.width).toBe("300px");
  expect(styles[1]).toEqual(styles[0]);
});

test("whitespace-only text between inline siblings is kept: one space, verbatim under pre", async () => {
  const snap = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/sizes.html`, { waitUntil: "load" });
    return snapshotDom(page);
  });
  const ws = find(snap, (n) => n.attrs.id === "ws")!;
  expect(ws.children.map((c) => c.text ?? c.tag)).toEqual(["a", " ", "a"]);
  const pre = find(snap, (n) => n.attrs.id === "pre")!;
  expect(pre.children.map((c) => c.text ?? c.tag)).toEqual(["b", "\n  ", "b"]);
  const head = find(root, (n) => n.tag === "head")!; // site1 head has indentation whitespace
  expect(head.children.some((c) => c.tag === "#text")).toBe(false);
});
