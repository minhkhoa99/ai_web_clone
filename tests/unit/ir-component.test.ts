import { expect, test } from "vitest";
import { promoteLegacyComponents, resolveComponents, resetOverride, detachComponent } from "@/core/ir-component";
import { migrateIR } from "@/core/ir-migrate";
import { MAX_CAPTURE_NODES } from "@/core/limit";
import { toV2, type IRNodeV2 } from "@/core/ir-v2";
import type { LegacyIR, LegacyIRNode } from "@/core/ir-legacy";

const node = (id: string, tag: string, children: LegacyIRNode[] = [], text?: string): LegacyIRNode => ({ id, tag, attrs: {}, cls: [], children, ...(text === undefined ? {} : { text }) });
const legacy = (): LegacyIR => ({
  pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: node("shell", "html") }],
  sections: [{ id: "s", pageId: "p", name: "cards", role: "main", hash: "s", origin: "capture", root: node("section", "section", [0, 1, 2].map(i => ({ ...node(`card${i}`, "article", [node(`label${i}`, "span", [node(`text${i}`, "#text", [], `Card ${i}`)]), node(`extra${i}`, "small")]), cls: [i === 1 ? "blue" : "red"] }))) }],
  components: [{ id: "cards", hash: "cards", instanceIds: ["card0", "card1", "card2"] }],
  classes: { red: { base: { color: "red" } }, blue: { base: { color: "blue" } } }, layouts: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [],
});
const promoted = () => { const v1 = legacy(); return promoteLegacyComponents(toV2(v1, []), v1.components); };
const cards = (ir: ReturnType<typeof promoted>) => ir.sections[0]!.root.children;
const texts = (n: IRNodeV2): string => (n.text ?? "") + n.children.map(texts).join("");

test("promotion preserves every render value and page ID with distinct main IDs", () => {
  const v1 = legacy(), before = toV2(v1, []), snapshot = structuredClone(before);
  const ir = promoteLegacyComponents(before, v1.components);
  expect(before).toEqual(snapshot);
  expect(ir.components).toHaveLength(1);
  expect(cards(ir).map(n => n.component?.role)).toEqual(["instance", "instance", "instance"]);
  expect(ir.components[0]!.root.id).not.toBe("card0");
  const resolved = cards(resolveComponents(ir));
  expect(resolved.map(texts)).toEqual(["Card 0", "Card 1", "Card 2"]);
  expect(resolved.map(n => [n.id, n.styles.base.color])).toEqual([["card0", "red"], ["card1", "blue"], ["card2", "red"]]);
  expect(migrateIR(v1, []).components).toHaveLength(1);
  expect(migrateIR(ir, [])).toBe(ir);
});

test("main changes propagate by source ID, children overrides preserve instance ordering", () => {
  const ir = promoted(), main = ir.components[0]!.root;
  main.styles.base.color = "green";
  cards(ir)[1]!.component!.overrides!.push("children");
  main.children.reverse();
  const result = cards(resolveComponents(ir));
  expect(result.map(n => n.styles.base.color)).toEqual(["green", "blue", "green"]);
  expect(result[0]!.children.map(n => n.id)).toEqual(["extra0", "label0"]);
  expect(result[1]!.children.map(n => n.id)).toEqual(["label1", "extra1"]);
  expect(result.map(texts)).toEqual(["Card 0", "Card 1", "Card 2"]);
});

test("reset removes one or all node overrides; detach retains effective values and IDs", () => {
  const ir = promoted(); ir.components[0]!.root.styles.base.color = "green";
  expect(cards(resetOverride(ir, "card1", "styles.base.color"))[1]!.styles.base.color).toBe("green");
  expect(texts(cards(resetOverride(ir, "text1"))[1]!)).toBe("Card 0");
  const detached = detachComponent(ir, "card1");
  expect(cards(detached)[1]!.id).toBe("card1");
  expect(texts(cards(detached)[1]!)).toBe("Card 1");
  expect(cards(detached)[1]!.styles.base.color).toBe("blue");
  expect(cards(detached)[1]!.children[0]!.children[0]!.component).toBeUndefined();
  expect(detached.components[0]!.instanceIds).toEqual(["card0", "card2"]);
  expect(cards(ir)[1]!.component).toBeDefined();
});

test("uncertain structure stays ordinary with partial fidelity", () => {
  const v1 = legacy(); v1.sections[0]!.root.children[1]!.children.pop();
  const ir = promoteLegacyComponents(toV2(v1, []), v1.components);
  expect(ir.components).toHaveLength(0);
  expect(cards(ir)[0]!.component).toBeUndefined();
  expect(ir.fidelity.some(f => f.feature === "component" && f.status === "partial")).toBe(true);
});

test("deleting an overridden source or referenced main rejects with instance context", () => {
  const ir = promoted(); ir.components[0]!.root.children.shift();
  expect(() => resolveComponents(ir)).toThrow(/text1/);
  const missing = promoted(); missing.components = [];
  expect(() => resolveComponents(missing)).toThrow(/card0/);
});

test("new main children receive stable instance IDs and valid parent IDs", () => {
  const ir = promoted();
  ir.components[0]!.root.children.push({ ...structuredClone(ir.components[0]!.root.children[1]!), id: "new-source" });
  const first = resolveComponents(ir), second = resolveComponents(ir);
  expect(first).toEqual(second);
  const added = cards(first).map(n => n.children[2]!);
  expect(new Set(added.map(n => n.id)).size).toBe(3);
  expect(added.map(n => n.parentId)).toEqual(["card0", "card1", "card2"]);
});

test("reset all on an instance root also resets descendant overrides", () => {
  expect(texts(cards(resetOverride(promoted(), "card1"))[1]!)).toBe("Card 0");
});

test("override deletion preserves missing attributes and dotted CSS property names", () => {
  const v1 = legacy(); v1.sections[0]!.root.children[0]!.attrs.title = "main";
  v1.classes.red!.base["--theme.color"] = "red";
  const ir = promoteLegacyComponents(toV2(v1, []), v1.components);
  const resolved = cards(resolveComponents(ir));
  expect(resolved[1]!.attrs.title).toBeUndefined();
  expect(resolved[1]!.styles.base["--theme.color"]).toBeUndefined();
});

test("cycles, invalid override paths, and expansion beyond limits are rejected", () => {
  const cyclic = promoted(), main = cyclic.components[0]!.root;
  main.component = { id: "cards", role: "instance", sourceId: main.id };
  expect(() => resolveComponents(cyclic)).toThrow(/cycle/);
  const bad = promoted(); cards(bad)[0]!.component!.overrides = ["__proto__.polluted"];
  expect(() => resolveComponents(bad)).toThrow(/invalid component override/);
  // each instance expands to half the per-page ceiling: the second one crosses it
  const large = promoted(); large.components[0]!.root.children = Array.from({ length: MAX_CAPTURE_NODES / 2 }, (_, i) => ({ ...structuredClone(main), id: `source${i}`, children: [], component: undefined }));
  const clear = (n: IRNodeV2): void => { if (n.component) n.component.overrides = []; n.children.forEach(clear); };
  cards(large).forEach(clear);
  expect(() => resolveComponents(large)).toThrow(/limit/);
});

test("detaching a linked descendant remains detached on subsequent resolution", () => {
  const detached = detachComponent(promoted(), "label1");
  const resolved = resolveComponents(detached);
  expect(cards(resolved)[1]!.children[0]!.id).toBe("label1");
  expect(cards(resolved)[1]!.children[0]!.component).toBeUndefined();
  expect(texts(cards(resolved)[1]!)).toBe("Card 1");
});

test("generated IDs unambiguously encode colon-containing instance and source IDs", () => {
  const ir = promoted();
  for (const [i, id] of ["a", "a:b"].entries()) {
    const card = cards(ir)[i]!;
    card.id = id;
    card.children.forEach(child => { child.parentId = id; });
  }
  const main = ir.components[0]!.root;
  for (const id of ["b:c", "c"]) main.children.push({ ...structuredClone(main.children[1]!), id });
  const resolved = resolveComponents(ir);
  const added = cards(resolved).flatMap(card => card.children.slice(2).map(child => child.id));
  expect(new Set(added).size).toBe(added.length);
  expect(resolveComponents(resolved)).toEqual(resolved);
  expect(migrateIR(resolved, [])).toBe(resolved);
});

test("malformed legacy component records fail with a coded error without mutation", () => {
  for (const record of [null, {}, { id: 42, hash: "h", instanceIds: ["card0", "card1"] },
    { id: "cards", hash: "h" }, { id: "cards", hash: "h", instanceIds: "card0" },
    { id: "cards", hash: "h", instanceIds: [null] }, { id: "", hash: "h", instanceIds: [] },
    { id: "cards", hash: 42, instanceIds: [] }]) {
    const input = { ...legacy(), components: [record] }, before = structuredClone(input);
    expect(() => migrateIR(input, [])).toThrowError(expect.objectContaining({ code: "IR_PATCH_INVALID" }));
    expect(input).toEqual(before);
  }
});
