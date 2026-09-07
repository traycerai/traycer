import { useCallback, useMemo } from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import {
  useChatAttachmentScope,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import type {
  ImageBytesFetcher,
  ImageBytesResult,
  ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { readHeldEpicAttachmentBytes } from "@/lib/epic-replica-reads";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * How long a one-shot byte read (clipboard re-inline, prompt stash) waits before giving up and treating the image as unresolvable.
 */
export const CHAT_ATTACHMENT_READ_TIMEOUT_MS = 8_000;

/**
 * Host BUILDS that have answered `E_HOST_UNSUPPORTED` for `epic.readChatAttachment`, keyed on the `(hostId, version)` pair.
 */
const hostBuildsWithoutChatAttachmentRead = new Set<string>();

/** The key a verdict is remembered under, or `null` when it must not be remembered at all. */
function hostBuildKey(scope: ChatAttachmentScopeValue): string | null {
  if (scope.hostVersion === null) return null;
  // JSON-encoded, not newline-joined.
  // The previous comment here asserted that "a host id never contains one" - an assumption about a value that crosses the wire as an unconstrained string, and it says nothing about `hostVersion` at all.
  return JSON.stringify([scope.hostId, scope.hostVersion]);
}

/**
 * Test-only: forgets every remembered `E_HOST_UNSUPPORTED` verdict.
 * The set is module-global and deliberately session-lived, so a suite that exercises the unsupported path would otherwise poison every later test in the same file.
 */
export function resetChatAttachmentHostSupportForTests(): void {
  hostBuildsWithoutChatAttachmentRead.clear();
}

function isHostUnsupported(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/** The chat-plane leg: ask this tile's host for one attachment's bytes. */
async function readChatAttachmentFromHost(
  scope: ChatAttachmentScopeValue | null,
  hash: string,
  signal: AbortSignal,
): Promise<ImageBytesResult | null> {
  if (scope === null || scope.client === null) return null;
  const buildKey = hostBuildKey(scope);
  if (buildKey !== null && hostBuildsWithoutChatAttachmentRead.has(buildKey)) {
    return null;
  }
  try {
    const response = await scope.client.requestWithSignal(
      "epic.readChatAttachment",
      { epicId: scope.epicId, chatId: scope.chatId, hash },
      signal,
    );
    if (!response.ok) return null;
    const bytes = base64ToBytes(response.bytesBase64);
    if (bytes === null) {
      // A malformed base64 body is a wire bug, not an absent image: throwing keeps it retryable and keeps it OUT of the "stored on the originating device" marker, which would report a transport fault as a data loss.
      throw new Error(`Chat attachment ${hash} had an undecodable body`);
    }
    return { bytes, mediaType: response.mediaType };
  } catch (error: unknown) {
    if (isHostUnsupported(error)) {
      if (buildKey !== null) {
        hostBuildsWithoutChatAttachmentRead.add(buildKey);
      }
      return null;
    }
    throw error;
  }
}

/** The legacy leg: the epic Y.Doc's content-addressed `attachments` map. */
async function readAttachmentFromEpicDoc(
  handle: OpenEpicStoreHandle | null,
  hash: string,
): Promise<ImageBytesResult | null> {
  if (handle === null) return null;
  // Through the replica-read seam, in its non-waiting variant - the same guarded read this leg always did, now expressed as one contract that survives the replica moving into the runtime worker.
  const bytes = await readHeldEpicAttachmentBytes(handle, hash);
  return bytes === null
    ? null
    : { bytes: new Uint8Array(bytes), mediaType: null };
}

/** The byte source for images rendered INSIDE a chat. */
export function useChatImageFetcher(): ScopedImageBytesFetcher {
  const scope = useChatAttachmentScope();
  const handle = useMaybeOpenEpicHandle();
  const fetch = useCallback<ImageBytesFetcher>(
    async (hash, signal) => {
      const fromChatPlane = await readChatAttachmentFromHost(
        scope,
        hash,
        signal,
      );
      if (fromChatPlane !== null) return fromChatPlane;
      const fromDoc = await readAttachmentFromEpicDoc(handle, hash);
      if (fromDoc !== null) return fromDoc;
      throw new Error(`Image attachment ${hash} unavailable`);
    },
    [scope, handle],
  );
  return useMemo<ScopedImageBytesFetcher>(
    () => ({ scopeKey: chatAttachmentScopeKey(handle, scope), fetch }),
    [handle, scope, fetch],
  );
}

/** What a chat-plane byte read is authorized against, as a cache subject. */
function chatAttachmentScopeKey(
  handle: OpenEpicStoreHandle | null,
  scope: ChatAttachmentScopeValue | null,
): string {
  return JSON.stringify([
    "chat-attachment",
    scope?.hostId ?? "",
    scope?.epicId ?? handle?.epicId ?? "",
    scope?.chatId ?? "",
  ]);
}

export type ChatAttachmentByteReader = (
  hash: string,
) => Promise<ImageBytes | null>;

/**
 * The same resolution chain as `useChatImageFetcher`, as a one-shot read that answers `null` instead of throwing and gives up after `CHAT_ATTACHMENT_READ_TIMEOUT_MS`.
 */
export function useChatAttachmentByteReader(): ChatAttachmentByteReader {
  const fetcher = useChatImageFetcher();
  return useCallback<ChatAttachmentByteReader>(
    async (hash) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        CHAT_ATTACHMENT_READ_TIMEOUT_MS,
      );
      try {
        // `.fetch` directly: this read never touches `imageBlobCache` (see the
        // doc comment), so it needs the byte source, not the cache subject.
        return (await fetcher.fetch(hash, controller.signal)).bytes;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    [fetcher],
  );
}
