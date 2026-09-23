import { expect, test } from "vitest";
import { PNG } from "pngjs";
import { diffCrops, sectionBoxes } from "@/core/qa";
import { buildIR } from "@/core/ir";
import type { CaptureNode, PageCapture } from "@/core/capture";

type Rgb = [number, number, number];

function solid(w: number, h: number, [r, g, b]: Rgb): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([r, g, b, 255], i * 4);
  return png;
}

function paint(png: PNG, [x, y, w, h]: [number, number, number, number], [r, g, b]: Rgb): PNG {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) png.data.set([r, g, b, 255], (yy * png.width + xx) * 4);
  return png;
}

const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [255, 0, 0];

test("identical crops score 1 with no diff pixels", () => {
  const r = diffCrops(solid(50, 40, WHITE), solid(50, 40, WHITE), []);
  expect(r).toMatchObject({ score: 1, diffPixels: 0, total: 2000 });
  expect([r.heat.width, r.heat.height]).toEqual([50, 40]);
});

test("a colored square counts exactly its area", () => {
  const r = diffCrops(solid(50, 40, WHITE), paint(solid(50, 40, WHITE), [10, 10, 10, 10], RED), []);
  expect(r.diffPixels).toBe(100);
  expect(r.score).toBeCloseTo(1 - 100 / 2000, 10);
});

test("height mismatch: the missing rows count as diff", () => {
  const r = diffCrops(solid(50, 40, WHITE), solid(50, 30, WHITE), []);
  expect(r).toMatchObject({ diffPixels: 500, total: 2000 });
  expect(r.score).toBeCloseTo(0.75, 10);
  expect(diffCrops(solid(50, 30, WHITE), solid(50, 40, WHITE), []).diffPixels).toBe(500);
});

test("a mask hides a changed region", () => {
  const changed = paint(solid(50, 40, WHITE), [10, 10, 10, 10], RED);
  expect(diffCrops(solid(50, 40, WHITE), changed, [[5, 5, 20, 20]]).score).toBe(1);
  expect(diffCrops(solid(50, 40, WHITE), changed, [[5, 5, 8, 20]]).diffPixels).toBe(70);
});

test("empty crops score 1", () => {
  expect(diffCrops(new PNG({ width: 0, height: 0 }), new PNG({ width: 0, height: 0 }), []).score).toBe(1);
});

function node(tag: string, bbox: CaptureNode["bbox"], children: CaptureNode[] = [], attrs: Record<string, string> = {}): CaptureNode {
  return { tag, attrs, bbox, style: {}, children };
}

function capture(pageId: string, url: string, dom1440: CaptureNode, dom375: CaptureNode): PageCapture {
  return {
    url,
    pageId,
    capturedAt: "2026-09-23T00:00:00.000Z",
    title: pageId,
    meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [
      { bp: 375, dom: dom375, truncated: false },
      { bp: 768, dom: dom1440, truncated: false },
      { bp: 1440, dom: dom1440, truncated: false },
    ],
    interactions: [],
    assets: {},
    skippedAssets: [],
    dynamic: [],
  };
}

test("sectionBoxes resolves each section per bp, falls back to 1440, and follows shared layouts per page", () => {
  const header = (y: number) => node("header", [0, y, 100, 50], [node("span", [0, y, 10, 10])]);
  const home1440 = node("html", [0, 0, 1440, 900], [node("head", [0, 0, 0, 0]), node("body", [0, 0, 1440, 900], [header(0), node("section", [0, 50, 1440, 300])])]);
  // 375: the second section is missing -> falls back to its 1440 box.
  const home375 = node("html", [0, 0, 375, 900], [node("head", [0, 0, 0, 0]), node("body", [0, 0, 375, 900], [node("header", [0, 0, 375, 80], [node("span", [0, 0, 10, 10])])])]);
  // "about" has an extra leading block, so the shared header sits at a different path there.
  const about = node("html", [0, 0, 1440, 900], [node("head", [0, 0, 0, 0]), node("body", [0, 0, 1440, 900], [node("div", [0, 0, 1440, 20]), header(20)])]);
  const caps = [capture("home", "https://x.test/", home1440, home375), capture("about", "https://x.test/about", about, about)];
  const ir = buildIR(caps);
  const shared = ir.layouts[0]!.sectionId;

  expect(sectionBoxes(caps[0]!, ir, "home", 1440)).toEqual({ [shared]: [0, 0, 100, 50], "home-s2": [0, 50, 1440, 300] });
  expect(sectionBoxes(caps[0]!, ir, "home", 375)).toEqual({ [shared]: [0, 0, 375, 80], "home-s2": [0, 50, 1440, 300] });
  expect(sectionBoxes(caps[1]!, ir, "about", 1440)).toEqual({ "about-s1": [0, 0, 1440, 20], [shared]: [0, 20, 100, 50] });
});
