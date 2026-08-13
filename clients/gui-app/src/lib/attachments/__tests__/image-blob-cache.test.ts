import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageBlobCache,
  type ImageBlobOps,
} from "@/lib/attachments/image-blob-cache";

function makeOps(): {
  ops: ImageBlobOps;
  created: string[];
  revoked: string[];
} {
  let n = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const ops: ImageBlobOps = {
    create: () => {
      const url = `blob:fake/${n++}`;
      created.push(url);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
  };
  return { ops, created, revoked };
}

describe("image-blob-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches bytes once per hash and shares one URL across acquirers", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));
    const { ops, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const leaseA = cache.acquire("h1", "image/png", fetcher, "grace");
    const leaseB = cache.acquire("h1", "image/png", fetcher, "grace");
    const [a, b] = await Promise.all([leaseA.promise, leaseB.promise]);

    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("revokes the URL after the grace window once references hit zero", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire("h1", "image/png", fetcher, "grace");
    const url = await lease.promise;
    lease.release();
    expect(revoked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("reuses the live blob when re-acquired within the grace window", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const firstLease = cache.acquire("h1", "image/png", fetcher, "grace");
    const first = await firstLease.promise;
    firstLease.release();
    await vi.advanceTimersByTimeAsync(500);
    const secondLease = cache.acquire("h1", "image/png", fetcher, "grace");
    const second = await secondLease.promise;

    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(2000);
    expect(revoked).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts the fetch and creates no blob when released before it resolves", async () => {
    let aborted = false;
    const fetcher = vi.fn(
      (_hash: string, signal: AbortSignal) =>
        new Promise<Uint8Array<ArrayBuffer>>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const { ops, created, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire("h1", "image/png", fetcher, "grace");
    lease.release();

    await expect(lease.promise).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(created).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    expect(cache.size()).toBe(0);
  });

  it("keeps distinct URLs for distinct hashes", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const a = await cache.acquire("h1", "image/png", fetcher, "grace").promise;
    const b = await cache.acquire("h2", "image/png", fetcher, "grace").promise;

    expect(a).not.toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  it("retains session URLs at zero references past the grace window", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "session-hash",
      "image/png",
      fetcher,
      "session",
    );
    const url = await lease.promise;
    lease.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(revoked).toHaveLength(0);
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("clear revokes and removes zero-reference session entries", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire("clear-hash", "image/png", fetcher, "session");
    const url = await lease.promise;
    lease.release();
    cache.clear();

    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("discards a referenced entry immediately, ignoring its ref count", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "referenced-hash",
      "image/png",
      fetcher,
      "grace",
    );
    const url = await lease.promise;
    cache.discard("referenced-hash");

    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
    cache.discard("referenced-hash");
    cache.discard("unknown-hash");
    expect(revoked).toEqual([url]);

    // A release for the now-discarded generation must be a silent no-op.
    lease.release();
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("discards session-retained entries and bypasses retention", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "session-discard-hash",
      "image/png",
      fetcher,
      "session",
    );
    const url = await lease.promise;
    lease.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(revoked).toHaveLength(0);

    cache.discard("session-discard-hash");
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("starts a fresh fetch after discarding an entry", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const firstLease = cache.acquire(
      "refetch-hash",
      "image/png",
      fetcher,
      "grace",
    );
    const first = await firstLease.promise;
    cache.discard("refetch-hash");
    const secondLease = cache.acquire(
      "refetch-hash",
      "image/png",
      fetcher,
      "grace",
    );
    const second = await secondLease.promise;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("keeps a replacement live when stale leases release after discard", async () => {
    const oldFetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const replacementFetcher = vi.fn(() =>
      Promise.resolve(new Uint8Array([2])),
    );
    const { ops, created, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const oldLeaseA = cache.acquire(
      "aba-hash",
      "image/png",
      oldFetcher,
      "grace",
    );
    const oldLeaseB = cache.acquire(
      "aba-hash",
      "image/png",
      oldFetcher,
      "grace",
    );
    const oldUrl = await oldLeaseA.promise;
    expect(await oldLeaseB.promise).toBe(oldUrl);

    cache.discard("aba-hash");
    expect(revoked).toEqual([oldUrl]);

    const replacementLease = cache.acquire(
      "aba-hash",
      "image/png",
      replacementFetcher,
      "grace",
    );
    const replacementUrl = await replacementLease.promise;
    expect(replacementUrl).not.toBe(oldUrl);
    expect(created).toHaveLength(2);

    oldLeaseA.release();
    oldLeaseB.release();
    expect(revoked).toEqual([oldUrl]);
    expect(cache.size()).toBe(1);

    replacementLease.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual([oldUrl, replacementUrl]);
    expect(cache.size()).toBe(0);
  });

  it("does not let stale releases abort an in-flight replacement", async () => {
    const oldFetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const resolveReplacementHolder: {
      current: ((bytes: Uint8Array<ArrayBuffer>) => void) | null;
    } = { current: null };
    let replacementAborted = false;
    const replacementFetcher = vi.fn(
      (_hash: string, signal: AbortSignal) =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
          resolveReplacementHolder.current = resolve;
          signal.addEventListener("abort", () => {
            replacementAborted = true;
            reject(new Error("replacement aborted"));
          });
        }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const oldLeaseA = cache.acquire(
      "aba-pending",
      "image/png",
      oldFetcher,
      "grace",
    );
    const oldLeaseB = cache.acquire(
      "aba-pending",
      "image/png",
      oldFetcher,
      "grace",
    );
    await oldLeaseA.promise;
    await oldLeaseB.promise;
    cache.discard("aba-pending");

    const replacementLease = cache.acquire(
      "aba-pending",
      "image/png",
      replacementFetcher,
      "grace",
    );
    oldLeaseA.release();
    oldLeaseB.release();

    expect(replacementAborted).toBe(false);
    resolveReplacementHolder.current?.(new Uint8Array([2]));
    const replacementUrl = await replacementLease.promise;
    expect(replacementAborted).toBe(false);
    expect(revoked).toHaveLength(1);

    replacementLease.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual(["blob:fake/0", replacementUrl]);
    expect(cache.size()).toBe(0);
  });
});
