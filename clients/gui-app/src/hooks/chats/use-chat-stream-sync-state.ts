import { useCallback, useSyncExternalStore } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";

/** The two facts the stream-syncing strip needs about one chat's stream. */
export interface ChatStreamSyncState {
  readonly status: StreamConnectionStatus;
  /** `snapshotLoaded`: a transcript is on screen and may now be behind. */
  readonly hasContent: boolean;
}

/**
 * A chat's own stream status, read by a surface that is NOT the one holding the
 * session handle - the phone's tile bar, which knows a tile ref and nothing
 * else. `chat-tile.tsx` owns the handle through `useChatSessionHandle`; this
 * only peeks an already-open one.
 *
 * Composed the same way as `useExistingChatSessionFatalClose`, and for the same
 * reason: the registry's subscription fires on MEMBERSHIP changes (a session
 * for this pair appearing or going away), never on state moving inside an
 * existing session - so a second subscription over the handle's own store is
 * what observes the status transition this hook exists to report.
 *
 * The two reads are separate `useSyncExternalStore` calls returning primitives,
 * deliberately: one call returning `{ status, hasContent }` would mint a new
 * object on every snapshot read and loop.
 *
 * No session is `closed`, not `connecting`. A tile whose chat has no open
 * session is not "coming back" - there is nothing on screen going stale, and a
 * strip claiming otherwise would animate over a surface with no stream at all.
 */
export function useChatStreamSyncState(
  epicId: string,
  chatId: string,
  hostId: string | null,
): ChatStreamSyncState {
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    [handle],
  );
  const readStatus = useCallback(
    (): StreamConnectionStatus =>
      handle?.store.getState().connectionStatus ?? "closed",
    [handle],
  );
  const readHasContent = useCallback(
    (): boolean => handle?.store.getState().snapshotLoaded ?? false,
    [handle],
  );
  const status = useSyncExternalStore(subscribe, readStatus, readClosed);
  const hasContent = useSyncExternalStore(subscribe, readHasContent, readFalse);
  return { status, hasContent };
}

function readClosed(): StreamConnectionStatus {
  return "closed";
}

function readFalse(): boolean {
  return false;
}
