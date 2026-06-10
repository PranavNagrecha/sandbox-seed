/**
 * Map `items` through an async `fn` with at most `limit` calls in flight.
 *
 * Results come back in input order. The first rejection wins: in-flight
 * calls are allowed to settle, but no NEW items are claimed after a
 * failure, and the original error propagates to the caller. This mirrors
 * fail-fast sequential semantics — callers that want per-item error
 * tolerance catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be a positive integer (got ${limit})`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
