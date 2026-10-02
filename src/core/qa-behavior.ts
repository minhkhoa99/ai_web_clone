// E2 §5: behaviour QA on the clone (live mode, fake clock — R4), after the pixel pass. Bounded: <= 5 s per component
// (its context is closed when time is up), <= 50 components per page, one page at a time, no AI. A check never throws:
// it fails with a reason (only a closed browser — a pause — ends the pass).
import type { Browser, Page } from "playwright";
import type { BrowserHandle } from "./browser";
import { pageFileNames } from "./emit-html";
import type { BehaviorResult } from "./fidelity";
import type { InteractiveSpec } from "./interactive";
import type { IRNodeV2, IRV2 } from "./ir-v2";
import { serveDir } from "./serve";
import { sameOrigin } from "./url";

export const BEHAVIOR_LIMITS = { perCheckMs: 5_000, perPage: 50 };
const sel = (id: string) => `[data-ir-id=${JSON.stringify(id)}]`;
const fail = (reason: string): never => { throw new Error(reason); };

async function check(page: Page, root: string, spec: InteractiveSpec): Promise<void> {
  const active = () => page.getAttribute(sel(root), "data-c-active");
  // shown the way the runtime shows / hides a part (R13): a box, not visibility:hidden, not opacity 0
  const visible = (id: string) => page.locator(sel(id)).evaluate((el) => {
    const cs = getComputedStyle(el);
    return el.getClientRects().length > 0 && cs.visibility !== "hidden" && cs.opacity !== "0";
  });
  switch (spec.kind) {
    case "carousel": {
      const key = (fwd: boolean) => (spec.direction === "vertical" ? (fwd ? "ArrowDown" : "ArrowUp") : fwd ? "ArrowRight" : "ArrowLeft");
      const move = async (fwd: boolean) => {
        const arrow = fwd ? spec.arrows?.next : spec.arrows?.prev;
        if (arrow) await page.click(sel(arrow), { force: true }); // the runtime marks an end arrow aria-disabled (Playwright waits on it)
        else await page.dispatchEvent(sel(root), "keydown", { key: key(fwd), bubbles: true }); // no arrow: the keyboard path
      };
      const start = await active();
      await move(true);
      // a non-loop carousel at its last (clamped) position has nowhere to go: back one, then next must return
      if ((await active()) === start && !spec.loop) {
        await move(false);
        const back = await active();
        await move(true);
        if (back === start || (await active()) === back) fail("bấm next không đổi slide");
      } else if ((await active()) === start) fail("bấm next không đổi slide");
      if (spec.autoplay) {
        const before = await active();
        // hover and focus-within pause autoplay (E2 §4): leave the component first
        await page.mouse.move(0, 0);
        await page.dispatchEvent(sel(root), "mouseleave");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.clock.runFor(Math.ceil(spec.interval * 1.5));
        if ((await active()) === before) fail("autoplay không đổi slide trong 1.5 × interval");
      }
      if (spec.pagination?.kind === "bullets") {
        // bullet 0 (or 1 from slide 0): never past the last position that fits, so the runtime's clamp never applies
        const target = (await active()) === "0" ? 1 : 0;
        await page.locator(`${sel(spec.pagination.container)} > *`).nth(target).click();
        if ((await active()) !== String(target)) fail("bấm pagination không tới đúng slide");
      }
      return;
    }
    case "tabs": {
      const k = spec.tabs.length > 1 ? (spec.active + 1) % spec.tabs.length : 0;
      await page.click(sel(spec.tabs[k]!.trigger));
      if (!(await visible(spec.tabs[k]!.panel))) fail(`bấm tab ${k + 1} không hiện panel ${k + 1}`);
      return;
    }
    case "accordion": {
      const it = spec.items[0]!, was = await visible(it.panel);
      await page.click(sel(it.trigger));
      if ((await visible(it.panel)) === was) fail("bấm mục không đổi trạng thái mở/đóng");
      return;
    }
    case "modal": {
      await page.click(sel(spec.triggers[0]!));
      if (!(await visible(spec.dialog))) fail("bấm trigger không mở dialog");
      if (spec.closeOn.includes("esc")) await page.keyboard.press("Escape");
      else if (spec.closeButton) await page.click(sel(spec.closeButton));
      if (await visible(spec.dialog)) fail("không đóng được dialog (Esc / nút đóng)");
      return;
    }
    case "video": {
      const ok = await page.$eval(sel(spec.node), (el, s) => el.tagName === "IFRAME" ? /^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com)\//.test((el as HTMLIFrameElement).src)
        : el.tagName === "VIDEO" && (el as HTMLVideoElement).loop === s.loop && (el as HTMLVideoElement).controls === s.controls && (el as HTMLVideoElement).muted === (s.muted || s.autoplay), spec);
      if (!ok) fail("thuộc tính video không khớp spec");
      return;
    }
    default: {
      if (spec.openOn === "hover") await page.hover(sel(spec.trigger)); else await page.click(sel(spec.trigger));
      if (!(await visible(spec.panel))) fail(`${spec.openOn === "hover" ? "hover" : "bấm"} trigger không mở panel`);
    }
  }
}

// A fresh context per component: Playwright's clock belongs to the context (page.clock === context.clock) and cannot
// be uninstalled, so it never leaks into the next check nor into the run's own pages. Time up closes the context,
// which ends the check's pending Playwright call at once.
async function checkOne(browser: Browser, url: string, root: IRNodeV2, ms: number): Promise<string | undefined> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // the IR is the 1440 tree
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((r) => { timer = setTimeout(() => { r(`quá thời gian ${ms / 1000}s`); void ctx.close().catch(() => {}); }, ms); });
  // newPage() issued during or after a close never settles (Playwright, see browser.ts): the close ends the run
  const closed = new Promise<never>((_, reject) => ctx.once("close", () => reject(new Error("context closed"))));
  const run = Promise.race([closed, (async () => {
    await ctx.route("**/*", (r) => (sameOrigin(r.request().url(), url) ? r.fallback() : r.abort()));
    await ctx.clock.install({ time: 0 });
    await ctx.clock.pauseAt(1000); // paused (R4): only runFor moves time, no autoplay tick mid-check
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "load" });
    await check(p, root.id, root.interactive!);
    return undefined;
  })()]).catch((e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200));
  try {
    return await Promise.race([run, timedOut]);
  } finally {
    clearTimeout(timer);
    await run; // never overlaps the next check (settles: caught above)
    await ctx.close().catch(() => {});
  }
}

export async function checkBehavior(handle: BrowserHandle, opts: { outDir: string; ir: IRV2; limits?: Partial<typeof BEHAVIOR_LIMITS> }): Promise<BehaviorResult[]> {
  const limits = { ...BEHAVIOR_LIMITS, ...opts.limits };
  const files = pageFileNames(opts.ir.pages), results: BehaviorResult[] = [];
  const work = opts.ir.pages.map((page) => {
    const roots: IRNodeV2[] = [];
    const visit = (n: IRNodeV2) => { if (n.interactive) roots.push(n); n.children.forEach(visit); };
    [page.shell, ...opts.ir.sections.filter((s) => s.pageId === page.id).map((s) => s.root)].forEach(visit);
    return { page, roots };
  }).filter((w) => w.roots.length);
  if (!work.length) return results;
  // the run's browser (persistent profile included): one fresh context per check (null only for Android / Electron)
  const browser = handle.context.browser();
  if (!browser) throw new Error("qa-behavior: browser handle without a Browser");
  const server = await serveDir(opts.outDir);
  try {
    for (const { page, roots } of work) {
      const url = `${server.url}/${files.get(page.id)}`;
      for (const [i, root] of roots.entries()) {
        const base = { pageId: page.id, nodeId: root.id, kind: root.interactive!.kind };
        if (i >= limits.perPage) { results.push({ ...base, ok: false, reason: `vượt giới hạn ${limits.perPage} component/trang` }); continue; }
        const reason = await checkOne(browser, url, root, limits.perCheckMs);
        results.push(reason === undefined ? { ...base, ok: true } : { ...base, ok: false, reason });
      }
    }
  } finally {
    await server.close();
  }
  return results;
}
