import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScopedImageCacheKey,
  imageBlobCache,
  type ImageBlobLease,
  type ImageBlobResolution,
  type ImageBytesFetcher,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import {
  IMAGE_FETCH_MAX_ATTEMPTS,
  IMAGE_FETCH_RETRY_BASE_MS,
  IMAGE_FETCH_RETRY_MAX_MS,
  IMAGE_UNAVAILABLE_GRACE_MS,
  useImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";

function makeLease(promise: Promise<ImageBlobResolution>): ImageBlobLease {
  return { promise, release: vi.fn() };
}

/** A resolution whose media type is whatever the caller declared. */
function resolvedAs(url: string): ImageBlobResolution {
  return { url, mediaType: "image/png" };
}

const bytesFetcher = () =>
  Promise.resolve({ bytes: new Uint8Array([1]), mediaType: null });

/**
 * Stand in for the cache's own key derivation.
 *
 * The hook hands `acquire` the raw hash plus the scoped source and the CACHE
 * derives the entry identity - so a double that keyed on the first argument
 * alone would collapse two subjects onto one blob and report that as correct.
 */
function leaseKeyedLikeTheCache(
  subject: string,
  fetcher: ScopedImageBytesFetcher,
): ImageBlobLease {
  return makeLease(
    Promise.resolve(
      resolvedAs(`blob:${buildScopedImageCacheKey(fetcher.scopeKey, subject)}`),
    ),
  );
}

/**
 * Bundles a bare byte source with a cache subject, for the cases below that
 * are about the retry/grace ladder rather than about scoping. `"test-scope"`
 * unless a case needs two distinct subjects.
 */
function scopedFetcher(
  fetch: ImageBytesFetcher,
  scopeKey: string,
): ScopedImageBytesFetcher {
  return { scopeKey, fetch };
}

describe("useImageBlobUrlState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("becomes unavailable after the grace period and recovers from late bytes", async () => {
    let resolveFetch: ((resolution: ImageBlobResolution) => void) | null = null;
    const pendingUrl = new Promise<ImageBlobResolution>((resolve) => {
      resolveFetch = resolve;
    });
    const lease = makeLease(pendingUrl);
    vi.spyOn(imageBlobCache, "acquire").mockReturnValue(lease);
    const fetcher = scopedFetcher(vi.fn(bytesFetcher), "test-scope");

    const { result, unmount } = renderHook(() =>
      useImageBlobUrlState(
        "late-hash",
        "image/png",
        fetcher,
        IMAGE_UNAVAILABLE_GRACE_MS,
      ),
    );

    expect(result.current).toEqual({ status: "loading", url: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS);
    });
    expect(result.current).toEqual({ status: "unavailable", url: null });

    await act(async () => {
      resolveFetch?.(resolvedAs("blob:late-image"));
      await Promise.resolve();
    });
    expect(result.current).toEqual({
      status: "ready",
      url: "blob:late-image",
      mediaType: "image/png",
    });

    unmount();
    expect(lease.release).toHaveBeenCalled();
  });

  it("re-acquires after a rejected fetch without requiring a remount", async () => {
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockReturnValueOnce(
        makeLease(Promise.reject(new Error("store disposed"))),
      )
      .mockReturnValueOnce(
        makeLease(Promise.resolve(resolvedAs("blob:retried-image"))),
      );
    const fetcher = scopedFetcher(vi.fn(bytesFetcher), "test-scope");

    const { result } = renderHook(() =>
      useImageBlobUrlState(
        "retry-hash",
        "image/png",
        fetcher,
        IMAGE_UNAVAILABLE_GRACE_MS,
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(acquire).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_FETCH_RETRY_BASE_MS);
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({
      status: "ready",
      url: "blob:retried-image",
      mediaType: "image/png",
    });
  });

  it("stops scheduling acquisitions after the retry budget is exhausted", async () => {
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation(() =>
        makeLease(Promise.reject(new Error("store disposed"))),
      );
    const fetcher = scopedFetcher(vi.fn(bytesFetcher), "test-scope");

    const { result } = renderHook(() =>
      useImageBlobUrlState(
        "exhausted-hash",
        "image/png",
        fetcher,
        IMAGE_UNAVAILABLE_GRACE_MS,
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS);
    });

    expect(acquire).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS);
    expect(result.current).toEqual({ status: "unavailable", url: null });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_FETCH_RETRY_MAX_MS * 3);
    });

    expect(acquire).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry when unmounted", async () => {
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation(() =>
        makeLease(Promise.reject(new Error("store disposed"))),
      );
    const fetcher = scopedFetcher(vi.fn(bytesFetcher), "test-scope");

    const { unmount } = renderHook(() =>
      useImageBlobUrlState(
        "unmounted-hash",
        "image/png",
        fetcher,
        IMAGE_UNAVAILABLE_GRACE_MS,
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS);
    });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("re-arms the retry budget when the fetcher dependency changes", async () => {
    const rejectedInner = vi.fn(bytesFetcher);
    const recoveredInner = vi.fn(bytesFetcher);
    // Same SUBJECT, different byte source - this case is about the fetcher
    // dependency re-arming the budget, not about scoping, so the scope key is
    // deliberately held constant across the rerender.
    const rejectedFetcher = scopedFetcher(rejectedInner, "test-scope");
    const recoveredFetcher = scopedFetcher(recoveredInner, "test-scope");
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation((_subject, _mediaType, fetcher) =>
        makeLease(
          // `.fetch`, because the hook hands `acquire` the SCOPED source, not
          // the bare function - the cache needs `scopeKey` to derive its own
          // entry identity.
          fetcher.fetch === recoveredInner
            ? Promise.resolve(resolvedAs("blob:rearmed-image"))
            : Promise.reject(new Error("store disposed")),
        ),
      );

    const { result, rerender } = renderHook(
      ({ fetcher }) =>
        useImageBlobUrlState(
          "rearmed-hash",
          "image/png",
          fetcher,
          IMAGE_UNAVAILABLE_GRACE_MS,
        ),
      { initialProps: { fetcher: rejectedFetcher } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS);
    });
    expect(acquire).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS);
    expect(result.current).toEqual({ status: "unavailable", url: null });

    rerender({ fetcher: recoveredFetcher });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(acquire).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS + 1);
    expect(result.current).toEqual({
      status: "ready",
      url: "blob:rearmed-image",
      mediaType: "image/png",
    });
  });
  it("keys the cache by SUBJECT as well as hash, so a second subject cannot be served the first's blob", async () => {
    // The disclosure this closes, at its own seam. `acquire` returns a resolved
    // (or in-flight) entry WITHOUT running the caller's fetcher, so under a
    // bare-hash key the second subject's byte source - and with it the
    // per-artifact/per-chat authorization the host performs inside it - never
    // executes. Asserting on the KEY rather than on a rendered `src` is
    // deliberate: the key is what decides whether the two acquirers meet, and a
    // src-level assertion would pass against a cache that merely happened to
    // miss.
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation((subject, _mediaType, fetcher) =>
        leaseKeyedLikeTheCache(subject, fetcher),
      );
    const sharedHash = "hash-referenced-from-two-artifacts";
    // Hoisted, not built inside the render callback: the hook documents that
    // `fetcher` must be referentially stable, and it is an effect dependency,
    // so a fresh object per render re-runs the effect forever.
    const fetcherA = scopedFetcher(vi.fn(bytesFetcher), "artifact-a");
    const fetcherB = scopedFetcher(vi.fn(bytesFetcher), "artifact-b");

    const first = renderHook(() =>
      useImageBlobUrlState(sharedHash, "image/png", fetcherA, null),
    );
    const second = renderHook(() =>
      useImageBlobUrlState(sharedHash, "image/png", fetcherB, null),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The SUBJECT handed to the cache is the bare hash, because that is what
    // the byte source is asked for. Passing the scoped identity here instead
    // made every artifact/chat RPC request `["scope","<hash>"]` and no
    // persisted image resolved.
    expect(acquire.mock.calls.map((call) => call[0])).toEqual([
      sharedHash,
      sharedHash,
    ]);

    // Scoping is therefore visible in the DERIVED identity, not the subject.
    const keys = acquire.mock.calls.map(([subject, , fetcher]) =>
      buildScopedImageCacheKey(fetcher.scopeKey, subject),
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // Every key still CONTAINS the hash - the entries are distinct because of
    // the subject, not because the hash was dropped.
    for (const key of keys) expect(key).toContain(sharedHash);
    // ...and each subject resolved its own entry rather than sharing one.
    expect(first.result.current.url).not.toBe(second.result.current.url);

    first.unmount();
    second.unmount();
  });

  it("still shares one entry across renders of the same hash under the SAME subject", async () => {
    // The other half, and the one that fails if the key is over-scoped into
    // uselessness: within a subject the cache must still collapse every fiber
    // rendering an image onto one blob, which is the whole reason it exists.
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation((subject, _mediaType, fetcher) =>
        leaseKeyedLikeTheCache(subject, fetcher),
      );
    const fetcher = scopedFetcher(vi.fn(bytesFetcher), "artifact-a");

    const first = renderHook(() =>
      useImageBlobUrlState("shared-hash", "image/png", fetcher, null),
    );
    const second = renderHook(() =>
      useImageBlobUrlState("shared-hash", "image/png", fetcher, null),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(new Set(acquire.mock.calls.map((call) => call[0])).size).toBe(1);
    expect(first.result.current.url).toBe(second.result.current.url);

    first.unmount();
    second.unmount();
  });

  it("drops the previous subject's resolved blob when the subject changes under one hash", async () => {
    // The same disclosure arriving through React state instead of the cache.
    // The resolved-state gate used to compare only the hash, so a tile rebound
    // to another artifact - or to another host - kept PAINTING the previous
    // subject's bytes for the whole of the new subject's fetch, and
    // indefinitely if the new one never resolves. `loading` is the assertion
    // that matters here; the later `ready` only proves the hook still works.
    vi.spyOn(imageBlobCache, "acquire").mockImplementation(
      (subject, _mediaType, fetcher) =>
        leaseKeyedLikeTheCache(subject, fetcher),
    );

    const fetcherA = scopedFetcher(vi.fn(bytesFetcher), "artifact-a");
    const fetcherB = scopedFetcher(vi.fn(bytesFetcher), "artifact-b");
    const { result, rerender } = renderHook(
      ({ fetcher }) =>
        useImageBlobUrlState("one-hash", "image/png", fetcher, null),
      { initialProps: { fetcher: fetcherA } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstUrl = result.current.url;
    expect(result.current.status).toBe("ready");

    rerender({ fetcher: fetcherB });
    expect(result.current).toEqual({ status: "loading", url: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.url).not.toBe(firstUrl);
  });
});
