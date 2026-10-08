import { expect, test } from "vitest";
import { DEFAULT_BUDGET_BYTES, MAX_FILE_BYTES } from "@/core/assets";
import type { IRNodeV2 } from "@/core/ir-v2";
import { attrBatch, uploadError, UPLOAD_LIMITS } from "@/app/p/[id]/editor/visual/element-panel";
import { indexPage } from "@/app/p/[id]/editor/visual/model";

const node = (id: string, tag: string, children: IRNodeV2[] = [], attrs: Record<string, string> = {}): IRNodeV2 =>
  ({ id, tag, type: tag === "a" ? "link" : tag === "img" ? "image" : "container", attrs, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children }) as IRNodeV2;
const index = indexPage({
  shell: node("html", "html", [node("body", "body", [node("ph", "#section", [], { "data-section": "s1" })])]),
  sections: [{ id: "s1", name: "Hero", root: node("root", "section", [node("a1", "a", [], { href: "#x" }), node("im", "img", [], { src: "a.png", alt: "old" })]) }],
});

test("UPLOAD_LIMITS pins the server's caps", () => {
  expect(UPLOAD_LIMITS).toEqual({ fileBytes: MAX_FILE_BYTES, projectBytes: DEFAULT_BUDGET_BYTES });
});

test("attrBatch: alt / href as one setAttribute; '' removes; href only through the safe-href allowlist", () => {
  expect(attrBatch(index, "im", "alt", "Ảnh mới")).toEqual({ commands: [{ op: "setAttribute", id: "im", name: "alt", value: "Ảnh mới" }] });
  expect(attrBatch(index, "im", "alt", "")).toEqual({ commands: [{ op: "setAttribute", id: "im", name: "alt", value: null }] });
  for (const ok of ["https://x.test/a", "/p/b", "#top", "mailto:a@b.c", "tel:123", "page.html"]) expect(attrBatch(index, "a1", "href", ok)).toEqual({ commands: [{ op: "setAttribute", id: "a1", name: "href", value: ok }] });
  for (const bad of ["javascript:alert(1)", " java\tscript:x", "data:text/html,<b>", "vbscript:x", "DATA:image/png;base64,AA"]) expect(attrBatch(index, "a1", "href", bad)).toHaveProperty("error");
  expect(attrBatch(index, "instance:a1", "href", "/x")).toHaveProperty("error"); // a main's node shown in an instance
  expect(attrBatch(index, "gone", "alt", "x")).toHaveProperty("error");
});

test("uploadError: the upload codes in Vietnamese", () => {
  expect(uploadError(413, { code: "ASSET_TOO_LARGE", message: "x" })).toBe("Ảnh vượt 25 MB.");
  expect(uploadError(413, { code: "PAYLOAD_TOO_LARGE", message: "request body over 1 bytes" })).toBe("Ảnh vượt 25 MB.");
  expect(uploadError(413, { code: "PROJECT_SIZE_LIMIT" })).toBe("Tổng ảnh của project vượt 500 MB.");
  expect(uploadError(400, { code: "UPLOAD_INVALID", message: "Tệp .svg không có thẻ <svg>." })).toBe("Tệp .svg không có thẻ <svg>.");
  expect(uploadError(400, { code: "UPLOAD_INVALID" })).toBe("Chỉ nhận ảnh png/jpg/webp/gif/svg/avif — đuôi file và nội dung phải khớp.");
  expect(uploadError(403, { code: "FORBIDDEN", message: "cross-origin request refused" })).toBe("Tải ảnh lỗi (HTTP 403, FORBIDDEN).");
  expect(uploadError(500, {})).toBe("Tải ảnh lỗi (HTTP 500).");
});
