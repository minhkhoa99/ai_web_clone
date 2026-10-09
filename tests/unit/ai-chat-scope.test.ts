import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { aiPatchable, type CarouselSpec, type InteractiveSpec } from "@/core/interactive";
import { resolveComponents } from "@/core/ir-component";
import { callChatTool, chatScope, componentList, nodeDetail, nodeLine, outlineText, SCOPE_LIMITS } from "@/core/ai-chat-scope";

const el = (tag: string, children: CaptureNode[] = [], text?: string, attrs: Record<string, string> = {}): CaptureNode => ({ tag, attrs, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
function doc(mainKids?: CaptureNode[]): IRV2 {
  const dom = el("html", [el("head"), el("body", [
    el("header", [el("h1", [el("#text", [], "Tiêu đề")])]),
    // buildIR makes one section per child of <main>: a single wrapper keeps the three body nodes in one section
    el("main", mainKids ?? [el("div", [el("p", [el("#text", [], "Đoạn một")]), el("div", [el("p", [el("#text", [], "Đoạn hai")])]), el("input", [], undefined, { type: "password", value: "bí-mật", onclick: "x()" })])]),
    el("footer", [el("p", [el("#text", [], "Chân trang")])]),
  ])]);
  const capture = {
    url: "http://x.test/", pageId: "home", capturedAt: "2026-10-09T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  return buildIR([capture]) as IRV2;
}
const walk = (n: IRNodeV2): IRNodeV2[] => [n, ...n.children.flatMap(walk)];
const sectionWith = (ir: IRV2, text: string) => ir.sections.find((s) => walk(s.root).some((n) => n.text === text))!;
const nodeWith = (ir: IRV2, text: string) => walk(sectionWith(ir, text).root).find((n) => n.text === text)!;
// the fixture must split header / main / footer into different sections; if buildIR ever merges them, change the fixture, not the test
test("fixture sanity: three texts sit in three sections", () => {
  const ir = doc();
  expect(new Set(["Tiêu đề", "Đoạn một", "Chân trang"].map((t) => sectionWith(ir, t).id)).size).toBe(3);
});

test("selection -> the sections that hold it (page order); no selection or none on the page -> every section of the page", () => {
  const ir = doc();
  const main = sectionWith(ir, "Đoạn một"), footer = sectionWith(ir, "Chân trang");
  const one = chatScope(ir, "home", [nodeWith(ir, "Đoạn một").id]);
  expect(one.sectionIds).toEqual([main.id]);
  expect(one.roots).toEqual([main.root.id]);
  expect(one.allowed.has(nodeWith(ir, "Chân trang").id)).toBe(false);
  expect(one.focus).toEqual([nodeWith(ir, "Đoạn một").id]);
  const two = chatScope(ir, "home", [nodeWith(ir, "Chân trang").id, nodeWith(ir, "Đoạn một").id]);
  expect(two.sectionIds).toEqual(ir.pages[0]!.sectionIds.filter((id) => id === main.id || id === footer.id));
  const all = chatScope(ir, "home", ["nope"]);
  expect(all.sectionIds.length).toBe(ir.sections.length);
  expect(all.focus).toEqual([]);
});

test("allowed = stored ids of the sections; a section in a shared layout reports its page count", () => {
  const ir = doc();
  const s = sectionWith(ir, "Tiêu đề");
  const shared: IRV2 = { ...ir, sections: ir.sections.map((x) => (x.id === s.id ? { ...x, layoutId: "L1" } : x)), layouts: [...ir.layouts, { id: "L1", hash: "h", sectionId: s.id, pageIds: ["home", "about"] }] };
  const scope = chatScope(shared, "home", [s.root.id]);
  expect([...scope.allowed].sort()).toEqual(walk(s.root).map((n) => n.id).sort());
  expect(scope.shared.get(s.id)).toBe(2);
  expect(outlineText(scope, 1440, SCOPE_LIMITS.outlineChars)).toContain("dùng chung 2 trang");
});

test("outline: focus, its ancestors and siblings first; over budget the rest folds into '… +N con'", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", []);
  const full = outlineText(scope, 1440, SCOPE_LIMITS.outlineChars);
  expect(full).toContain('"Đoạn hai"');
  const focus = nodeWith(ir, "Đoạn một").id;
  const focusScope = chatScope(ir, "home", [focus]);
  // a budget that fits exactly the chain root -> … -> focus (+5): nothing else, the rest folds
  const chain: string[] = [];
  for (let id: string | undefined = focus; id !== undefined; id = focusScope.parent.get(id)) chain.unshift(id);
  const need = chain.reduce((n, id, depth) => n + depth * 2 + nodeLine(focusScope, focusScope.nodes.get(id)!, 1440).length + 1, 0) + 5;
  const tight = outlineText(focusScope, 1440, need);
  expect(tight).toContain('"Đoạn một"');
  expect(tight).toMatch(/… \+\d+ con/);
  expect(tight).not.toContain('"Đoạn hai"');
  expect(tight.split("\n").filter((l) => !l.trim().startsWith("…"))).toHaveLength(chain.length);
});

test("nodeDetail: styles + safe attrs, never on* / a password value, capped", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", []);
  const input = walk(sectionWith(ir, "Đoạn một").root).find((n) => n.tag === "input")!;
  const text = nodeDetail(scope, input.id);
  expect(text).toContain('"type":"password"');
  expect(text).not.toContain("bí-mật");
  expect(text).not.toContain("onclick");
  expect(nodeDetail(scope, "nope")).toContain("không thuộc phạm vi");
  expect(nodeDetail(scope, sectionWith(ir, "Đoạn một").root.id, 50).length).toBeLessThanOrEqual(50);
});

test("tools: readNode / readSubtree / findText stay in scope and under 8 000 chars", () => {
  const ir = doc();
  const scope = chatScope(ir, "home", [nodeWith(ir, "Đoạn một").id]);
  expect(callChatTool(scope, 1440, "readNode", { id: nodeWith(ir, "Chân trang").id })).toContain("không thuộc phạm vi");
  expect(callChatTool(scope, 1440, "readSubtree", { id: sectionWith(ir, "Đoạn một").root.id, depth: 9 })).toContain('"Đoạn hai"');
  expect(callChatTool(scope, 1440, "findText", { query: "đoạn" })).toContain('"Đoạn hai"');
  expect(callChatTool(scope, 1440, "findText", { query: "chân" })).toBe("[]");
  expect(callChatTool(scope, 1440, "drop", {})).toContain("không có tool");
  expect(callChatTool(scope, 1440, "readSubtree", { id: sectionWith(ir, "Đoạn một").root.id }).length).toBeLessThanOrEqual(SCOPE_LIMITS.toolChars);
});

test("aiPatchable drops role-node fields; componentList lists only AI fields", () => {
  expect(aiPatchable("carousel")).not.toContain("arrows");
  expect(aiPatchable("carousel")).toContain("slidesPerView");
  expect(aiPatchable("modal")).toEqual(["closeOn"]);
  const ir = doc();
  expect(componentList(chatScope(ir, "home", []))).toEqual([]);
});

// R8: a main's children reach an instance as generated `instance:` nodes (not stored): they are in the scope and the
// OUTLINE, labelled read-only, but never in `allowed` (commands may only name stored ids).
function withInstance(): { ir: IRV2; section: IRV2["sections"][number]; generated: IRNodeV2[] } {
  const ir = doc();
  const section = sectionWith(ir, "Đoạn một");
  const mainRoot = structuredClone(section.root);
  const retag = (n: IRNodeV2, parentId?: string): void => {
    n.id = `main:C1:${n.id}`;
    if (parentId) n.parentId = parentId; else delete n.parentId;
    n.component = { id: "C1", role: "main" };
    n.children.forEach((c) => retag(c, n.id));
  };
  retag(mainRoot);
  const root = { ...section.root, children: [], component: { id: "C1", role: "instance" as const, sourceId: mainRoot.id, overrides: [] } };
  const out: IRV2 = {
    ...ir,
    sections: ir.sections.map((x) => (x.id === section.id ? { ...x, root } : x)),
    components: [{ id: "C1", root: mainRoot, instanceIds: [root.id] }],
  };
  const generated = walk(resolveComponents(out).sections.find((x) => x.id === section.id)!.root).filter((n) => n.id.startsWith("instance:"));
  return { ir: out, section: out.sections.find((x) => x.id === section.id)!, generated };
}

test("R8: a node generated from a main is in scope and focus but not allowed; it is read-only everywhere", () => {
  const { ir, section, generated } = withInstance();
  expect(generated.length).toBeGreaterThan(0);
  const gen = generated.find((n) => n.text === "Đoạn một")!;
  const scope = chatScope(ir, "home", [gen.id]);
  expect(scope.sectionIds).toEqual([section.id]);
  expect(scope.nodes.has(gen.id)).toBe(true);
  expect(scope.focus).toEqual([gen.id]);
  expect([...scope.allowed]).toEqual([section.root.id]); // only the stored instance root
  expect(scope.allowed.has(gen.id)).toBe(false);
  const readOnly = "chỉ đọc (thuộc main)";
  expect(nodeLine(scope, gen, 1440)).toContain(readOnly);
  expect(nodeLine(scope, scope.nodes.get(section.root.id)!, 1440)).not.toContain(readOnly);
  expect(outlineText(scope, 1440, SCOPE_LIMITS.outlineChars)).toContain(readOnly);
  expect(JSON.parse(nodeDetail(scope, gen.id)).editable).toBe(false);
  expect(JSON.parse(nodeDetail(scope, section.root.id)).editable).toBe(true);
  const hits = JSON.parse(callChatTool(scope, 1440, "findText", { query: "đoạn một" })) as { id: string; readOnly?: boolean }[];
  expect(hits).toEqual([{ id: gen.id, text: "Đoạn một", readOnly: true }]);
});

// E2 interactive roots: the AI sees config fields (aiPatchable) and item ids, never the role-node fields.
const carousel = (slides: string[], root: string, extra: Partial<CarouselSpec> = {}): CarouselSpec => ({
  kind: "carousel", source: "manual", confidence: "manual", viewport: root, track: root, slides, active: 0,
  autoplay: false, interval: 3000, loop: true, direction: "horizontal", transition: "slide", speed: 400,
  slidesPerView: { 1440: 3 }, gap: { 1440: 8 }, arrows: { prev: "a-prev", next: "a-next" }, pagination: { container: "a-dots", kind: "bullets" }, ...extra,
});
const withInteractive = (ir: IRV2, nodeId: string, interactive: InteractiveSpec): IRV2 => {
  const next = structuredClone(ir);
  for (const s of next.sections) for (const n of walk(s.root)) if (n.id === nodeId) n.interactive = interactive;
  return next;
};

test("component views: componentList and nodeDetail show AI fields + item ids, never arrows / pagination", () => {
  const base = doc();
  const root = sectionWith(base, "Đoạn một").root;
  const slides = root.children.slice(0, 2).map((c) => c.id);
  const ir = withInteractive(base, root.id, carousel(slides, root.id));
  const scope = chatScope(ir, "home", []);
  const list = componentList(scope);
  expect(list).toHaveLength(1);
  expect(list[0]!.id).toBe(root.id);
  expect(list[0]!.kind).toBe("carousel");
  expect(list[0]!.items).toEqual(slides);
  expect(list[0]!.config).toMatchObject({ speed: 400, loop: true, slidesPerView: { 1440: 3 }, gap: { 1440: 8 }, active: 0 });
  expect(Object.keys(list[0]!.config).sort()).toEqual(aiPatchable("carousel").sort());
  const detail = nodeDetail(scope, root.id);
  expect(detail).toContain('"speed":400');
  expect(detail).not.toContain("arrows");
  expect(detail).not.toContain("pagination");
  expect(detail).not.toContain("a-prev");
  expect(JSON.parse(detail).interactive.items).toEqual(slides);
  expect(nodeLine(scope, scope.nodes.get(root.id)!, 1440)).toContain("component carousel");
  // a modal with a closeButton: only closeOn is an AI field
  const modal = componentList(chatScope(withInteractive(base, root.id, { kind: "modal", source: "manual", confidence: "manual", triggers: [], dialog: root.id, closeOn: ["esc"], closeButton: "x" }), "home", []));
  expect(modal[0]!.config).toEqual({ closeOn: ["esc"] });
});

test("componentList caps at 50 components", () => {
  const ir = doc();
  const wrap = sectionWith(ir, "Đoạn một").root;
  const kids: IRNodeV2[] = Array.from({ length: 55 }, (_, i) => ({
    id: `m${i}`, parentId: wrap.id, tag: "div", type: "container", attrs: {}, styles: structuredClone(wrap.styles), children: [],
    interactive: { kind: "video", source: "manual", confidence: "manual", node: `m${i}`, mode: "native", autoplay: false, muted: false, loop: false, controls: true },
  } as IRNodeV2));
  const big: IRV2 = { ...ir, sections: ir.sections.map((s) => (s.root.id === wrap.id ? { ...s, root: { ...s.root, children: [...s.root.children, ...kids] } } : s)) };
  const scope = chatScope(big, "home", []);
  expect(scope.components.size).toBe(55);
  expect(componentList(scope)).toHaveLength(SCOPE_LIMITS.components);
});

// R = section root, F = the focus, S1 / S2 = its siblings, Fk = its child (text "kid"); the child of S1 is "the rest".
function priorityDoc(): { scope: ReturnType<typeof chatScope>; ids: Record<"R" | "F" | "Fk" | "S1" | "S2", string> } {
  const ir = doc([el("div", [
    el("div", [el("p", [el("#text", [], "kid")])]),
    el("div", [el("p", [el("#text", [], "sibtext")])]),
    el("div"),
  ])]);
  const R = sectionWith(ir, "kid").root;
  const [F, S1, S2] = R.children as [IRNodeV2, IRNodeV2, IRNodeV2];
  return { scope: chatScope(ir, "home", [F.id]), ids: { R: R.id, F: F.id, Fk: F.children[0]!.id, S1: S1.id, S2: S2.id } };
}
const budget = (scope: ReturnType<typeof chatScope>, ids: string[]) =>
  ids.reduce((n, id) => {
    let depth = 0;
    for (let p = scope.parent.get(id); p !== undefined; p = scope.parent.get(p)) depth++;
    return n + depth * 2 + nodeLine(scope, scope.nodes.get(id)!, 1440).length + 1;
  }, 0) + 5;

test("outline priority: the focus chain, then its siblings, then its subtree, then the rest", () => {
  const { scope, ids } = priorityDoc();
  expect(scope.focus).toEqual([ids.F]);
  const idsOf = (text: string) => text.split("\n").map((l) => l.trim().split(" · ")[0]!);
  // chain + siblings: the siblings are in; the focus subtree and the rest are folded
  const sib = outlineText(scope, 1440, budget(scope, [ids.R, ids.F, ids.S1, ids.S2]));
  expect(idsOf(sib)).toEqual(expect.arrayContaining([ids.R, ids.F, ids.S1, ids.S2]));
  expect(sib).not.toContain('"kid"');
  expect(sib).not.toContain('"sibtext"');
  expect(sib).toMatch(/… \+\d+ con/);
  // chain + siblings + subtree: the subtree is in; the rest (the sibling's own child) is still folded
  const sub = outlineText(scope, 1440, budget(scope, [ids.R, ids.F, ids.S1, ids.S2, ids.Fk, ...scope.nodes.get(ids.Fk)!.children.map((c) => c.id)]));
  expect(sub).toContain('"kid"');
  expect(sub).not.toContain('"sibtext"');
  expect(idsOf(sub)).toEqual(expect.arrayContaining([ids.S1, ids.S2]));
  // everything fits: the rest shows too
  expect(outlineText(scope, 1440, SCOPE_LIMITS.outlineChars)).toContain('"sibtext"');
});
