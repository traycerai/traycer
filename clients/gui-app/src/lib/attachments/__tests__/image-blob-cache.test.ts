import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageBlobCache,
  type ImageBlobOps,
  type ImageBytesFetcher,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

/** The scope every case here shares unless it is specifically about scoping. */
const TEST_SCOPE = "test-scope";

/**
 * Wrap a bare byte source as a scoped one.
 *
 * `acquire` takes a {@link ScopedImageBytesFetcher} rather than a bare
 * function precisely so a byte source cannot reach the cache without saying
 * what it authorizes against - see `scopeFor` below for the cases that vary
 * it.
 */
function scoped(fetch: ImageBytesFetcher): ScopedImageBytesFetcher {
  return { scopeKey: TEST_SCOPE, fetch };
}

function scopeFor(
  scopeKey: string,
  fetch: ImageBytesFetcher,
): ScopedImageBytesFetcher {
  return { scopeKey, fetch };
}

function makeOps(): {
  ops: ImageBlobOps;
  created: string[];
  createdTypes: string[];
  revoked: string[];
} {
  let n = 0;
  const created: string[] = [];
  const createdTypes: string[] = [];
  const revoked: string[] = [];
  const ops: ImageBlobOps = {
    create: (_bytes, mediaType) => {
      const url = `blob:fake/${n++}`;
      created.push(url);
      createdTypes.push(mediaType);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
  };
  return { ops, created, createdTypes, revoked };
}

describe("image-blob-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the byte source for the SUBJECT, not for the cache identity", async () => {
    // The scoped key and the fetch argument are two different values that were
    // one parameter. A caller passing the scoped identity for the key thereby
    // asked its RPC for `["scope","h1"]`, every request missed, and no
    // persisted image ever resolved. Nothing asserted this because the cache's
    // own suite still handed `acquire` a bare function - the type that made
    // scoping mandatory at the hooks never reached here.
    const seen: string[] = [];
    const fetcher = vi.fn((subject: string) => {
      seen.push(subject);
      return Promise.resolve({
        bytes: new Uint8Array([1]),
        mediaType: null,
      });
    });
    const { ops } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    await cache.acquire("h1", "image/png", scoped(fetcher), "grace").promise;

    expect(seen).toEqual(["h1"]);
  });

  it("keeps two scopes on separate entries for the same subject", async () => {
    // The round-27 property, asserted at the cache rather than at the hook:
    // `acquire` serves a resolved entry WITHOUT running the second acquirer's
    // fetcher, so sharing across scopes would let one subject's authorization
    // stand in for another's. Both fetchers must run and two URLs must exist.
    const first = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const second = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([2]), mediaType: null }),
    );
    const { ops, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const a = await cache.acquire(
      "shared-hash",
      "image/png",
      scopeFor("artifact-a", first),
      "grace",
    ).promise;
    const b = await cache.acquire(
      "shared-hash",
      "image/png",
      scopeFor("artifact-b", second),
      "grace",
    ).promise;

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(a.url).not.toBe(b.url);
    expect(created).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  it("fetches bytes once per hash and shares one URL across acquirers", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: null }),
    );
    const { ops, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const leaseA = cache.acquire("h1", "image/png", scoped(fetcher), "grace");
    const leaseB = cache.acquire("h1", "image/png", scoped(fetcher), "grace");
    const [a, b] = await Promise.all([leaseA.promise, leaseB.promise]);

    expect(a.url).toBe(b.url);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("types the blob from the fetcher's verdict, not the caller's claim", async () => {
    // The caller's `mediaType` is a claim about bytes it has not seen - for a
    // chat image it is whatever the composer stored on the message. A byte
    // source that sniffed the delivered bytes (the host, per
    // `epic.readChatAttachment`) outranks it, or SVG bytes filed as
    // `image/png` would be handed to the renderer as a PNG and skip the SVG
    // sanitizer entirely.
    const fetcher = vi.fn(() =>
      Promise.resolve({
        bytes: new Uint8Array([1]),
        mediaType: "image/svg+xml",
      }),
    );
    const { ops, createdTypes } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const resolution = await cache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    ).promise;

    expect(createdTypes).toEqual(["image/svg+xml"]);
    expect(resolution.mediaType).toBe("image/svg+xml");
  });

  it("keeps the caller's claim when the fetcher has no verdict", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, createdTypes } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const resolution = await cache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    ).promise;

    expect(createdTypes).toEqual(["image/png"]);
    expect(resolution.mediaType).toBe("image/png");
  });

  it("reports the resolved type to a later acquirer that hits the cache", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({
        bytes: new Uint8Array([1]),
        mediaType: "image/svg+xml",
      }),
    );
    const { ops } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    await cache.acquire("h1", "image/png", scoped(fetcher), "grace").promise;
    const onHit = await cache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    ).promise;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onHit.mediaType).toBe("image/svg+xml");
  });

  it("revokes the URL after the grace window once references hit zero", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire("h1", "image/png", scoped(fetcher), "grace");
    const url = (await lease.promise).url;
    lease.release();
    expect(revoked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("reuses the live blob when re-acquired within the grace window", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const firstLease = cache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    const first = (await firstLease.promise).url;
    firstLease.release();
    await vi.advanceTimersByTimeAsync(500);
    const secondLease = cache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    const second = (await secondLease.promise).url;

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
        new Promise<ImageBytesResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const { ops, created, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire("h1", "image/png", scoped(fetcher), "grace");
    lease.release();

    await expect(lease.promise).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(created).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    expect(cache.size()).toBe(0);
  });

  it("keeps distinct URLs for distinct hashes", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const a = (
      await cache.acquire("h1", "image/png", scoped(fetcher), "grace").promise
    ).url;
    const b = (
      await cache.acquire("h2", "image/png", scoped(fetcher), "grace").promise
    ).url;

    expect(a).not.toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  it("retains session URLs at zero references past the grace window", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "session-hash",
      "image/png",
      scoped(fetcher),
      "session",
    );
    const url = (await lease.promise).url;
    lease.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(revoked).toHaveLength(0);
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("clear revokes and removes zero-reference session entries", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "clear-hash",
      "image/png",
      scoped(fetcher),
      "session",
    );
    const url = (await lease.promise).url;
    lease.release();
    cache.clear();

    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("discards a referenced entry immediately, ignoring its ref count", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "referenced-hash",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    const url = (await lease.promise).url;
    cache.discard(TEST_SCOPE, "referenced-hash");

    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
    cache.discard(TEST_SCOPE, "referenced-hash");
    cache.discard(TEST_SCOPE, "unknown-hash");
    expect(revoked).toEqual([url]);

    // A release for the now-discarded generation must be a silent no-op.
    lease.release();
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("discards session-retained entries and bypasses retention", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const lease = cache.acquire(
      "session-discard-hash",
      "image/png",
      scoped(fetcher),
      "session",
    );
    const url = (await lease.promise).url;
    lease.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(revoked).toHaveLength(0);

    cache.discard(TEST_SCOPE, "session-discard-hash");
    expect(revoked).toEqual([url]);
    expect(cache.size()).toBe(0);
  });

  it("starts a fresh fetch after discarding an entry", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const { ops, created } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const firstLease = cache.acquire(
      "refetch-hash",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    const first = (await firstLease.promise).url;
    cache.discard(TEST_SCOPE, "refetch-hash");
    const secondLease = cache.acquire(
      "refetch-hash",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    const second = (await secondLease.promise).url;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("keeps a replacement live when stale leases release after discard", async () => {
    const oldFetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const replacementFetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([2]), mediaType: null }),
    );
    const { ops, created, revoked } = makeOps();
    const cache = createImageBlobCache(ops, 1000);

    const oldLeaseA = cache.acquire(
      "aba-hash",
      "image/png",
      scoped(oldFetcher),
      "grace",
    );
    const oldLeaseB = cache.acquire(
      "aba-hash",
      "image/png",
      scoped(oldFetcher),
      "grace",
    );
    const oldUrl = (await oldLeaseA.promise).url;
    expect((await oldLeaseB.promise).url).toBe(oldUrl);

    cache.discard(TEST_SCOPE, "aba-hash");
    expect(revoked).toEqual([oldUrl]);

    const replacementLease = cache.acquire(
      "aba-hash",
      "image/png",
      scoped(replacementFetcher),
      "grace",
    );
    const replacementUrl = (await replacementLease.promise).url;
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
    const oldFetcher = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null }),
    );
    const resolveReplacementHolder: {
      current: ((result: ImageBytesResult) => void) | null;
    } = { current: null };
    let replacementAborted = false;
    const replacementFetcher = vi.fn(
      (_hash: string, signal: AbortSignal) =>
        new Promise<ImageBytesResult>((resolve, reject) => {
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
      scoped(oldFetcher),
      "grace",
    );
    const oldLeaseB = cache.acquire(
      "aba-pending",
      "image/png",
      scoped(oldFetcher),
      "grace",
    );
    await oldLeaseA.promise;
    await oldLeaseB.promise;
    cache.discard(TEST_SCOPE, "aba-pending");

    const replacementLease = cache.acquire(
      "aba-pending",
      "image/png",
      scoped(replacementFetcher),
      "grace",
    );
    oldLeaseA.release();
    oldLeaseB.release();

    expect(replacementAborted).toBe(false);
    resolveReplacementHolder.current?.({
      bytes: new Uint8Array([2]),
      mediaType: null,
    });
    const replacementUrl = (await replacementLease.promise).url;
    expect(replacementAborted).toBe(false);
    expect(revoked).toHaveLength(1);

    replacementLease.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual(["blob:fake/0", replacementUrl]);
    expect(cache.size()).toBe(0);
  });
});
