import { useEffect, useState } from "react";

import {
  type ImageBytesFetcher,
  imageBlobCache,
} from "@/lib/attachments/image-blob-cache";

export type ImageBlobUrlState =
  | { readonly status: "loading"; readonly url: null }
  | { readonly status: "unavailable"; readonly url: null }
  | { readonly status: "ready"; readonly url: string };

export const IMAGE_UNAVAILABLE_GRACE_MS = 12_000;
export const IMAGE_FETCH_RETRY_BASE_MS = 250;
export const IMAGE_FETCH_RETRY_MAX_MS = 2_000;
export const IMAGE_FETCH_MAX_ATTEMPTS = 4;

/**
 * Resolve a chat image's content hash to a shared `blob:` URL, fetching its
 * bytes once via `fetcher` (the tab-scoped host's `attachments.read`). Every
 * component that renders the same hash shares one blob and one cache reference;
 * the URL is released on unmount and revoked once nothing holds it.
 *
 * `fetcher` must be referentially stable (wrap in `useCallback`) so the effect
 * does not re-acquire on every render.
 */
export function useImageBlobUrl(
  hash: string | null,
  mediaType: string,
  fetcher: ImageBytesFetcher,
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
  fetcher: ImageBytesFetcher,
  unavailableAfterMs: number | null,
): ImageBlobUrlState {
  const [resolved, setResolved] = useState<{
    hash: string;
    state: ImageBlobUrlState;
  } | null>(null);

  useEffect(() => {
    if (hash === null) return;
    let active = true;
    let attemptCount = 0;
    let cancelRetry: (() => void) | null = null;
    let cancelUnavailable: (() => void) | null = null;

    if (unavailableAfterMs !== null) {
      const unavailableTimer = window.setTimeout(() => {
        if (active) {
          setResolved({
            hash,
            state: { status: "unavailable", url: null },
          });
        }
      }, unavailableAfterMs);
      cancelUnavailable = () => window.clearTimeout(unavailableTimer);
    }

    const acquire = (): void => {
      attemptCount += 1;
      imageBlobCache
        .acquire(hash, mediaType, fetcher)
        .then((url) => {
          if (!active) return;
          cancelUnavailable?.();
          cancelUnavailable = null;
          setResolved({ hash, state: { status: "ready", url } });
        })
        .catch(() => {
          if (!active) return;
          if (attemptCount >= IMAGE_FETCH_MAX_ATTEMPTS) {
            cancelUnavailable?.();
            cancelUnavailable = null;
            setResolved({
              hash,
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
      imageBlobCache.release(hash);
    };
  }, [hash, mediaType, fetcher, unavailableAfterMs]);

  // Only surface state that belongs to the current hash, so a hash change shows
  // loading (not the previous image) until the new blob resolves.
  return resolved !== null && resolved.hash === hash
    ? resolved.state
    : { status: "loading", url: null };
}
