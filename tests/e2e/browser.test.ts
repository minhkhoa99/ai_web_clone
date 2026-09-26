import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage } from "@/core/browser";

test("withPage navigates, returns a result, and closes the page after", async () => {
  const handle = await openBrowser({ headed: false });
  try {
    const before = handle.context.pages().length;
    const title = await withPage(handle, async (page) => {
      await page.goto("data:text/html,<title>hi</title><h1>hi</h1>");
      return page.title();
    });
    expect(title).toBe("hi");
    expect(handle.context.pages().length).toBe(before);
  } finally {
    await handle.close();
  }
});

test("timeout bounds non-navigation page operations too, not just goto", async () => {
  const handle = await openBrowser({ headed: false });
  try {
    const start = Date.now();
    await expect(
      withPage(
        handle,
        async (page) => {
          await page.goto("data:text/html,<h1>no button here</h1>");
          await page.waitForSelector("#does-not-exist");
        },
        { timeout: 500 },
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5000);
  } finally {
    await handle.close();
  }
});

test("caps concurrent open pages at maxPages", async () => {
  const handle = await openBrowser({ headed: false, maxPages: 2 });
  try {
    let openCount = 0;
    let maxObserved = 0;
    const tasks = Array.from({ length: 6 }, () =>
      withPage(handle, async (page) => {
        openCount++;
        maxObserved = Math.max(maxObserved, openCount);
        await page.goto("data:text/html,<h1>x</h1>");
        await new Promise((resolve) => setTimeout(resolve, 20));
        openCount--;
        return null;
      }),
    );
    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(2);
  } finally {
    await handle.close();
  }
});

test("withPage on a handle being closed (a pause) rejects with BROWSER_CRASH instead of hanging in newPage", { timeout: 30_000 }, async () => {
  const handle = await openBrowser({ profileDir: await mkdtemp(join(tmpdir(), "ai-web-clone-close-")) });
  const closing = handle.close();
  await expect(withPage(handle, async () => "never")).rejects.toMatchObject({ code: "BROWSER_CRASH" });
  await closing;
  await handle.close(); // a second close (the run's finally after a pause) is fine
});
