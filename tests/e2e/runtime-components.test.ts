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
    await page.clock.install();
    await page.goto(url);
    await page.clock.runFor(1500);
    expect(await active(page)).toBe("1");
    await page.hover('[data-ir-id="vp"]');
    await page.clock.runFor(3000);
    expect(await active(page)).toBe("1");
  });
  await withPage(handle, async (page) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.goto(url);
    await page.clock.runFor(5000);
    expect(await active(page)).toBe("0");
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
