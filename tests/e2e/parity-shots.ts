// Parity screenshots (spec parity §7.1) for side-by-side review against docs/superpowers/design/stitch/*.png.
// Full-page at `width` x 900 (default 1440). Not a pass/fail check: a no-op unless PARITY_DIR is set, e.g.
//   PARITY_DIR=<scratchpad>/ui-parity npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export async function parityShot(page: Page, name: string, width = 1440): Promise<void> {
  const dir = process.env.PARITY_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.setViewportSize({ width, height: 900 });
  // from the top: a scrolled full-page capture paints the fixed header mid-page
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    return document.fonts.ready.then(() => undefined);
  });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
