import { expect, test } from "vitest";
import { isSafeCss } from "@/core/safe-names";

test("isSafeCss refuses any value that could end its declaration or rule; ordinary values pass", () => {
  const unsafe = ["red;x:y", "a{", "}", "<b", "red /* x", "x */ red", "red\\", 'url("a.png', "'Inter", '"a" "b', "a\\\\\\", "a\nb", '"a\rb"'];
  for (const value of unsafe) expect(isSafeCss("color", value), value).toBe(false);
  const safe = ['url("a.png")', "url('x y.png')", '"Inter", sans-serif', "'Font \\'A\\''", '"a\\"b"', "calc(100% - 2px)", "\\201C", "a\\\\", '"a/b"', "1px solid rgb(0, 0, 0)"];
  for (const value of safe) expect(isSafeCss("font-family", value), value).toBe(true);
  expect(isSafeCss("Bad Prop", "1")).toBe(false);
  expect(isSafeCss("color", "")).toBe(false);
});
