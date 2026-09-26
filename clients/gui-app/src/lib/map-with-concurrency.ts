/**
 * `Promise.all(items.map(fn))` with at most `limit` calls of `fn` in flight.
 *
 * For a fan-out whose per-item cost is not the await but what the await holds
 * live meanwhile: a FileReader over a multi-megabyte image keeps its source
 * bytes and produces a larger string, so thirty of them started on one tick
 * hold hundreds of megabytes at once where three hold a few. Results keep
 * their input order; a rejection from any call rejects the whole map, as
 * `Promise.all` would.
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}
