import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { AppError } from "@/core/errors";
import { snapshotA11y, screenshotSection, hover, click, readStyle, asTools } from "@/core/inspector";

const fixtureDir = fileURLToPath(new URL("../fixtures/site1", import.meta.url));

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
});

afterAll(async () => {
  await handle.close();
  await site.close();
});

async function onSite1<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
    return fn(page);
  });
}

test("readStyle returns the requested computed value", async () => {
  const style = await onSite1((page) => readStyle(page, ".hero h1", ["color", "font-size"]));
  expect(style).toEqual({ color: "rgb(200, 30, 60)", "font-size": "48px" });
});

test("readStyle caps props at 50", async () => {
  const manyProps = Array.from({ length: 80 }, (_, i) => (i === 0 ? "color" : `--bogus-${i}`));
  const style = await onSite1((page) => readStyle(page, ".hero h1", manyProps));
  expect(Object.keys(style)).toHaveLength(50);
  expect(style.color).toBe("rgb(200, 30, 60)");
});

test("readStyle on invalid/missing selector throws a clean AppError with selector context", async () => {
  await expect(onSite1((page) => readStyle(page, "#does-not-exist", ["color"]))).rejects.toMatchObject({
    name: "AppError",
    code: "INSPECTOR_OP_FAILED",
    context: { selector: "#does-not-exist" },
  });
});

test("snapshotA11y is truncated to 4000 chars", async () => {
  const long = await onSite1(async (page) => {
    const labels = Array.from({ length: 400 }, (_, i) => `<button aria-label="item number ${i} padded with extra descriptive text">x</button>`).join("");
    await page.setContent(`<div id="many">${labels}</div>`);
    const full = await page.locator("#many").first().ariaSnapshot();
    const capped = await snapshotA11y(page, "#many");
    return { fullLength: full.length, capped };
  });
  expect(long.fullLength).toBeGreaterThan(4000);
  expect(long.capped.length).toBe(4000);
});

test("screenshotSection returns a PNG buffer of the requested size", async () => {
  const png = await onSite1((page) => screenshotSection(page, [0, 0, 100, 50]));
  expect(Buffer.isBuffer(png)).toBe(true);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  expect(png.readUInt32BE(16)).toBe(100); // IHDR width
  expect(png.readUInt32BE(20)).toBe(50); // IHDR height
});

test("screenshotSection clamps non-positive width/height to at least 1", async () => {
  const png = await onSite1((page) => screenshotSection(page, [0, 0, 0, -5]));
  expect(png.readUInt32BE(16)).toBe(1);
  expect(png.readUInt32BE(20)).toBe(1);
});

test("hover and click on a real element resolve", async () => {
  await onSite1(async (page) => {
    await hover(page, "header .logo");
    await click(page, "header .logo");
  });
});

test("click on a link does not navigate the page away", async () => {
  // blockNavigationAway aborts the navigation request; Chromium lands the
  // frame on an error page rather than restoring the previous document, but
  // it never reaches the external target — that's the guarantee under test.
  const finalUrl = await onSite1(async (page) => {
    await page.setContent('<a id="away" href="https://example.com/should-not-navigate">go</a>');
    await click(page, "#away");
    return page.url();
  });
  expect(finalUrl).not.toContain("example.com");
});

test("hover on an invalid selector throws a clean AppError", async () => {
  await expect(onSite1((page) => hover(page, ":::not-a-selector"))).rejects.toBeInstanceOf(AppError);
});

test("asTools: readStyle succeeds via tool call, target orig not available returns error result", async () => {
  const result = await onSite1(async (page) => {
    const { tools, call, calls } = asTools({ clone: page });
    const names = tools.map((t) => t.name).sort();
    const readResult = (await call("readStyle", { target: "clone", selector: ".hero h1", props: ["color"] })) as Record<string, string>;
    const origResult = (await call("readStyle", { target: "orig", selector: ".hero h1", props: ["color"] })) as { error: string };
    return { names, readResult, origResult, calls: calls() };
  });
  expect(result.names).toEqual(["click", "hover", "readStyle", "screenshotSection", "snapshotA11y"]);
  expect(result.readResult).toEqual({ color: "rgb(200, 30, 60)" });
  expect(result.origResult.error).toMatch(/orig/);
  expect(result.calls).toBe(2);
});

test("asTools: target \"orig\" is advertised only when an original page is given", async () => {
  await onSite1(async (page) => {
    const enums = (pages: Parameters<typeof asTools>[0]) =>
      asTools(pages).tools.map((t) => (t.parameters as { properties: { target: { enum: string[] } } }).properties.target.enum);
    expect(new Set(enums({ clone: page }).map((e) => e.join()))).toEqual(new Set(["clone"]));
    expect(new Set(enums({ orig: page, clone: page }).map((e) => e.join()))).toEqual(new Set(["orig,clone"]));
  });
});

test("asTools: unknown tool name and op errors both return {error} and count as a call", async () => {
  const result = await onSite1(async (page) => {
    const { call, calls } = asTools({ clone: page });
    const unknown = (await call("doesNotExist", {})) as { error: string };
    const inherited = (await call("constructor", {})) as { error: string }; // Object.prototype key, not a tool
    const opError = (await call("readStyle", { target: "clone", selector: "#does-not-exist", props: ["color"] })) as { error: string };
    return { unknown, inherited, opError, calls: calls() };
  });
  expect(result.unknown.error).toMatch(/unknown tool/);
  expect(result.inherited.error).toMatch(/unknown tool/);
  expect(result.opError.error).toBeTruthy();
  expect(result.calls).toBe(3);
});

test("asTools: zod rejects bad args and still counts as a call", async () => {
  const result = await onSite1(async (page) => {
    const { call, calls } = asTools({ clone: page });
    const bad = (await call("readStyle", { target: "clone" })) as { error: string };
    return { bad, calls: calls() };
  });
  expect(result.bad.error).toBeTruthy();
  expect(result.calls).toBe(1);
});

test("asTools: screenshotSection attaches the PNG (taken once) and returns only a short text", async () => {
  const result = await onSite1(async (page) => {
    const { call, takeImages } = asTools({ clone: page });
    const text = await call("screenshotSection", { target: "clone", bbox: [0, 0, 20, 20] });
    return { text, images: takeImages(), again: takeImages() };
  });
  expect(result.text).toBe("image attached");
  expect(result.images).toHaveLength(1);
  expect(Buffer.from(result.images[0]!, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
  expect(result.again).toEqual([]);
});

test("asTools: a screenshotSection box larger than 800x800 is clipped to its top-left 800x800 and says so", async () => {
  const result = await onSite1(async (page) => {
    const { call, takeImages } = asTools({ clone: page });
    const text = await call("screenshotSection", { target: "clone", bbox: [0, 0, 5000, 900] });
    return { text, images: takeImages() };
  });
  expect(result.text).toMatch(/clipped to the top-left 800x800 of the requested 5000x900/);
  const png = PNG.sync.read(Buffer.from(result.images[0]!, "base64"));
  expect([png.width, png.height]).toEqual([800, 800]);
});

test("asTools: the 6th call throws, the first 5 count and succeed", async () => {
  await onSite1(async (page) => {
    const { call, calls } = asTools({ clone: page }, { maxCalls: 5 });
    for (let i = 0; i < 5; i++) {
      await call("hover", { target: "clone", selector: "header .logo" });
    }
    expect(calls()).toBe(5);
    await expect(call("hover", { target: "clone", selector: "header .logo" })).rejects.toMatchObject({
      name: "AppError",
      code: "AI_BAD_RESPONSE",
      context: { limit: 5 },
    });
    expect(calls()).toBe(5);
  });
});
