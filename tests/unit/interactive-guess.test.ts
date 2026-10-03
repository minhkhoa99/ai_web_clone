import { expect, test } from "vitest";
import { documentStore } from "@/core/ir-store";
import { guessAll, guessAt, measureCarousel, migrateBehaviors, pageNodes, placeGuesses, upgradeDocument } from "@/core/interactive-guess";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], attrs: Record<string, string> = {}, extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const page = (...roots: IRNodeV2[]): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: roots.map((_, i) => `s${i}`), shell: n("html", "html", [n("body", "body", roots.map((_, i) => n(`ph${i}`, "#section", [], { "data-section": `s${i}` })))]) }],
  sections: roots.map((root, i) => ({ id: `s${i}`, pageId: "p", name: `s${i}`, role: "block", hash: `h${i}`, origin: "capture" as const, root })),
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
// site2 in IR form: header menu, two sibling dropdowns, tabs, modal (trigger + dialog in one section), details, scroll-snap carousel
const site2 = () => page(
  n("hdr", "header", [n("menu-btn", "button", [], { "aria-expanded": "false", "aria-controls": "main-nav" }), n("nav", "nav", [], { id: "main-nav" })]),
  n("dd", "section", [n("vis", "button", [], { "aria-expanded": "false" }), n("vism", "ul"), n("fade", "button", [], { "aria-expanded": "false" }), n("fadem", "ul")]),
  n("tabs", "section", [n("tl", "div", [n("t1", "button", [], { role: "tab", "aria-selected": "true", "aria-controls": "panel-1" }), n("t2", "button", [], { role: "tab", "aria-selected": "false", "aria-controls": "panel-2" })], { role: "tablist" }),
    n("pn1", "div", [], { role: "tabpanel", id: "panel-1" }), n("pn2", "div", [], { role: "tabpanel", id: "panel-2", hidden: "" })]),
  n("mod", "section", [n("open", "button", [], { "aria-haspopup": "dialog", "data-modal": "#dialog" }), n("dlg", "div", [n("x", "button", [], { "data-close": "" })], { id: "dialog", role: "dialog" })]),
  n("faq", "section", [n("det", "details", [n("sum", "summary"), n("ans", "p")])]),
  n("car", "section", [n("cv", "div", [n("c1", "div", [], {}, { box: { 1440: [0, 0, 300, 120] } }), n("c2", "div", [], {}, { box: { 1440: [300, 0, 300, 120] } })], {},
    { box: { 1440: [0, 0, 300, 120] }, styles: { base: { "scroll-snap-type": "x mandatory", "overflow-x": "auto" }, bp: {}, state: {}, pseudo: {} } }),
    n("cnext", "button", [], { "aria-label": "Next slide" })]),
  n("vid", "section", [n("v", "video", [], { autoplay: "", muted: "", loop: "" }), n("yt", "iframe", [], { src: "https://www.youtube.com/embed/abc123?autoplay=1" })]),
);
const find = (doc: IRV2, id: string): IRNodeV2 | undefined => { let hit: IRNodeV2 | undefined; const v = (x: IRNodeV2) => { if (x.id === id) hit = x; x.children.forEach(v); }; doc.sections.forEach((s) => v(s.root)); return hit; };

test("guessAll on site2: tabs, modal, details accordion, menu, video + embed; sibling dropdowns: first wins (R2)", () => {
  const p = pageNodes(site2(), "p");
  const by = (kind: string) => guessAll(p).filter((g) => g.spec.kind === kind);
  expect(by("tabs")[0]).toMatchObject({ root: "tabs", spec: { tabs: [{ trigger: "t1", panel: "pn1" }, { trigger: "t2", panel: "pn2" }], active: 0, source: "aria", confidence: "guessed" } });
  expect(by("modal")[0]).toMatchObject({ root: "dlg", spec: { triggers: ["open"], dialog: "dlg", closeButton: "x", closeOn: ["esc", "backdrop", "button"] } });
  expect(by("accordion")[0]).toMatchObject({ root: "faq", spec: { source: "details", items: [{ trigger: "sum", panel: "ans", open: false }] } });
  expect(by("menu")[0]).toMatchObject({ root: "hdr", spec: { trigger: "menu-btn", panel: "nav", openOn: "click" } });
  expect(by("video").map((g) => g.spec)).toEqual([
    expect.objectContaining({ node: "v", mode: "native", autoplay: true, muted: true, loop: true, controls: false }),
    expect.objectContaining({ node: "yt", mode: "embed", autoplay: true, muted: true }), // autoplay always muted (schema)
  ]);
  const doc = site2();
  expect(migrateBehaviors(doc)).toBe(doc); // nothing to migrate: the same object
});

test("guessAt carousel (scroll-snap): viewport = track, slides, next arrow, root = LCA; slidesPerView/gap measured from box", () => {
  const p = pageNodes(site2(), "p");
  const g = guessAt(p, "cv", "carousel")!;
  expect(g).toMatchObject({ root: "car", spec: { kind: "carousel", source: "scroll-snap", viewport: "cv", track: "cv", slides: ["c1", "c2"], arrows: { next: "cnext" }, slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, autoplay: false } });
  expect(g.notes.join(" ")).toContain("giá trị mặc định");
  expect(measureCarousel(p, "cv", ["c1", "c2"])).toEqual({ slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, direction: "horizontal" });
});

test("§9: behaviors become guessed interactives (defaults noted), unresolved stays out, idempotent, no behavior left", () => {
  const ir = site2();
  ir.interactions = [
    { id: "ix-car", kind: "carousel", trigger: "#x", status: "captured", pageId: "p" },
    { id: "ix-tab", kind: "tab", trigger: "#t1", status: "captured", pageId: "p" },
  ];
  const sec = (id: string) => ir.sections.find((s) => s.root.id === id)!.root;
  sec("car").children[0]!.behavior = "ix-car";
  sec("tabs").children[0]!.children[0]!.behavior = "ix-tab";
  sec("mod").children[0]!.behavior = "unresolved";
  const once = migrateBehaviors(ir);
  expect(JSON.stringify(once)).not.toContain('"behavior"');
  expect(find(once, "car")!.interactive).toMatchObject({ kind: "carousel", confidence: "guessed" });
  expect(find(once, "tabs")!.interactive).toMatchObject({ kind: "tabs" });
  expect(find(once, "dlg")!.interactive).toBeUndefined(); // only behaviors migrate (§9); unresolved -> nothing
  expect(once.fidelity.some((x) => x.feature === "component-note" && x.note.includes("giá trị mặc định"))).toBe(true);
  expect(migrateBehaviors(once)).toBe(once);
  expect(upgradeDocument(once)).toBe(once);
});

test("R2: two sibling dropdowns sharing a parent both become components (second root = its trigger); every tab of one tablist -> one tabs", () => {
  const ir = site2();
  ir.interactions = [
    { id: "ix-vis", kind: "menu", trigger: "#vis", status: "captured", pageId: "p" },
    { id: "ix-fade", kind: "menu", trigger: "#fade", status: "captured", pageId: "p" },
    { id: "ix-t1", kind: "tab", trigger: "#t1", status: "captured", pageId: "p" },
    { id: "ix-t2", kind: "tab", trigger: "#t2", status: "captured", pageId: "p" },
  ];
  find(ir, "vis")!.behavior = "ix-vis";
  find(ir, "fade")!.behavior = "ix-fade";
  find(ir, "t1")!.behavior = "ix-t1";
  find(ir, "t2")!.behavior = "ix-t2";
  const out = upgradeDocument(ir); // checkInteractives accepts the panel outside the trigger root
  expect(find(out, "dd")!.interactive).toMatchObject({ kind: "menu", trigger: "vis", panel: "vism" });
  expect(find(out, "fade")!.interactive).toMatchObject({ kind: "menu", trigger: "fade", panel: "fadem" });
  expect(find(out, "tabs")!.interactive).toMatchObject({ kind: "tabs" });
  expect(out.fidelity.filter((x) => x.status === "unsupported")).toEqual([]);
  // the trigger itself taken too -> unsupported "trùng node gốc"
  const g = guessAt(pageNodes(out, "p"), "fade", "menu")!;
  const again = placeGuesses(out, "p", [g], "test");
  expect(again.fidelity.some((x) => x.status === "unsupported" && x.note.includes("trùng node gốc"))).toBe(true);
});

test("the store commits an adopted pre-E2 document upgraded once on load (E2 §9): revision+1, History reset; a second load changes nothing", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE document_state(project_id TEXT PRIMARY KEY, ir_json TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL, materialized_revision INTEGER NOT NULL); CREATE TABLE document_history(project_id TEXT NOT NULL, seq INTEGER NOT NULL, forward_json TEXT NOT NULL, inverse_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(project_id,seq));");
  const ir = site2();
  ir.interactions = [{ id: "ix-tab", kind: "tab", trigger: "#t1", status: "captured", pageId: "p" }];
  ir.sections.find((s) => s.root.id === "tabs")!.root.children[0]!.children[0]!.behavior = "ix-tab";
  db.prepare("INSERT INTO document_state VALUES('x', ?, 3, 1, 3)").run(JSON.stringify({ ...ir, revision: 3 })); // as change() stored it pre-E2
  db.prepare("INSERT INTO document_history(project_id,seq,forward_json,inverse_json,source) VALUES('x',1,'[]','[]','user')").run();
  const written: number[] = [];
  const store = documentStore(db, async (_id, doc) => void written.push(doc.revision), { loadInitial: async () => ir, upgrade: upgradeDocument });
  const doc = await store.loadDocument("x");
  expect(doc.revision).toBe(4);
  expect(JSON.stringify(doc)).not.toContain('"behavior"');
  expect(find(doc, "tabs")!.interactive).toMatchObject({ kind: "tabs" });
  expect((db.prepare("SELECT COUNT(*) c FROM document_history").get() as { c: number }).c).toBe(0);
  expect((await store.loadDocument("x")).revision).toBe(4);
  expect(written).toEqual([4]);
});
