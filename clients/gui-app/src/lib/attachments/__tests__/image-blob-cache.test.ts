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

    const [a, b] = await Promise.all([
      cache.acquire("h1", "image/png", fetcher),
      cache.acquire("h1", "image/png", fetcher),
    ]);

    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("revokes the URL after the grace window once references hit zero", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const url = await cache.acquire("h1", "image/png", fetcher);
    cache.release("h1");
    expect(revoked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("reuses the live blob when re-acquired within the grace window", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops, revoked, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const first = await cache.acquire("h1", "image/png", fetcher);
    cache.release("h1");
    await vi.advanceTimersByTimeAsync(500);
    const second = await cache.acquire("h1", "image/png", fetcher);

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

    const pending = cache.acquire("h1", "image/png", fetcher);
    cache.release("h1");

    await expect(pending).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(created).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    expect(cache.size()).toBe(0);
  });

  it("keeps distinct URLs for distinct hashes", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    const { ops } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const a = await cache.acquire("h1", "image/png", fetcher);
    const b = await cache.acquire("h2", "image/png", fetcher);

    expect(a).not.toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });
});
