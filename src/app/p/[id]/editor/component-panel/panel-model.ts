// E2 §7: the Component panel's pure helpers (client-safe: types only from core).
import type { EditorCommand } from "@/core/ir-command";
import type { PanelComponent } from "@/core/interactive";

export type PanelDocument = { components: PanelComponent[]; ancestors: string[]; outline: { id: string; label: string; depth: number }[]; shot?: string };

// The nearest component whose root or member is the selected node or one of its ancestors (ancestors[0] = the node).
export function componentFor(doc: PanelDocument, selectedId: string | null): PanelComponent | undefined {
  if (!selectedId) return undefined;
  for (const id of doc.ancestors) {
    const hit = doc.components.find((c) => c.rootId === id || c.members.includes(id));
    if (hit) return hit;
  }
  return undefined;
}

// E2 §7: "Clone lại để đọc cấu hình thật" only where a re-clone can read a library config (core fidelity says the same)
export const recloneHint = (spec: PanelComponent["spec"]): boolean =>
  spec.kind === "carousel" && spec.confidence === "guessed" && ["swiper", "slick", "splide"].includes(spec.source);

export function moveCommand(c: PanelComponent, itemId: string, delta: -1 | 1): EditorCommand | undefined {
  const at = c.items.findIndex((x) => x.id === itemId), to = at + delta;
  return at < 0 || to < 0 || to >= c.items.length ? undefined : { op: "moveComponentItem", id: c.rootId, itemId, index: to };
}

// A crop of the 1440 capture shot (page coordinates) scaled to `size` px wide.
export function thumbStyle(box: [number, number, number, number] | undefined, shot: string | undefined, size = 48): Record<string, string> | undefined {
  if (!box || !shot || box[2] <= 0) return undefined;
  const scale = size / box[2];
  return { backgroundImage: `url("${shot}")`, backgroundSize: `${1440 * scale}px auto`, backgroundPosition: `${-box[0] * scale}px ${-box[1] * scale}px`, width: `${size}px`, height: `${Math.min(size, Math.round(box[3] * scale))}px` };
}

// The schema's number rules (core/interactive zod, mirrored: the form must not send what the server refuses).
export type NumberRule = { min: number; max: number; int?: true; cents?: true; optional?: true };
export const NUMBER_RULES = {
  interval: { min: 1000, max: 60000, int: true },
  speed: { min: 0, max: 5000, int: true },
  slidesPerView: { min: 1, max: 10, cents: true, optional: true },
  gap: { min: 0, max: 200, optional: true },
} as const satisfies Record<string, NumberRule>;
export function numberValue(raw: string, rule: NumberRule): { value?: number; error?: string } {
  if (raw.trim() === "" && rule.optional) return { value: undefined };
  const v = raw.trim() === "" ? NaN : Number(raw);
  const ok = Number.isFinite(v) && v >= rule.min && v <= rule.max && (!rule.int || Number.isInteger(v)) && (!rule.cents || Math.abs(v * 100 - Math.round(v * 100)) < 1e-9);
  if (ok) return { value: v };
  const what = `${rule.int ? "số nguyên" : "số"} từ ${rule.min} đến ${rule.max}${rule.cents ? ", tối đa 2 chữ số thập phân" : ""}`;
  return { error: `Cần ${what}${rule.optional ? " (để trống: theo màn rộng hơn)" : ""}.` };
}

// resolveComponents' view-only ids for a main's nodes inside an instance (`instance:…`): never sent as a role
export const generatedId = (id: string) => id.startsWith("instance:");
