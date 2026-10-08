import { expect, test } from "vitest";
import { applyCommands, prepareCommands } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { indexPage } from "@/app/p/[id]/editor/visual/model";
import { dropPosition, insertBatch, TEMPLATES, type Template } from "@/app/p/[id]/editor/visual/templates";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const doc = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1"], shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s1" } })])]) }],
  sections: [{ id: "s1", pageId: "pg", name: "S", role: "main", hash: "h", origin: "capture", root: n("r", "section", [n("a", "p"), n("b", "div")]) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
} as unknown as IRV2);
let k = 0;
const ids = () => `x${++k}`;
const insert = (t: Template) => {
  const b = insertBatch(t, { parentId: "r", index: 1 });
  if ("error" in b) throw new Error(b.error);
  const done = applyCommands(doc(), prepareCommands(doc(), b.commands, ids));
  return { b, done, made: done.ir.sections[0]!.root.children[1]! };
};
const tags = (node: IRNodeV2, out = new Map<string, string>()) => { out.set(node.id, node.tag); node.children.forEach((c) => tags(c, out)); return out; };
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

test("every template of spec §3 is one valid batch (createNode [+ convertToComponent]) the core accepts; component samples become their kind, roles on elements; Vietnamese text, no class", () => {
  expect(TEMPLATES.map((t) => t.label)).toEqual(["Text", "Tiêu đề", "Đoạn văn", "Ảnh", "Nút", "Link", "Khung trống", "Flex hàng", "Flex cột", "Grid 2 cột", "Grid 3 cột", "Section trống", "Carousel", "Tabs", "Accordion", "Modal"]);
  for (const t of TEMPLATES) {
    const { b, done, made } = insert(t);
    expect(done.createdIds, t.id).toEqual([made.id]);
    if (t.kind) {
      expect(made.interactive?.kind, t.id).toBe(t.kind);
      const inside = tags(made), refs = strings(made.interactive).filter((s) => inside.has(s));
      expect(refs.length, t.id).toBeGreaterThan(0);
      for (const r of refs) expect(inside.get(r), `${t.id} ${r}`).not.toBe("#text");
    } else expect(b.commands, t.id).toHaveLength(1);
    expect(JSON.stringify(t.draft), t.id).not.toMatch(/"class"/);
  }
});

test("R2 role paths count the draft's raw children, #text included: a path skipping a text child lands on the element", () => {
  const acc = TEMPLATES.find((t) => t.id === "accordion")!;
  const t: Template = {
    ...acc,
    draft: { ...acc.draft, children: [{ tag: "#text", text: "\n" }, ...acc.draft.children!] },
    roles: { items: [{ trigger: "new:0/1", panel: "new:0/2" }, { trigger: "new:0/3", panel: "new:0/4" }] },
  };
  const { made } = insert(t);
  expect(made.children[0]!.tag).toBe("#text");
  const spec = made.interactive as { items: { trigger: string; panel: string }[] };
  expect(spec.items.map((x) => [x.trigger, x.panel])).toEqual([[made.children[1]!.id, made.children[2]!.id], [made.children[3]!.id, made.children[4]!.id]]);
  expect(made.children[1]!.tag).toBe("button");
});

test("dropPosition: before / after a node in its parent, inside a container at the end; a section root's side or the shell refuses", () => {
  const index = indexPage({ shell: doc().pages[0]!.shell, sections: [{ id: "s1", name: "S", root: doc().sections[0]!.root }] } as never);
  expect(dropPosition(index, [], "b", "before")).toEqual({ parentId: "r", index: 1 });
  expect(dropPosition(index, [], "a", "after")).toEqual({ parentId: "r", index: 1 });
  expect(dropPosition(index, [], "b", "inside")).toEqual({ parentId: "b", index: 0 });
  expect(dropPosition(index, [], "r", "before")).toEqual({ error: expect.any(String) });
  expect(dropPosition(index, [], "body", "inside")).toEqual({ error: expect.any(String) });
});
