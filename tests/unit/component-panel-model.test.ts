import { expect, test } from "vitest";
import { componentFor, generatedId, moveCommand, NUMBER_RULES, numberValue, thumbStyle, type PanelDocument } from "@/app/p/[id]/editor/component-panel/panel-model";
import { parseSpec } from "@/core/interactive";
import { panelComponents, type PanelComponent } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const car = { rootId: "root", members: ["vp", "tr", "s0", "s1", "s2"], instance: false, items: [{ id: "s0", label: "Slide 1" }, { id: "s1", label: "Slide 2" }, { id: "s2", label: "Slide 3" }],
  spec: { kind: "carousel", source: "swiper", confidence: "guessed", viewport: "vp", track: "tr", slides: ["s0", "s1", "s2"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: {}, gap: {} } } as PanelComponent;
const doc = (ancestors: string[]): PanelDocument => ({ components: [car], ancestors, outline: [] });

test("componentFor: a node inside a slide (or the root itself) finds the carousel; an unrelated node finds none", () => {
  expect(componentFor(doc(["txt", "s1", "tr", "vp", "root", "sec"]), "txt")?.rootId).toBe("root");
  expect(componentFor(doc(["root", "sec"]), "root")?.rootId).toBe("root");
  expect(componentFor(doc(["p", "sec"]), "p")).toBeUndefined();
  expect(componentFor(doc(["root"]), null)).toBeUndefined();
});

test("moveCommand: ↑/↓ become moveComponentItem within bounds", () => {
  expect(moveCommand(car, "s1", -1)).toEqual({ op: "moveComponentItem", id: "root", itemId: "s1", index: 0 });
  expect(moveCommand(car, "s0", -1)).toBeUndefined();
  expect(moveCommand(car, "s2", 1)).toBeUndefined();
});

test("thumbStyle: a crop of the 1440 shot scaled into the thumbnail box", () => {
  expect(thumbStyle([100, 200, 300, 150], "/shot.png", 48)).toEqual({ backgroundImage: 'url("/shot.png")', backgroundSize: "230.4px auto", backgroundPosition: "-16px -32px", width: "48px", height: "24px" });
  expect(thumbStyle(undefined, "/shot.png")).toBeUndefined();
  expect(thumbStyle([0, 0, 0, 10], "/shot.png")).toBeUndefined();
});

test("numberValue: the schema's ranges / integer / 2-decimal rules, a Vietnamese error otherwise; '' only where a value may be absent", () => {
  expect(numberValue("3000", NUMBER_RULES.interval)).toEqual({ value: 3000 });
  expect(numberValue("999", NUMBER_RULES.interval).error).toBe("Cần số nguyên từ 1000 đến 60000.");
  expect(numberValue("1500.5", NUMBER_RULES.interval).error).toBe("Cần số nguyên từ 1000 đến 60000.");
  expect(numberValue("", NUMBER_RULES.interval).error).toBe("Cần số nguyên từ 1000 đến 60000.");
  expect(numberValue("abc", NUMBER_RULES.speed).error).toBe("Cần số nguyên từ 0 đến 5000.");
  expect(numberValue("5001", NUMBER_RULES.speed).error).toBeDefined();
  expect(numberValue("2.55", NUMBER_RULES.slidesPerView)).toEqual({ value: 2.55 });
  expect(numberValue("2.555", NUMBER_RULES.slidesPerView).error).toBe("Cần số từ 1 đến 10, tối đa 2 chữ số thập phân (để trống: theo màn rộng hơn).");
  expect(numberValue("", NUMBER_RULES.slidesPerView)).toEqual({ value: undefined });
  expect(numberValue("12.5", NUMBER_RULES.gap)).toEqual({ value: 12.5 });
  expect(numberValue("201", NUMBER_RULES.gap).error).toBeDefined();
  // what the form accepts, the schema accepts (and the edges it refuses, the schema refuses)
  const ok = (patch: Record<string, unknown>) => () => parseSpec({ ...car.spec, ...patch });
  for (const [field, raw] of [["interval", "1000"], ["interval", "60000"], ["speed", "0"], ["speed", "5000"]] as const) expect(ok({ [field]: numberValue(raw, NUMBER_RULES[field]).value })).not.toThrow();
  for (const raw of ["1", "10", "1.15", "9.99"]) expect(ok({ slidesPerView: { "1440": numberValue(raw, NUMBER_RULES.slidesPerView).value } })).not.toThrow();
  for (const raw of ["0", "200", "7.5"]) expect(ok({ gap: { "768": numberValue(raw, NUMBER_RULES.gap).value } })).not.toThrow();
});

test("generatedId: instance view ids are not document ids", () => {
  expect(generatedId("instance:4:sec1:m0")).toBe(true);
  expect(generatedId("index:0.2.3")).toBe(false);
});

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
test("panelComponents: the page's components (layout sections through their placeholder), labels name > text > 'Slide k', 1440 box, Fidelity, instance", () => {
  const ir: IRV2 = {
    version: 2, revision: 0,
    pages: [
      { id: "pg", path: "/", title: "", meta: {}, sectionIds: ["a"], shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "a" } })])]) },
      { id: "p2", path: "/2", title: "", meta: {}, sectionIds: ["b"], shell: n("h2", "html", [n("b2", "body", [n("ph2", "#section", [], { attrs: { "data-section": "b" } })])]) },
    ],
    sections: [
      { id: "a", pageId: "pg", name: "a", role: "block", hash: "h", origin: "capture", root: n("root", "section", [n("vp", "div", [n("tr", "div", [
        n("s0", "div", [], { name: "Hero" }),
        n("s1", "div", [n("s1t", "#text", [], { text: "   " }), n("s1b", "b", [n("s1bt", "#text", [], { text: "x".repeat(60) })])], { box: { 1440: [10, 20, 300, 100] } }),
        n("s2", "div"),
      ])])], { interactive: car.spec, component: { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] } }) },
      { id: "b", pageId: "p2", name: "b", role: "block", hash: "h2", origin: "capture", root: n("other", "section", [n("t", "button"), n("pn", "div")], { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "t", panel: "pn", openOn: "click" } }) },
    ],
    layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [],
    fidelity: [{ pageId: "pg", feature: "component", status: "partial", nodeId: "root", note: "" }, { pageId: "pg", feature: "script", status: "unsupported", nodeId: "root", note: "" }],
  };
  const [c, ...rest] = panelComponents(ir, "pg");
  expect(rest).toEqual([]);
  expect(c).toMatchObject({ rootId: "root", members: ["vp", "tr", "s0", "s1", "s2"], fidelity: "partial", instance: true });
  expect(c!.items).toEqual([{ id: "s0", label: "Hero" }, { id: "s1", label: "x".repeat(40), box: [10, 20, 300, 100] }, { id: "s2", label: "Slide 3" }]);
  const [d] = panelComponents(ir, "p2");
  expect(d).toMatchObject({ rootId: "other", members: ["t", "pn"], items: [], instance: false });
  expect(d!.fidelity).toBeUndefined();
  expect(panelComponents(ir, "nope")).toEqual([]);
});
