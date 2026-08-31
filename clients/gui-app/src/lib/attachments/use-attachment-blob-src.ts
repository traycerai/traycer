import { useCallback } from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useEpicSnapshotLoaded } from "@/lib/epic-selectors";
import {
  type ImageBytesFetcher,
  type ImageBytesResult,
} from "@/lib/attachments/image-blob-cache";
import {
  IMAGE_UNAVAILABLE_GRACE_MS,
  useImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import {
  useArtifactAttachmentScope,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";
import { base64ToBytes } from "@/lib/composer/image-base64";
import {
  readEpicAttachmentBytes,
  readHeldEpicAttachmentBytes,
} from "@/lib/epic-replica-reads";

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
 * Host BUILDS that have answered `E_HOST_UNSUPPORTED` for
 * `epic.fetchArtifactAttachment`, keyed on the `(hostId, version)` pair.
 *
 * The method is optional rather than floor, so a lane-capable host can still
 * predate it. Per build and not per image, for the reason the chat set spells
 * out: the answer is a property of the host binary's negotiated method set, and
 * re-deriving it per thumbnail would rebuild the same rejection to re-learn a
 * constant. The VERSION is in the key because a host can be upgraded in place
 * under the same id with no renderer reload; keyed on the id alone that upgrade
 * would stay degraded for the session.
 */
const hostBuildsWithoutArtifactAttachmentFetch = new Set<string>();

/**
 * Test-only: forgets every remembered `E_HOST_UNSUPPORTED` verdict. The set is
 * module-global and deliberately session-lived, so a suite that exercises the
 * unsupported path would otherwise poison every later test in the same file.
 */
export function resetArtifactAttachmentHostSupportForTests(): void {
  hostBuildsWithoutArtifactAttachmentFetch.clear();
}

/**
 * The key a verdict is remembered under, or `null` when it must not be
 * remembered at all - an unresolved version would collapse every unknown into
 * one bucket and let a single probe pin a permanent negative no upgrade clears.
 */
function artifactHostBuildKey(
  scope: ArtifactAttachmentScopeValue,
): string | null {
  if (scope.hostVersion === null) return null;
  // Newline-separated: a host id never contains one, so no two distinct pairs
  // can collide on a single key.
  return `${scope.hostId}\n${scope.hostVersion}`;
}

/**
 * The lane-arm leg: ask this artifact's host for one attachment's bytes.
 *
 * `null` for every "not obtainable here" answer - the host said `missing`, the
 * host predates the method, or there is no artifact scope / no reachable host -
 * so the caller can fall through. It THROWS for transient failures, which keeps
 * the image blob cache's retry ladder alive for bytes that are one publish
 * away.
 *
 * The response's `mediaType` rides along because it is host-authoritative,
 * derived from the delivered bytes' magic bytes rather than echoed from the
 * document-authored claim - and the SVG sanitization gate downstream keys on
 * whichever one reaches it.
 */
async function readArtifactAttachmentFromHost(
  scope: ArtifactAttachmentScopeValue | null,
  hash: string,
  signal: AbortSignal,
): Promise<ImageBytesResult | null> {
  if (scope === null || scope.client === null) return null;
  const buildKey = artifactHostBuildKey(scope);
  if (
    buildKey !== null &&
    hostBuildsWithoutArtifactAttachmentFetch.has(buildKey)
  ) {
    return null;
  }
  try {
    const response = await scope.client.requestWithSignal(
      "epic.fetchArtifactAttachment",
      { epicId: scope.epicId, artifactId: scope.artifactId, hash },
      signal,
    );
    if (!response.ok) return null;
    const bytes = base64ToBytes(response.bytesBase64);
    if (bytes === null) {
      // A malformed base64 body is a wire bug, not an absent image: throwing
      // keeps it retryable rather than caching a permanent unavailable.
      throw new Error(`Artifact attachment ${hash} had an undecodable body`);
    }
    return { bytes, mediaType: response.mediaType };
  } catch (error: unknown) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED") {
      if (buildKey !== null) {
        hostBuildsWithoutArtifactAttachmentFetch.add(buildKey);
      }
      return null;
    }
    throw error;
  }
}

/**
 * The byte source for image attachments rendered inside an ARTIFACT body.
 *
 * Two legs, selected by the installed ARM rather than by trying both, because
 * the legacy leg's contract is a WAITING read and waiting is only correct where
 * the bytes can actually arrive:
 *
 * 1. **Lane arm** - `epic.fetchArtifactAttachment` on the artifact's host. Only
 *    the `@1` adapter ever emits on the root plane, so a lane-backed session's
 *    `attachments` map is never seeded and the waiting read below would park
 *    for the life of the session while the image rendered "unavailable". The
 *    host still holds these bytes canonically in the root document, which is
 *    the case this unary was added for. With no scope or a host that predates
 *    the method it falls back to whatever the replica already HOLDS - the
 *    non-waiting read, so an absent hash fails fast and stays retryable rather
 *    than parking on bytes no lane will deliver.
 * 2. **`@1`** - the waiting doc read, unchanged. An artifact is epic-shared by
 *    nature, so doc replication IS its access model there, and an image whose
 *    bytes are still replicating must resolve when they land rather than read
 *    as missing. Deliberately NOT routed through the host: this leg is
 *    byte-for-byte what every legacy session already did.
 *
 * Referentially stable per (handle, scope) so it can be fed to
 * `useImageBlobUrl` / `AttachmentStrip` without re-acquiring on render.
 */
export function useEpicImageFetcher(): ImageBytesFetcher {
  const handle = useMaybeOpenEpicHandle();
  const scope = useArtifactAttachmentScope();
  return useCallback<ImageBytesFetcher>(
    async (h, signal) => {
      if (handle === null) {
        throw new Error("No open-epic handle to fetch image attachment");
      }
      if (handle.store.getState().installedArm === "lanes") {
        const fromHost = await readArtifactAttachmentFromHost(scope, h, signal);
        if (fromHost !== null) return fromHost;
        const held = await readHeldEpicAttachmentBytes(handle, h);
        if (held === null) {
          throw new Error(`Image attachment ${h} unavailable`);
        }
        return { bytes: new Uint8Array(held), mediaType: null };
      }
      // Through the replica-read seam rather than the store directly: this is
      // one of the byte reads that resolves against the worker-held root
      // replica once the runtime moves, and the seam is where that swap
      // happens. The WAITING variant deliberately - an artifact image whose
      // bytes are still replicating must resolve when they land, not read as
      // missing (see the seam for why the chat leg takes the other one).
      const bytes = await readEpicAttachmentBytes(handle, h, signal);
      if (bytes === null) {
        throw new Error(`Image attachment ${h} unavailable`);
      }
      // The doc replica stores raw bytes with no sniffed header of its own, so
      // it has no verdict to offer and the caller's declared type stands.
      return { bytes: new Uint8Array(bytes), mediaType: null };
    },
    [handle, scope],
  );
}

/** Synchronously checks the currently-open epic's local attachment replica. */
export function useEpicAttachmentBytesPresence():
  | ((hash: string) => boolean)
  | null {
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
