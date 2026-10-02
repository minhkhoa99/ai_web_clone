import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import type { CarouselSpec } from "@/core/interactive";
import { carouselRoot, emitAndServe, n, siteOf, t } from "./component-site";

let handle: BrowserHandle;
let tmp = "";
const closers: (() => Promise<void>)[] = [];
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "runtime-c-")); });
afterAll(async () => { await handle.close(); for (const close of closers) await close(); await rm(tmp, { recursive: true, force: true }); });

let seq = 0;
async function serve(...roots: Parameters<typeof siteOf>): Promise<{ url: string; outDir: string }> {
  const site = await emitAndServe(siteOf(...roots), join(tmp, `s${++seq}`));
  closers.push(site.close);
  return site;
}
const active = (page: Page, root = "root") => page.getAttribute(`[data-ir-id="${root}"]`, "data-c-active");
const warnings = (page: Page) => { const out: string[] = []; page.on("console", (m) => { if (m.type() === "warning") out.push(m.text()); }); return out; };

test("carousel: next/prev move one slide, ARIA set, prev disabled (aria) at the start without loop", async () => {
  const { url } = await serve(carouselRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await active(page)).toBe("0");
    expect(await page.getAttribute('[data-ir-id="root"]', "aria-roledescription")).toBe("carousel");
    expect(await page.getAttribute('[data-ir-id="sl1"]', "aria-label")).toBe("2 / 3");
    expect(await page.getAttribute('[data-ir-id="prev"]', "aria-disabled")).toBe("true");
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("1");
    expect(await page.$eval('[data-ir-id="tr"]', (el) => (el as HTMLElement).style.transform)).toBe("translate3d(-300px, 0px, 0px)");
    await page.click('[data-ir-id="prev"]');
    expect(await active(page)).toBe("0");
    await page.focus('[data-ir-id="next"]');
    await page.keyboard.press("ArrowRight");
    expect(await active(page)).toBe("1");
  });
});

test("carousel: loop wraps both ways; bullets go to a slide; fraction shows n / N", async () => {
  const { url } = await serve(carouselRoot({ loop: true }), carouselRoot({ pagination: { container: "f-dots", kind: "fraction" } }, "f-"));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="prev"]');
    expect(await active(page)).toBe("2");
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("0");
    const bullets = page.locator('[data-ir-id="dots"] > *');
    expect(await bullets.count()).toBe(3);
    await bullets.nth(2).click();
    expect(await active(page)).toBe("2");
    await bullets.nth(1).focus(); // captured <span> bullets: kept, made keyboard buttons
    await page.keyboard.press("Enter");
    expect(await active(page)).toBe("1");
    expect(await page.getAttribute('[data-ir-id="d1"]', "aria-current")).toBe("true");
    expect(await page.textContent('[data-ir-id="f-dots"]')).toBe("1 / 3");
  });
});

test("carousel: autoplay advances within 1.5 x interval, pauses on hover; reduced motion disables it", async () => {
  const { url } = await serve(carouselRoot({ autoplay: true, interval: 1000, loop: true }));
  await withPage(handle, async (page) => {
    await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000); // paused: only runFor moves time (no flake under load)
    await page.goto(url);
    await page.clock.runFor(1500);
    expect(await active(page)).toBe("1");
    await page.hover('[data-ir-id="vp"]');
    await page.clock.runFor(3000);
    expect(await active(page)).toBe("1");
    await page.clock.resume(); // the clock is the context's: later pages get natural time back
  });
  await withPage(handle, async (page) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000); // paused: only runFor moves time (no flake under load)
    await page.goto(url);
    await page.clock.runFor(5000);
    expect(await active(page)).toBe("0");
    await page.clock.resume(); // the clock is the context's: later pages get natural time back
  });
});

test("Review Focus 4 — ?qa=1: capture state (active), no autoplay, no transition, identical screenshots", async () => {
  const { url } = await serve(carouselRoot({ autoplay: true, interval: 1000, loop: true, active: 2, speed: 400 }));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(`${url}?qa=1`);
    const first = await page.screenshot();
    await page.clock.runFor(5000);
    expect(await active(page)).toBe("2");
    expect(await page.$eval('[data-ir-id="tr"]', (el) => (el as HTMLElement).style.transition)).toBe("none");
    expect((await page.screenshot()).equals(first)).toBe(true);
  });
});

test("responsive: slidesPerView/gap per breakpoint (768/375 inherit from the next wider one)", async () => {
  const { url } = await serve(carouselRoot({ slidesPerView: { "1440": 2, "375": 1 }, gap: { "1440": 10 } }));
  await withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    expect(await page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(145);
    await page.setViewportSize({ width: 800, height: 900 }); // 768 bucket inherits 1440
    await expect.poll(() => page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(145);
    await page.setViewportSize({ width: 375, height: 900 });
    await expect.poll(() => page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(300);
  });
});

test("a broken component is skipped with console.warn; the others still run", async () => {
  const broken = carouselRoot({ slides: ["b-sl0", "missing", "b-sl2"] }, "b-");
  const { url } = await serve(broken, carouselRoot());
  await withPage(handle, async (page) => {
    const warned = warnings(page);
    await page.goto(url);
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("1");
    expect(warned.some((w) => w.includes("aiwc runtime: component skipped"))).toBe(true);
  });
});

test("?edit=1 (script src): no input handlers, no autoplay; postMessage from the parent shows the item", async () => {
  const { url, outDir } = await serve(carouselRoot({ autoplay: true, interval: 1000 }));
  const file = join(outDir, "index.html");
  await writeFile(file, (await readFile(file, "utf8")).replace('src="js/runtime.js"', 'src="js/runtime.js?edit=1"'));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(url);
    await page.click('[data-ir-id="next"]');
    await page.clock.runFor(3000);
    expect(await active(page)).toBeNull(); // not initialised until the editor asks
    await page.evaluate(() => window.postMessage({ type: "aiwc:show", root: "root", index: 2 }, "*"));
    await expect.poll(() => active(page)).toBe("2");
  });
});

test("nested carousel (inside an outer slide): swipes and keys on the inner one move only the inner one", async () => {
  const inner = carouselRoot({}, "in-");
  const outer = carouselRoot();
  outer.children[0]!.children[0]!.children[0]!.children.push(inner); // outer viewport > track > slide 0
  inner.parentId = "sl0";
  const { url } = await serve(outer);
  await withPage(handle, async (page) => {
    await page.goto(url);
    const box = (await page.locator('[data-ir-id="in-vp"]').boundingBox())!;
    await page.mouse.move(box.x + 250, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 50, box.y + 20);
    await page.mouse.up();
    expect(await active(page, "in-root")).toBe("1");
    expect(await active(page)).toBe("0");
    await page.focus('[data-ir-id="in-next"]');
    await page.keyboard.press("ArrowRight");
    expect(await active(page, "in-root")).toBe("2");
    expect(await active(page)).toBe("0");
  });
});

test("fade: only the active slide is opaque", async () => {
  const { url } = await serve(carouselRoot({ transition: "fade" }));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="next"]');
    const op = (id: string) => page.$eval(`[data-ir-id="${id}"]`, (el) => (el as HTMLElement).style.opacity);
    expect([await op("sl0"), await op("sl1"), await op("sl2")]).toEqual(["0", "1", "0"]);
  });
});

test("slidesPerView 2: active never goes past the last position that fits (non-loop stops, loop wraps)", async () => {
  const { url } = await serve(carouselRoot({ slidesPerView: { "1440": 2 } }), carouselRoot({ slidesPerView: { "1440": 2 }, loop: true }, "l-"));
  await withPage(handle, async (page) => {
    await page.goto(url);
    const tr = (id: string) => page.$eval(`[data-ir-id="${id}"]`, (el) => (el as HTMLElement).style.transform);
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("1");
    expect(await tr("tr")).toBe("translate3d(-150px, 0px, 0px)");
    expect(await page.getAttribute('[data-ir-id="next"]', "aria-disabled")).toBe("true");
    await page.click('[data-ir-id="next"]', { force: true }); // aria-disabled: Playwright waits for "enabled", a user can still click
    expect(await active(page)).toBe("1");
    await page.click('[data-ir-id="prev"]'); // no dead click
    expect(await active(page)).toBe("0");
    await page.click('[data-ir-id="l-next"]');
    expect(await active(page, "l-root")).toBe("1");
    await page.click('[data-ir-id="l-next"]');
    expect(await active(page, "l-root")).toBe("0");
    await page.click('[data-ir-id="l-prev"]');
    expect(await active(page, "l-root")).toBe("1");
    expect(await tr("l-tr")).toBe("translate3d(-150px, 0px, 0px)");
  });
});

test("autoplay: stays paused while focus is inside after the mouse leaves; a manual move restarts the interval", async () => {
  const { url } = await serve(carouselRoot({ autoplay: true, interval: 1000, loop: true }));
  await withPage(handle, async (page) => {
    await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000); // paused: only runFor moves time (no flake under load)
    await page.goto(url);
    await page.hover('[data-ir-id="vp"]');
    await page.click('[data-ir-id="next"]'); // focus moves inside
    expect(await active(page)).toBe("1");
    await page.mouse.move(1000, 800);
    await page.clock.runFor(3000);
    expect(await active(page)).toBe("1");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.clock.runFor(1100);
    expect(await active(page)).toBe("2");
    await page.clock.runFor(500);
    await page.$eval('[data-ir-id="prev"]', (el) => (el as HTMLElement).click()); // no focus, no hover
    expect(await active(page)).toBe("1");
    await page.clock.runFor(700); // the old tick (500 ms later) is gone
    expect(await active(page)).toBe("1");
    await page.clock.runFor(400);
    expect(await active(page)).toBe("2");
    await page.clock.resume(); // the clock is the context's: later pages get natural time back
  });
});

test("swipe: viewport touch-action keeps the other axis for the page; pointercancel drops the swipe; keys in a field are ignored", async () => {
  const { url } = await serve(carouselRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.$eval('[data-ir-id="vp"]', (el) => (el as HTMLElement).style.touchAction)).toBe("pan-y");
    await page.$eval('[data-ir-id="vp"]', (vp) => {
      const fire = (type: string, x: number) => vp.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 20, bubbles: true, cancelable: true }));
      fire("pointerdown", 250); fire("pointercancel", 250); fire("pointerup", 50);
    });
    expect(await active(page)).toBe("0");
    await page.$eval('[data-ir-id="sl0"]', (s) => s.appendChild(document.createElement("input")));
    await page.focus('[data-ir-id="sl0"] input');
    await page.keyboard.press("ArrowRight");
    expect(await active(page)).toBe("0");
  });
});

test("?edit=1: an index that is not a non-negative integer below the item count is ignored", async () => {
  const { url, outDir } = await serve(carouselRoot());
  const file = join(outDir, "index.html");
  await writeFile(file, (await readFile(file, "utf8")).replace('src="js/runtime.js"', 'src="js/runtime.js?edit=1"'));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.evaluate(() => { for (const index of [-1, 1.5, "2", null]) window.postMessage({ type: "aiwc:show", root: "root", index }, "*"); });
    await page.waitForTimeout(100);
    expect(await active(page)).toBeNull();
    await page.evaluate(() => window.postMessage({ type: "aiwc:show", root: "root", index: 1 }, "*"));
    await expect.poll(() => active(page)).toBe("1");
    await page.evaluate(() => window.postMessage({ type: "aiwc:show", root: "root", index: 3 }, "*"));
    await page.waitForTimeout(100);
    expect(await active(page)).toBe("1");
  });
});

const tabsRoot = () => n("tabs", "section", [
  n("tl", "div", [n("tab0", "button", [t("a", "One")]), n("tab1", "button", [t("b", "Two")])]),
  n("p0", "div", [t("c", "Panel one")]),
  n("p1", "div", [t("d", "Panel two")], { attrs: { hidden: "" }, styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} } }),
], { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "tab0", panel: "p0" }, { trigger: "tab1", panel: "p1" }], active: 0 } });

test("tabs: click and arrow keys select, aria-selected/tabindex follow, panels shown the way the capture hid them", async () => {
  const { url } = await serve(tabsRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(false);
    await page.click('[data-ir-id="tab1"]');
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(true);
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(false);
    expect(await page.getAttribute('[data-ir-id="tab1"]', "aria-selected")).toBe("true");
    expect(await page.getAttribute('[data-ir-id="tab0"]', "tabindex")).toBe("-1");
    await page.keyboard.press("Home");
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(true);
  });
});

test("accordion: <details> stays native (multiple=false closes the others); ARIA items toggle aria-expanded", async () => {
  const det = (i: number) => n(`dt${i}`, "details", [n(`sm${i}`, "summary", [t(`smt${i}`, `Q${i}`)]), n(`an${i}`, "p", [t(`ant${i}`, `A${i}`)])]);
  const native = n("acc", "section", [det(0), det(1)], { interactive: { kind: "accordion", source: "details", confidence: "guessed", multiple: false, items: [0, 1].map((i) => ({ trigger: `sm${i}`, panel: `an${i}`, open: false })) } });
  const aria = n("acc2", "section", [n("q", "button", [t("qt", "Q")]), n("a", "div", [t("at", "A")], { styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} } })],
    { interactive: { kind: "accordion", source: "aria", confidence: "guessed", multiple: true, items: [{ trigger: "q", panel: "a", open: false }] } });
  const { url } = await serve(native, aria);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="sm0"]');
    await page.click('[data-ir-id="sm1"]');
    await expect.poll(() => page.$eval('[data-ir-id="dt0"]', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.click('[data-ir-id="q"]');
    expect(await page.isVisible('[data-ir-id="a"]')).toBe(true);
    expect(await page.getAttribute('[data-ir-id="q"]', "aria-expanded")).toBe("true");
  });
});

test("Review Focus 5 — modal: a trigger in another section opens it; focus moves in, stays in (Tab), Esc closes, scroll lock, focus returns", async () => {
  const dialog = n("dlg", "div", [t("dt", "Body "), n("ok", "button", [t("okt", "OK")]), n("x", "button", [t("xt", "Đóng")])],
    { attrs: { hidden: "" }, styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} },
      interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc", "backdrop", "button"], closeButton: "x" } });
  const { url } = await serve(n("head-sec", "section", [n("open", "button", [t("ot", "Open")])]), n("foot", "section", [dialog]));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="open"]');
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("ok");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab"); // wraps from the last focusable back to the first
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("ok");
    await page.keyboard.press("Shift+Tab"); // and backwards from the first to the last
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("x");
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("open");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");
    expect(await page.getAttribute('[data-ir-id="dlg"]', "data-c-open")).toBe("false");
    await page.click('[data-ir-id="open"]');
    await page.click('[data-ir-id="x"]');
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
  });
});

test("dropdown: hover opens, closes 150 ms after leaving; click-kind opens on click, outside click and Esc close", async () => {
  const hidden = { base: { visibility: "hidden" }, bp: {}, state: {}, pseudo: {} };
  const hover = n("dd", "nav", [n("dt-a", "a", [t("x1", "Menu")], { attrs: { href: "#" } }), n("dp", "ul", [n("li", "li", [t("x2", "Item")])], { styles: hidden })],
    { interactive: { kind: "menu", source: "aria", confidence: "observed", trigger: "dt-a", panel: "dp", openOn: "hover" } });
  const click = n("dc", "div", [n("ct", "button", [t("x3", "Account")]), n("cp", "ul", [n("cli", "li", [t("x4", "Profile")])], { styles: hidden })],
    { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "ct", panel: "cp", openOn: "click" } });
  const { url } = await serve(hover, click);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.hover('[data-ir-id="dt-a"]');
    expect(await page.isVisible('[data-ir-id="dp"]')).toBe(true);
    await page.mouse.move(1000, 800);
    await expect.poll(() => page.isVisible('[data-ir-id="dp"]')).toBe(false);
    await page.click('[data-ir-id="ct"]');
    expect(await page.getAttribute('[data-ir-id="ct"]', "aria-expanded")).toBe("true");
    await page.mouse.click(1000, 800);
    expect(await page.isVisible('[data-ir-id="cp"]')).toBe(false);
    await page.click('[data-ir-id="ct"]');
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="cp"]')).toBe(false);
  });
});

test("video: native attributes follow the spec (autoplay forces muted); ?qa=1 keeps it paused", async () => {
  const v = n("vid", "video", [], { attrs: { controls: "" }, interactive: { kind: "video", source: "native", confidence: "guessed", node: "vid", mode: "native", autoplay: true, muted: true, loop: true, controls: false } });
  const { url } = await serve(n("vs", "section", [v]));
  await withPage(handle, async (page) => {
    await page.goto(`${url}?qa=1`);
    const state = await page.$eval('[data-ir-id="vid"]', (el) => { const v = el as HTMLVideoElement; return { muted: v.muted, loop: v.loop, controls: v.controls, paused: v.paused }; });
    expect(state).toEqual({ muted: true, loop: true, controls: false, paused: true });
  });
});

test("native-scroll carousel (viewport === track): no touch-action, so touch keeps scrolling it natively", async () => {
  const native = carouselRoot({ source: "scroll-snap", viewport: "tr" });
  native.children[0]!.children[0]!.styles = { base: { display: "flex", width: "300px", "overflow-x": "auto" }, bp: {}, state: {}, pseudo: {} };
  const { url } = await serve(native);
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.$eval('[data-ir-id="tr"]', (el) => (el as HTMLElement).style.touchAction)).toBe("");
    await page.click('[data-ir-id="next"]');
    await expect.poll(() => page.$eval('[data-ir-id="tr"]', (el) => el.scrollLeft)).toBe(300);
  });
});

test("a carousel inside a hidden tab panel is laid out again when the panel opens", async () => {
  const tabs = tabsRoot();
  const inner = carouselRoot({}, "in-");
  tabs.children[2]!.children.push(inner); // p1: hidden at start
  inner.parentId = "p1";
  const { url } = await serve(tabs);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="tab1"]');
    expect(await page.$eval('[data-ir-id="in-sl0"]', (el) => el.getBoundingClientRect().width)).toBe(300);
    await page.click('[data-ir-id="in-next"]');
    expect(await page.$eval('[data-ir-id="in-tr"]', (el) => (el as HTMLElement).style.transform)).toBe("translate3d(-300px, 0px, 0px)");
  });
});

test("R2 dropdown: a hover panel outside the trigger root stays open while the pointer moves onto it; clicks inside it do not close it", async () => {
  const hidden = { base: { visibility: "hidden" }, bp: {}, state: {}, pseudo: {} };
  const trig = n("rt", "button", [t("rtt", "More")], { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "rt", panel: "rp", openOn: "hover" } });
  const { url } = await serve(n("bar", "div", [trig, n("rp", "ul", [n("rli", "li", [t("rlt", "Item")])], { styles: hidden })]));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(url);
    await page.hover('[data-ir-id="rt"]');
    await page.hover('[data-ir-id="rli"]');
    await page.clock.runFor(500);
    expect(await page.isVisible('[data-ir-id="rp"]')).toBe(true);
    await page.click('[data-ir-id="rli"]');
    expect(await page.isVisible('[data-ir-id="rp"]')).toBe(true);
    await page.mouse.move(1000, 800);
    await page.clock.runFor(100);
    expect(await page.isVisible('[data-ir-id="rp"]')).toBe(true); // 150 ms delay
    await page.clock.runFor(100);
    expect(await page.isVisible('[data-ir-id="rp"]')).toBe(false);
  });
});

test("?qa=1 keeps tabs/accordion/modal at the captured state; ?edit=1 shows the posted tab and opens the modal without handlers", async () => {
  const acc = n("acc", "section", [n("qq", "button", [t("qqt", "Q")]), n("aa", "div", [t("aat", "A")])],
    { interactive: { kind: "accordion", source: "aria", confidence: "guessed", multiple: true, items: [{ trigger: "qq", panel: "aa", open: true }] } });
  const dlg = n("dlg", "div", [n("ok", "button", [t("okt", "OK")])], { styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} },
    interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc"] } });
  const { url, outDir } = await serve(tabsRoot(), acc, n("ms", "section", [n("open", "button", [t("ot", "Open")]), dlg]));
  await withPage(handle, async (page) => {
    await page.goto(`${url}?qa=1`);
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(true);
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(false);
    expect(await page.isVisible('[data-ir-id="aa"]')).toBe(true);
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
  });
  const file = join(outDir, "index.html");
  await writeFile(file, (await readFile(file, "utf8")).replace('src="js/runtime.js"', 'src="js/runtime.js?edit=1"'));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="tab1"]');
    await page.click('[data-ir-id="open"]');
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(false);
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
    await page.evaluate(() => { window.postMessage({ type: "aiwc:show", root: "tabs", index: 1 }, "*"); window.postMessage({ type: "aiwc:show", root: "dlg", index: 0 }, "*"); });
    await expect.poll(() => page.isVisible('[data-ir-id="p1"]')).toBe(true);
    await expect.poll(() => page.isVisible('[data-ir-id="dlg"]')).toBe(true);
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe(""); // no scroll lock in the canvas
  });
});

const none = () => ({ base: { display: "none" }, bp: {}, state: {}, pseudo: {} });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"));

test("fix 1: a tab panel that is itself a carousel root is laid out again when it opens", async () => {
  const tabs = tabsRoot();
  const car = carouselRoot({}, "pc-");
  car.attrs = { hidden: "" };
  car.styles = none();
  tabs.children[2] = car; // panel p1 replaced by the carousel root
  car.parentId = "tabs";
  (tabs.interactive as { tabs: { trigger: string; panel: string }[] }).tabs[1]!.panel = "pc-root";
  const { url } = await serve(tabs);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="tab1"]');
    expect(await page.$eval('[data-ir-id="pc-sl0"]', (el) => el.getBoundingClientRect().width)).toBe(300);
  });
});

test("fix 3: hidden inputs, display:none and disabled controls are never focus targets in a modal", async () => {
  const dlg = n("dlg", "div", [
    n("csrf", "input", [], { attrs: { type: "hidden", name: "csrf" } }),
    n("gone", "button", [t("gt", "Gone")], { styles: none() }),
    n("off", "button", [t("oft", "Off")], { attrs: { disabled: "" } }),
    n("ok", "button", [t("okt", "OK")]), n("x", "button", [t("xt", "X")]),
  ], { styles: none(), interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc"] } });
  const { url } = await serve(n("ms", "section", [n("open", "button", [t("ot", "Open")]), dlg]));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="open"]');
    expect(await focused(page)).toBe("ok");
    await page.keyboard.press("Shift+Tab");
    expect(await focused(page)).toBe("x");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("ok");
  });
});

test("fix 4: stacked modals — Esc closes only the top one; the scroll lock is restored when the last one closes", async () => {
  const modal = (id: string, trigger: string, kids: ReturnType<typeof n>[]) => n(id, "div", kids,
    { styles: none(), interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: [trigger], dialog: id, closeOn: ["esc"] } });
  const b = modal("mb", "openB", [n("bok", "button", [t("bt", "B")])]);
  const a = modal("ma", "openA", [n("openB", "button", [t("obt", "Open B")])]);
  // B comes first in the document: its key listener runs before A's
  const { url } = await serve(n("sb", "section", [b]), n("sa", "section", [n("openA", "button", [t("oat", "Open A")]), a]));
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.getAttribute('[data-ir-id="openA"]', "aria-haspopup")).toBe("dialog");
    await page.click('[data-ir-id="openA"]');
    expect(await page.getAttribute('[data-ir-id="openA"]', "aria-expanded")).toBe("true");
    await page.click('[data-ir-id="openB"]');
    expect(await focused(page)).toBe("bok");
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="mb"]')).toBe(false);
    expect(await page.isVisible('[data-ir-id="ma"]')).toBe(true);
    expect(await focused(page)).toBe("openB");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
    await page.keyboard.press("Tab"); // A is the top again: Tab stays inside A
    expect(await focused(page)).toBe("openB");
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="ma"]')).toBe(false);
    expect(await page.getAttribute('[data-ir-id="openA"]', "aria-expanded")).toBe("false");
    expect(await focused(page)).toBe("openA");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");
  });
});

test("minor: Esc on a dropdown inside a modal closes only the dropdown; a hover menu closes when focus leaves it", async () => {
  const hidden = { base: { visibility: "hidden" }, bp: {}, state: {}, pseudo: {} };
  const dd = n("dd", "div", [n("ddt", "button", [t("ddtt", "More")]), n("ddp", "ul", [n("ddi", "li", [t("ddit", "Item")])], { styles: hidden })],
    { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "ddt", panel: "ddp", openOn: "click" } });
  const dlg = n("dlg", "div", [dd], { styles: none(), interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc"] } });
  const hm = n("hm", "nav", [n("hmt", "button", [t("hmtt", "Menu")]), n("hmp", "ul", [n("hmi", "li", [t("hmit", "Item")])], { styles: hidden })],
    { interactive: { kind: "menu", source: "aria", confidence: "guessed", trigger: "hmt", panel: "hmp", openOn: "hover" } });
  const { url } = await serve(n("ms", "section", [n("open", "button", [t("ot", "Open")]), dlg]), n("hs", "section", [hm, n("after", "button", [t("aft", "After")])]));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="open"]');
    await page.click('[data-ir-id="ddt"]');
    expect(await page.isVisible('[data-ir-id="ddp"]')).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="ddp"]')).toBe(false);
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
    await page.mouse.move(1000, 700); // the pointer is not over the menu: only focus drives it
    await page.focus('[data-ir-id="hmt"]');
    expect(await page.isVisible('[data-ir-id="hmp"]')).toBe(true);
    await page.focus('[data-ir-id="after"]');
    expect(await page.isVisible('[data-ir-id="hmp"]')).toBe(false);
    await page.focus('[data-ir-id="hmt"]');
    await page.keyboard.press("Escape"); // focus goes back to the trigger without reopening the menu
    expect(await page.isVisible('[data-ir-id="hmp"]')).toBe(false);
    expect(await focused(page)).toBe("hmt");
  });
});

test("minor: tabs get a tablist parent and aria-controls / aria-labelledby", async () => {
  const { url } = await serve(tabsRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.getAttribute('[data-ir-id="tl"]', "role")).toBe("tablist");
    expect(await page.getAttribute('[data-ir-id="tabs"]', "role")).toBeNull();
    const panelId = await page.getAttribute('[data-ir-id="p1"]', "id");
    expect(await page.getAttribute('[data-ir-id="tab1"]', "aria-controls")).toBe(panelId);
    expect(await page.getAttribute('[data-ir-id="p1"]', "aria-labelledby")).toBe(await page.getAttribute('[data-ir-id="tab1"]', "id"));
  });
});
