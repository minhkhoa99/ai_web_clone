import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { aiPatchable } from "@/core/interactive";
import { callChatTool, chatScope, componentList, nodeDetail, nodeLine, outlineText, SCOPE_LIMITS } from "@/core/ai-chat-scope";

const el = (tag: string, children: CaptureNode[] = [], text?: string, attrs: Record<string, string> = {}): CaptureNode => ({ tag, attrs, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
function doc(): IRV2 {
  const dom = el("html", [el("head"), el("body", [
    el("header", [el("h1", [el("#text", [], "Tiêu đề")])]),
    // buildIR makes one section per child of <main>: a single wrapper keeps the three body nodes in one section
    el("main", [el("div", [el("p", [el("#text", [], "Đoạn một")]), el("div", [el("p", [el("#text", [], "Đoạn hai")])]), el("input", [], undefined, { type: "password", value: "bí-mật", onclick: "x()" })])]),
    el("footer", [el("p", [el("#text", [], "Chân trang")])]),
  ])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-10-09T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  return buildIR([capture]) as IRV2;
}
const walk = (n: IRNodeV2): IRNodeV2[] => [n, ...n.children.flatMap(walk)];
const sectionWith = (ir: IRV2, text: string) => ir.sections.find((s) => walk(s.root).some((n) => n.text === text))!;
const nodeWith = (ir: IRV2, text: string) => walk(sectionWith(ir, text).root).find((n) => n.text === text)!;
// the fixture must split header / main / footer into different sections; if buildIR ever merges them, change the fixture, not the test
test("fixture sanity: three texts sit in three sections", () => {
  const ir = doc();
  expect(new Set(["Tiêu đề", "Đoạn một", "Chân trang"].map((t) => sectionWith(ir, t).id)).size).toBe(3);
});

test("selection -> the sections that hold it (page order); no selection or none on the page -> every section of the page", () => {
  const ir = doc();
  const main = sectionWith(ir, "Đoạn một"), footer = sectionWith(ir, "Chân trang");
  const one = chatScope(ir, "home", [nodeWith(ir, "Đoạn một").id]);
  expect(one.sectionIds).toEqual([main.id]);
  expect(one.roots).toEqual([main.root.id]);
  expect(one.allowed.has(nodeWith(ir, "Chân trang").id)).toBe(false);
  expect(one.focus).toEqual([nodeWith(ir, "Đoạn một").id]);
  const two = chatScope(ir, "home", [nodeWith(ir, "Chân trang").id, nodeWith(ir, "Đoạn một").id]);
  expect(two.sectionIds).toEqual(ir.pages[0]!.sectionIds.filter((id) => id === main.id || id === footer.id));
  const all = chatScope(ir, "home", ["nope"]);
  expect(all.sectionIds.length).toBe(ir.sections.length);
  expect(all.focus).toEqual([]);
});

test("allowed = stored ids of the sections; a section in a shared layout reports its page count", () => {
  const ir = doc();
  const s = sectionWith(ir, "Tiêu đề");
  const shared: IRV2 = { ...ir, sections: ir.sections.map((x) => (x.id === s.id ? { ...x, layoutId: "L1" } : x)), layouts: [...ir.layouts, { id: "L1", hash: "h", sectionId: s.id, pageIds: ["home", "about"] }] };
  const scope = chatScope(shared, "home", [s.root.id]);
  expect([...scope.allowed].sort()).toEqual(walk(s.root).map((n) => n.id).sort());
  expect(scope.shared.get(s.id)).toBe(2);
  expect(outlineText(scope, 1440, SCOPE_LIMITS.outlineChars)).toContain("dùng chung 2 trang");
});

test("outline: focus, its ancestors and siblings first; over budget the rest folds into '… +N con'", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", []);
  const full = outlineText(scope, 1440, SCOPE_LIMITS.outlineChars);
  expect(full).toContain('"Đoạn hai"');
  const focus = nodeWith(ir, "Đoạn một").id;
  const focusScope = chatScope(ir, "home", [focus]);
  // a budget that fits exactly the chain root -> … -> focus (+5): nothing else, the rest folds
  const chain: string[] = [];
  for (let id: string | undefined = focus; id !== undefined; id = focusScope.parent.get(id)) chain.unshift(id);
  const need = chain.reduce((n, id, depth) => n + depth * 2 + nodeLine(focusScope, focusScope.nodes.get(id)!, 1440).length + 1, 0) + 5;
  const tight = outlineText(focusScope, 1440, need);
  expect(tight).toContain('"Đoạn một"');
  expect(tight).toMatch(/… \+\d+ con/);
  expect(tight).not.toContain('"Đoạn hai"');
  expect(tight.split("\n").filter((l) => !l.trim().startsWith("…"))).toHaveLength(chain.length);
});

test("nodeDetail: styles + safe attrs, never on* / a password value, capped", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", []);
  const input = walk(sectionWith(ir, "Đoạn một").root).find((n) => n.tag === "input")!;
  const text = nodeDetail(scope, input.id);
  expect(text).toContain('"type":"password"');
  expect(text).not.toContain("bí-mật");
  expect(text).not.toContain("onclick");
  expect(nodeDetail(scope, "nope")).toContain("không thuộc phạm vi");
  expect(nodeDetail(scope, sectionWith(ir, "Đoạn một").root.id, 50).length).toBeLessThanOrEqual(50);
});

test("tools: readNode / readSubtree / findText stay in scope and under 8 000 chars", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", [nodeWith(ir, "Đoạn một").id]);
  expect(callChatTool(scope, 1440, "readNode", { id: nodeWith(ir, "Chân trang").id })).toContain("không thuộc phạm vi");
  expect(callChatTool(scope, 1440, "readSubtree", { id: sectionWith(ir, "Đoạn một").root.id, depth: 9 })).toContain('"Đoạn hai"');
  expect(callChatTool(scope, 1440, "findText", { query: "đoạn" })).toContain('"Đoạn hai"');
  expect(callChatTool(scope, 1440, "findText", { query: "chân" })).toBe("[]");
  expect(callChatTool(scope, 1440, "drop", {})).toContain("không có tool");
  expect(callChatTool(scope, 1440, "readSubtree", { id: sectionWith(ir, "Đoạn một").root.id }).length).toBeLessThanOrEqual(SCOPE_LIMITS.toolChars);
});

test("aiPatchable drops role-node fields; componentList lists only AI fields", () => {
  expect(aiPatchable("carousel")).not.toContain("arrows");
  expect(aiPatchable("carousel")).toContain("slidesPerView");
  expect(aiPatchable("modal")).toEqual(["closeOn"]);
  const ir = doc();
  expect(componentList(chatScope(ir, "home", []))).toEqual([]);
});
