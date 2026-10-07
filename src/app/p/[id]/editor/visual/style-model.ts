// E3 §3 Style Manager model (pure): the value a property shows at (breakpoint, state), where it comes from (R4, R5),
// and the one command that sets or removes exactly that layer.
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeCss } from "@/core/safe-names";
import { GENERATED, styleTarget, type Batch, type Bp } from "./model";

export type StateName = "hover" | "focus" | "active";
export type Source = "here" | "desktop" | "main";
export type Field = { value: string; source: Source; path: string };
export const SOURCE_VI: Record<Source, string> = { here: "đặt ở bp này", desktop: "kế thừa từ Desktop", main: "từ main component" };
export const GROUPS = [
  { id: "layout", label: "Layout", props: ["display", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "grid-template-rows", "position", "top", "right", "bottom", "left", "overflow", "z-index"] },
  { id: "size", label: "Kích thước", props: ["width", "height", "min-width", "max-width", "min-height", "max-height"] },
  { id: "spacing", label: "Khoảng cách", props: ["margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left"] },
  { id: "typography", label: "Chữ", props: ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "color"] },
  { id: "appearance", label: "Hiển thị", props: ["background-color", "background-image", "border", "border-radius", "opacity", "box-shadow"] },
  { id: "transform", label: "Biến đổi", props: ["translate", "scale", "rotate"] },
] as const satisfies readonly { id: string; label: string; props: readonly string[] }[];
export const CHOICES: Readonly<Partial<Record<string, readonly string[]>>> = {
  display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "none"],
  "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
  "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
  "justify-content": ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"],
  "align-items": ["stretch", "flex-start", "center", "flex-end", "baseline"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  overflow: ["visible", "hidden", "auto", "scroll"],
  "text-align": ["left", "center", "right", "justify"],
  "font-weight": ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
};
// The one view-only check (E3b Task 14 swaps it for viewOnly(node), R16).
const viewOnly = (node: IRNodeV2) => node.id.startsWith(GENERATED);
const VIEW_ONLY_MSG = "Phần tử này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach).";
export const layerPath = (bp: Bp, state: StateName | undefined, prop: string): string =>
  state ? `styles.state.${state}.${prop}` : bp === 1440 ? `styles.base.${prop}` : `styles.bp.${bp}.${prop}`;
const layer = (n: IRNodeV2, bp: Bp, state?: StateName) => (state ? n.styles.state[state] : bp === 1440 ? n.styles.base : n.styles.bp[bp]);
export const styleKey = (id: string, bp: Bp, state: StateName | undefined, prop: string): string => `${id}|${styleTarget(bp, state)}|${prop}`;

export function fieldOf(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Field | undefined {
  const instance = node.component?.role === "instance", overrides = node.component?.overrides ?? [];
  const at = (value: string, path: string, source: Source): Field => ({ value, path, source: instance && !overrides.includes(path) ? "main" : source });
  const own = layer(node, bp, state)?.[prop];
  if (own !== undefined) return at(own, layerPath(bp, state, prop), "here");
  if (state || bp === 1440) return undefined;
  const base = node.styles.base[prop]; // R4: 768 and 375 both fall back to Desktop
  return base !== undefined ? at(base, layerPath(1440, undefined, prop), "desktop") : undefined;
}
const unset = (node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Batch =>
  ({ commands: [{ op: "setStyle", id: node.id, target: styleTarget(bp, state), changes: { [prop]: null } }] });
export function clearField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Batch {
  if (viewOnly(node)) return { error: VIEW_ONLY_MSG };
  const f = fieldOf(node, bp, state, prop);
  if (!f || f.source === "desktop") return { error: "Lớp này không đặt giá trị để bỏ." };
  if (f.source === "main") return { error: "Giá trị lấy từ main component — sửa ở main." };
  if (node.component?.role === "instance") return { commands: [{ op: "resetOverride", instanceId: node.id, path: f.path }] };
  return unset(node, bp, state, prop);
}
export function setField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string, value: string): Batch {
  if (viewOnly(node)) return { error: VIEW_ONLY_MSG };
  const v = value.trim();
  // empty = ↺ on this layer (same instance rules as clearField); nothing to send when the layer sets nothing
  if (v === "") {
    const f = fieldOf(node, bp, state, prop);
    return !f || f.source === "desktop" ? { commands: [] } : clearField(node, bp, state, prop);
  }
  if (!isSafeCss(prop, v)) return { error: `Giá trị CSS không hợp lệ cho ${prop.slice(0, 80)}.` };
  return { commands: [{ op: "setStyle", id: node.id, target: styleTarget(bp, state), changes: { [prop]: v } }] };
}
export function otherProps(node: IRNodeV2, bp: Bp, state: StateName | undefined): string[] {
  const known = new Set<string>(GROUPS.flatMap((g) => g.props));
  return Object.keys(layer(node, bp, state) ?? {}).filter((p) => !known.has(p)).sort();
}
const NUMBER = /^(-?\d*\.?\d+)([a-z%]*)$/i;
// "kéo trực tiếp trên số": the number moves by `delta`, the unit stays (px when there is none)
export function scrub(value: string, delta: number): string | undefined {
  const m = NUMBER.exec(value.trim() || "0px");
  if (!m) return undefined;
  return `${Math.round((Number(m[1]) + delta) * 100) / 100}${m[2] || "px"}`;
}
