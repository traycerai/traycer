import { useMemo } from "react";

import { type ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { getImageBytes } from "@/lib/composer/landing-image-store";

/**
 * Hash-only restored drafts read IndexedDB, not the epic Y.Doc. Throw on missing bytes so the blob cache does not cache a failure. Referentially stable.
 */
export function useLandingImageFetcher(): ScopedImageBytesFetcher {
  return useMemo<ScopedImageBytesFetcher>(
    () => ({
      // It still needs its OWN namespace rather than sharing the bare-hash one, because a flat namespace lets a landing hash and an epic hash resolve each other's bytes - the same disclosure as the two scoped sources, arriving through a source that has no check to skip.
      scopeKey: JSON.stringify(["landing-image"]),
      fetch: async (hash) => {
        const bytes = await getImageBytes(hash);
        if (bytes === undefined) {
          throw new Error(`Landing image ${hash} unavailable`);
        }
        // The local store keeps raw bytes with no sniffed header, so it has
        // no media-type verdict of its own and the chip's declared type
        // stands.
        return { bytes, mediaType: null };
      },
    }),
    [],
  );
}
