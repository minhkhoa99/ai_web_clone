import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { config } from "@/core/config";
import { openDb } from "@/core/db";
import { createProject, enqueue, requeueRescore, runProject, type QaFile } from "@/core/jobs";
import { emitHtml } from "@/core/emit-html";
import { checkBehavior } from "@/core/qa-behavior";
import { prepareClonePage } from "@/core/qa";
import { serveDir } from "@/core/serve";
import { carouselRoot, css, n, siteOf, t } from "./component-site";

let handle: BrowserHandle;
let tmp = "";
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "qa-beh-")); });
afterAll(async () => { await handle.close(); await rm(tmp, { recursive: true, force: true }); });

const emit = (ir: ReturnType<typeof siteOf>, dir: string) => emitHtml(ir, { outDir: join(tmp, dir), workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } }).then(() => join(tmp, dir));
const hidden = { base: { display: "none" }, bp: {}, state: {}, pseudo: {} };
const tabs = n("tabs", "section", [n("tl", "div", [n("t0", "button", [t("a", "1")]), n("t1", "button", [t("b", "2")])]), n("p0", "div", [t("c", "one")]), n("p1", "div", [t("d", "two")], { styles: hidden })],
  { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t0", panel: "p0" }, { trigger: "t1", panel: "p1" }], active: 0 } });
// the dialog is the component root; the section around it holds the trigger (outside the subtree, same page)
type Close = "esc" | "backdrop" | "button";
const modal = (k: string, closeOn: Close[]) => n(`sec-${k}`, "section", [n(`o-${k}`, "button", [t(`ot-${k}`, "Open")]),
  n(`m-${k}`, "div", [t(`dt-${k}`, "Dialog"), n(`x-${k}`, "button", [t(`xt-${k}`, "Close")])],
    { styles: hidden, interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: [`o-${k}`], dialog: `m-${k}`, closeOn, closeButton: `x-${k}` } })]);

test("checkBehavior: carousel next + autoplay (fake clock) + pagination, tabs, modal closes the configured ways; a broken configured close fails", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 60_000, loop: true }), tabs, modal("esc", ["esc"]), modal("backdrop", ["backdrop"]), modal("all", ["esc", "button", "backdrop"]), modal("broken", ["backdrop"]));
  // the emitted "broken" dialog only closes on Esc, while its spec says backdrop: the backdrop click leaves it open
  const outDir = await emit(siteOf(...ir.sections.slice(0, 5).map((s) => s.root), modal("broken", ["esc"])), "a");
  const started = Date.now();
  const results = await checkBehavior(handle, { outDir, ir });
  expect(Date.now() - started).toBeLessThan(4 * 5_000); // 1.5 x 60 s autoplay is checked on the fake clock (R4)
  const by = (id: string) => results.find((r) => r.nodeId === id)!;
  expect(by("root")).toMatchObject({ kind: "carousel", ok: true });
  expect(by("tabs")).toMatchObject({ ok: true });
  expect(by("m-esc")).toMatchObject({ ok: true });
  expect(by("m-backdrop")).toMatchObject({ ok: true }); // a click on the dialog itself (the backdrop)
  expect(by("m-all")).toMatchObject({ ok: true });
  expect(by("m-broken")).toMatchObject({ ok: false, reason: "không đóng được dialog bằng click nền" });
});

test("carousel edge cases: a non-loop carousel captured at its last position passes; slidesPerView 2 clamps; a broken autoplay fails", { timeout: 60_000 }, async () => {
  // last position, no loop: next has nowhere to go (prev then next verifies it); per 2 of 3: last fitting position is 1
  const atEnd = carouselRoot({ active: 2 }, "e-");
  const per2 = carouselRoot({ slidesPerView: { "1440": 2 }, active: 1 }, "p-");
  // autoplay in the spec but the emitted page runs a 10 min interval: 1.5 x 1 s on the clock never moves it
  const ir = siteOf(atEnd, per2, carouselRoot({ autoplay: true, interval: 1000, loop: true }, "s-"));
  const outDir = await emit(siteOf(atEnd, per2, carouselRoot({ autoplay: true, interval: 600_000, loop: true }, "s-")), "e");
  const results = await checkBehavior(handle, { outDir, ir });
  const by = (id: string) => results.find((r) => r.nodeId === id)!;
  expect(by("e-root")).toMatchObject({ ok: true });
  expect(by("p-root")).toMatchObject({ ok: true });
  expect(by("s-root")).toMatchObject({ ok: false, reason: expect.stringMatching(/autoplay/) });
});

test("carousel where every slide fits at 1440 (nothing can move): not applicable, no result — loop or not, arrows or keyboard", { timeout: 60_000 }, async () => {
  const fit = { slidesPerView: { "1440": 3 } };
  const ir = siteOf(carouselRoot(fit, "f-"), carouselRoot({ ...fit, loop: true }, "l-"), carouselRoot({ ...fit, arrows: undefined, pagination: undefined }, "k-"), carouselRoot({}, "m-"));
  const results = await checkBehavior(handle, { outDir: await emit(ir, "f"), ir });
  expect(results.map((r) => [r.nodeId, r.ok])).toEqual([["m-root", true]]);
});

test("accordion toggle, dropdown hover + click, native video attributes", { timeout: 60_000 }, async () => {
  const acc = n("acc", "section", [n("h0", "button", [t("h0t", "Q")]), n("b0", "div", [t("b0t", "A")], { styles: hidden })],
    { interactive: { kind: "accordion", source: "aria", confidence: "guessed", items: [{ trigger: "h0", panel: "b0", open: false }], multiple: false } });
  const dd = (id: string, openOn: "click" | "hover") => n(id, "nav", [n(`${id}-t`, "button", [t(`${id}-tt`, "Menu")]), n(`${id}-p`, "div", [t(`${id}-pt`, "Items")], { styles: hidden })],
    { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: `${id}-t`, panel: `${id}-p`, openOn } });
  const video = n("vid", "video", [], { styles: css({ width: "100px", height: "50px" }), interactive: { kind: "video", source: "native", confidence: "guessed", node: "vid", mode: "native", autoplay: true, muted: true, loop: true, controls: false } });
  const ir = siteOf(acc, dd("ddc", "click"), dd("ddh", "hover"), n("vs", "section", [video]));
  const results = await checkBehavior(handle, { outDir: await emit(ir, "d"), ir });
  expect(results.map((r) => [r.nodeId, r.ok, r.reason])).toEqual([["acc", true, undefined], ["ddc", true, undefined], ["ddh", true, undefined], ["vid", true, undefined]]);
});

test("limits: a check over its timeout fails as 'quá thời gian'; components past 50 on a page are not checked", { timeout: 60_000 }, async () => {
  const many = siteOf(...Array.from({ length: 3 }, (_, i) => carouselRoot({}, `c${i}-`)));
  const outDir = await emit(many, "b");
  const timed = await checkBehavior(handle, { outDir, ir: many, limits: { perCheckMs: 1 } });
  expect(timed).toHaveLength(3);
  expect(timed.every((r) => !r.ok && r.reason?.includes("quá thời gian"))).toBe(true);
  const capped = await checkBehavior(handle, { outDir, ir: many, limits: { perPage: 2 } });
  expect(capped.filter((r) => r.reason?.includes("vượt giới hạn"))).toHaveLength(1);
  expect(capped.filter((r) => r.ok)).toHaveLength(2);
});

test("a pause mid-check (signal aborted, browser closed) throws at once: no made-up result", { timeout: 60_000 }, async () => {
  // the emitted tabs have no second trigger: the check's click waits (it would time out after 5 s)
  const ir = siteOf(tabs);
  const outDir = await emit(siteOf(n("tabs", "section", [n("t0", "button", [t("a", "1")])])), "z");
  const own = await openBrowser({ headed: false });
  const pause = new AbortController();
  setTimeout(() => { pause.abort(new Error("paused")); void own.close(); }, 800);
  const t0 = Date.now();
  await expect(checkBehavior(own, { outDir, ir, signal: pause.signal })).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(4_000);
  // signal already aborted: nothing is checked
  await expect(checkBehavior(handle, { outDir, ir, signal: AbortSignal.abort() })).rejects.toThrow();
});

test("the run's persistent profile: checks run in contexts of their own, the run's pages keep real time", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 1000, loop: true }));
  const outDir = await emit(ir, "p");
  const run = await openBrowser({ profileDir: join(tmp, "profile") });
  try {
    expect(await checkBehavior(run, { outDir, ir })).toEqual([{ pageId: "home", nodeId: "root", kind: "carousel", ok: true }]);
    // the fake clock lived in its own context: a page of the run's handle still autoplays on real time
    const server = await serveDir(outDir);
    try {
      await withPage(run, async (page) => {
        await page.goto(`${server.url}/index.html`);
        await expect.poll(() => page.getAttribute('[data-ir-id="root"]', "data-c-active"), { timeout: 5_000 }).not.toBe("0");
      });
    } finally {
      await server.close();
    }
  } finally {
    await run.close();
  }
});

test("Review Focus 4 — prepareClonePage (scoring + fix inspector) loads ?qa=1: the autoplay carousel stays at its capture state", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 1000, loop: true, speed: 300, active: 1 }));
  const server = await serveDir(await emit(ir, "c"));
  try {
    await withPage(handle, async (page) => {
      await prepareClonePage(page, `${server.url}/index.html`, 1440);
      expect(new URL(page.url()).searchParams.get("qa")).toBe("1");
      await page.waitForTimeout(2_500); // real time: 2+ intervals
      expect(await page.getAttribute('[data-ir-id="root"]', "data-c-active")).toBe("1");
    });
  } finally {
    await server.close();
  }
});

// E2 §9 final review #1: a project cloned before E2 and never opened in the editor — its v2 ir.json still carries
// the v1 `behavior`s, out/ is the old data-behavior output. "Chạy lại QA" upgrades the IR in memory; out/ must be
// re-emitted from it before scoring, or the behaviour pass checks the new components against the old HTML.
test("Chạy lại QA on a not-adopted pre-E2 project: out/ re-emitted from the upgraded IR first; the menu and modal pass", { timeout: 120_000 }, async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  await enqueue(db, id, ["http://x.test/"]);
  const ws = join(config.workspaceRoot, id);
  try {
    db.prepare("DELETE FROM tasks WHERE project_id=? AND phase='capture'").run(id); // no capture evidence needed here
    db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=?").run(id);
    db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(id);
    const hidden = css({ display: "none" });
    const ir = siteOf(
      n("hdr", "header", [n("menu-btn", "button", [t("mb", "Menu")], { attrs: { "aria-expanded": "false", "aria-controls": "main-nav" } }),
        n("nav", "nav", [t("nv", "Links")], { attrs: { id: "main-nav" }, styles: hidden })]),
      n("mod", "section", [n("open", "button", [t("ob", "Open")], { attrs: { "aria-haspopup": "dialog", "data-modal": "#dialog" } }),
        n("dlg", "div", [t("dt", "Dialog"), n("x", "button", [t("xb", "Close")], { attrs: { "data-close": "" } })], { attrs: { id: "dialog", role: "dialog" }, styles: hidden })]),
    );
    ir.interactions = [{ id: "ix-menu", kind: "menu", trigger: "#menu-btn", status: "captured", pageId: "home" }, { id: "ix-modal", kind: "modal", trigger: "#open", status: "captured", pageId: "home" }];
    ir.sections[0]!.root.children[0]!.behavior = "ix-menu";
    ir.sections[1]!.root.children[0]!.behavior = "ix-modal";
    await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
    await emitHtml(ir, { outDir: join(ws, "out"), workspaceDir: ws, assetMap: {}, pageUrls: {} }); // no data-c: the old output
    await writeFile(join(ws, "out", "js", "runtime.js"), "/* pre-E2 runtime */");
    await writeFile(join(ws, "qa.json"), JSON.stringify({ scores: [] }));
    requeueRescore(db, id);
    await runProject(db, id, { deps: { scoreSections: async () => [] } });
    const qa = JSON.parse(await readFile(join(ws, "qa.json"), "utf8")) as QaFile;
    expect(qa.behavior!.map((b) => b.kind).sort()).toEqual(["menu", "modal"]);
    expect(qa.behavior!.filter((b) => !b.ok)).toEqual([]);
    expect(await readFile(join(ws, "out", "index.html"), "utf8")).toContain('data-c="menu"');
    expect(JSON.stringify(JSON.parse(await readFile(join(ws, "ir.json"), "utf8")))).not.toContain('"behavior"'); // the checkpoint is the upgraded document
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 3 });
  }
});
