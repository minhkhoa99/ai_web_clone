import { expect, test } from "vitest";
import { applyCommands, prepareCommands, type EditorCommand, type NodeDraft } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { MAX_CAPTURE_NODES } from "@/core/limit";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const fixture = (): IRV2 => deepFreeze({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1", "s2"], shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("ph2", "#section", [], { attrs: { "data-section": "s2" } }),
  ])]) }],
  sections: [
    { id: "s1", pageId: "pg", name: "one", role: "main", hash: "h1", origin: "capture", root: n("p", "div", [
      n("a", "h1", [n("ta", "#text", [], { text: "Hello" })], { styles: { base: { color: "red" }, bp: {}, state: {}, pseudo: {} }, box: { 1440: [0, 0, 10, 10] } }),
      n("b", "p"), n("c", "a", [], { attrs: { href: "/x" } }),
    ]) },
    { id: "s2", pageId: "pg", name: "two", role: "footer", hash: "h2", origin: "capture", root: n("q", "footer", [n("d", "span")]) },
  ],
  layouts: [{ id: "L", hash: "h2", sectionId: "s2", pageIds: ["pg"] }],
  components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const kids = (ir: IRV2, i = 0) => ir.sections[i]!.root.children;
const ids = () => { let i = 0; return () => `new${++i}`; };
const roundTrip = (ir: IRV2, commands: Parameters<typeof applyCommands>[1]) => {
  const result = applyCommands(ir, commands);
  expect(applyCommands(result.ir, result.inverse).ir).toEqual(ir);
  return result;
};

test("reorder keeps IDs, index counts after removal, undo restores the same IDs", () => {
  const frozen = fixture();
  const { ir: moved, inverse } = applyCommands(frozen, [{ op: "moveNode", id: "b", parentId: "p", index: 2 }]);
  expect(moved.sections[0]!.root.children.map((x) => x.id)).toEqual(["a", "c", "b"]);
  expect(applyCommands(moved, inverse).ir).toEqual(frozen);
  const nested = roundTrip(frozen, [{ op: "moveNode", id: "c", parentId: "a", index: 0 }]).ir;
  expect(kids(nested)[0]!.children.map((x) => [x.id, x.parentId])).toEqual([["c", "a"], ["ta", "a"]]);
});

test("setStyle writes base / 768 / state, null removes, inverse is exact", () => {
  const ir = fixture();
  const { ir: out } = roundTrip(ir, [
    { op: "setStyle", id: "a", target: "base", changes: { color: null, "font-size": "20px" } },
    { op: "setStyle", id: "a", target: 768, changes: { "font-size": "16px" } },
    { op: "setStyle", id: "b", target: "hover", changes: { color: "blue" } },
  ]);
  expect(kids(out)[0]!.styles).toEqual({ base: { "font-size": "20px" }, bp: { 768: { "font-size": "16px" } }, state: {}, pseudo: {} });
  expect(kids(out)[1]!.styles.state).toEqual({ hover: { color: "blue" } });
  const cleared = applyCommands(out, [{ op: "setStyle", id: "a", target: 768, changes: { "font-size": null } }]).ir;
  expect(kids(cleared)[0]!.styles.bp).toEqual({});
  for (const changes of [{ color: "red;}body{x:y" }, { "Bad Prop": "1" }, { color: "" }] as Record<string, string>[]) {
    expect(() => applyCommands(ir, [{ op: "setStyle", id: "a", target: "base", changes }])).toThrow(/command 0/);
  }
  expect(() => applyCommands(ir, [{ op: "setStyle", id: "a", target: 1024 as never, changes: { color: "red" } }])).toThrow(/target/);
  expect(() => applyCommands(ir, [{ op: "setStyle", id: "ta", target: "base", changes: { color: "red" } }])).toThrow(/#text/);
});

test("setText only on #text; setAttribute sets, removes and refuses unsafe input", () => {
  const ir = fixture();
  expect(kids(roundTrip(ir, [{ op: "setText", id: "ta", text: "Bye" }]).ir)[0]!.children[0]!.text).toBe("Bye");
  expect(() => applyCommands(ir, [{ op: "setText", id: "a", text: "x" }])).toThrow(/#text/);
  const { ir: out } = roundTrip(ir, [{ op: "setAttribute", id: "c", name: "href", value: null }, { op: "setAttribute", id: "c", name: "title", value: "t" }]);
  expect(kids(out)[2]!.attrs).toEqual({ title: "t" });
  for (const [name, value] of [["onclick", "x"], ["href", "java\tscript:alert(1)"], ["class", "x"], ["srcdoc", "x"], ["__proto__", "x"], ["a b", "x"]] as const) {
    expect(() => applyCommands(ir, [{ op: "setAttribute", id: "c", name, value }])).toThrow(/command 0/);
  }
  expect(() => applyCommands(ir, [{ op: "setAttribute", id: "ph1", name: "data-section", value: "s2" }])).toThrow(/placeholder/);
});

test("createNode gets server IDs, ignores client IDs, validates the draft", () => {
  const ir = fixture();
  const draft = { tag: "section", id: "evil", attrs: { title: "x" }, styles: { base: { color: "red" } }, children: [{ tag: "#text", text: "hi" }] } as unknown as NodeDraft;
  const commands = prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 1, draft }], ids());
  const { ir: out, createdIds } = roundTrip(ir, commands);
  expect(createdIds).toEqual(["new1"]);
  const created = kids(out)[1]!;
  expect([created.id, created.parentId, created.type, created.children[0]!.id, created.children[0]!.parentId]).toEqual(["new1", "p", "container", "new2", "new1"]);
  expect(JSON.stringify(out)).not.toContain("evil");
  for (const bad of [{ tag: "script" }, { tag: "#section" }, { tag: "div", attrs: { onload: "x" } }, { tag: "div", text: "x" }, { tag: "div", type: "weird" }, { tag: "div", component: { id: "x", role: "main" } }]) {
    expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft: bad } as never], ids())).toThrow(/command 0/);
  }
  expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 4, draft: { tag: "div" } }], ids())).toThrow(/index/);
  expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "ta", index: 0, draft: { tag: "div" } }], ids())).toThrow(/parent/);
  expect(() => applyCommands(ir, [{ op: "createNode", parentId: "p", index: 0, node: n("a", "div") }])).toThrow(/duplicate/);
  expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft: { tag: "div", children: [{ tag: "b" }] } }], () => "same")).toThrow(/duplicate/);
});

test("deleteNode and duplicateNode invert exactly; duplicate gets fresh IDs", () => {
  const ir = fixture();
  expect(kids(roundTrip(ir, [{ op: "deleteNode", id: "a" }]).ir).map((x) => x.id)).toEqual(["b", "c"]);
  const commands = prepareCommands(ir, [{ op: "duplicateNode", id: "a", parentId: "p", index: 3 }], ids());
  const { ir: out, createdIds } = roundTrip(ir, commands);
  expect(createdIds).toEqual(["new1"]);
  expect(kids(out).map((x) => x.id)).toEqual(["a", "b", "c", "new1"]);
  expect(kids(out)[3]!.children[0]).toMatchObject({ id: "new2", parentId: "new1", text: "Hello" });
  expect(kids(out)[3]!.box).toBeUndefined();
  // a later command in the same batch sees the earlier one's result (duplicate of a node created in the batch's tree)
  const batch = prepareCommands(ir, [{ op: "createNode", parentId: "a", index: 0, draft: { tag: "span" } }, { op: "duplicateNode", id: "a", parentId: "p", index: 0 }], ids());
  const copy = kids(applyCommands(ir, batch).ir)[0]!;
  expect([copy.id, ...copy.children.map((x) => x.id)]).toEqual(["new2", "new3", "new4"]);
});

test("protected roots, cycles and owner boundaries are refused", () => {
  const ir = fixture();
  const refused: EditorCommand[] = [
    { op: "deleteNode", id: "p" }, { op: "moveNode", id: "p", parentId: "a", index: 0 }, { op: "deleteNode", id: "html" },
    { op: "moveNode", id: "a", parentId: "ta", index: 0 }, { op: "moveNode", id: "a", parentId: "a", index: 0 },
    { op: "moveNode", id: "d", parentId: "p", index: 0 }, { op: "moveNode", id: "b", parentId: "body", index: 0 },
    { op: "duplicateNode", id: "ph1", parentId: "body", index: 0 }, { op: "duplicateNode", id: "d", parentId: "p", index: 0 },
    { op: "deleteNode", id: "missing" }, { op: "moveNode", id: "b", parentId: "p", index: 3 },
  ];
  for (const command of refused) expect(() => prepareCommands(ir, [command], ids()), JSON.stringify(command)).toThrow(/command 0/);
  const cycle = applyCommands(ir, [{ op: "moveNode", id: "b", parentId: "a", index: 0 }]).ir;
  expect(() => applyCommands(cycle, [{ op: "moveNode", id: "a", parentId: "b", index: 0 }])).toThrow(/cycle/);
});

test("shell edits sync section references and undo restores sections and layouts", () => {
  const ir = fixture();
  const moved = roundTrip(ir, [{ op: "moveNode", id: "ph2", parentId: "body", index: 0 }]).ir;
  expect(moved.pages[0]!.sectionIds).toEqual(["s2", "s1"]);
  const { ir: deleted, inverse } = roundTrip(ir, [{ op: "deleteNode", id: "ph2" }]);
  expect(deleted.pages[0]!.sectionIds).toEqual(["s1"]);
  expect(deleted.sections.map((s) => s.id)).toEqual(["s1"]);
  expect(deleted.layouts).toEqual([]);
  // the inverse of the inverse re-applies the edit (redo equivalence)
  const undone = applyCommands(deleted, inverse);
  expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(deleted);
});

test("a bad command rejects the whole batch with its index; private ops are not client input", () => {
  const ir = fixture();
  const before = JSON.stringify(ir);
  expect(() => applyCommands(ir, [{ op: "setText", id: "ta", text: "ok" }, { op: "deleteNode", id: "nope" }])).toThrow(/command 1.*nope/);
  expect(JSON.stringify(ir)).toBe(before);
  try { applyCommands(ir, [{ op: "deleteNode", id: "nope" }]); } catch (e) { expect((e as { code: string }).code).toBe("IR_PATCH_INVALID"); }
  expect(() => prepareCommands(ir, [{ op: "restoreNode", parentId: "p", index: 0, node: n("x", "div") } as never], ids())).toThrow(/unknown/);
  expect(() => applyCommands(ir, [{ op: "replaceSubtree", id: "a" } as never])).toThrow(/unknown/);
  expect(() => applyCommands(ir, [])).toThrow(/empty/);
});

test("limits: 50 commands, 500 nodes, 20 levels, 8 MB per step", () => {
  const ir = fixture();
  const text = (i: number) => ({ op: "setText" as const, id: "ta", text: `t${i}` });
  expect(applyCommands(ir, Array.from({ length: 50 }, (_, i) => text(i))).inverse).toHaveLength(50);
  expect(() => applyCommands(ir, Array.from({ length: 51 }, (_, i) => text(i)))).toThrow(/50/);
  expect(() => prepareCommands(ir, Array.from({ length: 51 }, (_, i) => text(i)), ids())).toThrow(/50/);
  let deep = { tag: "div", children: [] as unknown[] };
  for (let i = 0; i < 20; i++) deep = { tag: "div", children: [deep] };
  expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft: deep as never }], ids())).toThrow(/limit/);
  const wide = { tag: "div", children: Array.from({ length: 500 }, () => ({ tag: "span" })) };
  expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft: wide }], ids())).toThrow(/limit/);
  const big = "x".repeat(4.5 * 1024 * 1024);
  expect(applyCommands(ir, [{ op: "setText", id: "ta", text: big }]).ir).toBeDefined();
  // forward (4.5 MB) + inverse of the second edit (restores the 4.5 MB text) > 8 MB
  expect(() => applyCommands(ir, [{ op: "setText", id: "ta", text: big }, { op: "setText", id: "ta", text: "y" }])).toThrow(/8 MB/);
});

test("limits apply to the edited subtree, not the host section", () => {
  const blob = n("blob", "div", Array.from({ length: 500 }, (_, i) => n(`x${i}`, "span")));
  const leaves = Array.from({ length: 98 }, (_, i) => n(`leaf${i}`, "i"));
  const base = fixture();
  const ir = deepFreeze({ ...base, sections: [{ ...base.sections[0]!, id: "big", root: n("big", "div", [...leaves, blob]) }, ...base.sections.slice(1)] });
  expect(roundTrip(ir, [{ op: "deleteNode", id: "leaf0" }]).ir.sections[0]!.root.children).toHaveLength(98);
  expect(roundTrip(ir, [{ op: "moveNode", id: "leaf1", parentId: "leaf2", index: 0 }]).ir.sections[0]!.root.children).toHaveLength(98);
  expect(() => applyCommands(ir, [{ op: "deleteNode", id: "blob" }])).toThrow(/limit/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "blob", parentId: "leaf0", index: 0 }])).toThrow(/limit/);
});

test("page shells: property edits on existing nodes, only placeholders move or delete", () => {
  const ir = fixture();
  roundTrip(ir, [{ op: "setStyle", id: "body", target: "base", changes: { margin: "0" } }, { op: "setAttribute", id: "body", name: "lang", value: "vi" }]);
  const refused: EditorCommand[] = [
    { op: "createNode", parentId: "body", index: 0, draft: { tag: "div" } }, { op: "duplicateNode", id: "ph1", parentId: "body", index: 0 },
    { op: "deleteNode", id: "body" }, { op: "moveNode", id: "body", parentId: "html", index: 0 },
  ];
  for (const command of refused) expect(() => prepareCommands(ir, [command], ids()), command.op).toThrow(/placeholders/);
  expect(() => applyCommands(ir, [{ op: "restoreNode", parentId: "body", index: 0, node: n("x", "div") } as never])).toThrow(/placeholders/);
});

test("dependent shell commands in one batch undo exactly; malformed restore payloads are IR_PATCH_INVALID", () => {
  const ir = fixture();
  const { ir: out } = roundTrip(ir, [{ op: "moveNode", id: "ph2", parentId: "body", index: 0 }, { op: "deleteNode", id: "ph2" }]);
  expect(out.pages[0]!.sectionIds).toEqual(["s1"]);
  for (const node of [null, { id: "x" }, { id: "x", tag: "div", attrs: {}, styles: {}, children: [null] }]) {
    try {
      applyCommands(ir, [{ op: "restoreNode", parentId: "p", index: 0, node } as never]);
      expect.unreachable();
    } catch (e) { expect((e as { code: string }).code).toBe("IR_PATCH_INVALID"); }
  }
});

test("results stay loadable: page node ceiling and tree depth are enforced", () => {
  const base = fixture();
  // fixture page pg has 11 nodes; a third section brings it to MAX_CAPTURE_NODES - 3
  const filler = n("big", "div", Array.from({ length: MAX_CAPTURE_NODES - 15 }, (_, i) => n(`f${i}`, "i")));
  const full = { ...base, sections: [...base.sections, { ...base.sections[1]!, id: "s3", root: filler }] };
  const three = { tag: "div", children: [{ tag: "b" }, { tag: "b" }] };
  expect(applyCommands(full, prepareCommands(full, [{ op: "createNode", parentId: "p", index: 0, draft: three }], ids())).createdIds).toEqual(["new1"]);
  const four = { tag: "div", children: [{ tag: "b" }, { tag: "b" }, { tag: "b" }] };
  expect(() => prepareCommands(full, [{ op: "createNode", parentId: "p", index: 0, draft: four }], ids())).toThrow(/command 0.*page node limit/);
  expect(() => prepareCommands(full, [{ op: "duplicateNode", id: "a", parentId: "p", index: 0 }, { op: "duplicateNode", id: "a", parentId: "p", index: 0 }], ids())).toThrow(/command 1.*page node limit/);

  let deep = n("chain-999", "div");
  for (let i = 998; i >= 1; i--) deep = n(`chain-${i}`, "div", [deep]); // root depth 1 ... leaf depth 999
  const tall = { ...base, sections: [...base.sections, { ...base.sections[1]!, id: "s4", root: deep }] };
  expect(prepareCommands(tall, [{ op: "createNode", parentId: "chain-999", index: 0, draft: { tag: "b" } }], ids())).toHaveLength(1);
  expect(() => prepareCommands(tall, [{ op: "createNode", parentId: "chain-999", index: 0, draft: { tag: "b", children: [{ tag: "b" }] } }], ids())).toThrow(/depth limit/);
});
