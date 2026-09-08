import { useCallback, useEffect, useSyncExternalStore } from "react";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  clearHostOlderThanDataRefusal,
  hostRefusesEpicStore,
  recordHostOlderThanDataRefusal,
  subscribeHostOlderThanDataRefusal,
} from "@/lib/chats/host-older-than-data-refusals";

/**
 * Whether `hostId`, as the build the directory currently reports, is known to
 * refuse `epicId`'s chat store (`HOST_OLDER_THAN_DATA`).
 *
 * The open-decision half of `host-older-than-data-refusals.ts`: read by the
 * surfaces that mint a chat's tile ref so a chat on a reachable-but-too-old
 * host opens its published copy the way an unreachable owner's does. Reads
 * the directory's version for the host so an in-place upgrade, which keeps
 * the `hostId`, retires the verdict on its own.
 *
 * ## Why it reads the shared connection registry and not a directory hook
 *
 * Every sidebar row calls this, and the row suites hold that a row is cheap
 * and self-contained: one stands up no `<HostRuntimeProvider>` (which the
 * per-host directory hook requires) and another stubs the host binding away
 * (which the list query requires). The shared registry's row read is the one
 * source that needs neither - it answers through whatever source the runtime
 * installed, `null` when there is none - and `subscribeHostRowChanged` is its
 * per-host arm, so this read wakes for its own host's row and no other's.
 *
 * Both subscriptions are keyed to this row's own pair, the snapshot is a
 * primitive, and nothing is allocated per render, which is what keeps an
 * untouched row still when some other epic's verdict moves.
 *
 * `null` host answers `false`: a chat with no persisted owner has no host to
 * have refused anything, and the predicate downstream already keeps such rows
 * on the live fallback.
 */
export function useHostRefusesEpicStore(
  hostId: string | null,
  epicId: string,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (hostId === null) return () => undefined;
      const unsubscribeRefusal = subscribeHostOlderThanDataRefusal(
        hostId,
        epicId,
        listener,
      );
      const unsubscribeRow = subscribeHostRowChanged(hostId, listener);
      return () => {
        unsubscribeRefusal();
        unsubscribeRow();
      };
    },
    [hostId, epicId],
  );
  const getSnapshot = useCallback(
    () =>
      hostId === null
        ? false
        : hostRefusesEpicStore({
            hostId,
            epicId,
            hostVersion: readHostDirectoryEntry(hostId)?.version ?? null,
          }),
    [hostId, epicId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The recording half: fold what a LIVE chat session learned about its host
 * into the registry.
 *
 * Mounted by the live chat tile, which is the only surface that ever dials
 * the store and therefore the only one that can learn the answer. A fatal
 * close carrying `HOST_OLDER_THAN_DATA` records the refusal against the build
 * the directory reports for the host; a landed snapshot clears it, because a
 * snapshot is the host proving it reads the file now.
 *
 * `hostVersion` is passed in rather than read here because the tile already
 * subscribes to its host's directory entry for the attachment scope, and a
 * second subscription to the same row would be a second render trigger for
 * one fact.
 */
export function useRecordHostOlderThanDataRefusal(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly hostVersion: string | null;
  readonly fatalCloseCode: string | null;
  readonly snapshotLoaded: boolean;
}): void {
  const { hostId, epicId, hostVersion, fatalCloseCode, snapshotLoaded } = input;
  useEffect(() => {
    if (snapshotLoaded) {
      clearHostOlderThanDataRefusal({ hostId, epicId });
      return;
    }
    if (fatalCloseCode === HOST_OLDER_THAN_DATA_FATAL_CODE) {
      recordHostOlderThanDataRefusal({
        hostId,
        epicId,
        hostVersion,
        now: Date.now(),
      });
    }
  }, [hostId, epicId, hostVersion, fatalCloseCode, snapshotLoaded]);
}
