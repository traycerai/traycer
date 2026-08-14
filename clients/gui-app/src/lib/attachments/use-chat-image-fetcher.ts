import { useCallback } from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import {
  useChatAttachmentScope,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import type { ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { base64ToBytes } from "@/lib/composer/image-base64";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/** A view guaranteed to be backed by a plain `ArrayBuffer` (not shared). */
type ImageBytes = Uint8Array<ArrayBuffer>;

/**
 * How long a one-shot byte read (clipboard re-inline, prompt stash) waits before
 * giving up and treating the image as unresolvable.
 *
 * These two callers are not renderers: nothing paints while they run, and both
 * have a defined "couldn't get it" behavior (drop the image from the clipboard
 * write / fail the stash save). An unbounded wait would hang a Cmd+C instead,
 * which is what the old `hasAttachmentBytes` pre-check existed to avoid - the
 * bound replaces that pre-check rather than being added on top of it.
 */
export const CHAT_ATTACHMENT_READ_TIMEOUT_MS = 8_000;

/**
 * Hosts that have answered `E_HOST_UNSUPPORTED` for `epic.readChatAttachment`.
 *
 * Per host, not per image, and remembered for the session: the answer is a
 * property of the host BUILD, so re-probing it once per image would spend a
 * round trip per thumbnail to re-learn a constant. A host in this set falls
 * straight through to the epic doc-replica read - which is that host's only
 * byte source, so the "degraded" path is exactly its current behavior.
 */
const hostsWithoutChatAttachmentRead = new Set<string>();

/**
 * Test-only: forgets every remembered `E_HOST_UNSUPPORTED` verdict. The set is
 * module-global and deliberately session-lived, so a suite that exercises the
 * unsupported path would otherwise poison every later test in the same file.
 */
export function resetChatAttachmentHostSupportForTests(): void {
  hostsWithoutChatAttachmentRead.clear();
}

function isHostUnsupported(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/**
 * The chat-plane leg: ask this tile's host for one attachment's bytes.
 *
 * Returns `null` for every "these bytes are not obtainable here" answer - the
 * host said `missing`, the host predates the method, or there is no chat scope /
 * no reachable host - so the caller can fall through to the doc replica. It
 * THROWS for transient failures, which is what keeps the image blob cache's
 * retry ladder alive for a blob that is one publish away.
 */
async function readChatAttachmentFromHost(
  scope: ChatAttachmentScopeValue | null,
  hash: string,
  signal: AbortSignal,
): Promise<ImageBytes | null> {
  if (scope === null || scope.client === null) return null;
  if (hostsWithoutChatAttachmentRead.has(scope.hostId)) return null;
  try {
    const response = await scope.client.requestWithSignal(
      "epic.readChatAttachment",
      { epicId: scope.epicId, chatId: scope.chatId, hash },
      signal,
    );
    if (!response.ok) return null;
    const bytes = base64ToBytes(response.bytesBase64);
    if (bytes === null) {
      // A malformed base64 body is a wire bug, not an absent image: throwing
      // keeps it retryable and keeps it OUT of the "stored on the originating
      // device" marker, which would report a transport fault as a data loss.
      throw new Error(`Chat attachment ${hash} had an undecodable body`);
    }
    return bytes;
  } catch (error: unknown) {
    if (isHostUnsupported(error)) {
      hostsWithoutChatAttachmentRead.add(scope.hostId);
      return null;
    }
    throw error;
  }
}

/**
 * The legacy leg: the epic Y.Doc's content-addressed `attachments` map.
 *
 * Guarded by `hasAttachmentBytes`, and the guard is not optional.
 * `readAttachmentBytes` waits INDEFINITELY for a hash the local replica does
 * not hold - it is built for a doc-resident image that is still syncing - so
 * calling it unguarded here would park the chain forever on exactly the case
 * the chat-plane leg above is supposed to own, and the blob cache would never
 * retry the leg that could actually succeed.
 */
async function readAttachmentFromEpicDoc(
  handle: OpenEpicStoreHandle | null,
  hash: string,
  signal: AbortSignal,
): Promise<ImageBytes | null> {
  if (handle === null) return null;
  const state = handle.store.getState();
  if (!state.hasAttachmentBytes(hash)) return null;
  const bytes = await state.readAttachmentBytes(hash, signal);
  return bytes === null ? null : new Uint8Array(bytes);
}

/**
 * The byte source for images rendered INSIDE a chat.
 *
 * Resolution order, and each leg is here for a different era of the same image:
 *
 * 1. `imageBlobCache` - not in this function. The cache wraps the fetcher
 *    (`use-image-blob-url.ts`), so a hash already resolved anywhere in the app
 *    never reaches this code at all.
 * 2. `epic.readChatAttachment` on the tile's host - the chat plane, where chat
 *    image bytes now live. That host serves it from its own per-epic disk store
 *    when it has the file, else as a bearer pass-through to the blob the owning
 *    host published, where the server applies the chat's ACL.
 * 3. The epic doc's `attachments` map - legacy hashes written before the move,
 *    and artifact-plane hashes that a chat message happens to reference. Behind
 *    a presence check; see `readAttachmentFromEpicDoc`.
 *
 * With no chat scope (a chat-shaped surface rendered outside a tile) leg 2 is
 * skipped, which is exactly where those surfaces already were.
 *
 * Referentially stable per (scope, epic handle) so it can be handed to
 * `useImageBlobUrl` / `AttachmentStrip` without re-acquiring every render.
 */
export function useChatImageFetcher(): ImageBytesFetcher {
  const scope = useChatAttachmentScope();
  const handle = useMaybeOpenEpicHandle();
  return useCallback<ImageBytesFetcher>(
    async (hash, signal) => {
      const fromChatPlane = await readChatAttachmentFromHost(
        scope,
        hash,
        signal,
      );
      if (fromChatPlane !== null) return fromChatPlane;
      const fromDoc = await readAttachmentFromEpicDoc(handle, hash, signal);
      if (fromDoc !== null) return fromDoc;
      throw new Error(`Image attachment ${hash} unavailable`);
    },
    [scope, handle],
  );
}

export type ChatAttachmentByteReader = (
  hash: string,
) => Promise<ImageBytes | null>;

/**
 * The same resolution chain as `useChatImageFetcher`, as a one-shot read that
 * answers `null` instead of throwing and gives up after
 * `CHAT_ATTACHMENT_READ_TIMEOUT_MS`.
 *
 * For the two non-rendering consumers - the clipboard re-inline on a copied
 * user message and the prompt stash's hash resolution. Both used to pre-check
 * `hasAttachmentBytes` and read the doc directly; both now go through the host,
 * so both need a bound instead of a pre-check. `null` keeps their existing skip
 * behavior verbatim: the clipboard write leaves the image as a bare hash, and
 * the stash reports the image as unavailable.
 *
 * Deliberately NOT routed through `imageBlobCache`: that cache hands back a
 * blob URL, not bytes, and its entries are reference-counted against mounted
 * renderers. A copy is neither.
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
        return await fetcher(hash, controller.signal);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    [fetcher],
  );
}
