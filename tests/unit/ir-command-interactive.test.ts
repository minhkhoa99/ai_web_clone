import { expect, test } from "vitest";
import { refreshFidelity } from "@/core/fidelity";
import { applyCommands, prepareCommands, type EditorCommand } from "@/core/ir-command";
import { resolveComponents } from "@/core/ir-component";
import type { CarouselSpec, InteractiveSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const spec: CarouselSpec = { kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1"], active: 0,
  autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: { "1440": 0 } };
const fixture = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["a", "b"], shell: n("html", "html", [n("body", "body", [n("pa", "#section", [], { attrs: { "data-section": "a" } }), n("pb", "#section", [], { attrs: { "data-section": "b" } })])]) }],
  sections: [
    { id: "a", pageId: "pg", name: "a", role: "block", hash: "h", origin: "capture", root: n("sec", "section", [
      n("root", "div", [n("vp", "div", [n("tr", "div", [n("s0", "div"), n("s1", "div")])])], { interactive: spec }),
      n("dlg", "div", [n("x", "button")], { interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc"] } }),
      n("tabs", "div", [n("t1", "button"), n("p1", "div")]),
    ]) },
    { id: "b", pageId: "pg", name: "b", role: "block", hash: "h2", origin: "capture", root: n("sec2", "section", [n("open", "button")]) },
  ],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const ids = () => { let i = 0; return () => `new${++i}`; };
const run = (ir: IRV2, commands: EditorCommand[]) => applyCommands(ir, prepareCommands(ir, commands, ids()));
const node = (ir: IRV2, id: string): IRNodeV2 | undefined => { let hit: IRNodeV2 | undefined; const v = (x: IRNodeV2) => { if (x.id === id) hit = x; x.children.forEach(v); }; ir.sections.forEach((s) => v(s.root)); return hit; };
const roundTrip = (ir: IRV2, commands: EditorCommand[]) => { const out = run(ir, commands); expect(applyCommands(out.ir, out.inverse).ir).toEqual(ir); return out; };

test("updateComponent: schema per kind, exact inverse; foreign fields, bad values and id-list changes are refused", () => {
  const { ir } = roundTrip(fixture(), [{ op: "updateComponent", id: "root", patch: { autoplay: true, interval: 4000, slidesPerView: { "1440": 1, "768": 2 } } }]);
  expect(node(ir, "root")!.interactive).toMatchObject({ autoplay: true, interval: 4000, slidesPerView: { "768": 2 }, confidence: "config" });
  for (const patch of [{ tabs: [] }, { interval: 10 }, { slides: ["s1", "s0"] }, { kind: "tabs" }, { confidence: "manual" }])
    expect(() => run(fixture(), [{ op: "updateComponent", id: "root", patch }])).toThrow(/IR_PATCH_INVALID|not allowed|invalid/);
  expect(() => run(fixture(), [{ op: "updateComponent", id: "tabs", patch: { active: 0 } }])).toThrow(/no interactive/);
});

test("updateComponent on an instance writes interactive.<field> overrides", () => {
  const ir = fixture();
  const inst = node(ir, "root")!;
  inst.component = { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] };
  ir.components = [{ id: "c", root: n("m", "div", [n("mvp", "div", [n("mtr", "div", [n("m0", "div"), n("m1", "div")])])], { component: { id: "c", role: "main" } }), instanceIds: ["root"] }];
  for (const x of [["vp", "mvp"], ["tr", "mtr"], ["s0", "m0"], ["s1", "m1"]] as const) node(ir, x[0])!.component = { id: "c", role: "instance", sourceId: x[1], overrides: [] };
  const out = run(ir, [{ op: "updateComponent", id: "root", patch: { loop: true } }]).ir;
  expect(node(out, "root")!.component!.overrides).toEqual(expect.arrayContaining(["interactive", "interactive.loop"]));
  expect(node(resolveComponents(out), "root")!.interactive).toMatchObject({ loop: true });
});

test("convertToComponent (manual) validates like load; unwrapComponent removes it, Undo restores, Fidelity marks the unwrap", () => {
  const { ir } = roundTrip(fixture(), [{ op: "convertToComponent", id: "tabs", kind: "tabs", roles: { tabs: [{ trigger: "t1", panel: "p1" }] } }]);
  expect(node(ir, "tabs")!.interactive).toEqual({ kind: "tabs", source: "manual", confidence: "manual", tabs: [{ trigger: "t1", panel: "p1" }], active: 0 });
  expect(() => run(fixture(), [{ op: "convertToComponent", id: "tabs", kind: "tabs", roles: { tabs: [{ trigger: "t1", panel: "open" }] } }])).toThrow(/outside/);
  expect(() => run(fixture(), [{ op: "convertToComponent", id: "root", kind: "tabs", roles: { tabs: [{ trigger: "s0", panel: "s1" }] } }])).toThrow(/already/);
  const unwrapped = roundTrip(fixture(), [{ op: "unwrapComponent", id: "root" }]).ir;
  expect(node(unwrapped, "root")!.interactive).toBeUndefined();
  const before = refreshFidelity([], fixture(), []);
  expect(refreshFidelity(before, unwrapped, []).some((x) => x.nodeId === "root" && x.note.includes("bỏ hành vi theo yêu cầu"))).toBe(true);
});

test("Review Focus 3 — tree commands cannot break a component: slide / outside modal trigger refused by role, whole component fine", () => {
  expect(() => run(fixture(), [{ op: "deleteNode", id: "s1" }])).toThrow(/slide.*removeComponentItem/);
  expect(() => run(fixture(), [{ op: "deleteNode", id: "open" }])).toThrow(/trigger/);
  expect(() => run(fixture(), [{ op: "moveNode", id: "s1", parentId: "tr", index: 0 }])).toThrow(/moveComponentItem/);
  expect(() => run(fixture(), [{ op: "createNode", parentId: "tr", index: 0, draft: { tag: "div" } }])).toThrow(/addComponentItem/);
  expect(() => run(fixture(), [{ op: "deleteNode", id: "root" }])).not.toThrow();
  const copy = run(fixture(), [{ op: "duplicateNode", id: "root", parentId: "sec", index: 3 }]).ir;
  expect(node(copy, "new1")!.interactive).toBeUndefined(); // R12: a copy is static
  expect(() => run(fixture(), [{ op: "setHidden", id: "s1", hidden: true }])).not.toThrow();
});

// --- edge cases ---
const withArrow = (): IRV2 => { const ir = fixture(); const root = node(ir, "root")!; root.children.push({ ...n("nx", "button"), parentId: "root" }); return ir; };
test("redo replays the inverse of the inverse: update / convert / unwrap come back exactly", () => {
  for (const commands of [
    [{ op: "updateComponent", id: "root", patch: { autoplay: true, arrows: { next: "nx" } } }],
    [{ op: "convertToComponent", id: "tabs", kind: "tabs", roles: { tabs: [{ trigger: "t1", panel: "p1" }] } }],
    [{ op: "unwrapComponent", id: "root" }],
  ] as EditorCommand[][]) {
    const out = run(withArrow(), commands);
    const undone = applyCommands(out.ir, out.inverse);
    expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out.ir);
  }
});

test("updateComponent: optional fields take null to drop; accordion items only change `open`; commands are refused on mains", () => {
  const withArrows = run(withArrow(), [{ op: "updateComponent", id: "root", patch: { arrows: { next: "nx" } } }]).ir;
  expect((node(withArrows, "root")!.interactive as CarouselSpec).arrows).toEqual({ next: "nx" });
  expect(() => applyCommands(withArrows, prepareCommands(withArrows, [{ op: "deleteNode", id: "nx" }], ids()))).toThrow(/nút next của carousel root/);
  const dropped = applyCommands(withArrows, prepareCommands(withArrows, [{ op: "updateComponent", id: "root", patch: { arrows: null } }], ids())).ir;
  expect(node(dropped, "root")!.interactive).not.toHaveProperty("arrows");
  expect(() => run(fixture(), [{ op: "updateComponent", id: "root", patch: {} }])).toThrow(/non-empty/);
  expect(() => run(fixture(), [{ op: "updateComponent", id: "root", patch: { arrows: { next: "open" } } }])).toThrow(/outside/);

  const acc = run(fixture(), [{ op: "convertToComponent", id: "tabs", kind: "accordion", roles: { items: [{ trigger: "t1", panel: "p1" }] } }]).ir;
  expect(node(acc, "tabs")!.interactive).toMatchObject({ items: [{ trigger: "t1", panel: "p1", open: false }], multiple: true, confidence: "manual" });
  const opened = applyCommands(acc, prepareCommands(acc, [{ op: "updateComponent", id: "tabs", patch: { items: [{ trigger: "t1", panel: "p1", open: true }] } }], ids())).ir;
  expect((node(opened, "tabs")!.interactive as Extract<InteractiveSpec, { kind: "accordion" }>).items[0]!.open).toBe(true);
  expect(() => applyCommands(acc, prepareCommands(acc, [{ op: "updateComponent", id: "tabs", patch: { items: [{ trigger: "p1", panel: "t1", open: true }] } }], ids()))).toThrow(/only `open`/);

  const ir = fixture();
  ir.components = [{ id: "c", root: n("m", "div", [n("m0", "button"), n("m1", "div")], { component: { id: "c", role: "main" } }), instanceIds: [] }];
  expect(() => run(ir, [{ op: "convertToComponent", id: "m", kind: "tabs", roles: { tabs: [{ trigger: "m0", panel: "m1" }] } }])).toThrow(/component main/);
});

test("every batch is validated after each command: a step that breaks a component names its index", () => {
  const ir = run(fixture(), [{ op: "updateComponent", id: "dlg", patch: { closeButton: "x", closeOn: ["esc", "button"] } }]).ir;
  expect(() => applyCommands(ir, prepareCommands(ir, [{ op: "setHidden", id: "x", hidden: true }, { op: "deleteNode", id: "x" }], ids()))).toThrow(/command 1 \(deleteNode\).*nút đóng/);
  // applyCommands alone (History payloads) re-validates too: a restoreProps can't plant a spec pointing outside its root
  const { id: _id, parentId: _p, children: _c, ...props } = node(fixture(), "tabs")!;
  const planted = { ...props, interactive: { kind: "tabs", source: "manual", confidence: "manual", tabs: [{ trigger: "t1", panel: "open" }], active: 0 } as InteractiveSpec };
  expect(() => applyCommands(fixture(), [{ op: "setHidden", id: "t1", hidden: true }, { op: "restoreProps", id: "tabs", props: planted }])).toThrow(/command 1 \(restoreProps\).*outside/);
});

// --- Task 11: item commands ---
const texted = (): IRV2 => {
  const ir = fixture();
  node(ir, "s0")!.children = [n("s0t", "#text", [], { text: "A", parentId: "s0" }), n("s0i", "img", [], { attrs: { src: "https://x.test/a.png", alt: "a" }, parentId: "s0" })];
  node(ir, "s1")!.children = [n("s1t", "#text", [], { text: "B", parentId: "s1" })];
  return ir;
};
const slides = (ir: IRV2) => (node(ir, "root")!.interactive as CarouselSpec).slides;

test("addComponentItem: blank slide (text/img emptied) or a duplicate of `from`; server ids; active follows; Undo/Redo exact", () => {
  const ir = texted();
  const forward = prepareCommands(ir, [{ op: "addComponentItem", id: "root", index: 0 }], ids());
  const done = applyCommands(ir, forward);
  expect(slides(done.ir)).toEqual(["new1", "s0", "s1"]);
  expect(node(done.ir, "new1")!.children.map((c) => [c.tag, c.text, c.attrs.src])).toEqual([["#text", "", undefined], ["img", undefined, undefined]]);
  expect(applyCommands(done.ir, done.inverse).ir).toEqual(ir);
  expect(applyCommands(applyCommands(done.ir, done.inverse).ir, forward).ir).toEqual(done.ir); // redo: same ids
  const dup = run(texted(), [{ op: "addComponentItem", id: "root", from: "s1", index: 2 }]).ir;
  expect(node(dup, slides(dup)[2]!)!.children[0]!.text).toBe("B");
  const moved = run(texted(), [{ op: "updateComponent", id: "root", patch: { active: 1 } }, { op: "addComponentItem", id: "root", index: 0 }]).ir;
  expect((node(moved, "root")!.interactive as CarouselSpec).active).toBe(2);
});

test("tabs/accordion items: trigger + panel copied (no duplicate html ids); <details> container copied as one", () => {
  const ir = fixture();
  node(ir, "tabs")!.interactive = { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t1", panel: "p1" }], active: 0 };
  node(ir, "t1")!.attrs = { id: "tab-1", "aria-controls": "panel-1" };
  const out = run(ir, [{ op: "addComponentItem", id: "tabs", from: "t1", index: 1 }]).ir;
  const tabs = (node(out, "tabs")!.interactive as InteractiveSpec & { tabs: { trigger: string; panel: string }[] }).tabs;
  expect(tabs).toHaveLength(2);
  expect(node(out, tabs[1]!.trigger)!.attrs).toEqual({});
  expect(node(out, "tabs")!.children.map((c) => c.id)).toEqual(["t1", tabs[1]!.trigger, "p1", tabs[1]!.panel]);
});

test("removeComponentItem: active adjusts, the last item cannot go, Undo puts the node back at its place", () => {
  const ir = run(texted(), [{ op: "updateComponent", id: "root", patch: { active: 1 } }]).ir;
  const { ir: out, inverse } = applyCommands(ir, prepareCommands(ir, [{ op: "removeComponentItem", id: "root", itemId: "s0" }], ids()));
  expect(slides(out)).toEqual(["s1"]);
  expect((node(out, "root")!.interactive as CarouselSpec).active).toBe(0);
  expect(applyCommands(out, inverse).ir).toEqual(ir);
  expect(() => run(out, [{ op: "removeComponentItem", id: "root", itemId: "s1" }])).toThrow(/last item/);
});

test("moveComponentItem: spec and DOM reorder together, hidden loop clones keep their slots, active follows its item", () => {
  const ir = texted();
  node(ir, "tr")!.children = [n("clone", "div", [], { hidden: true, parentId: "tr" }), ...node(ir, "tr")!.children];
  const out = roundTrip(ir, [{ op: "moveComponentItem", id: "root", itemId: "s0", index: 1 }]).ir;
  expect(slides(out)).toEqual(["s1", "s0"]);
  expect(node(out, "tr")!.children.map((c) => c.id)).toEqual(["clone", "s1", "s0"]);
  expect((node(out, "root")!.interactive as CarouselSpec).active).toBe(1);
});

test("limits and instances: 100 items max; item commands on an instance are refused; aliases normalize", () => {
  const big = texted();
  const hundred = Array.from({ length: 100 }, (_, i) => n(`k${i}`, "div", [], { parentId: "tr" }));
  node(big, "tr")!.children = hundred;
  node(big, "root")!.interactive = { ...spec, slides: hundred.map((x) => x.id) }; // not the shared `spec` object
  expect(() => run(big, [{ op: "addComponentItem", id: "root", index: 0 }])).toThrow(/100/);
  const inst = texted();
  node(inst, "root")!.component = { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] };
  expect(() => run(inst, [{ op: "removeComponentItem", id: "root", itemId: "s0" }])).toThrow(/main|detach/);
  expect(prepareCommands(texted(), [{ op: "addCarouselSlide", id: "root", index: 0 }], ids())[0]).toMatchObject({ op: "addComponentItem" });
  expect(() => prepareCommands(texted(), [{ op: "updateCarousel", id: "dlg", patch: { closeOn: [] } }], ids())).toThrow(/carousel/);
});

// --- Task 11 edge cases ---
const tabbed = (): IRV2 => {
  const ir = fixture();
  const box = node(ir, "tabs")!;
  box.children = [n("t1", "button", [], { parentId: "tabs" }), n("t2", "button", [], { parentId: "tabs" }), n("p1", "div", [], { parentId: "tabs" }), n("p2", "div", [], { parentId: "tabs" })];
  box.interactive = { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t1", panel: "p1" }, { trigger: "t2", panel: "p2" }], active: 1 };
  return ir;
};
const detailed = (): IRV2 => {
  const ir = fixture();
  const d = (k: string) => n(`d${k}`, "details", [n(`sm${k}`, "summary", [n(`sm${k}t`, "#text", [], { text: k })]), n(`pn${k}`, "div")]);
  node(ir, "sec")!.children.push(n("acc", "div", [d("1"), d("2")], { parentId: "sec", interactive: { kind: "accordion", source: "details", confidence: "guessed", items: [{ trigger: "sm1", panel: "pn1", open: false }, { trigger: "sm2", panel: "pn2", open: true }], multiple: true } }));
  return ir;
};
const accItems = (ir: IRV2) => (node(ir, "acc")!.interactive as Extract<InteractiveSpec, { kind: "accordion" }>).items;

test("tabs sharing one parent: move / remove keep triggers among triggers and panels among panels; Undo and redo exact", () => {
  const moved = roundTrip(tabbed(), [{ op: "moveComponentItem", id: "tabs", itemId: "t1", index: 1 }]);
  expect(node(moved.ir, "tabs")!.children.map((c) => c.id)).toEqual(["t2", "t1", "p2", "p1"]);
  expect(node(moved.ir, "tabs")!.interactive).toMatchObject({ tabs: [{ trigger: "t2", panel: "p2" }, { trigger: "t1", panel: "p1" }], active: 0 });
  const removed = roundTrip(tabbed(), [{ op: "removeComponentItem", id: "tabs", itemId: "t1" }]);
  expect(node(removed.ir, "tabs")!.children.map((c) => c.id)).toEqual(["t2", "p2"]);
  expect(node(removed.ir, "tabs")!.interactive).toMatchObject({ active: 0 });
  for (const out of [moved, removed]) {
    const undone = applyCommands(out.ir, out.inverse);
    expect(applyCommands(undone.ir, undone.inverse).ir).toEqual(out.ir); // inverse of the inverse
  }
  const added = roundTrip(tabbed(), [{ op: "addComponentItem", id: "tabs", index: 1 }]);
  expect(node(added.ir, "tabs")!.children.map((c) => c.id)).toEqual(["t1", "new1", "t2", "p1", "new2", "p2"]);
  expect(node(added.ir, "tabs")!.interactive).toMatchObject({ active: 2 });
});

test("<details> accordion: the container is the item (copied, removed and moved as one); ids follow preorder", () => {
  const open = detailed();
  node(open, "d2")!.attrs = { open: "" };
  expect(node(run(open, [{ op: "addComponentItem", id: "acc", from: "sm2", index: 0 }]).ir, "new1")!.attrs).toEqual({}); // spec says open: false
  const added = roundTrip(detailed(), [{ op: "addComponentItem", id: "acc", from: "sm2", index: 0 }]);
  expect(node(added.ir, "acc")!.children.map((c) => c.id)).toEqual(["new1", "d1", "d2"]);
  expect(accItems(added.ir)[0]).toEqual({ trigger: "new2", panel: "new4", open: false });
  expect(node(added.ir, "new3")!.text).toBe("2");
  const removed = roundTrip(detailed(), [{ op: "removeComponentItem", id: "acc", itemId: "sm1" }]).ir;
  expect(node(removed, "acc")!.children.map((c) => c.id)).toEqual(["d2"]);
  const moved = roundTrip(detailed(), [{ op: "moveComponentItem", id: "acc", itemId: "sm2", index: 0 }]).ir;
  expect(node(moved, "acc")!.children.map((c) => c.id)).toEqual(["d2", "d1"]);
  expect(accItems(moved).map((x) => x.trigger)).toEqual(["sm2", "sm1"]);
});

test("item commands refuse bad input: unknown item / from, out-of-range index, kinds without items, wrong alias kind, forged newIds", () => {
  expect(() => run(texted(), [{ op: "removeComponentItem", id: "root", itemId: "nope" }])).toThrow(/not in/);
  expect(() => run(texted(), [{ op: "addComponentItem", id: "root", from: "nope", index: 0 }])).toThrow(/not in/);
  expect(() => run(texted(), [{ op: "addComponentItem", id: "root", index: 3 }])).toThrow(/index out of range/);
  expect(() => run(texted(), [{ op: "moveComponentItem", id: "root", itemId: "s0", index: 2 }])).toThrow(/index out of range/);
  expect(() => run(texted(), [{ op: "addComponentItem", id: "dlg", index: 0 }])).toThrow(/no items/);
  expect(() => run(texted(), [{ op: "removeCarouselSlide", id: "dlg", itemId: "x" }])).toThrow(/carousel/);
  expect(() => run(texted(), [{ op: "addComponentItem", id: "tabs", index: 0 }])).toThrow(/no interactive/);
  expect(prepareCommands(texted(), [{ op: "removeCarouselSlide", id: "root", itemId: "s0" }], ids())[0]).toEqual({ op: "removeComponentItem", id: "root", itemId: "s0" });
  expect(prepareCommands(texted(), [{ op: "updateCarousel", id: "root", patch: { loop: true } }], ids())[0]).toEqual({ op: "updateComponent", id: "root", patch: { loop: true } });
  expect(() => applyCommands(texted(), [{ op: "addComponentItem", id: "root", index: 0, newIds: ["s1", "a", "b"] }])).toThrow(/duplicate node id/);
  expect(() => applyCommands(texted(), [{ op: "addComponentItem", id: "root", index: 0, newIds: ["z"] }])).toThrow(/newIds/);
  expect(() => applyCommands(texted(), [{ op: "restoreItems", id: "root", interactive: spec, remove: [], insert: [], order: [{ parentId: "tr", ids: ["s0"] }] }])).toThrow(/invalid item restore/);
  const nested = tabbed();
  node(nested, "t1")!.children = [n("p1", "div", [], { parentId: "t1" })];
  node(nested, "tabs")!.children = node(nested, "tabs")!.children.filter((c) => c.id !== "p1");
  expect(() => run(nested, [{ op: "addComponentItem", id: "tabs", from: "t1", index: 0 }])).toThrow(/nested/);
  // review fix 1: what removeComponentItem takes out, its Undo must be able to put back (E1 deleteNode limits)
  const huge = texted();
  node(huge, "s1")!.children = Array.from({ length: 500 }, (_, i) => n(`h${i}`, "span", [], { parentId: "s1" }));
  expect(() => run(huge, [{ op: "removeComponentItem", id: "root", itemId: "s1" }])).toThrow(/command 0 \(removeComponentItem\): subtree limit/);
  const heavy = texted(); // the 8 MB History step check counts the restoreItems payload
  node(heavy, "s1t")!.text = "x".repeat(8 * 1024 * 1024);
  expect(() => run(heavy, [{ op: "removeComponentItem", id: "root", itemId: "s1" }])).toThrow(/8 MB/);
  const holding = texted();
  node(holding, "s1")!.component = { id: "c", role: "instance", sourceId: "m", overrides: [] };
  expect(() => run(holding, [{ op: "removeComponentItem", id: "root", itemId: "s1" }])).toThrow(/instance nodes: detach/);
  const instTrack = texted(); // the root is plain but the track is an instance node: still a structural edit of the instance
  node(instTrack, "tr")!.component = { id: "c", role: "instance", sourceId: "m", overrides: [] };
  for (const command of [{ op: "moveComponentItem", id: "root", itemId: "s0", index: 1 }, { op: "removeComponentItem", id: "root", itemId: "s0" }, { op: "addComponentItem", id: "root", index: 0 }] as EditorCommand[])
    expect(() => run(instTrack, [command])).toThrow(/component instance tr/);
});
