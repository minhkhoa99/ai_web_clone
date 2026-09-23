// Bounded-concurrency map: runs `fn` over `items` with at most `limit` in
// flight, keeps results in input order, stops starting new items once one
// throws, waits for in-flight ones to settle, then rejects with the first error.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError(`mapLimit: limit must be >= 1, got ${limit}`);

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (failed) throw firstError;
  return results;
}
