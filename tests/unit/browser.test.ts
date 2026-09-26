import { afterEach, expect, test, vi } from "vitest";
import type { Page } from "playwright";
import { evalWithTimeout } from "@/core/browser";
import { AppError } from "@/core/errors";

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
