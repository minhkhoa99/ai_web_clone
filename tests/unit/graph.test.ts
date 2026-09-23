import { expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { CaptureNode, PageCapture } from "@/core/capture";
import type { Interaction } from "@/core/interactions";
import { AppError } from "@/core/errors";
import { openDb } from "@/core/db";
import { buildIR, type IR, type IRNode } from "@/core/ir";
import { coverage, contextForFix, sharedLayouts, writeGraph } from "@/core/graph";

type Opts = { style?: Record<string, string>; bbox?: [number, number, number, number] };

function el(tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], opts: Opts = {}): CaptureNode {
  return { tag, attrs, bbox: opts.bbox ?? [0, 0, 100, 20], style: opts.style ?? {}, children };
}

function txt(text: string): CaptureNode {
  return { tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] };
}

function doc(body: CaptureNode[]): CaptureNode {
  return el("html", {}, [el("head", {}, [el("title", {}, [txt("t")])]), el("body", {}, body)]);
}

type CapOpts = { interactions?: Interaction[] };

function capture(pageId: string, url: string, dom: CaptureNode, opts: CapOpts = {}): PageCapture {
  return {
    url,
    pageId,
    capturedAt: "2026-09-23T00:00:00.000Z",
    title: `title ${pageId}`,
    meta: { description: pageId },
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [
      { bp: 1440, dom, truncated: false },
      { bp: 768, dom, truncated: false },
      { bp: 375, dom, truncated: false },
    ],
    interactions: opts.interactions ?? [],
    assets: {},
    skippedAssets: [],
    dynamic: [],
  };
}

const header = () => el("header", { class: "top" }, [el("a", { href: "/" }, [txt("Logo")])], { style: { color: "red" } });

// header() + button (red) + nav (red) -> 3x color:red, over extractTokens' minCount=3.
function tokenIr(): IR {
  return buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        header(),
        el("div", {}, [el("button", { id: "b1" }, [txt("go")])], { style: { color: "red" } }),
        el("nav", {}),
        el("div", {}, [el("img", { src: "https://x.test/logo.png", alt: "logo" }, [])]),
      ]),
    ),
  ]);
}

function db(): DatabaseSync {
  return openDb(":memory:");
}

test("writeGraph + coverage: counts Interaction nodes by status per page, zero-interaction pages still listed", () => {
  const interactions: Interaction[] = [
    { id: "i1", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "captured" },
    { id: "i2", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "failed" },
    { id: "i3", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "skipped" },
  ];
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("nav", {})]), { interactions }),
    capture("p2", "https://x.test/about", doc([el("footer", {})])),
  ]);

  const d = db();
  writeGraph(d, "proj1", ir, {});
  const rows = coverage(d, "proj1");

  expect(rows).toEqual([
    { page: "/", captured: 1, failed: 1, skipped: 1 },
    { page: "/about", captured: 0, failed: 0, skipped: 0 },
  ]);
});

test("contextForFix: returns the requested section's subtree, tokens and interactions", () => {
  const interactions: Interaction[] = [{ id: "i1", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "captured" }];
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([header(), el("div", {}, [], { style: { color: "red" } }), el("nav", {}), el("div", {}, [], { style: { color: "red" } })]),
      { interactions },
    ),
  ]);
  const navSection = ir.sections.find((s) => s.role === "nav")!;

  const d = db();
  writeGraph(d, "proj1", ir, {});
  const ctx = contextForFix(d, "proj1", navSection.id, 100_000);

  expect(ctx.subtree).toEqual(navSection.root);
  expect(ctx.interactions).toEqual([interactions[0]]);

  const headerSection = ir.sections.find((s) => s.role === "header")!;
  const headerCtx = contextForFix(d, "proj1", headerSection.id, 100_000);
  expect(headerCtx.tokens).toEqual({ "--color-1": "red" });
});

test("writeGraph: a hover-state class (not in node.cls) still counts for USES_TOKEN, and contextForFix returns it", () => {
  const interactions: Interaction[] = [{ id: "i1", kind: "hover", trigger: "#b\\31 ", styleDelta: { color: "red", "font-weight": "bold" }, status: "captured" }];
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        header(),
        el("div", {}, [], { style: { color: "red" } }),
        el("div", {}, [], { style: { color: "red" } }),
        el("div", {}, [el("button", { id: "b1" }, [txt("go")])]),
      ]),
      { interactions },
    ),
  ]);
  expect(ir.tokens["--color-1"]).toBe("red");
  const buttonSection = ir.sections.find((s) => s.root.children.some((c) => c.tag === "button"))!;
  const buttonNode = buttonSection.root.children.find((c) => c.tag === "button")!;
  const hoverClass = buttonNode.states!.hover!;

  const d = db();
  writeGraph(d, "proj1", ir, {});

  const edge = d.prepare("SELECT * FROM edges WHERE project_id=? AND type='USES_TOKEN' AND src=? AND dst='token:--color-1'").get("proj1", buttonSection.id);
  expect(edge).toBeTruthy();

  const ctx = contextForFix(d, "proj1", buttonSection.id, 100_000);
  expect(ctx.classes[hoverClass]).toEqual({ base: { color: "red", "font-weight": "bold" } });
});

test("writeGraph is idempotent: writing the same IR twice does not duplicate rows", () => {
  const ir = tokenIr();
  const d = db();
  writeGraph(d, "proj1", ir, { "https://x.test/logo.png": "assets/logo.png" });
  const nodesOnce = (d.prepare("SELECT COUNT(*) AS n FROM nodes WHERE project_id=?").get("proj1") as { n: number }).n;
  const edgesOnce = (d.prepare("SELECT COUNT(*) AS n FROM edges WHERE project_id=?").get("proj1") as { n: number }).n;

  writeGraph(d, "proj1", ir, { "https://x.test/logo.png": "assets/logo.png" });
  const nodesTwice = (d.prepare("SELECT COUNT(*) AS n FROM nodes WHERE project_id=?").get("proj1") as { n: number }).n;
  const edgesTwice = (d.prepare("SELECT COUNT(*) AS n FROM edges WHERE project_id=?").get("proj1") as { n: number }).n;

  expect(nodesOnce).toBeGreaterThan(0);
  expect(nodesTwice).toBe(nodesOnce);
  expect(edgesTwice).toBe(edgesOnce);
});

test("writeGraph: edges for HAS_SECTION, USES_LAYOUT, INSTANCE_OF, USES_TOKEN, USES_ASSET, TRIGGERS", () => {
  const item = (t: string) => el("li", { class: "i" }, [el("a", {}, [txt(t)])]);
  const interactions: Interaction[] = [{ id: "i1", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "captured" }];
  const ir = buildIR([
    capture(
      "p1",
      "https://x.test/",
      doc([
        header(),
        el("div", {}, [], { style: { color: "red" } }),
        el("nav", {}, [], { style: { color: "red" } }),
        el("div", {}, [el("ul", {}, [item("a"), item("b"), item("c")])]),
        el("div", {}, [el("img", { src: "https://x.test/logo.png", alt: "logo" }, [])]),
      ]),
      { interactions },
    ),
    capture("p2", "https://x.test/about", doc([header(), el("footer")])),
  ]);
  const assets = { "https://x.test/logo.png": "assets/logo.png" };

  const d = db();
  writeGraph(d, "proj1", ir, assets);
  const edgeTypes = (d.prepare("SELECT DISTINCT type FROM edges WHERE project_id=?").all("proj1") as { type: string }[]).map((r) => r.type).sort();
  expect(edgeTypes).toEqual(["HAS_SECTION", "INSTANCE_OF", "TRIGGERS", "USES_ASSET", "USES_LAYOUT", "USES_TOKEN"]);

  const layout = ir.layouts[0]!;
  const layoutEdges = d.prepare("SELECT src FROM edges WHERE project_id=? AND type='USES_LAYOUT' AND dst=?").all("proj1", layout.id) as { src: string }[];
  expect(layoutEdges.map((r) => r.src).sort()).toEqual(["p1", "p2"]);

  const component = ir.components[0]!;
  const compSection = ir.sections.find((s) => s.root.children.some((c) => c.tag === "ul"))!;
  const instanceEdge = d.prepare("SELECT * FROM edges WHERE project_id=? AND type='INSTANCE_OF' AND src=? AND dst=?").get("proj1", compSection.id, component.id);
  expect(instanceEdge).toBeTruthy();

  const navSection = ir.sections.find((s) => s.role === "nav")!;
  const triggerEdge = d.prepare("SELECT * FROM edges WHERE project_id=? AND type='TRIGGERS' AND src=? AND dst='i1'").get("proj1", navSection.id);
  expect(triggerEdge).toBeTruthy();
});

test("contextForFix: unknown section -> AppError with context", () => {
  const d = db();
  writeGraph(d, "proj1", tokenIr(), {});
  let caught: unknown;
  try {
    contextForFix(d, "proj1", "nope", 1000);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code: "GRAPH_NOT_FOUND", context: { projectId: "proj1", sectionId: "nope" } });
});

test("contextForFix: prunes deepest children to fit budgetChars but keeps the focusIds path", () => {
  // Each level's non-protected sibling is a small subtree (not a single word) so replacing it
  // with a pruned marker is a real saving; the leaf is nested under the *other* branch, protected.
  const bushy = (label: string): CaptureNode =>
    el("div", {}, [el("p", {}, [txt(`${label}-a`)]), el("p", {}, [txt(`${label}-b`)]), el("p", {}, [txt(`${label}-c`)]), el("p", {}, [txt(`${label}-d`)])]);
  const deep = (n: number): CaptureNode => (n === 0 ? el("span", {}, [txt("leaf")]) : el("div", {}, [deep(n - 1), bushy(`wide-${n}`)]));
  const ir = buildIR([capture("p1", "https://x.test/", doc([el("div", {}, [deep(8)])]))]);
  const section = ir.sections[0]!;

  const findLeaf = (n: IRNode): IRNode | undefined => (n.tag === "span" ? n : n.children.map(findLeaf).find(Boolean));
  const leaf = findLeaf(section.root)!;

  const d = db();
  writeGraph(d, "proj1", ir, {});
  const full = contextForFix(d, "proj1", section.id, 100_000);
  const fullSize = JSON.stringify(full.subtree).length;

  const pruned = contextForFix(d, "proj1", section.id, 400, [leaf.id]);
  const prunedSize = JSON.stringify(pruned.subtree).length;

  expect(prunedSize).toBeLessThan(fullSize);
  const stillHasLeaf = (n: IRNode): boolean => n.id === leaf.id || n.children.some(stillHasLeaf);
  expect(stillHasLeaf(pruned.subtree)).toBe(true);
});

test("sharedLayouts: returns the shared layout", () => {
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([header(), el("section", {}, [el("h1", {}, [txt("Home")])])])),
    capture("p2", "https://x.test/about", doc([header(), el("article", {}, [el("p", {}, [txt("About")])])])),
  ]);
  const d = db();
  writeGraph(d, "proj1", ir, {});

  const layouts = sharedLayouts(d, "proj1");
  expect(layouts).toEqual(ir.layouts);
});

test("writeGraph: an interaction id repeated across pages (shared header) and two URLs of one asset file store one node / one edge each", () => {
  const interactions: Interaction[] = [{ id: "i1", kind: "menu", trigger: "html:nth-of-type(1) > body:nth-of-type(1) > nav:nth-of-type(1)", status: "captured" }];
  const ir = buildIR([
    capture("p1", "https://x.test/", doc([el("nav", {}), el("div", {}, [el("img", { src: "https://x.test/a.png" }), el("img", { src: "https://x.test/a.png?v=2" })])]), { interactions }),
    capture("p2", "https://x.test/about", doc([el("nav", {})]), { interactions }),
  ]);
  const d = db();
  writeGraph(d, "proj1", ir, { "https://x.test/a.png": "assets/aa.png", "https://x.test/a.png?v=2": "assets/aa.png" });
  const count = (type: string) => (d.prepare("SELECT COUNT(*) n FROM nodes WHERE project_id='proj1' AND type=?").get(type) as { n: number }).n;
  expect(count("Interaction")).toBe(1);
  expect(count("Asset")).toBe(1);
  const assetEdges = d.prepare("SELECT src,dst FROM edges WHERE project_id='proj1' AND type='USES_ASSET'").all();
  expect(assetEdges).toEqual([{ src: expect.any(String), dst: "asset:assets/aa.png" }]);
});
