import { useMemo } from "react";

import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { getImageBytes } from "@/lib/composer/landing-image-store";

/**
 * Byte source for the landing composer's hash-only image chips: the per-runtime
 * IndexedDB store (with its session cache in front), NOT the epic Y.Doc. Used by
 * the shared `AttachmentStrip` only for RESTORED drafts — a same-session paste
 * resolves synchronously via `sessionObjectUrl` and never reaches the fetcher.
 *
 * Throws when a hash has no bytes (manual wipe of a restored draft) so the blob
 * cache drops the poisoned entry and a later acquire retries instead of caching
 * a failure. Referentially stable (no deps) so it never churns the blob cache.
 */
export function useLandingImageFetcher(): ImageBytesFetcher {
  return useMemo<ImageBytesFetcher>(
    () => async (hash) => {
      const bytes = await getImageBytes(hash);
      if (bytes === undefined) {
        throw new Error(`Landing image ${hash} unavailable`);
      }
      return bytes;
    },
    [],
  );
}
