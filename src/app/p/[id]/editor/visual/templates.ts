// E3 §3 "Thêm": the insertable templates (Vietnamese sample content, minimal styles, no class) and the batch each one
// is — createNode, plus convertToComponent naming the new nodes (R2) for the component samples. Role paths count the
// draft's raw children array (a #text draft included), as the server's `new:<k>/<path>` does.
import type { InteractiveKind, PanelComponent } from "@/core/interactive";
import type { NodeDraft } from "@/core/ir-command";
import type { IconName } from "@/app/_ui/icons.gen";
import { guardParent, type Batch, type DocIndex, type Zone } from "./model";

export type Template = { id: string; label: string; icon: IconName; draft: NodeDraft; kind?: InteractiveKind; roles?: Record<string, unknown> };
const text = (t: string): NodeDraft => ({ tag: "#text", text: t });
const base = (decl: Record<string, string>) => ({ base: decl });
const item = (t: string): NodeDraft => ({ tag: "div", styles: base({ padding: "16px", "background-color": "#f2f2f2" }), children: [{ tag: "p", children: [text(t)] }] });
const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='100%25' height='100%25' fill='%23d9d9d9'/%3E%3C/svg%3E";
const grid = (cols: number): NodeDraft => ({ tag: "div", styles: base({ display: "grid", "grid-template-columns": `repeat(${cols}, minmax(0, 1fr))`, gap: "16px", padding: "16px" }), children: Array.from({ length: cols }, (_, i) => item(`Cột ${i + 1}`)) });
const slide = (i: number): NodeDraft => ({ tag: "div", styles: base({ padding: "48px 16px", "text-align": "center", "background-color": "#eeeeee" }), children: [{ tag: "p", children: [text(`Slide ${i}`)] }] });
const button = (t: string, label?: string): NodeDraft => ({ tag: "button", attrs: { type: "button", ...(label && { "aria-label": label }) }, children: [text(t)] });

export const TEMPLATES: readonly Template[] = [
  { id: "text", label: "Text", icon: "text_fields", draft: { tag: "span", children: [text("Văn bản mới")] } },
  { id: "heading", label: "Tiêu đề", icon: "title", draft: { tag: "h2", children: [text("Tiêu đề mới")] } },
  { id: "paragraph", label: "Đoạn văn", icon: "text_snippet", draft: { tag: "p", children: [text("Đoạn văn mới. Nhấp đúp để sửa nội dung.")] } },
  { id: "image", label: "Ảnh", icon: "image", draft: { tag: "img", attrs: { src: PLACEHOLDER, alt: "Ảnh mới", width: "320", height: "180" } } },
  { id: "button", label: "Nút", icon: "touch_app", draft: { ...button("Nút bấm"), styles: base({ padding: "8px 16px", "border-radius": "4px" }) } },
  { id: "link", label: "Link", icon: "link", draft: { tag: "a", attrs: { href: "#" }, children: [text("Liên kết")] } },
  { id: "box", label: "Khung trống", icon: "add_box", draft: { tag: "div", styles: base({ "min-height": "80px", padding: "16px" }) } },
  { id: "row", label: "Flex hàng", icon: "view_week", draft: { tag: "div", styles: base({ display: "flex", gap: "16px", padding: "16px" }), children: [item("Mục 1"), item("Mục 2")] } },
  { id: "column", label: "Flex cột", icon: "view_agenda", draft: { tag: "div", styles: base({ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px" }), children: [item("Mục 1"), item("Mục 2")] } },
  { id: "grid2", label: "Grid 2 cột", icon: "grid_view", draft: grid(2) },
  { id: "grid3", label: "Grid 3 cột", icon: "grid_view", draft: grid(3) },
  // R7: a <section> inside the current section (the Command API cannot add an IR section)
  { id: "section", label: "Section trống", icon: "crop_square", draft: { tag: "section", styles: base({ "min-height": "160px", padding: "48px 16px" }) } },
  {
    id: "carousel", label: "Carousel", icon: "view_carousel", kind: "carousel",
    draft: { tag: "div", styles: base({ position: "relative" }), children: [
      { tag: "div", styles: base({ overflow: "hidden" }), children: [{ tag: "div", styles: base({ display: "flex" }), children: [slide(1), slide(2), slide(3)] }] },
      button("‹", "Slide trước"), button("›", "Slide sau"),
    ] },
    roles: { viewport: "new:0/0", track: "new:0/0.0", slides: ["new:0/0.0.0", "new:0/0.0.1", "new:0/0.0.2"], arrows: { prev: "new:0/1", next: "new:0/2" } },
  },
  {
    id: "tabs", label: "Tabs", icon: "tab", kind: "tabs",
    draft: { tag: "div", children: [{ tag: "div", attrs: { role: "tablist" }, children: [button("Tab 1"), button("Tab 2")] }, { tag: "div", children: [{ tag: "p", children: [text("Nội dung tab 1")] }] }, { tag: "div", children: [{ tag: "p", children: [text("Nội dung tab 2")] }] }] },
    roles: { tabs: [{ trigger: "new:0/0.0", panel: "new:0/1" }, { trigger: "new:0/0.1", panel: "new:0/2" }] },
  },
  {
    id: "accordion", label: "Accordion", icon: "expand_circle_down", kind: "accordion",
    draft: { tag: "div", children: [button("Câu hỏi 1"), { tag: "div", children: [{ tag: "p", children: [text("Trả lời 1")] }] }, button("Câu hỏi 2"), { tag: "div", children: [{ tag: "p", children: [text("Trả lời 2")] }] }] },
    roles: { items: [{ trigger: "new:0/0", panel: "new:0/1" }, { trigger: "new:0/2", panel: "new:0/3" }] },
  },
  {
    id: "modal", label: "Modal", icon: "web_asset", kind: "modal",
    draft: { tag: "div", children: [button("Mở hộp thoại"), { tag: "div", attrs: { role: "dialog" }, styles: base({ display: "none", padding: "24px", "background-color": "#ffffff" }), children: [{ tag: "p", children: [text("Nội dung hộp thoại")] }, button("Đóng")] }] },
    roles: { triggers: ["new:0/0"], dialog: "new:0/1", closeButton: "new:0/1.1", closeOn: ["esc", "backdrop", "button"] },
  },
];

// one batch = one revision = one Undo (R2); the created root is what the server selects (createdIds)
export function insertBatch(t: Template, at: { parentId: string; index: number }): Batch {
  return { commands: [
    { op: "createNode", parentId: at.parentId, index: at.index, draft: t.draft },
    ...(t.kind && t.roles ? [{ op: "convertToComponent" as const, id: "new:0/", kind: t.kind, roles: t.roles }] : []),
  ] };
}
// a new node dropped on `overId`: before / after it in its parent, or last inside it
export function dropPosition(index: DocIndex, components: readonly PanelComponent[], overId: string, zone: Zone): { parentId: string; index: number } | { error: string } {
  const over = index.get(overId);
  if (!over) return { error: "Không tìm thấy vị trí thả." };
  const parentId = zone === "inside" ? over.node.id : over.sectionName !== undefined ? undefined : over.parent;
  if (parentId === undefined) return { error: "Thả vào trong section, không đặt cạnh section." };
  const why = guardParent(index, components, parentId);
  if (why) return { error: why };
  return { parentId, index: zone === "inside" ? over.node.children.length : over.index + (zone === "after" ? 1 : 0) };
}
