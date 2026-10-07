import { expect, test } from "vitest";
import { applyCommands, prepareCommands, type EditorCommand, type NodeDraft } from "@/core/ir-command";
import { promoteLegacyComponents, resolveComponents } from "@/core/ir-component";
import type { LegacyIR, LegacyIRNode } from "@/core/ir-legacy";
import { toV2, type IRNodeV2, type IRV2 } from "@/core/ir-v2";
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
  for (const bad of [{ tag: "script" }, { tag: "div", children: [{ tag: "script" }] }, { tag: "#section" }, { tag: "div", attrs: { onload: "x" } }, { tag: "div", text: "x" }, { tag: "div", type: "weird" }, { tag: "div", component: { id: "x", role: "main" } }]) {
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

test("duplicateNode strips html ids and id references from every copied node (R12); the original keeps them; undo is exact", () => {
  const base = fixture();
  const withIds = { ...base, sections: base.sections.map((s, i) => i ? s : { ...s, root: n("p", "div", [
    n("a", "label", [n("in", "input", [], { attrs: { id: "email", "aria-controls": "x", title: "t" } })], { attrs: { for: "email", "aria-labelledby": "y" } }), n("b", "p"),
  ]) }) };
  const { ir: out } = roundTrip(withIds, prepareCommands(withIds, [{ op: "duplicateNode", id: "a", parentId: "p", index: 2 }], ids()));
  expect(kids(out)[0]!.attrs).toEqual({ for: "email", "aria-labelledby": "y" });
  expect(kids(out)[0]!.children[0]!.attrs).toEqual({ id: "email", "aria-controls": "x", title: "t" });
  expect(kids(out)[2]!.attrs).toEqual({});
  expect(kids(out)[2]!.children[0]!.attrs).toEqual({ title: "t" });
});

test("a section placeholder moves into another shell parent (body -> main) and back on undo", () => {
  const base = fixture();
  const ir = { ...base, pages: [{ ...base.pages[0]!, shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("main", "main", [n("ph2", "#section", [], { attrs: { "data-section": "s2" } })]),
  ])]) }] };
  const moved = roundTrip(ir, [{ op: "moveNode", id: "ph1", parentId: "main", index: 1 }]).ir;
  expect(moved.pages[0]!.sectionIds).toEqual(["s2", "s1"]);
});

test("protected roots, cycles and owner boundaries are refused", () => {
  const ir = fixture();
  const refused: EditorCommand[] = [
    { op: "deleteNode", id: "p" }, { op: "moveNode", id: "p", parentId: "a", index: 0 }, { op: "deleteNode", id: "html" },
    { op: "moveNode", id: "a", parentId: "ta", index: 0 }, { op: "moveNode", id: "a", parentId: "a", index: 0 },
    { op: "moveNode", id: "b", parentId: "body", index: 0 },
    { op: "duplicateNode", id: "ph1", parentId: "body", index: 0 }, { op: "duplicateNode", id: "d", parentId: "p", index: 0 },
    { op: "deleteNode", id: "missing" }, { op: "moveNode", id: "b", parentId: "p", index: 3 },
  ];
  for (const command of refused) expect(() => prepareCommands(ir, [command], ids()), JSON.stringify(command)).toThrow(/command 0/);
  const cycle = applyCommands(ir, [{ op: "moveNode", id: "b", parentId: "a", index: 0 }]).ir;
  expect(() => applyCommands(cycle, [{ op: "moveNode", id: "a", parentId: "b", index: 0 }])).toThrow(/cycle/);
});

test("E3b R1: moveNode between two sections keeps the ids of the whole subtree and inverts exactly; shell and main boundaries still hold", () => {
  const ir = fixture();
  const out = roundTrip(ir, [{ op: "moveNode", id: "d", parentId: "p", index: 1 }]).ir;
  expect(kids(out).map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
  expect(kids(out)[1]!.parentId).toBe("p");
  expect(kids(out, 1)).toEqual([]);
  const back = roundTrip(out, [{ op: "moveNode", id: "a", parentId: "q", index: 0 }]).ir; // with its #text child
  expect(kids(back, 1)[0]).toMatchObject({ id: "a", parentId: "q", children: [{ id: "ta", parentId: "a" }] });
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "b", parentId: "body", index: 0 }])).toThrow(/boundaries/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "d", parentId: "p", index: 9 }])).toThrow(/index out of range/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "d", parentId: "ta", index: 0 }])).toThrow(/cannot have children/);
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

// --- Task 6: layout + component commands ---
const twoPages = (): IRV2 => deepFreeze({
  ...fixture(),
  pages: [
    fixture().pages[0]!,
    { id: "pg2", path: "/b", title: "", meta: {}, sectionIds: ["s3"], shell: n("html2", "html", [n("body2", "body", [n("ph3", "#section", [], { attrs: { "data-section": "s3" } })])]) },
  ],
  sections: [...fixture().sections, { id: "s3", pageId: "pg2", name: "three", role: "footer", hash: "h2", origin: "capture", root: n("r", "footer", [n("e", "span")]) }],
});

test("promoteLayout across two pages: undo restores sectionIds, placeholder, layout and the dropped root", () => {
  const ir = twoPages();
  const { ir: out, inverse } = roundTrip(ir, [{ op: "promoteLayout", sectionIds: ["s1", "s3"] }]);
  expect(out.pages.map((p) => p.sectionIds)).toEqual([["s1", "s2"], ["s1"]]);
  expect(out.pages[1]!.shell.children[0]!.children[0]!.attrs["data-section"]).toBe("s1");
  expect(out.sections.map((s) => s.id)).toEqual(["s1", "s2"]);
  const layout = out.layouts.find((l) => l.sectionId === "s1")!;
  expect(layout.pageIds).toEqual(["pg", "pg2"]);
  expect(out.sections[0]!.layoutId).toBe(layout.id);
  const undone = applyCommands(out, inverse);
  expect(undone.ir.sections[2]!.root).toEqual(ir.sections[2]!.root);
  expect("layoutId" in undone.ir.sections[0]!).toBe(false);
  expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out); // redo
  // a follow-up shell edit on the layout still round-trips
  roundTrip(out, [{ op: "deleteNode", id: "ph3" }]);
  for (const sectionIds of [["s1", "s2"], ["s1"], ["s1", "nope"], "s1"] as never[]) {
    expect(() => applyCommands(ir, [{ op: "promoteLayout", sectionIds }])).toThrow(/command 0 \(promoteLayout\)/);
  }
  expect(prepareCommands(ir, [{ op: "promoteLayout", sectionIds: ["s1", "s3"] }], ids())).toEqual([{ op: "promoteLayout", sectionIds: ["s1", "s3"] }]);
});

const cardsLegacy = (): LegacyIR => {
  const l = (id: string, tag: string, children: LegacyIRNode[] = [], text?: string): LegacyIRNode => ({ id, tag, attrs: {}, cls: [], children, ...(text === undefined ? {} : { text }) });
  return {
    pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: l("shell", "html", [{ ...l("ph", "#section"), attrs: { "data-section": "s" } }]) }],
    sections: [{ id: "s", pageId: "p", name: "cards", role: "main", hash: "s", origin: "capture", root: l("section", "section", [0, 1, 2].map((i) => ({ ...l(`card${i}`, "article", [l(`label${i}`, "span", [l(`text${i}`, "#text", [], `Card ${i}`)]), l(`extra${i}`, "small")]), cls: [i === 1 ? "blue" : "red"] }))) }],
    components: [{ id: "cards", hash: "cards", instanceIds: ["card0", "card1", "card2"] }],
    classes: { red: { base: { color: "red" } }, blue: { base: { color: "blue" } } }, layouts: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [],
  };
};
const cardsIr = (): IRV2 => { const v1 = cardsLegacy(); return deepFreeze(promoteLegacyComponents(toV2(v1, []), v1.components)); };
const card = (ir: IRV2, i: number) => resolveComponents(ir).sections[0]!.root.children[i]!;
const textOf = (x: IRNodeV2): string => (x.text ?? "") + x.children.map(textOf).join("");
const all = (x: IRNodeV2): IRNodeV2[] => [x, ...x.children.flatMap(all)];
const overridesOf = (ir: IRV2, id: string) => all(ir.sections[0]!.root).find((x) => x.id === id)?.component?.overrides;

test("instance property edits record override paths and survive resolve; main edits reach non-overriding instances", () => {
  const ir = cardsIr(), mainRoot = ir.components[0]!.root.id;
  const { ir: out } = roundTrip(ir, [
    { op: "setStyle", id: "card2", target: 768, changes: { color: "pink" } },
    { op: "setAttribute", id: "card0", name: "title", value: "t" },
    { op: "setText", id: "text0", text: "Zero" },
    { op: "setHidden", id: "extra2", hidden: true },
    { op: "setStyle", id: mainRoot, target: "base", changes: { color: "green" } },
  ]);
  expect(overridesOf(out, "card2")).toEqual(["styles.bp.768.color"]);
  expect(overridesOf(out, "text0")).toEqual(["text"]);
  expect(overridesOf(out, "extra2")).toEqual(["hidden"]);
  expect(card(out, 2).styles.bp[768]).toEqual({ color: "pink" });
  expect(card(out, 0).attrs.title).toBe("t");
  expect(textOf(card(out, 0))).toBe("Zero");
  expect(card(out, 2).children[1]!.hidden).toBe(true);
  // main change: card0/card2 do not override base color, card1 does
  expect([0, 1, 2].map((i) => card(out, i).styles.base.color)).toEqual(["green", "blue", "green"]);
  // editing an overridden path again keeps a single entry
  expect(overridesOf(applyCommands(out, [{ op: "setText", id: "text0", text: "Z" }]).ir, "text0")).toEqual(["text"]);
  expect(() => applyCommands(ir, [{ op: "setAttribute", id: "card0", name: "constructor", value: null }])).toThrow(/override/);
});

test("setHidden toggles, undoes exactly and validates", () => {
  const ir = fixture();
  const hidden = roundTrip(ir, [{ op: "setHidden", id: "b", hidden: true }]).ir;
  expect(kids(hidden)[1]!.hidden).toBe(true);
  expect("hidden" in kids(roundTrip(hidden, [{ op: "setHidden", id: "b", hidden: false }]).ir)[1]!).toBe(false);
  expect(() => applyCommands(ir, [{ op: "setHidden", id: "b", hidden: "yes" as never }])).toThrow(/boolean/);
  expect(() => applyCommands(ir, [{ op: "setHidden", id: "ph1", hidden: true }])).toThrow(/placeholder/);
  expect(prepareCommands(ir, [{ op: "setHidden", id: "b", hidden: true, x: 1 } as never], ids())).toEqual([{ op: "setHidden", id: "b", hidden: true }]);
});

test("resetOverride and detachComponent undo exactly", () => {
  const ir = cardsIr();
  const reset = roundTrip(ir, [{ op: "resetOverride", instanceId: "card1", path: "styles.base.color" }]);
  expect(overridesOf(reset.ir, "card1")).toEqual([]);
  expect(card(reset.ir, 1).styles.base.color).toBe("red");
  const undone = applyCommands(reset.ir, reset.inverse);
  expect(overridesOf(undone.ir, "card1")).toEqual(["styles.base.color"]);
  expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(reset.ir); // redo
  expect(textOf(card(roundTrip(ir, [{ op: "resetOverride", instanceId: "card1" }]).ir, 1))).toBe("Card 0");

  const result = applyCommands(ir, [{ op: "detachComponent", instanceId: "card1" }]);
  expect(result.ir.components[0]!.instanceIds).toEqual(["card0", "card2"]);
  expect(result.ir.sections[0]!.root.children[1]!.component).toBeUndefined();
  expect(applyCommands(result.ir, result.inverse).ir).toEqual(ir);

  expect(() => applyCommands(ir, [{ op: "resetOverride", instanceId: "card1", path: "text" }])).toThrow(/no override/);
  expect(() => applyCommands(ir, [{ op: "resetOverride", instanceId: "section" }])).toThrow(/instance/);
  expect(() => applyCommands(ir, [{ op: "detachComponent", instanceId: ir.components[0]!.root.id }])).toThrow(/command 0 \(detachComponent\)/);
});

test("reset/detach store only the target instance: other instances stay shared, the inverse holds the target alone", () => {
  const base = cardsIr(), mainId = base.components[0]!.root.id;
  // a stale stored value (card0/card2 show the main's green) and a main child no instance stores yet
  const ir = deepFreeze(applyCommands(base, [
    { op: "setStyle", id: mainId, target: "base", changes: { color: "green" } },
    { op: "createNode", parentId: mainId, index: 2, node: n("added", "i") },
  ]).ir);
  for (const command of [
    { op: "resetOverride", instanceId: "card1" }, { op: "resetOverride", instanceId: "card1", path: "styles.base.color" },
    { op: "detachComponent", instanceId: "card1" }, { op: "detachComponent", instanceId: "label1" },
  ] as const) {
    const { ir: out, inverse } = roundTrip(ir, [command]);
    expect(kids(out)[0]).toBe(kids(ir)[0]);
    expect(kids(out)[2]).toBe(kids(ir)[2]);
    expect(out.pages).toBe(ir.pages);
    expect(out.components[0]!.root).toBe(ir.components[0]!.root);
    const undo = JSON.stringify(inverse);
    for (const id of ["label0", "text0", "label2", "text2"]) expect(undo).not.toContain(`"${id}"`);
    const undone = applyCommands(out, inverse);
    expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out); // redo
    expect(card(out, 0).styles.base.color).toBe("green");
    expect(card(out, 0).children[2]!.id).toMatch(/^instance:/);
  }
});

test("main structure edits that orphan an instance override are refused; instance roots keep instanceIds in sync", () => {
  const ir = cardsIr(), main = ir.components[0]!.root;
  const overriddenMainChildId = main.children[0]!.children[0]!.id; // text0's source: text1/text2 override "text"
  expect(() => applyCommands(ir, [{ op: "deleteNode", id: overriddenMainChildId }])).toThrow(/instance/);
  expect(() => applyCommands(ir, [{ op: "deleteNode", id: main.children[0]!.id }])).toThrow(/instance text/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: overriddenMainChildId, parentId: main.children[1]!.id, index: 0 }])).toThrow(/instance/);
  // extra has no override anywhere: it can be removed from the main, and undone
  const trimmed = roundTrip(ir, [{ op: "deleteNode", id: main.children[1]!.id }]).ir;
  expect(card(trimmed, 0).children.map((x) => x.id)).toEqual(["label0"]);
  // editing the orphaned instance node is refused (it would never render)
  expect(() => applyCommands(trimmed, [{ op: "setHidden", id: "extra0", hidden: true }])).toThrow(/main source/);

  const { ir: out } = roundTrip(ir, [{ op: "deleteNode", id: "card1" }]);
  expect(out.components[0]!.instanceIds).toEqual(["card0", "card2"]);
  expect(out.components[0]!.root).toBe(main); // deleting an instance never touches the main
  // structural edits inside an instance: edit the main or detach first
  expect(() => applyCommands(ir, [{ op: "deleteNode", id: "extra0" }])).toThrow(/inside component instance/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "card1", parentId: "card0", index: 0 }])).toThrow(/inside component instance/);
  expect(() => applyCommands(ir, [{ op: "createNode", parentId: "card0", index: 0, node: n("x", "div") }])).toThrow(/inside component instance/);
  // shell placeholder delete drops the section and its instances from instanceIds
  expect(roundTrip(ir, [{ op: "deleteNode", id: "ph" }]).ir.components[0]!.instanceIds).toEqual([]);
});

test("instance override paths follow the resolver's rule: an empty attribute name is refused and the document still resolves", () => {
  const ir = cardsIr();
  for (const value of ["x", null]) {
    expect(() => applyCommands(ir, [{ op: "setAttribute", id: "card0", name: "", value }])).toThrow(/command 0 \(setAttribute\).*non-empty/);
  }
  expect(() => resolveComponents(ir)).not.toThrow();
  const bad = [{ op: "restoreComponent", command: { op: "setText", id: "text0", text: "x" }, trees: [], instanceIds: [["card0", "card1", "card2"]] }] as never;
  expect(() => applyCommands(ir, bad)).toThrow(/invalid component restore/);
  const out = applyCommands(twoPages(), [{ op: "promoteLayout", sectionIds: ["s1", "s3"] }]);
  const inverse = [{ ...out.inverse[0]!, layoutId: 42 }] as never;
  expect(() => applyCommands(out.ir, inverse)).toThrow(/invalid layout restore/);
});

test("setHidden refuses the page html/body but allows other shell nodes; on a main it reaches non-overriding instances", () => {
  const ir = fixture();
  for (const id of ["html", "body"]) expect(() => applyCommands(ir, [{ op: "setHidden", id, hidden: true }])).toThrow(/cannot be hidden/);
  const shell = { ...ir, pages: [{ ...ir.pages[0]!, shell: n("html", "html", [n("body", "body", [n("nav", "nav"), ...ir.pages[0]!.shell.children[0]!.children.map((c) => ({ ...c }))])]) }] };
  expect(roundTrip(shell, [{ op: "setHidden", id: "nav", hidden: true }]).ir.pages[0]!.shell.children[0]!.children[0]!.hidden).toBe(true);

  const cards = cardsIr(), extraMain = cards.components[0]!.root.children[1]!.id;
  const own = applyCommands(cards, [{ op: "setHidden", id: "extra2", hidden: false }]).ir; // card2 overrides "hidden"
  const out = roundTrip(own, [{ op: "setHidden", id: extraMain, hidden: true }]).ir;
  expect([0, 1, 2].map((i) => card(out, i).children[1]!.hidden)).toEqual([true, true, undefined]);
});

test("a batch mixing detach with property edits round-trips (undo and redo)", () => {
  const ir = cardsIr();
  const batch: Parameters<typeof applyCommands>[1] = [
    { op: "setText", id: "text1", text: "One" },
    { op: "detachComponent", instanceId: "card1" },
    { op: "setStyle", id: "card1", target: "base", changes: { color: "black" } }, // plain node now: no override
    { op: "setStyle", id: "card0", target: "base", changes: { color: "gold" } },
  ];
  const { ir: out, inverse } = roundTrip(ir, batch);
  expect(out.sections[0]!.root.children[1]!.component).toBeUndefined();
  expect(textOf(out.sections[0]!.root.children[1]!)).toBe("One");
  expect(overridesOf(out, "card0")).toEqual(["styles.base.color"]);
  const undone = applyCommands(out, inverse);
  expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out);
});

test("promoteLayout dropping a section that holds instances round-trips instanceIds", () => {
  const v1 = cardsLegacy();
  v1.pages.push({ id: "p2", path: "/b", title: "", meta: {}, sectionIds: ["s2"], shell: { id: "shell2", tag: "html", attrs: {}, cls: [], children: [{ id: "ph2", tag: "#section", attrs: { "data-section": "s2" }, cls: [], children: [] }] } });
  v1.sections.push({ id: "s2", pageId: "p2", name: "other", role: "main", hash: "s2", origin: "capture", root: { id: "plain", tag: "section", attrs: {}, cls: [], children: [] } });
  const ir = deepFreeze(promoteLegacyComponents(toV2(v1, []), v1.components));
  const { ir: out, inverse } = roundTrip(ir, [{ op: "promoteLayout", sectionIds: ["s2", "s"] }]);
  expect(out.sections.map((s) => s.id)).toEqual(["s2"]);
  expect(out.components[0]!.instanceIds).toEqual([]);
  const undone = applyCommands(out, inverse);
  expect(undone.ir.components[0]!.instanceIds).toEqual(["card0", "card1", "card2"]);
  expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out);
});

test("setName trims, holds 1–80 characters, inverts exactly; an instance records a name override; #text and placeholders are refused", () => {
  const ir = fixture();
  const named = roundTrip(ir, [{ op: "setName", id: "a", name: "  Tiêu đề chính  " }]).ir;
  expect(kids(named)[0]!.name).toBe("Tiêu đề chính");
  expect(prepareCommands(ir, [{ op: "setName", id: "a", name: "x".repeat(80) }], ids())).toEqual([{ op: "setName", id: "a", name: "x".repeat(80) }]);
  for (const name of ["", "   ", "x".repeat(81)]) expect(() => prepareCommands(ir, [{ op: "setName", id: "a", name }], ids()), JSON.stringify(name)).toThrow(/1–80/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "a", name: 5 as never }])).toThrow(/string/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "ta", name: "t" }])).toThrow(/#text/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "ph1", name: "t" }])).toThrow(/placeholder/);
  const cards = cardsIr();
  const out = roundTrip(cards, [{ op: "setName", id: "card1", name: "Thẻ giữa" }]).ir;
  expect(overridesOf(out, "card1")).toContain("name");
  expect(card(out, 1).name).toBe("Thẻ giữa");
});

test("E3b R2: convertToComponent names nodes an earlier createNode of the batch made (new:<k>/<path>); History keeps real ids; bad refs are refused", () => {
  const ir = fixture();
  const draft: NodeDraft = { tag: "div", children: [{ tag: "div", styles: { base: { overflow: "hidden" } }, children: [{ tag: "div", children: [{ tag: "div" }, { tag: "div" }] }] }] };
  const forward = prepareCommands(ir, [
    { op: "createNode", parentId: "p", index: 0, draft },
    { op: "convertToComponent", id: "new:0/", kind: "carousel", roles: { viewport: "new:0/0", track: "new:0/0.0", slides: ["new:0/0.0.0", "new:0/0.0.1"] } },
  ], ids());
  expect(forward[1]).toEqual({ op: "convertToComponent", id: "new1", kind: "carousel", roles: { viewport: "new2", track: "new3", slides: ["new4", "new5"] } });
  const done = roundTrip(ir, forward);
  expect(kids(done.ir)[0]!.interactive).toMatchObject({ kind: "carousel", viewport: "new2", track: "new3", slides: ["new4", "new5"] });
  expect(done.createdIds).toEqual(["new1"]);
  for (const ref of ["new:1/", "new:0/9", "new:0/0.0.0.0", "new:7/"]) {
    expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft }, { op: "convertToComponent", id: ref, kind: "carousel", roles: {} }], ids()), ref).toThrow(/command 1/);
  }
  // a plain id that only looks alike is left alone (and then simply not found)
  expect(() => prepareCommands(ir, [{ op: "convertToComponent", id: "new:x", kind: "carousel", roles: {} }], ids())).toThrow(/not found/);
  // client JSON: prototype keys and deep nesting are refused before anything resolves
  const create: EditorCommand = { op: "createNode", parentId: "p", index: 0, draft };
  const roles = JSON.parse('{"__proto__":{"viewport":"new:0/0"}}') as Record<string, unknown>;
  expect(() => prepareCommands(ir, [create, { op: "convertToComponent", id: "new:0/", kind: "carousel", roles }], ids())).toThrow(/command 1/);
  const deep = JSON.parse(`{"x":${"[".repeat(50)}${"]".repeat(50)}}`) as Record<string, unknown>;
  expect(() => prepareCommands(ir, [create, { op: "convertToComponent", id: "new:0/", kind: "carousel", roles: deep }], ids())).toThrow(/command 1/);
});
