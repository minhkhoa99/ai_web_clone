import { expect, test } from "vitest";
import { cfgOf, checkInteractives, INTERACTIVE_LIMITS, parseSpec, rolesOf, type CarouselSpec, type InteractiveSpec } from "@/core/interactive";
import { migrateIR } from "@/core/ir-migrate";
import { isOverridePath, resolveComponents } from "@/core/ir-component";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const carousel = (over: Partial<CarouselSpec> = {}): CarouselSpec => ({
  kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1", "s2"], active: 0,
  autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300,
  slidesPerView: { "1440": 3, "768": 2.5 }, gap: { "1440": 30 }, arrows: { next: "nx" }, ...over,
});
// page "pg": section s1 holds the carousel; section s2 holds a modal trigger for the dialog in s1
const doc = (spec: InteractiveSpec, rootChildren?: IRNodeV2[]): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1", "s2"], shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("ph2", "#section", [], { attrs: { "data-section": "s2" } })])]) }],
  sections: [
    { id: "s1", pageId: "pg", name: "a", role: "block", hash: "h", origin: "capture", root: n("root", "section", rootChildren ?? [
      n("vp", "div", [n("tr", "div", [n("s0", "div"), n("s1", "div"), n("s2", "div")])]), n("nx", "button"), n("dlg", "div"),
    ], { interactive: spec }) },
    { id: "s2", pageId: "pg", name: "b", role: "block", hash: "h2", origin: "capture", root: n("other", "section", [n("open", "button")]) },
  ],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});

test("schema per kind: valid specs parse, unknown fields / out-of-range values / semantic errors are refused", () => {
  expect(parseSpec(carousel())).toEqual(carousel());
  expect(() => parseSpec({ ...carousel(), tabs: [] })).toThrow(/IR_PATCH_INVALID|invalid/);
  expect(() => parseSpec(carousel({ interval: 999 }))).toThrow();
  expect(() => parseSpec(carousel({ speed: 5001 }))).toThrow();
  expect(() => parseSpec(carousel({ slidesPerView: { "1440": 11 } }))).toThrow();
  expect(() => parseSpec(carousel({ slidesPerView: { "1440": 2.333 } }))).toThrow(); // R1: 2 decimals
  expect(() => parseSpec(carousel({ gap: { "375": 201 } }))).toThrow();
  expect(() => parseSpec(carousel({ active: 3 }))).toThrow(/active/);
  expect(() => parseSpec(carousel({ slides: Array.from({ length: INTERACTIVE_LIMITS.items + 1 }, (_, i) => `s${i}`) }))).toThrow();
  expect(() => parseSpec(carousel({ slides: ["s0", "s0"] }))).toThrow(/duplicate/);
  const video = { kind: "video", source: "native", confidence: "guessed", node: "v", mode: "native", autoplay: true, muted: false, loop: false, controls: true };
  expect(() => parseSpec(video)).toThrow(/muted/);
  expect(parseSpec({ ...video, muted: true }).kind).toBe("video");
  expect(() => parseSpec({ kind: "modal", source: "aria", confidence: "guessed", triggers: ["t"], dialog: "d", closeOn: ["button"] })).toThrow(/closeButton/);
});

test("rolesOf and cfgOf: ids by role; cfg has only numbers/booleans/enums/ids and stays under 16 KB", () => {
  expect(rolesOf(carousel())).toEqual([["vp", "viewport"], ["tr", "track"], ["s0", "slide"], ["s1", "slide"], ["s2", "slide"], ["nx", "next"]]);
  const cfg = JSON.parse(cfgOf(carousel()));
  expect(cfg).not.toHaveProperty("source");
  expect(cfg).not.toHaveProperty("confidence");
  expect(cfg.slides).toEqual(["s0", "s1", "s2"]);
  const big = carousel({ slides: Array.from({ length: 100 }, (_, i) => `${"x".repeat(190)}${i}`) });
  const children = big.slides.map((id) => n(id, "div"));
  expect(() => checkInteractives(doc(big, [n("vp", "div", [n("tr", "div", children)]), n("nx", "button")]))).toThrow(/16 KB/);
});

test("references: inside the root, slides are track children, modal triggers may sit elsewhere on the same page", () => {
  expect(() => checkInteractives(doc(carousel()))).not.toThrow();
  expect(() => checkInteractives(doc(carousel({ arrows: { next: "open" } })))).toThrow(/outside/);
  expect(() => checkInteractives(doc(carousel({ slides: ["s0", "s1", "dlg"] })))).toThrow(/track/); // dlg: inside the root, not under the track
  const modal: InteractiveSpec = { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc", "backdrop"] };
  expect(() => checkInteractives(doc(modal))).not.toThrow(); // Review Focus 5: trigger in another section of the page
  expect(() => checkInteractives(doc({ ...modal, triggers: ["nowhere"] }))).toThrow(/outside|not on page/);
});

// R2: sibling dropdowns under one parent (site2 #vis-btn/#fade-btn) root at the trigger, so the panel lies outside.
test("R2: a dropdown/menu panel may sit outside the subtree on the same page; tabs/carousel references may not", () => {
  for (const kind of ["dropdown", "menu"] as const) {
    const spec: InteractiveSpec = { kind, source: "aria", confidence: "guessed", trigger: "nx", panel: "open", openOn: "click" };
    expect(() => checkInteractives(doc(spec))).not.toThrow();
    expect(() => checkInteractives(doc({ ...spec, panel: "nowhere" }))).toThrow(/outside|not on page/);
    expect(() => checkInteractives(doc({ ...spec, trigger: "open", panel: "dlg" }))).toThrow(/trigger open is outside/);
  }
  const tabs: InteractiveSpec = { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "nx", panel: "open" }], active: 0 };
  expect(() => checkInteractives(doc(tabs))).toThrow(/panel open is outside/);
  expect(() => checkInteractives(doc(carousel({ pagination: { container: "open", kind: "bullets" } })))).toThrow(/pagination open is outside/);
});

test("at most 50 components per page; none on a component main", () => {
  const tabs = (i: number): IRNodeV2 => n(`r${i}`, "div", [n(`t${i}`, "button"), n(`p${i}`, "div")], { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: `t${i}`, panel: `p${i}` }], active: 0 } });
  const many = doc(carousel(), Array.from({ length: INTERACTIVE_LIMITS.perPage + 1 }, (_, i) => tabs(i)));
  many.sections[0]!.root = n("root", "section", many.sections[0]!.root.children);
  expect(() => checkInteractives(many)).toThrow(/50/);
  const withMain = doc(carousel());
  withMain.components = [{ id: "c", root: tabs(99), instanceIds: [] }];
  expect(() => checkInteractives(withMain)).toThrow(/main/);
});

test("migrateIR v2 validates interactive on load (R11) and keeps a valid document as-is", () => {
  const ok = doc(carousel());
  expect(migrateIR(ok, [])).toBe(ok);
  expect(() => migrateIR(doc(carousel({ track: "missing" })), [])).toThrow(/IR_PATCH_INVALID|outside/);
});

test("an instance keeps its own interactive through resolveComponents via the interactive override path", () => {
  expect(isOverridePath("interactive")).toBe(true);
  expect(isOverridePath("interactive.autoplay")).toBe(true);
  expect(isOverridePath("interactive.__proto__")).toBe(false);
  const ir = doc(carousel());
  const main = n("m", "div", [n("m1", "button"), n("m2", "div")], { component: { id: "c", role: "main" } });
  const spec: InteractiveSpec = { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "i1", panel: "i2", openOn: "click" };
  const inst = n("i", "div", [n("i1", "button", [], { component: { id: "c", role: "instance", sourceId: "m1", overrides: [] } }), n("i2", "div", [], { component: { id: "c", role: "instance", sourceId: "m2", overrides: [] } })],
    { component: { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] }, interactive: spec });
  ir.sections[1]!.root = n("other", "section", [n("open", "button"), inst]);
  ir.components = [{ id: "c", root: main, instanceIds: ["i"] }];
  const shown = resolveComponents(ir).sections[1]!.root.children[1]!;
  expect(shown.interactive).toEqual(spec);
});
