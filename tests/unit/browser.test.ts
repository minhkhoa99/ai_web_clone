import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chromium, type BrowserContext, type Page } from "playwright";
import { evalWithTimeout, openBrowser, withPage } from "@/core/browser";
import { AppError } from "@/core/errors";

vi.mock("playwright", () => ({ chromium: { launchPersistentContext: vi.fn() } }));

afterEach(() => vi.useRealTimers());

test("evalWithTimeout: a page script that never settles rejects with BROWSER_CRASH after 30 s; a quick one resolves", async () => {
  vi.useFakeTimers();
  const hung = { evaluate: () => new Promise(() => {}), url: () => "http://127.0.0.1/x" } as unknown as Page;
  const result = evalWithTimeout(hung, "Section boxes", () => 1).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  const err = (await result) as AppError;
  expect(err).toBeInstanceOf(AppError);
  expect([err.code, err.message]).toEqual(["BROWSER_CRASH", "Section boxes timed out after 30s"]);

  const quick = { evaluate: async (_fn: unknown, arg: number) => arg * 2, url: () => "" } as unknown as Page;
  expect(await evalWithTimeout(quick, "x", (n: number) => n * 2, 21)).toBe(42);
  expect(vi.getTimerCount()).toBe(0); // the timer is cleared once the evaluate settles
});

// A context whose newPage never settles (like Playwright's during a close); close() fires "close" like the real one.
function fakeContext(): BrowserContext & EventEmitter {
  const ctx = new EventEmitter() as BrowserContext & EventEmitter;
  Object.assign(ctx, { newPage: () => new Promise(() => {}), close: async () => void ctx.emit("close") });
  return ctx;
}

const WINDOW_CLOSED = "Cửa sổ Chrome đã bị đóng — bấm Tiếp tục để chạy lại (đừng đóng cửa sổ khi đang chạy).";

test("headed: the user closing the Chrome window (no pause) reads as BROWSER_CRASH with the window message; headless and a pause keep \"browser closed\"", async () => {
  const open = async (headed: boolean) => {
    const ctx = fakeContext();
    vi.mocked(chromium.launchPersistentContext).mockResolvedValueOnce(ctx);
    return { ctx, handle: await openBrowser({ profileDir: "unused", headed }) };
  };
  const rejection = (handle: Awaited<ReturnType<typeof openBrowser>>) => withPage(handle, async () => "never").catch((e: AppError) => [e.code, e.message]);

  const headed = await open(true);
  headed.ctx.emit("close"); // the user closed the window
  expect(await rejection(headed.handle)).toEqual(["BROWSER_CRASH", WINDOW_CLOSED]);

  const headless = await open(false);
  headless.ctx.emit("close");
  expect(await rejection(headless.handle)).toEqual(["BROWSER_CRASH", "browser closed"]);

  const paused = await open(true);
  await paused.handle.close(); // a pause closes it: not the user's doing
  expect(await rejection(paused.handle)).toEqual(["BROWSER_CRASH", "browser closed"]);
});
