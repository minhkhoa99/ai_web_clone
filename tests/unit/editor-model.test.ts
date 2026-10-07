import { expect, test } from "vitest";
import { COMMAND_LIMITS } from "@/core/ir-command";
import type { PanelComponent } from "@/core/interactive";
import type { IRNodeV2 } from "@/core/ir-v2";
import {
  ancestorsOf, bands, bodyOf, copyClip, deleteBatch, dropCommand, duplicateBatch, guard, hideBatch, imageBatch, indexPage, isTextHost, keyAction,
  labelOf, layerRows, LIMITS, MAX_ROWS, parentOf, pasteBatch, pickTarget, renameBatch, reorderBatch, rowWindow, siblingsOf, styleTarget, topMost,
} from "@/app/p/[id]/editor/visual/model";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const page = () => ({
  shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("ph2", "#section", [], { attrs: { "data-section": "s2" } }), n("nav", "nav"),
  ])]),
  sections: [
    { id: "s1", name: "Hero", root: n("r1", "section", [
      n("h", "h1", [n("t", "#text", [], { text: "Xin chào thế giới" })], { type: "text" }),
      n("p", "p", [n("pt", "#text", [], { text: "Đoạn " }), n("b", "b", [n("bt", "#text", [], { text: "đậm" })])], { type: "text" }),
      n("box", "div", [n("img", "img", [], { type: "image", attrs: { src: "a.png", srcset: "a.png 1x" } })]),
      n("pic", "picture", [n("src1", "source", [], { attrs: { srcset: "b.webp" } }), n("img2", "img", [], { type: "image", attrs: { src: "b.png" } })]),
      n("gone", "div", [n("inner", "span")], { hidden: true }),
      n("bad", "div", [n("frame", "iframe", [], { type: "media" }), n("ok", "em", [], { attrs: { onclick: "x", title: "t", id: "hero-cta", "aria-controls": "menu", for: "f" }, styles: { base: { color: "red", width: "1px;}" }, bp: {}, state: {}, pseudo: {} } })]),
    ]) },
    { id: "s2", name: "Footer", layoutId: "L", root: n("r2", "footer", [
      n("inst", "div", [n("instance:4:inst:m1", "span"), n("ic", "span")], { component: { id: "c", role: "instance", sourceId: "m" } }),
      n("track", "div", [n("slide", "div")]),
    ]) },
  ],
});
const carousel = { rootId: "r2", spec: { kind: "carousel", track: "track" }, members: ["track", "slide"], items: [], instance: false } as unknown as PanelComponent;
const ix = () => indexPage(page());

test("index: section roots carry their placeholder (subject) and shell parent; depth, children, hidden and shell flags; labels", () => {
  const index = ix();
  expect(bodyOf(page())).toBe("body");
  expect(index.get("r1")).toMatchObject({ subject: "ph1", parent: "body", index: 0, depth: 2, sectionId: "s1", sectionName: "Hero", shell: false });
  expect(index.get("r2")).toMatchObject({ subject: "ph2", index: 1, layout: true });
  expect(index.get("body")!.children).toEqual(["r1", "r2", "nav"]);
  expect(index.get("h")).toMatchObject({ parent: "r1", subject: "h", index: 0, depth: 3, sectionId: "s1" });
  expect(index.get("inner")!.hidden).toBe(true);
  expect(index.get("nav")!.shell).toBe(true);
  expect(labelOf(index.get("r1")!)).toBe("Hero");
  expect(labelOf(index.get("h")!)).toBe("Chữ Xin chào thế giới");
  expect(labelOf(index.get("box")!)).toBe("Khung <div>");
  expect(labelOf({ ...index.get("h")!, node: { ...index.get("h")!.node, name: "Tiêu đề" } })).toBe("Tiêu đề");
  expect(ancestorsOf(index, "bt")).toEqual(["bt", "b", "p", "r1", "body", "html"]);
});

test("layer rows: no #text rows, open state, search keeps matches + ancestors, badges; the window renders at most 200 rows", () => {
  const index = ix();
  expect(layerRows(index, "body", new Set(["body"]), "", []).map((r) => r.id)).toEqual(["body", "r1", "r2", "nav"]);
  expect(layerRows(index, "body", new Set(), "", [], "Trang /index.html")[0]?.label).toBe("Trang /index.html");
  const rows = layerRows(index, "body", new Set(["body", "r1", "r2"]), "", [carousel]);
  expect(rows.map((r) => r.id)).toEqual(["body", "r1", "h", "p", "box", "pic", "gone", "bad", "r2", "inst", "track", "nav"]);
  expect(rows.find((r) => r.id === "r2")).toMatchObject({ kind: "carousel", section: true });
  expect(rows.find((r) => r.id === "inst")).toMatchObject({ role: "instance" });
  expect(rows.find((r) => r.id === "gone")).toMatchObject({ hidden: true, dimmed: true });
  expect(layerRows(index, "body", new Set(), "thế giới", []).map((r) => r.id)).toEqual(["body", "r1", "h"]);
  expect(rowWindow(10_000, 0, 600)).toEqual({ start: 0, end: 45 });
  const w = rowWindow(10_000, 24 * 5000, 100_000);
  expect(w.end - w.start).toBe(MAX_ROWS);
  expect(rowWindow(3, 0, 600)).toEqual({ start: 0, end: 3 });
});

test("selection: #text and hidden nodes resolve to a pickable ancestor; parent never html/body; siblings; top-most; text hosts", () => {
  const index = ix();
  expect(pickTarget(index, "t")).toBe("h");
  expect(pickTarget(index, "inner")).toBeUndefined();
  expect(pickTarget(index, "body")).toBeUndefined();
  expect(parentOf(index, "h")).toBe("r1");
  expect(parentOf(index, "r1")).toBeUndefined();
  expect(siblingsOf(index, "h")).toEqual(["h", "p", "box", "pic", "bad"]);
  expect(topMost(index, ["bt", "p", "h", "p"])).toEqual(["p", "h"]);
  expect([isTextHost(index.get("h")!.node), isTextHost(index.get("p")!.node), isTextHost(index.get("box")!.node)]).toEqual([true, true, false]);
  expect(bands({ x: 10, y: 10, w: 100, h: 50 }, [1, 2, 3, 4], false)).toEqual([
    { x: 6, y: 9, w: 106, h: 1 }, { x: 110, y: 10, w: 2, h: 50 }, { x: 6, y: 60, w: 106, h: 3 }, { x: 6, y: 10, w: 4, h: 50 },
  ]);
});

test("guards: generated instance ids, instance structure, component roles, shell nodes, carousel track — Vietnamese reasons, nothing sent", () => {
  const index = ix();
  expect(guard(index, [], "instance:4:inst:m1", "edit")).toMatch(/instance/);
  expect(guard(index, [], "ic", "delete")).toMatch(/instance.*main|Detach/);
  expect(guard(index, [carousel], "slide", "delete")).toMatch(/Carousel.*panel Component/);
  expect(guard(index, [carousel], "r2", "delete")).toBeUndefined(); // the whole component may go
  expect(guard(index, [], "nav", "delete")).toMatch(/shell/);
  expect(guard(index, [], "inst", "duplicate")).toMatch(/component/);
  expect(deleteBatch(index, [carousel], ["slide"])).toEqual({ error: expect.stringMatching(/Carousel/) });
  expect(dropCommand(index, [carousel], "h", "track", "inside")).toEqual({ error: expect.stringMatching(/track.*panel Component/) });
});

test("batches: delete top-most (a section by its placeholder), duplicate in descending index order, hide = setHidden + display, reorder, rename", () => {
  const index = ix();
  expect(deleteBatch(index, [], ["bt", "p", "r2"])).toEqual({ commands: [{ op: "deleteNode", id: "p" }, { op: "deleteNode", id: "ph2" }] });
  expect(duplicateBatch(index, [], ["h", "box"])).toEqual({ commands: [
    { op: "duplicateNode", id: "box", parentId: "r1", index: 3 }, { op: "duplicateNode", id: "h", parentId: "r1", index: 1 },
  ] });
  expect(hideBatch(index, ["h"], true)).toEqual({ commands: [{ op: "setHidden", id: "h", hidden: true }, { op: "setStyle", id: "h", target: "base", changes: { display: "none" } }] });
  expect(hideBatch(index, ["gone"], false)).toEqual({ commands: [{ op: "setHidden", id: "gone", hidden: false }] });
  expect(hideBatch(index, ["body"], true)).toEqual({ error: expect.any(String) });
  expect(reorderBatch(index, [], ["p", "box"], 1)).toEqual({ commands: [{ op: "moveNode", id: "box", parentId: "r1", index: 3 }, { op: "moveNode", id: "p", parentId: "r1", index: 2 }] });
  expect(reorderBatch(index, [], ["h"], -1)).toEqual({ error: expect.any(String) });
  expect(reorderBatch(index, [], ["gone", "bad"], 1)).toEqual({ error: "Đã ở đầu / cuối danh sách." }); // bad is last: nothing moves
  // whitespace-only text between elements is skipped (the tree never shows it); consecutive picks keep their order
  const ws = (id: string) => n(id, "#text", [], { text: "\n  " });
  const spaced = indexPage({ shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s" } })])]), sections: [{ id: "s", name: "S", root: n("r", "div", [ws("w0"), n("a", "h1"), ws("w1"), n("b2", "p"), ws("w2"), n("c", "p"), ws("w3")]) }] });
  expect(reorderBatch(spaced, [], ["b2"], -1)).toEqual({ commands: [{ op: "moveNode", id: "b2", parentId: "r", index: 1 }] });
  expect(reorderBatch(spaced, [], ["a"], 1)).toEqual({ commands: [{ op: "moveNode", id: "a", parentId: "r", index: 3 }] });
  expect(reorderBatch(spaced, [], ["b2", "c"], -1)).toEqual({ commands: [{ op: "moveNode", id: "b2", parentId: "r", index: 1 }, { op: "moveNode", id: "c", parentId: "r", index: 2 }] });
  expect(reorderBatch(spaced, [], ["a"], -1)).toEqual({ error: "Đã ở đầu / cuối danh sách." });
  expect(renameBatch(index, "h", "  Tiêu đề  ")).toEqual({ commands: [{ op: "setName", id: "h", name: "Tiêu đề" }] });
  expect(renameBatch(index, "h", " ")).toEqual({ error: expect.stringMatching(/1–80/) });
  const many = Array.from({ length: 26 }, (_, i) => `x${i}`);
  const wide = indexPage({ shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s" } })])]), sections: [{ id: "s", name: "S", root: n("r", "div", many.map((x) => n(x, "div"))) }] });
  expect(hideBatch(wide, many, true)).toEqual({ error: expect.stringMatching(/50/) });
});

test("drop: before/after/inside with the index counted after lifting; into itself, void tags, the shell and (E3a) another section are refused; a section row only reorders sections", () => {
  const index = ix();
  expect(dropCommand(index, [], "h", "box", "after")).toEqual({ commands: [{ op: "moveNode", id: "h", parentId: "r1", index: 2 }] });
  expect(dropCommand(index, [], "box", "h", "before")).toEqual({ commands: [{ op: "moveNode", id: "box", parentId: "r1", index: 0 }] });
  expect(dropCommand(index, [], "h", "box", "inside")).toEqual({ commands: [{ op: "moveNode", id: "h", parentId: "box", index: 1 }] });
  expect(dropCommand(index, [], "p", "b", "inside")).toEqual({ error: expect.stringMatching(/chính nó/) });
  expect(dropCommand(index, [], "h", "img", "inside")).toEqual({ error: expect.stringMatching(/img/) });
  expect(dropCommand(index, [], "h", "nav", "after")).toEqual({ error: expect.stringMatching(/shell/) });
  expect(dropCommand(index, [], "h", "track", "after")).toEqual({ error: expect.stringMatching(/section khác/) });
  expect(dropCommand(index, [], "r2", "r1", "before")).toEqual({ commands: [{ op: "moveNode", id: "ph2", parentId: "body", index: 0 }] });
  expect(dropCommand(index, [], "r2", "h", "after")).toEqual({ error: expect.stringMatching(/section/) });
  expect(dropCommand(index, [], "r1", "r2", "before")).toEqual({ error: expect.stringMatching(/chỗ cũ/) });
  expect(dropCommand(index, [], "h", "p", "before")).toEqual({ error: expect.stringMatching(/chỗ cũ/) });
  const split = indexPage({ shell: n("html", "html", [n("body", "body", [n("pa", "#section", [], { attrs: { "data-section": "a" } }), n("main", "main", [n("pb", "#section", [], { attrs: { "data-section": "b" } })])])]),
    sections: [{ id: "a", name: "A", root: n("ra", "div") }, { id: "b", name: "B", root: n("rb", "div") }] });
  expect(dropCommand(split, [], "ra", "rb", "after")).toEqual({ commands: [{ op: "moveNode", id: "pa", parentId: "main", index: 1 }] });
});

test("clipboard: one subtree as a draft without ids, unsafe tags/attrs/CSS dropped, ≤ 500 nodes; paste right after the selection (inside a section root)", () => {
  expect(LIMITS).toEqual({ batch: COMMAND_LIMITS.commands, clipboard: COMMAND_LIMITS.nodes, depth: COMMAND_LIMITS.depth });
  const index = ix();
  const clip = copyClip(index, "bad");
  expect(clip).toEqual({ count: 2, draft: { tag: "div", type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [
    { tag: "em", type: "container", attrs: { title: "t" }, styles: { base: { color: "red" }, bp: {}, state: {}, pseudo: {} }, children: [] },
  ] } });
  expect(JSON.stringify(clip)).not.toMatch(/"id"|parentId|iframe|onclick|hero-cta|aria-controls|"for"/);
  expect(copyClip(index, "nav")).toEqual({ error: expect.any(String) });
  if ("error" in clip) throw new Error("clip");
  expect(pasteBatch(index, [], clip, "h")).toEqual({ commands: [{ op: "createNode", parentId: "r1", index: 1, draft: clip.draft }] });
  expect(pasteBatch(index, [], clip, "r1")).toEqual({ commands: [{ op: "createNode", parentId: "r1", index: 6, draft: clip.draft }] });
  expect(pasteBatch(index, [], clip, undefined)).toEqual({ error: expect.any(String) });
  const big = indexPage({ shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s" } })])]), sections: [{ id: "s", name: "S", root: n("r", "div", Array.from({ length: 501 }, (_, i) => n(`k${i}`, "i"))) }] });
  expect(copyClip(big, "r")).toEqual({ error: expect.stringMatching(/500/) });
});

test("keys, style targets, images", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => keyAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }, false);
  expect([k("z", { ctrlKey: true }), k("Z", { ctrlKey: true, shiftKey: true }), k("y", { ctrlKey: true }), k("z", { metaKey: true })]).toEqual(["undo", "redo", "redo", "undo"]);
  expect([k("Delete"), k("d", { ctrlKey: true }), k("h"), k("H"), k("c", { ctrlKey: true }), k("v", { ctrlKey: true })]).toEqual(["delete", "duplicate", "hide", "hide", "copy", "paste"]);
  expect([k("ArrowUp", { altKey: true }), k("ArrowDown", { altKey: true }), k("Enter", { ctrlKey: true }), k("Escape"), k("a", { ctrlKey: true })]).toEqual(["up", "down", "child", "parent", "siblings"]);
  expect([k("h", { ctrlKey: true }), k("x"), keyAction({ key: "Delete", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, true)]).toEqual([undefined, undefined, undefined]);
  expect([styleTarget(1440), styleTarget(768), styleTarget(375), styleTarget(768, "hover")]).toEqual(["base", 768, 375, "hover"]);
  const index = ix();
  expect(imageBatch(index, "img", "img", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "img", name: "src", value: "K" }, { op: "setAttribute", id: "img", name: "srcset", value: null }] });
  expect(imageBatch(index, "img2", "img", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "img2", name: "src", value: "K" }, { op: "setAttribute", id: "src1", name: "srcset", value: "K" }] });
  expect(imageBatch(index, "src1", "source", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "src1", name: "srcset", value: "K" }] });
  expect(imageBatch(index, "box", "background", "https://u/x.png", 768)).toEqual({ commands: [{ op: "setStyle", id: "box", target: 768, changes: { "background-image": 'url("https://u/x.png")' } }] });
});
