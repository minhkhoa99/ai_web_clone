// Shared UI smoke assertions (spec parity §7.2).
import { expect } from "vitest";
import type { Page } from "playwright";

// Stitch-invented strings that must never be rendered (spec §5 + §7.2). Iframe (clone) content is not in body.innerText.
export const DRIFT: RegExp[] = [
  /Turnstile/i, /Cloudflare/i, /Inject Auth/i, /Inject Cookies/i, /\.har\b/i, /Puppeteer/i, /Stealth/i, /Auto-reconcile/i,
  /Approve/i, /Deploy/i, /Telemetry/i, /\bPID\b/, /Daemon/i, /worker#/i, /Thread #/i, /Build Successful/i, /Export Package/i,
  /Save as preset/i, /Figma/i, /Markdown/i, /DOM Delta/i, /\bAbort\b/i, /Configure Rules/i, /\bEngine/i, /Cluster/i,
  /DevBrowser/i, /main branch/i, /Synced/i, /ROUTER ACTIVE/i, /High Precision/i, /AES-256/i, /\$\s?\d/, /Task #/i,
  /claude-3/i, /gpt-4o/i,
];

export async function expectNoDrift(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const re of DRIFT) expect(text, `drift ${re}`).not.toMatch(re);
}

// Every button/link whose only content is an icon names itself with aria-label AND title.
export async function expectIconButtonsLabelled(page: Page): Promise<void> {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a")]
      .filter((el) => el.innerText.trim() === "" && el.querySelector("svg"))
      .filter((el) => !el.getAttribute("aria-label")?.trim() || !el.getAttribute("title")?.trim())
      .map((el) => el.outerHTML.slice(0, 160)),
  );
  expect(bad).toEqual([]);
}

// Any http(s) request off the loopback host (font CDN, icon CDN, …) is collected.
export function trackForeignRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") seen.push(r.url());
  });
  return seen;
}

export async function expectUi(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) expect(await page.locator(`[data-ui="${id}"]`).count(), id).toBeGreaterThan(0);
}

// The element has a real size, lies inside the viewport horizontally and is the topmost thing at its centre
// (not clipped by an overflow:hidden ancestor, not covered by a neighbour) once scrolled into view. Returns the misses.
export function hittable(page: Page, selector: string, minWidth = 1): Promise<string[]> {
  return page.evaluate(
    ([sel, min]) =>
      [...document.querySelectorAll<HTMLElement>(sel)].flatMap((el) => {
        // window-only vertical scroll: scrollIntoView would also scroll overflow:hidden ancestors and hide a clip
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const ok = r.width >= min && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth && !!hit && el.contains(hit);
        return ok ? [] : [`${el.outerHTML.slice(0, 120)} @ ${Math.round(r.left)}..${Math.round(r.right)}`];
      }),
    [selector, minWidth] as const,
  );
}
