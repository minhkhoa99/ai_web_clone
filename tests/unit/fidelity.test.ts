import { expect, test } from "vitest";
import { buildIR } from "@/core/ir";
import { migrateIR } from "@/core/ir-migrate";
import type { IRNodeV2, IRV2, FidelityItem } from "@/core/ir-v2";
import type { CaptureNode, PageCapture } from "@/core/capture";
import type { Interaction } from "@/core/interactions";
import { buildFidelity, refreshFidelity, styleTargetFidelity, MAX_FIDELITY_ITEMS } from "@/core/fidelity";

const n = (tag: string, children: CaptureNode[] = [], extra: Partial<CaptureNode> = {}): CaptureNode =>
  ({ tag, attrs: {}, bbox: [0, 0, 100, 50], style: {}, children, ...extra });
// html(0) > head(0.0), body(0.1) > section(0.1.0) > div#car(0.1.0.0) + button(0.1.0.1); section(0.1.1) > canvas, iframe, input
const dom = (pseudo375 = false, extraLi = false): CaptureNode => n("html", [
  n("head"),
  n("body", [
    n("section", [
      n("div", [n("ul", [n("li"), n("li"), ...(extraLi ? [n("li")] : [])])], { attrs: { id: "car" } }),
      n("button", [n("#text", [], { text: "next" })], { pseudo: { before: { content: pseudo375 ? '"b"' : '"a"' } } }),
    ]),
    n("section", [n("canvas", [], { attrs: { "data-dynamic": "canvas" } }), n("iframe", [], { attrs: { src: "https://other.test/?t=secret" } }), n("input")]),
  ]),
]);
const ix = (kind: Interaction["kind"], trigger: string, status: Interaction["status"], extra: Partial<Interaction> = {}): Interaction =>
  ({ id: `${kind}-${trigger}`, kind, trigger, status, ...extra });
const cap = (over: Partial<PageCapture> = {}): PageCapture => ({
  pageId: "p1", url: "https://x.test/", capturedAt: "2026-09-30", title: "t", meta: {},
  cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
  breakpoints: [{ bp: 375, dom: dom(), truncated: false }, { bp: 768, dom: dom(), truncated: false }, { bp: 1440, dom: dom(), truncated: false }],
  interactions: [], assets: {}, skippedAssets: [], dynamic: [{ order: 0, asset: "assets/abc.png" }],
  inventory: { scripts: 0, iframes: 1, canvases: 1, skippedNodes: 0 },
  ...over,
});
const irOf = (c: PageCapture): IRV2 => migrateIR(buildIR([c]), [c]);
const find = (items: FidelityItem[], feature: string) => items.filter((x) => x.feature === feature);

test("a captured carousel is only partial and anchored to its node", () => {
  const c = cap({ interactions: [ix("carousel", "#car", "captured")] });
  const items = buildFidelity([c], irOf(c));
  const carousel = items.find((x) => x.feature === "carousel");
  expect(carousel?.status).toBe("partial");
  expect(carousel?.nodeId).toBe("p1:0.1.0.0");
  expect(carousel?.sourceRef).toBe("p1:0.1.0.0");
});

test("failed or skipped interactions never become supported", () => {
  const c = cap({ interactions: [
    ix("menu", "#car", "failed"), ix("modal", "html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1) > button:nth-of-type(1)", "skipped"),
    ix("hover", "#car", "failed"), ix("carousel", "#nope", "failed"), ix("tab", "#car", "captured", { subtreeHtml: "<div>x</div>" }),
  ] });
  const items = buildFidelity([c], irOf(c));
  for (const kind of ["menu", "modal", "hover", "carousel"]) expect(find(items, kind).map((x) => x.status)).toEqual(["unsupported"]);
  expect(find(items, "modal")[0]!.nodeId).toBe("p1:0.1.0.1");
  expect(find(items, "tab")[0]!.status).toBe("partial"); // JS runtime is generic: markup + capture is not proof
  expect(items.some((x) => x.status === "supported" && x.feature !== "sticky")).toBe(false);
});

test("iframe and canvas are static partials; an unshot canvas is unsupported", () => {
  const c = cap();
  const items = buildFidelity([c], irOf(c));
  expect(find(items, "iframe").map((x) => [x.status, x.nodeId])).toEqual([["partial", "p1:0.1.1.1"]]);
  expect(find(items, "canvas").map((x) => [x.status, x.nodeId])).toEqual([["partial", "p1:0.1.1.0"]]);
  expect(items.every((x) => !x.note.includes("secret"))).toBe(true);
  expect(find(buildFidelity([cap({ dynamic: [] })], irOf(c)), "canvas")[0]!.status).toBe("unsupported");
});

test("skipped assets are unsupported without leaking query strings", () => {
  const c = cap({ skippedAssets: [{ url: "https://cdn.test/a.png?sig=secret", code: "DOWNLOAD_FAILED", reason: "HTTP 403 sig=secret" }] });
  const assets = find(buildFidelity([c], irOf(c)), "asset");
  expect(assets.map((x) => x.status)).toEqual(["unsupported"]);
  expect(assets[0]!.note).toContain("cdn.test/a.png");
  expect(assets[0]!.note).not.toContain("secret");
});

test("a legacy capture without inventory is partial, never supported by default", () => {
  const legacyCap = cap();
  delete legacyCap.inventory;
  const ir = irOf(legacyCap);
  expect(buildFidelity([legacyCap], ir).some((x) => x.note.includes("chưa đủ dữ liệu"))).toBe(true);
  expect(buildFidelity([legacyCap], ir).find((x) => x.feature === "capture-inventory")?.status).toBe("partial");
  expect(buildFidelity([cap()], ir).some((x) => x.feature === "capture-inventory")).toBe(false);
  // a capture.json predating fields does not crash the loader
  expect(buildFidelity([{ pageId: "p1" } as PageCapture], ir).map((x) => x.feature)).toEqual(["capture-inventory"]);
  // migration runs the analyzer too
  expect(ir.fidelity.some((x) => x.feature === "capture-inventory")).toBe(true);
});

test("scripts and skipped nodes from the inventory are unsupported", () => {
  const c = cap({ inventory: { scripts: 3, iframes: 1, canvases: 1, skippedNodes: 2 } });
  const items = buildFidelity([c], irOf(c));
  expect(find(items, "script").map((x) => x.status)).toEqual(["unsupported"]);
  expect(find(items, "script")[0]!.note).toContain("3");
  expect(find(items, "capture-skipped").map((x) => x.status)).toEqual(["unsupported"]);
});

test("CSSOM media, pseudo/breakpoint, state pseudo, focus, sticky and lazy-load gaps get their own items", () => {
  const c = cap({
    cssom: { keyframes: [], fontFace: [], media: ["@media (max-width: 1000px) { .a { color: red; } }", "@media (prefers-color-scheme: dark) { .a { color: #fff; } }"], vars: {}, stateSelectors: [".btn::before", ".card"] },
    breakpoints: [{ bp: 375, dom: dom(true, true), truncated: true }, { bp: 768, dom: dom(), truncated: false }, { bp: 1440, dom: dom(), truncated: false }],
    interactions: [ix("form", "#car", "captured", { styleDelta: { "outline-color": "blue" }, subtreeHtml: '<input value="hunter2">' }), ix("sticky", "#car", "captured", { styleDelta: { "background-color": "white" } })],
  });
  const items = buildFidelity([c], irOf(c));
  expect(find(items, "css-media").map((x) => x.status).sort()).toEqual(["partial", "unsupported"]);
  expect(find(items, "pseudo-breakpoint").map((x) => [x.status, x.nodeId, x.breakpoint])).toEqual([["partial", "p1:0.1.0.1", 375]]);
  expect(find(items, "breakpoint-structure").map((x) => [x.nodeId, x.breakpoint])).toEqual([["p1:0.1.0.0.0", 375]]);
  expect(find(items, "pseudo-state").map((x) => x.status)).toEqual(["partial"]);
  expect(find(items, "form").map((x) => x.status)).toEqual(["unsupported"]);
  expect(find(items, "sticky").map((x) => x.status)).toEqual(["partial"]);
  expect(find(items, "lazy-load").map((x) => [x.status, x.breakpoint])).toEqual([["partial", 375]]);
  expect(JSON.stringify(items)).not.toContain("hunter2");
});

const removeNode = (ir: IRV2, id: string): IRV2 => {
  const next = structuredClone(ir);
  const strip = (node: IRNodeV2): void => {
    node.children = node.children.filter((child) => child.id !== id);
    node.children.forEach(strip);
  };
  next.sections.forEach((s) => strip(s.root));
  return next;
};

test("deleting the clone node keeps the item anchored by sourceRef", () => {
  const c = cap({ interactions: [ix("carousel", "#car", "captured")] });
  const ir = irOf(c);
  const before: FidelityItem[] = [...buildFidelity([c], ir), { pageId: "p1", feature: "style-target", status: "unsupported", nodeId: "p1:0.1.0.0", note: "x" }];
  const after = removeNode(ir, "p1:0.1.0.0");
  // Re-derived from the capture the carousel has no clone counterpart any more (worse, not gone); without captures it is carried.
  for (const [items, status] of [[refreshFidelity(before, after, [c]), "unsupported"], [refreshFidelity(before, after, []), "partial"]] as const) {
    const carousel = items.find((x) => x.feature === "carousel");
    expect(carousel).toMatchObject({ status, sourceRef: "p1:0.1.0.0" });
    expect(carousel?.nodeId).toBeUndefined();
    const target = items.find((x) => x.feature === "style-target");
    expect(target).toMatchObject({ sourceRef: "p1:0.1.0.0" });
    expect(target?.nodeId).toBeUndefined();
  }
  expect(refreshFidelity(before, ir, [c]).filter((x) => x.feature === "style-target")).toHaveLength(1); // no duplicates
});

test("the list is capped with a final summary item", () => {
  const many: FidelityItem[] = Array.from({ length: MAX_FIDELITY_ITEMS + 150 }, (_, i) => ({ pageId: "p1", feature: "style-target", status: "unsupported", note: `n${i}` }));
  const items = refreshFidelity(many, irOf(cap()), []);
  expect(items).toHaveLength(MAX_FIDELITY_ITEMS);
  expect(items.at(-1)).toMatchObject({ feature: "fidelity-overflow", status: "unsupported" });
  expect(items.at(-1)!.note).toContain("151");
});

test("node-anchored findings are bounded per page and feature with a summary", () => {
  const c = cap({ interactions: Array.from({ length: 60 }, (_, i) => ix("sticky", `#h${i}`, i === 0 ? "failed" : "captured", { styleDelta: { color: "red" } })) });
  const sticky = find(buildFidelity([c], irOf(cap())), "sticky");
  expect(sticky).toHaveLength(51);
  expect(sticky[0]!.status).toBe("unsupported");
  expect(sticky.at(-1)).toMatchObject({ status: "partial" }); // worst of the 10 omitted, not of the listed ones
  expect(sticky.at(-1)!.note).toContain("10");
});

test("unrepresentable editor style targets become unsupported style-target items", () => {
  const items = styleTargetFidelity("p1", ["#i3k:hover (max-width:767.98px)", "#zz (min-width:500px)", "p1:0.1 [onclick]"], (el) => (el === "i3k" ? "p1:0.1.0" : undefined));
  expect(items).toEqual([
    { pageId: "p1", feature: "style-target", status: "unsupported", nodeId: "p1:0.1.0", sourceRef: "p1:0.1.0", note: expect.stringContaining(":hover") },
    { pageId: "p1", feature: "style-target", status: "unsupported", note: expect.stringContaining("(min-width:500px)") },
  ]);
});
