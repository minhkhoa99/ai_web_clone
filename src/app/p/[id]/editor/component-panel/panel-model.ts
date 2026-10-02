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
