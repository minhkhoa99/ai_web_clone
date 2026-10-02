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
