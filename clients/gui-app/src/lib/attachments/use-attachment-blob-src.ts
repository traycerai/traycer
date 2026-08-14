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
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";

export type AttachmentBlobSrcState =
  | { readonly status: "loading"; readonly src: null }
  | { readonly status: "unavailable"; readonly src: null }
  | {
      readonly status: "ready";
      readonly src: string;
      /**
       * What `src` actually IS, as opposed to what the message model claimed.
       * For a resolved hash this is the blob's real type - the serving host
       * sniffs chat-attachment bytes and its verdict is authoritative - and
       * for an inline `dataUrl` it is the declared type, which is also the
       * type encoded in the URL itself. Render sites that gate on format
       * (SVG sanitization) must branch on this, never on the stored claim.
       */
      readonly mediaType: string;
    };

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
      // The doc replica stores raw bytes with no sniffed header of its own, so
      // it has no verdict to offer and the caller's declared type stands.
      return { bytes: new Uint8Array(bytes), mediaType: null };
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
 * Resolves an ARTIFACT image attachment's `src`: persisted images (`hash`)
 * stream their bytes from the epic doc's attachments map into a shared blob URL
 * via the content-addressed cache; draft/optimistic images use their inline
 * `dataUrl`. Persisted images become unavailable after the sync grace window,
 * but the underlying acquisition remains recoverable when bytes arrive later.
 *
 * Artifact-referenced images stay doc-resident by design - an artifact is
 * epic-shared by nature, so doc replication IS its access model - which is why
 * this keeps the epic byte source while every CHAT render site moved to
 * `useChatAttachmentBlobSrc` below.
 */
export function useAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): AttachmentBlobSrcState {
  const fetcher = useEpicImageFetcher();
  return useResolvedAttachmentBlobSrc(hash, mediaType, dataUrl, fetcher);
}

/**
 * The same resolution, for an image rendered inside a CHAT: bytes come off the
 * chat plane (`epic.readChatAttachment` on the tile's host) with the epic doc
 * as the legacy fallback. The chat scope comes from
 * `ChatAttachmentScopeContext`; see `use-chat-image-fetcher.ts` for the chain
 * and why the chat id is part of it. Outside a chat tile there is no scope, and
 * this degrades to the doc-replica read those surfaces already used.
 */
export function useChatAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): AttachmentBlobSrcState {
  const fetcher = useChatImageFetcher();
  return useResolvedAttachmentBlobSrc(hash, mediaType, dataUrl, fetcher);
}

function useResolvedAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
  fetcher: ImageBytesFetcher,
): AttachmentBlobSrcState {
  const blob = useImageBlobUrlState(
    hash,
    mediaType,
    fetcher,
    IMAGE_UNAVAILABLE_GRACE_MS,
  );
  if (hash !== null) {
    return blob.status === "ready"
      ? { status: "ready", src: blob.url, mediaType: blob.mediaType }
      : { status: blob.status, src: null };
  }
  return dataUrl === null
    ? { status: "unavailable", src: null }
    : { status: "ready", src: dataUrl, mediaType };
}
