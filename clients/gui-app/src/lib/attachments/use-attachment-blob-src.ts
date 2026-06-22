import { useCallback } from "react";

import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrl } from "@/lib/attachments/use-image-blob-url";

/**
 * The epic-doc byte source for image attachments: streams a hash's bytes from
 * the open epic's attachments map. Referentially stable per handle, so it can be
 * fed to `useImageBlobUrl` / `AttachmentStrip` without re-acquiring on render.
 */
export function useEpicImageFetcher(): ImageBytesFetcher {
  const handle = useMaybeOpenEpicHandle();
  return useCallback<ImageBytesFetcher>(
    async (h, signal) => {
      if (handle === null) {
        throw new Error("No open-epic handle to fetch image attachment");
      }
      const bytes = await handle.store
        .getState()
        .readAttachmentBytes(h, signal);
      if (bytes === null) {
        throw new Error(`Image attachment ${h} unavailable`);
      }
      return new Uint8Array(bytes);
    },
    [handle],
  );
}

/**
 * Resolves an image attachment's `src`: persisted images (`hash`) stream their
 * bytes from the epic doc's attachments map into a shared blob URL via the
 * content-addressed cache; draft/optimistic images use their inline `dataUrl`.
 * Returns null while a persisted image's blob is still loading. Used by the
 * sent-message renderer (the composer chip resolves images via the strip's
 * injected fetcher instead).
 */
export function useAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): string | null {
  const fetcher = useEpicImageFetcher();
  const blobUrl = useImageBlobUrl(hash, mediaType, fetcher);
  return hash !== null ? blobUrl : dataUrl;
}
