import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";

/** One macrotask - enough for a chain of `await`s queued this tick to settle. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise this test controls the settlement of. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("keeps results in input order even when items settle out of order", async () => {
    // Five items, limit 2: at most two indices are ever claimed at once, and
    // the claimed index is always the LOWEST unclaimed one - `next` only
    // moves forward, so item 0 is claimed first and item 4 last. The
    // reversed-completion property this shape can actually realize is: each
    // later item resolves and frees its worker to claim the next one, while
    // item 0 - claimed first - is left outstanding until every other item has
    // already resolved. A naive `results.push(await fn())` implementation
    // would put item 0's result LAST; the correct one keeps it at index 0
    // regardless of when it settles.
    const items = ["a", "b", "c", "d", "e"];
    const deferreds = items.map(() => deferred<string>());
    const resultPromise = mapWithConcurrency(
      items,
      2,
      (_item, index) => deferreds[index].promise,
    );

    // Let the first two workers claim items 0 and 1.
    await tick();

    deferreds[1].resolve("B");
    await tick();
    deferreds[2].resolve("C");
    await tick();
    deferreds[3].resolve("D");
    await tick();
    deferreds[4].resolve("E");
    await tick();
    // Only item 0 is left outstanding now - resolved dead last.
    deferreds[0].resolve("A");

    const results = await resultPromise;
    expect(results).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("keeps at most `limit` calls in flight at once", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    const limit = 3;
    let inFlight = 0;
    let peak = 0;
    const deferreds = items.map(() => deferred<number>());
    const resultPromise = mapWithConcurrency(
      items,
      limit,
      async (_item, index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await deferreds[index].promise;
        } finally {
          inFlight -= 1;
        }
      },
    );

    for (let wave = 0; wave < 20 && peak < limit; wave += 1) {
      await tick();
    }
    expect(peak).toBe(limit);
    expect(inFlight).toBeLessThanOrEqual(limit);

    for (let index = 0; index < items.length; index += 1) {
      deferreds[index].resolve(index * 100);
      await tick();
    }

    const results = await resultPromise;
    expect(results).toEqual(items.map((item) => item * 100));
    expect(inFlight).toBe(0);
  });

  it("runs every item when limit exceeds the item count", async () => {
    const items = [1, 2, 3];
    let concurrentCalls = 0;
    const results = await mapWithConcurrency(items, 10, (item) => {
      concurrentCalls += 1;
      return Promise.resolve(item * 2);
    });
    expect(results).toEqual([2, 4, 6]);
    expect(concurrentCalls).toBe(3);
  });

  it("resolves an empty array without calling fn", async () => {
    const fn = vi.fn((item: number) => Promise.resolve(item));
    const results = await mapWithConcurrency([], 3, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects the whole map when one call rejects", async () => {
    const items = [1, 2, 3];
    const error = new Error("boom");
    await expect(
      mapWithConcurrency(items, 2, (item) => {
        if (item === 2) return Promise.reject(error);
        return Promise.resolve(item);
      }),
    ).rejects.toThrow(error);
  });
});
