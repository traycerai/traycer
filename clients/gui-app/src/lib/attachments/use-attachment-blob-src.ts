import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useEpicSnapshotLoaded } from "@/lib/epic-selectors";
import {
  type ImageBytesFetcher,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
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
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

export type AttachmentBlobSrcState =
  | { readonly status: "loading"; readonly src: null }
  | { readonly status: "unavailable"; readonly src: null }
  | {
      readonly status: "ready";
      readonly src: string;
      /**
       * What `src` actually IS, as opposed to what the message model claimed.
       * For a resolved hash this is the blob's real type - the serving host sniffs chat-attachment bytes and its verdict is authoritative - and for an inline `dataUrl` it is the declared type, which is also the type encoded in the URL itself.
       */
      readonly mediaType: string;
    };

/**
 * Host BUILDS that have answered `E_HOST_UNSUPPORTED` for `epic.fetchArtifactAttachment`, keyed on the `(hostId, version)` pair.
 */
const hostBuildsWithoutArtifactAttachmentFetch = new Set<string>();

/**
 * Test-only: forgets every remembered `E_HOST_UNSUPPORTED` verdict.
 * The set is module-global and deliberately session-lived, so a suite that exercises the unsupported path would otherwise poison every later test in the same file.
 */
export function resetArtifactAttachmentHostSupportForTests(): void {
  hostBuildsWithoutArtifactAttachmentFetch.clear();
}

/**
 * The key a verdict is remembered under, or `null` when it must not be remembered at all - an unresolved version would collapse every unknown into one bucket and let a single probe pin a permanent negative no upgrade clears.
 */
function artifactHostBuildKey(
  scope: ArtifactAttachmentScopeValue,
): string | null {
  if (scope.hostVersion === null) return null;
  // JSON-encoded, not newline-joined.
  // The previous comment here asserted that "a host id never contains one" - an assumption about a value that crosses the wire as an unconstrained string, and it says nothing about `hostVersion` at all.
  return JSON.stringify([scope.hostId, scope.hostVersion]);
}

/** The lane-arm leg: ask this artifact's host for one attachment's bytes. */
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

/** The byte source for image attachments rendered inside an ARTIFACT body. */
export function useEpicImageFetcher(): ScopedImageBytesFetcher {
  const handle = useMaybeOpenEpicHandle();
  const scope = useArtifactAttachmentScope();
  // SUBSCRIBED, not read imperatively at call time.
  // The arm decides which of the two legs below runs, and the legacy leg's contract is to WAIT - so an in-place host upgrade that swaps `@1` for `lanes` mid-read leaves that wait parked on a root-document attachments map the lane arm never seeds.
  const installedArm = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        handle === null ? () => {} : handle.store.subscribe(onStoreChange),
      [handle],
    ),
    useCallback(() => handle?.store.getState().installedArm ?? null, [handle]),
  );
  // One controller per arm GENERATION.
  // Identity alone does not free a parked read: `imageBlobCache` entries are keyed by subject AND hash, neither of which an arm change moves, so later acquirers still reuse the first in-flight fetch - a new fetcher would attach to the same stuck promise, and.
  const armGeneration = useMemo(
    // The arm is IN the value, not only in the dependency list: a memo whose body ignores its own dep reads to the exhaustive-deps rule as an unnecessary dependency, and the dep is the entire point here.
    () => ({ arm: installedArm, abort: new AbortController() }),
    [installedArm],
  );
  useEffect(
    () => () => {
      armGeneration.abort.abort();
    },
    [armGeneration],
  );
  const fetch = useCallback<ImageBytesFetcher>(
    async (h, callerSignal) => {
      if (handle === null) {
        throw new Error("No open-epic handle to fetch image attachment");
      }
      const composed = signalUntilArmChanges(
        callerSignal,
        armGeneration.abort.signal,
      );
      try {
        const signal = composed.signal;
        if (installedArm === "lanes") {
          const fromHost = await readArtifactAttachmentFromHost(
            scope,
            h,
            signal,
          );
          if (fromHost !== null) return fromHost;
          const held = await readHeldEpicAttachmentBytes(handle, h);
          if (held === null) {
            throw new Error(`Image attachment ${h} unavailable`);
          }
          return { bytes: new Uint8Array(held), mediaType: null };
        }
        // Through the replica-read seam rather than the store directly: this is one of the byte reads that resolves against the worker-held root replica once the runtime moves, and the seam is where that swap happens.
        const bytes = await readEpicAttachmentBytes(handle, h, signal);
        if (bytes === null) {
          throw new Error(`Image attachment ${h} unavailable`);
        }
        // The doc replica stores raw bytes with no sniffed header of its own,
        // so it has no verdict to offer and the caller's declared type stands.
        return { bytes: new Uint8Array(bytes), mediaType: null };
      } finally {
        // On EVERY path, resolve included.
        // The arm signal outlives this fetch by design and is shared by every image in the epic, so a listener left behind by a fetch that simply succeeded is retained until the arm next changes - one per thumbnail the user scrolled past.
        composed.clear();
      }
    },
    [handle, scope, installedArm, armGeneration],
  );
  return useMemo<ScopedImageBytesFetcher>(
    () => ({ scopeKey: epicAttachmentScopeKey(handle, scope), fetch }),
    [handle, scope, fetch],
  );
}

/** What an artifact-plane byte read is authorized against, as a cache subject. */
function epicAttachmentScopeKey(
  handle: OpenEpicStoreHandle | null,
  scope: ArtifactAttachmentScopeValue | null,
): string {
  return JSON.stringify([
    "epic-attachment",
    scope?.hostId ?? "",
    scope?.epicId ?? handle?.epicId ?? "",
    scope?.artifactId ?? "",
  ]);
}

/** A signal that fires when EITHER the caller's does or the arm generation ends. */
interface ArmScopedAbort {
  readonly signal: AbortSignal;
  /** Call once the fetch settles, on every path including failure. */
  readonly clear: () => void;
}

function signalUntilArmChanges(
  callerSignal: AbortSignal,
  armSignal: AbortSignal,
): ArmScopedAbort {
  const noop = (): void => {};
  if (armSignal.aborted) return { signal: armSignal, clear: noop };
  if (callerSignal.aborted) return { signal: callerSignal, clear: noop };
  const controller = new AbortController();
  const detach = (): void => {
    callerSignal.removeEventListener("abort", forward);
    armSignal.removeEventListener("abort", forward);
  };
  const forward = (): void => {
    detach();
    controller.abort();
  };
  callerSignal.addEventListener("abort", forward);
  armSignal.addEventListener("abort", forward);
  return { signal: controller.signal, clear: detach };
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
 * Resolves an ARTIFACT image attachment's `src`: persisted images (`hash`) stream their bytes from the epic doc's attachments map into a shared blob URL via the content-addressed cache; draft/optimistic images use their inline `dataUrl`.
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
 * The same resolution, for an image rendered inside a CHAT: bytes come off the chat plane (`epic.readChatAttachment` on the tile's host) with the epic doc as the legacy fallback.
 * The chat scope comes from `ChatAttachmentScopeContext`; see `use-chat-image-fetcher.ts` for the chain and why the chat id is part of it.
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
  fetcher: ScopedImageBytesFetcher,
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
