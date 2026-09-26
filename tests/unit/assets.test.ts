import { expect, test } from "vitest";
import { assetExt, collectAssetUrls, urlsFromFontFaces } from "@/core/assets";
import type { CaptureNode } from "@/core/capture";

const BASE = "https://example.com/page";

function node(partial: Partial<CaptureNode>): CaptureNode {
  return { tag: "div", attrs: {}, bbox: [0, 0, 0, 0], style: {}, children: [], ...partial };
}

test("img src and srcset, dedupe, deterministic order, resolved against baseUrl", () => {
  const dom = node({
    children: [
      node({ tag: "img", attrs: { src: "a.png", srcset: "b.png 1x, c.png 2x" } }),
      node({ tag: "img", attrs: { src: "a.png" } }), // duplicate of the first
    ],
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual([
    "https://example.com/a.png",
    "https://example.com/b.png",
    "https://example.com/c.png",
  ]);
});

test("picture > source[srcset], video[src|poster], source[src]", () => {
  const dom = node({
    children: [
      node({ tag: "picture", children: [node({ tag: "source", attrs: { srcset: "wide.jpg 1024w" } })] }),
      node({ tag: "video", attrs: { src: "clip.mp4", poster: "poster.jpg" }, children: [node({ tag: "source", attrs: { src: "clip.webm" } })] }),
    ],
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual([
    "https://example.com/wide.jpg",
    "https://example.com/clip.mp4",
    "https://example.com/poster.jpg",
    "https://example.com/clip.webm",
  ]);
});

test("background-image url() on element style and ::before/::after pseudo", () => {
  const dom = node({
    style: { "background-image": 'url("bg.png")' },
    pseudo: { before: { "background-image": "url(before.png)" }, after: { "background-image": "url(after.png)" } },
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual([
    "https://example.com/bg.png",
    "https://example.com/before.png",
    "https://example.com/after.png",
  ]);
});

test("multiple url() in one background-image value (layered backgrounds)", () => {
  const dom = node({ style: { "background-image": "url(one.png), url(two.png)" } });
  expect(collectAssetUrls(dom, [], BASE)).toEqual(["https://example.com/one.png", "https://example.com/two.png"]);
});

test("link[rel~=icon], link[rel=apple-touch-icon], meta[property=og:image]", () => {
  const dom = node({
    children: [
      node({ tag: "link", attrs: { rel: "shortcut icon", href: "favicon.ico" } }),
      node({ tag: "link", attrs: { rel: "apple-touch-icon", href: "apple.png" } }),
      node({ tag: "link", attrs: { rel: "stylesheet", href: "styles.css" } }), // not an asset source
      node({ tag: "meta", attrs: { property: "og:image", content: "og.png" } }),
      node({ tag: "meta", attrs: { property: "og:title", content: "not a url" } }),
    ],
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual([
    "https://example.com/favicon.ico",
    "https://example.com/apple.png",
    "https://example.com/og.png",
  ]);
});

test("svg use href/xlink:href external ref, fragment stripped, same-document ref skipped", () => {
  const dom = node({
    children: [
      node({ tag: "use", attrs: { href: "sprite.svg#icon-home" } }),
      node({ tag: "use", attrs: { "xlink:href": "sprite2.svg#icon-star" } }),
      node({ tag: "use", attrs: { href: "#local-only" } }),
    ],
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual(["https://example.com/sprite.svg", "https://example.com/sprite2.svg"]);
});

test("network urls are merged in and deduped against DOM-sourced ones", () => {
  const dom = node({ children: [node({ tag: "img", attrs: { src: "shared.png" } })] });
  const networkUrls = ["https://example.com/shared.png", "https://example.com/network-only.png"];
  expect(collectAssetUrls(dom, networkUrls, BASE)).toEqual([
    "https://example.com/shared.png",
    "https://example.com/network-only.png",
  ]);
});

test("data: and blob: urls are skipped, unresolvable urls are skipped", () => {
  const dom = node({
    children: [
      node({ tag: "img", attrs: { src: "data:image/png;base64,AAAA" } }),
      node({ tag: "video", attrs: { poster: "blob:https://example.com/1234" } }),
      node({ tag: "img", attrs: { src: "" } }),
    ],
  });
  expect(collectAssetUrls(dom, [], BASE)).toEqual([]);
});

test("urlsFromFontFaces: absolute kept, relative resolved against the page URL, local()/data: skipped, deduped", () => {
  const fontFace = [
    '@font-face { font-family: A; src: url("https://cdn.test/_next/static/media/a.woff2") format("woff2"), local("A"); }',
    "@font-face { font-family: FA; src: url(/webfonts/fa-solid.woff2) format('woff2'), url('../fonts/b.woff') format('woff'); }",
    '@font-face { font-family: D; src: url(data:font/woff2;base64,AAAA); }',
    '@font-face { font-family: A2; src: url("https://cdn.test/_next/static/media/a.woff2"); }',
  ];
  expect(urlsFromFontFaces(fontFace, BASE)).toEqual([
    "https://cdn.test/_next/static/media/a.woff2",
    "https://example.com/webfonts/fa-solid.woff2",
    "https://example.com/fonts/b.woff",
  ]);
});

test("assetExt: only passive media extensions survive; html/js/css (by type or by url) become .bin", () => {
  expect(assetExt("image/png", "https://x.test/a")).toBe("png");
  expect(assetExt("application/octet-stream", "https://x.test/f/font.woff2?v=1")).toBe("woff2");
  expect(assetExt("image/svg+xml; charset=utf-8", "https://x.test/i")).toBe("svg");
  expect(assetExt("application/octet-stream", "https://x.test/x.html")).toBe("bin");
  expect(assetExt("text/html", "https://x.test/x.html")).toBe("bin");
  expect(assetExt("text/javascript", "https://x.test/app.js")).toBe("bin");
  expect(assetExt(undefined, "https://x.test/site.css")).toBe("bin");
  expect(assetExt("text/html", "https://x.test/evil.htm")).toBe("bin");
  expect(assetExt(undefined, "https://x.test/noext")).toBe("bin");
});
