import { useEffect, useState } from "react";

import {
  type ImageBytesFetcher,
  imageBlobCache,
} from "@/lib/attachments/image-blob-cache";

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
  const [resolved, setResolved] = useState<{
    hash: string;
    url: string;
  } | null>(null);

  useEffect(() => {
    if (hash === null) return;
    let active = true;
    imageBlobCache
      .acquire(hash, mediaType, fetcher)
      .then((url) => {
        if (active) setResolved({ hash, url });
      })
      .catch(() => {
        if (active) setResolved(null);
      });
    return () => {
      active = false;
      imageBlobCache.release(hash);
    };
  }, [hash, mediaType, fetcher]);

  // Only surface a URL that belongs to the current hash, so a hash change shows
  // nothing (not the previous image) until the new blob resolves.
  return resolved !== null && resolved.hash === hash ? resolved.url : null;
}
