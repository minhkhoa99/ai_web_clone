import { expect, test } from "vitest";
import { mapLimit } from "@/core/limit";

test("bounded concurrency, results in input order", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);

  const results = await mapLimit(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return n * 2;
  });

  expect(maxActive).toBeLessThanOrEqual(3);
  expect(results).toEqual(items.map((n) => n * 2));
});

test("stops starting new items after one throws, waits for in-flight, rejects with first error", async () => {
  const started: number[] = [];
  const items = [0, 1, 2, 3, 4, 5];

  const promise = mapLimit(items, 2, async (n) => {
    started.push(n);
    if (n === 1) throw new Error("boom");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return n;
  });

  await expect(promise).rejects.toThrow("boom");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(started.length).toBeLessThan(items.length);
});

test("rejects when limit < 1", async () => {
  await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow();
});
