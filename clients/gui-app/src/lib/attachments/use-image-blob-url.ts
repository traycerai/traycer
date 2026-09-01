import { useEffect, useState } from "react";

import {
  buildScopedImageCacheKey,
  imageBlobCache,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

export type ImageBlobUrlState =
  | { readonly status: "loading"; readonly url: null }
  | { readonly status: "unavailable"; readonly url: null }
  | {
      readonly status: "ready";
      readonly url: string;
      /**
       * The type the Blob behind `url` was actually created with - the byte
       * source's sniffed verdict when it had one, else the `mediaType` passed
       * in. Anything that branches on format (SVG sanitization) must read this
       * rather than the caller's own argument; see `ImageBlobResolution`.
       */
      readonly mediaType: string;
    };

export const IMAGE_UNAVAILABLE_GRACE_MS = 12_000;
export const IMAGE_FETCH_RETRY_BASE_MS = 250;
export const IMAGE_FETCH_RETRY_MAX_MS = 2_000;
export const IMAGE_FETCH_MAX_ATTEMPTS = 4;

/**
 * Resolve a chat image's content hash to a shared `blob:` URL, fetching its
 * bytes once via `fetcher` (the tab-scoped host's `attachments.read`). Every
 * component that renders the same hash UNDER THE SAME SUBJECT shares one blob
 * and one cache reference; the URL is released on unmount and revoked once
 * nothing holds it.
 *
 * `fetcher` must be referentially stable (wrap in `useMemo`) so the effect does
 * not re-acquire on every render.
 */
export function useImageBlobUrl(
  hash: string | null,
  mediaType: string,
  fetcher: ScopedImageBytesFetcher,
): string | null {
  return useImageBlobUrlState(hash, mediaType, fetcher, null).url;
}

/**
 * Resolves the same shared blob URL while preserving the difference between a
 * hash that is still within its sync grace window and one that has remained
 * absent long enough to be called unavailable.
 *
 * A pending fetch stays alive after the unavailable transition, so a late Yjs
 * attachment-map update can still resolve it. Rejected acquisitions (for
 * example, an open-epic store being disposed during mount) receive a finite
 * retry budget, then rest in unavailable until a dependency change or remount
 * starts a fresh acquisition.
 */
export function useImageBlobUrlState(
  hash: string | null,
  mediaType: string,
  fetcher: ScopedImageBytesFetcher,
  unavailableAfterMs: number | null,
): ImageBlobUrlState {
  // Keyed by the full cache identity, not the hash. The SUBJECT can change
  // while the hash stays put - the same image referenced from a second
  // artifact, or a tile rebound to another host - and a hash-keyed gate would
  // keep painting the previous subject's resolved blob throughout the new
  // one's fetch, which is the exact byte-for-byte disclosure the scoped key
  // above exists to prevent, merely arriving through React state instead of
  // the cache.
  const [resolved, setResolved] = useState<{
    identity: string;
    state: ImageBlobUrlState;
  } | null>(null);
  const identity =
    hash === null ? null : buildScopedImageCacheKey(fetcher.scopeKey, hash);

  useEffect(() => {
    if (hash === null || identity === null) return;
    let active = true;
    let attemptCount = 0;
    let cancelRetry: (() => void) | null = null;
    let cancelUnavailable: (() => void) | null = null;
    // Rebound to the LATEST attempt's lease on every `acquire()` call - a
    // failed attempt's entry is already self-removed by the cache (see
    // image-blob-cache.ts's poisoned-entry cleanup), so there is never a
    // stale lease from an earlier attempt worth separately releasing before
    // overwriting this.
    let releaseLease: (() => void) | null = null;

    if (unavailableAfterMs !== null) {
      const unavailableTimer = window.setTimeout(() => {
        if (active) {
          setResolved({
            identity,
            state: { status: "unavailable", url: null },
          });
        }
      }, unavailableAfterMs);
      cancelUnavailable = () => window.clearTimeout(unavailableTimer);
    }

    const acquire = (): void => {
      attemptCount += 1;
      const lease = imageBlobCache.acquire(
        // The SUBJECT is in the identity, not just the hash: `acquire` serves a
        // resolved or in-flight entry without running this fetcher, so a
        // bare-hash key would let the first acquirer's authorization stand in
        // for every later one's (`ScopedImageBytesFetcher`).
        identity,
        mediaType,
        fetcher.fetch,
        // Content-addressed within their subject, but not treated as
        // session-immutable here - unchanged grace-window behavior.
        "grace",
      );
      releaseLease = lease.release;
      lease.promise
        .then((resolution) => {
          if (!active) return;
          cancelUnavailable?.();
          cancelUnavailable = null;
          setResolved({
            identity,
            state: {
              status: "ready",
              url: resolution.url,
              mediaType: resolution.mediaType,
            },
          });
        })
        .catch(() => {
          if (!active) return;
          if (attemptCount >= IMAGE_FETCH_MAX_ATTEMPTS) {
            cancelUnavailable?.();
            cancelUnavailable = null;
            setResolved({
              identity,
              state: { status: "unavailable", url: null },
            });
            return;
          }
          const delay = Math.min(
            IMAGE_FETCH_RETRY_BASE_MS * 2 ** (attemptCount - 1),
            IMAGE_FETCH_RETRY_MAX_MS,
          );
          const retryTimer = window.setTimeout(() => {
            cancelRetry = null;
            acquire();
          }, delay);
          cancelRetry = () => window.clearTimeout(retryTimer);
        });
    };

    acquire();
    return () => {
      active = false;
      cancelRetry?.();
      cancelUnavailable?.();
      releaseLease?.();
    };
  }, [hash, identity, mediaType, fetcher, unavailableAfterMs]);

  // Only surface state that belongs to the current hash AND subject, so either
  // changing shows loading (not the previous image) until the new blob
  // resolves.
  return resolved !== null && resolved.identity === identity
    ? resolved.state
    : { status: "loading", url: null };
}
