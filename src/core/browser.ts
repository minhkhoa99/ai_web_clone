import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type BrowserHandle = {
  context: BrowserContext;
  close(): Promise<void>;
};

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

type Semaphore = { acquire(): Promise<void>; release(): void };

function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire() {
      if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
    },
    release() {
      active--;
      queue.shift()?.();
    },
  };
}

// Internal shape: BrowserHandle plus the page-pool semaphore, kept off the
// public type per the interface contract — withPage recovers it via cast.
interface PooledHandle extends BrowserHandle {
  _semaphore: Semaphore;
}

async function openViaCdp(cdpUrl: string, maxPages: number): Promise<PooledHandle> {
  const browser: Browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { context, close: () => browser.close(), _semaphore: createSemaphore(maxPages) };
}

async function openPersistent(profileDir: string, headed: boolean, maxPages: number): Promise<PooledHandle> {
  const context = await chromium.launchPersistentContext(profileDir, { headless: !headed });
  return { context, close: () => context.close(), _semaphore: createSemaphore(maxPages) };
}

async function openEphemeral(headed: boolean, maxPages: number): Promise<PooledHandle> {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
    _semaphore: createSemaphore(maxPages),
  };
}

export async function openBrowser(
  opts: { profileDir?: string; headed?: boolean; maxPages?: number } = {},
): Promise<BrowserHandle> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const cdpUrl = process.env.CDP_URL;
  if (cdpUrl) return openViaCdp(cdpUrl, maxPages);
  if (opts.profileDir) return openPersistent(opts.profileDir, opts.headed ?? false, maxPages);
  return openEphemeral(opts.headed ?? false, maxPages);
}

// Acquires a pool slot (bounded by maxPages from openBrowser), opens a page,
// applies the navigation timeout, runs fn, then closes the page and releases
// the slot — both in `finally` so a throw from fn never leaks either.
export async function withPage<T>(
  handle: BrowserHandle,
  fn: (page: Page) => Promise<T>,
  opts?: { timeout?: number },
): Promise<T> {
  const semaphore = (handle as PooledHandle)._semaphore;
  await semaphore.acquire();
  try {
    const page = await handle.context.newPage();
    const timeout = opts?.timeout ?? DEFAULT_NAV_TIMEOUT_MS;
    page.setDefaultNavigationTimeout(timeout);
    page.setDefaultTimeout(timeout);
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  } finally {
    semaphore.release();
  }
}
