// The editor canvas renders IR text as text: irToGrapes' textnodes loaded into the real GrapesJS (the bundle the
// editor ships) never become elements, so captured text like `<img onerror=…>` can't run in the editor.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import { irToGrapes } from "@/core/grapes-adapter";
import type { IR, IRNode } from "@/core/ir";

const grapesBundle = createRequire(import.meta.url).resolve("grapesjs/dist/grapes.min.js");
const EVIL = '<img src=x onerror="window.top.__pwned = 1">';
const node = (id: string, tag: string, children: IRNode[] = [], text?: string): IRNode => ({ id, tag, attrs: {}, cls: [], children, ...(text ? { text } : {}) });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

test("GrapesJS canvas: textnode content with markup is shown as text, no <img>, no handler run", async () => {
  const root = node("s", "section", [node("h", "h1", [node("h.0", "#text", [], EVIL)]), node("t", "#text", [], EVIL)]);
  const ir = {
    pages: [{ id: "p", path: "/", title: "t", meta: {}, sectionIds: ["s"], shell: node("p:0", "html", [node("p:0.0", "body", [{ ...node("ph", "#section"), attrs: { "data-section": "s" } }])]) }],
    sections: [{ id: "s", pageId: "p", name: "hero", role: "section", hash: "x", origin: "capture", root }],
    layouts: [],
    components: [],
    classes: {},
    tokens: {},
    cssom: { keyframes: [], fontFace: [], vars: {} },
    interactions: [],
  } as unknown as IR;
  const { components } = irToGrapes(ir, "p", { assetMap: {}, pageUrls: {} });

  const page = await browser.newPage();
  await page.setContent('<div id="gjs" style="height:400px"></div>');
  await page.addScriptTag({ path: grapesBundle });
  const result = await page.evaluate(async (comps) => {
    const g = (window as unknown as { grapesjs: { init(o: unknown): { setComponents(c: unknown): void; Canvas: { getDocument(): Document } } } }).grapesjs;
    const editor = g.init({ container: "#gjs", storageManager: false, height: "400px" });
    editor.setComponents(comps);
    await new Promise((r) => setTimeout(r, 500)); // canvas frame + components rendered
    const doc = editor.Canvas.getDocument();
    return { imgs: doc.querySelectorAll("img").length, text: doc.body.textContent ?? "", pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0 };
  }, components);
  expect(result.imgs).toBe(0);
  expect(result.text.split(EVIL).length - 1).toBe(2);
  expect(result.pwned).toBe(0);
  await page.close();
});
