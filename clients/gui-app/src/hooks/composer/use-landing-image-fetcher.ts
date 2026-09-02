import { useMemo } from "react";

import { type ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
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
export function useLandingImageFetcher(): ScopedImageBytesFetcher {
  return useMemo<ScopedImageBytesFetcher>(
    () => ({
      // The one byte source here that is genuinely unscoped: the landing store
      // is per-runtime IndexedDB on this device, with no epic, chat or host to
      // prove access to. It still needs its OWN namespace rather than sharing
      // the bare-hash one, because a flat namespace lets a landing hash and an
      // epic hash resolve each other's bytes - the same disclosure as the two
      // scoped sources, arriving through a source that has no check to skip.
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
