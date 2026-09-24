import { expect, test } from "vitest";
import { normalizeUrl, sameOrigin, isHtmlLike, pathSlug } from "@/core/url";

test("strips tracking + hash + trailing slash", () => {
  expect(normalizeUrl("https://x.com/a/?utm_source=z&b=1#top"))
    .toBe("https://x.com/a?b=1");
});

test("resolves relative", () => {
  expect(normalizeUrl("../b", "https://x.com/a/c")).toBe("https://x.com/b");
});

test("rejects non-http", () => {
  expect(normalizeUrl("mailto:a@b.com")).toBeNull();
});

test("isHtmlLike false for assets", () => {
  expect(isHtmlLike("https://x.com/a.png")).toBe(false);
});

test("pathSlug: the one slug behind page ids and page file names", () => {
  expect(["/", "/a/b", "/About.html", "/x.htm?q=1", "/..%2Fetc/p@ss", "/v1.2/x"].map(pathSlug)).toEqual(["", "a-b", "About", "x-q-1", "2Fetc-p-ss", "v1-2-x"]);
});
