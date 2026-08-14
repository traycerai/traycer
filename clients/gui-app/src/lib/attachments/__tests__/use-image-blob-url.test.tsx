import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  imageBlobCache,
  type ImageBlobLease,
  type ImageBlobResolution,
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
    const fetcher = vi.fn(bytesFetcher);

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
    const fetcher = vi.fn(bytesFetcher);

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
    const fetcher = vi.fn(bytesFetcher);

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
    const fetcher = vi.fn(bytesFetcher);

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
    const rejectedFetcher = vi.fn(bytesFetcher);
    const recoveredFetcher = vi.fn(bytesFetcher);
    const acquire = vi
      .spyOn(imageBlobCache, "acquire")
      .mockImplementation((_hash, _mediaType, fetcher) =>
        makeLease(
          fetcher === recoveredFetcher
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
});
