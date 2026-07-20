import { useCallback } from "react";

import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useEpicSnapshotLoaded } from "@/lib/epic-selectors";
import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import {
  IMAGE_UNAVAILABLE_GRACE_MS,
  useImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";

export type AttachmentBlobSrcState =
  | { readonly status: "loading"; readonly src: null }
  | { readonly status: "unavailable"; readonly src: null }
  | { readonly status: "ready"; readonly src: string };

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

/** Synchronously checks the currently-open epic's local attachment replica. */
export function useEpicAttachmentBytesPresence():
  ((hash: string) => boolean) | null {
  const handle = useOpenEpicHandle();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const hasAttachmentBytes = useCallback(
    (hash: string) => handle.store.getState().hasAttachmentBytes(hash),
    [handle],
  );
  return snapshotLoaded ? hasAttachmentBytes : null;
}

/**
 * Resolves an image attachment's `src`: persisted images (`hash`) stream their
 * bytes from the epic doc's attachments map into a shared blob URL via the
 * content-addressed cache; draft/optimistic images use their inline `dataUrl`.
 * Persisted images become unavailable after the sync grace window, but the
 * underlying acquisition remains recoverable when bytes arrive later. Used by
 * the sent-message renderer (the composer chip resolves images via the strip's
 * injected fetcher instead).
 */
export function useAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): AttachmentBlobSrcState {
  const fetcher = useEpicImageFetcher();
  const blob = useImageBlobUrlState(
    hash,
    mediaType,
    fetcher,
    IMAGE_UNAVAILABLE_GRACE_MS,
  );
  if (hash !== null) {
    return blob.status === "ready"
      ? { status: "ready", src: blob.url }
      : { status: blob.status, src: null };
  }
  return dataUrl === null
    ? { status: "unavailable", src: null }
    : { status: "ready", src: dataUrl };
}
