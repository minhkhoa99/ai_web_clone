// E2 §5: behaviour QA on the clone (live mode, fake clock — R4), after the pixel pass. Bounded: <= 5 s per component
// (its context is closed when time is up), <= 50 components per page, one page at a time, no AI. A check never throws:
// it fails with a reason (only a pause — the signal, or the browser closed — ends the pass).
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserHandle } from "./browser";
import { pageFileNames } from "./emit-html";
import type { BehaviorResult } from "./fidelity";
import type { InteractiveSpec } from "./interactive";
import type { IRNodeV2, IRV2 } from "./ir-v2";
import { serveDir } from "./serve";
import { sameOrigin } from "./url";

export const BEHAVIOR_LIMITS = { perCheckMs: 5_000, perPage: 50 };
const sel = (id: string) => `[data-ir-id=${JSON.stringify(id)}]`;
class CheckFailed extends Error {}
const fail = (reason: string): never => { throw new CheckFailed(reason); };
const NOT_APPLICABLE = "n/a" as const; // nothing to check (a carousel whose slides all fit): no result, the item keeps its status
// a check's own reason as is; a raw Playwright error as a short Vietnamese one
function reasonOf(e: unknown): string {
  if (e instanceof CheckFailed) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/closed|disconnected/i.test(m)) return "Trình duyệt đã đóng trong lúc kiểm tra";
  if (e instanceof Error && e.name === "TimeoutError") return "Hết thời gian chờ phần tử trên bản clone";
  return "Không thao tác được trên bản clone (phần tử thiếu, bị ẩn hoặc bị che)";
}

async function check(page: Page, root: string, spec: InteractiveSpec): Promise<typeof NOT_APPLICABLE | undefined> {
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
      if ((await active()) === start) {
        await move(false);
        const back = await active();
        if (back === start) {
          // neither way moves: everything fits at 1440 (the runtime's last position is 0) -> not applicable
          const arrows = [spec.arrows?.prev, spec.arrows?.next].filter((x): x is string => !!x);
          const disabled = arrows.length > 0 && (await Promise.all(arrows.map((a) => page.getAttribute(sel(a), "aria-disabled")))).every((v) => v === "true");
          if (disabled || spec.slides.length <= (spec.slidesPerView["1440"] ?? 1)) return NOT_APPLICABLE;
          fail("bấm next không đổi slide");
        }
        // back moved: a non-loop carousel at its last (clamped) position, next must return; a loop one should have moved
        if (spec.loop) fail("bấm next không đổi slide");
        await move(true);
        if ((await active()) === back) fail("bấm next không đổi slide");
      }
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
      // each configured way to close, from open: Esc, the close button, a click on the backdrop (the dialog itself)
      const ways = spec.closeOn.filter((k) => k !== "button" || spec.closeButton);
      for (const way of ways.length ? ways : [undefined]) {
        await page.click(sel(spec.triggers[0]!));
        if (!(await visible(spec.dialog))) fail("bấm trigger không mở dialog");
        if (!way) return;
        if (way === "esc") await page.keyboard.press("Escape");
        else if (way === "button") await page.click(sel(spec.closeButton!));
        else await page.dispatchEvent(sel(spec.dialog), "click"); // the runtime closes when e.target is the dialog
        if (await visible(spec.dialog)) fail(`không đóng được dialog bằng ${way === "esc" ? "Esc" : way === "button" ? "nút đóng" : "click nền"}`);
      }
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
// be uninstalled, so it never leaks into the next check nor into the run's own pages. The 5 s include opening it; time
// up closes it, which ends the check's pending Playwright call at once. undefined = passed.
async function checkOne(browser: Browser, url: string, root: IRNodeV2, ms: number): Promise<string | typeof NOT_APPLICABLE | undefined> {
  let ctx: BrowserContext | undefined, late = false, timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((r) => { timer = setTimeout(() => { late = true; r(`quá thời gian ${ms / 1000} giây`); void ctx?.close().catch(() => {}); }, ms); });
  const run = (async () => {
    const c = (ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })); // the IR is the 1440 tree
    if (late) return undefined;
    // newPage() issued during or after a close never settles (Playwright, see browser.ts): the close ends the run
    const closed = new Promise<never>((_, reject) => c.once("close", () => reject(new Error("context closed"))));
    return await Promise.race([closed, (async () => {
      await c.route("**/*", (r) => (sameOrigin(r.request().url(), url) ? r.fallback() : r.abort()));
      await c.clock.install({ time: 0 });
      await c.clock.pauseAt(1000); // paused (R4): only runFor moves time, no autoplay tick mid-check
      const p = await c.newPage();
      await p.goto(url, { waitUntil: "load" });
      return check(p, root.id, root.interactive!);
    })()]);
  })().catch(reasonOf);
  try {
    return await Promise.race([run, timedOut]);
  } finally {
    clearTimeout(timer);
    await run; // never overlaps the next check (settles: caught above)
    await ctx?.close().catch(() => {});
  }
}

// A pause (signal aborted, or the browser gone) throws: never a made-up failure in qa.json, the qa task stays unfinished.
export async function checkBehavior(handle: BrowserHandle, opts: { outDir: string; ir: IRV2; limits?: Partial<typeof BEHAVIOR_LIMITS>; signal?: AbortSignal }): Promise<BehaviorResult[]> {
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
        const spec = root.interactive!;
        const base: BehaviorResult = { pageId: page.id, nodeId: root.id, kind: spec.kind, ok: false, ...(spec.kind === "video" && spec.mode === "embed" && { embed: true as const }) };
        if (i >= limits.perPage) { results.push({ ...base, ok: false, reason: `vượt giới hạn ${limits.perPage} component/trang` }); continue; }
        opts.signal?.throwIfAborted();
        const reason = await checkOne(browser, url, root, limits.perCheckMs);
        opts.signal?.throwIfAborted();
        if (!browser.isConnected()) throw new Error("qa-behavior: browser closed during the behaviour pass");
        if (reason !== NOT_APPLICABLE) results.push(reason === undefined ? { ...base, ok: true } : { ...base, ok: false, reason });
      }
    }
  } finally {
    await server.close();
  }
  return results;
}
