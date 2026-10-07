import { expect, test } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import { clearField, fieldOf, GROUPS, otherProps, scrub, setField, styleKey } from "@/app/p/[id]/editor/visual/style-model";

const node = (extra: Partial<IRNodeV2> = {}): IRNodeV2 => ({
  id: "n", tag: "h1", type: "text", attrs: {}, children: [],
  styles: { base: { color: "red", "font-size": "48px", "outline-offset": "2px" }, bp: { 768: { color: "blue" } }, state: { hover: { color: "green" } }, pseudo: {} }, ...extra,
});

test("value sources: the layer itself; 768 and 375 inherit Desktop (375 never 768, R4); states own their layer; an instance shows main values it does not override", () => {
  expect(fieldOf(node(), 1440, undefined, "color")).toEqual({ value: "red", source: "here", path: "styles.base.color" });
  expect(fieldOf(node(), 768, undefined, "color")).toEqual({ value: "blue", source: "here", path: "styles.bp.768.color" });
  expect(fieldOf(node(), 768, undefined, "font-size")).toEqual({ value: "48px", source: "desktop", path: "styles.base.font-size" });
  expect(fieldOf(node(), 375, undefined, "color")).toEqual({ value: "red", source: "desktop", path: "styles.base.color" });
  expect(fieldOf(node(), 1440, "hover", "color")).toEqual({ value: "green", source: "here", path: "styles.state.hover.color" });
  expect(fieldOf(node(), 1440, "hover", "font-size")).toBeUndefined();
  expect(fieldOf(node(), 1440, undefined, "width")).toBeUndefined();
  const inst = node({ component: { id: "c", role: "instance", sourceId: "m", overrides: ["styles.base.color"] } });
  expect(fieldOf(inst, 1440, undefined, "color")!.source).toBe("here");
  expect(fieldOf(inst, 1440, undefined, "font-size")!.source).toBe("main");
  expect(fieldOf(inst, 768, undefined, "font-size")!.source).toBe("main");
});

test("setField / clearField: one setStyle at the bp/state target; unsafe CSS refused before anything is sent; ↺ removes exactly that layer (resetOverride on an instance)", () => {
  expect(setField(node(), 768, undefined, "width", " 50% ")).toEqual({ commands: [{ op: "setStyle", id: "n", target: 768, changes: { width: "50%" } }] });
  expect(setField(node(), 1440, "focus", "color", "black")).toEqual({ commands: [{ op: "setStyle", id: "n", target: "focus", changes: { color: "black" } }] });
  for (const bad of ["red; } body{display:none", 'url("x', "a\nb", "/* x */"]) expect(setField(node(), 1440, undefined, "color", bad)).toEqual({ error: expect.stringMatching(/không hợp lệ/) });
  expect(setField(node(), 1440, undefined, "Bad Prop", "1px")).toEqual({ error: expect.any(String) });
  expect(setField(node(), 768, undefined, "color", "")).toEqual({ commands: [{ op: "setStyle", id: "n", target: 768, changes: { color: null } }] });
  expect(clearField(node(), 768, undefined, "font-size")).toEqual({ error: expect.stringMatching(/không đặt/) });
  const inst = node({ component: { id: "c", role: "instance", sourceId: "m", overrides: ["styles.base.color"] } });
  expect(clearField(inst, 1440, undefined, "color")).toEqual({ commands: [{ op: "resetOverride", instanceId: "n", path: "styles.base.color" }] });
  expect(clearField(inst, 1440, undefined, "font-size")).toEqual({ error: expect.stringMatching(/main/) });
  expect(setField({ ...node(), id: "instance:1:x:n" }, 1440, undefined, "color", "red")).toEqual({ error: expect.stringMatching(/instance/) });
});

test("catalog, other properties, scrubbing numbers, coalesce keys", () => {
  expect(GROUPS.map((g) => g.label)).toEqual(["Layout", "Kích thước", "Khoảng cách", "Chữ", "Hiển thị", "Biến đổi"]);
  expect(GROUPS.flatMap((g) => g.props)).toEqual(expect.arrayContaining(["display", "flex-direction", "grid-template-columns", "z-index", "min-width", "padding-left", "letter-spacing", "box-shadow", "rotate"]));
  expect(otherProps(node(), 1440, undefined)).toEqual(["outline-offset"]);
  expect([scrub("12px", 3), scrub("1.5em", 1), scrub("", 2), scrub("-4px", -1), scrub("auto", 1)]).toEqual(["15px", "2.5em", "2px", "-5px", undefined]);
  expect(styleKey("n", 768, undefined, "color")).toBe("n|768|color");
  expect(styleKey("n", 1440, "hover", "color")).toBe("n|hover|color");
});
