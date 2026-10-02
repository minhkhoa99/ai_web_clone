import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
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
const modal = (k: "esc" | "backdrop") => n(`sec-${k}`, "section", [n(`o-${k}`, "button", [t(`ot-${k}`, "Open")]),
  n(`m-${k}`, "div", [t(`dt-${k}`, "Dialog")], { styles: hidden, interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: [`o-${k}`], dialog: `m-${k}`, closeOn: [k] } })]);

test("checkBehavior: carousel next + autoplay (fake clock) + pagination, tabs, modal Esc pass; a modal Esc cannot close fails with a reason", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 60_000, loop: true }), tabs, modal("esc"), modal("backdrop"));
  const outDir = await emit(ir, "a");
  const started = Date.now();
  const results = await checkBehavior(handle, { outDir, ir });
  expect(Date.now() - started).toBeLessThan(4 * 5_000); // 1.5 x 60 s autoplay is checked on the fake clock (R4)
  const by = (id: string) => results.find((r) => r.nodeId === id)!;
  expect(by("root")).toMatchObject({ kind: "carousel", ok: true });
  expect(by("tabs")).toMatchObject({ ok: true });
  expect(by("m-esc")).toMatchObject({ ok: true });
  expect(by("m-backdrop")).toMatchObject({ ok: false, reason: expect.stringMatching(/đóng/) }); // no Esc, no close button: the check cannot close it
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
