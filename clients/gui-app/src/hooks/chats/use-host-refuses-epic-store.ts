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
 *
 * TWO arms record, and they are not the same kind of claim:
 *
 *  - `fatalCloseCode` is the HOST'S OWN VERDICT. A host from 1.3 onward names
 *    the refusal, and there is nothing to infer.
 *  - the rest is THIS CLIENT'S INFERENCE, and it exists because the host
 *    generation this whole surface is about cannot make that statement. A
 *    shipped 1.2.0 host has no store-format check at all: a chat store written
 *    by a newer build throws `ChatStoreSchemaError` deep in its open path,
 *    which is not the one error class its chat resolver treats as fatal, so it
 *    comes back as a RETRYABLE `CHAT_OPEN_FAILED` and the transport redials
 *    forever. No fatal close ever arrives, so the arm above never fires, and
 *    the epic this refusal is meant to route around stays pointed at a host
 *    that cannot open it.
 *
 * The inference is sound because it rests on the same evidence, and reaches
 * the same remedy, as the verdict it stands in for: the load is stalled past
 * the bounded budget, the host is provably older than this app, and the host
 * ANSWERED with a chat-open failure rather than going quiet. It is retired the
 * same way too - a landed snapshot clears it, and a directory version change
 * retires it - so the update that fixes the host also ends the inference.
 *
 * `hostAnswered` is what keeps this honest. A host that is merely slow or
 * unreachable produces no close at all, and it must stay on the live retry
 * lane rather than being recorded as refusing: "we did not hear back" is not
 * evidence about the file on that disk.
 */
export function useRecordHostOlderThanDataRefusal(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly hostVersion: string | null;
  readonly fatalCloseCode: string | null;
  readonly snapshotLoaded: boolean;
  /** The bounded-budget verdict - see `useChatLoadStalled`. */
  readonly loadStalled: boolean;
  /** Whether the two app versions prove the bound host is behind this app. */
  readonly hostIsBehind: boolean;
  /**
   * The bounded code of the last retryable close, or `null` when the host has
   * closed nothing. Matched as a CODE, never against the message text.
   */
  readonly retryableCloseCode: string | null;
}): void {
  const {
    hostId,
    epicId,
    hostVersion,
    fatalCloseCode,
    snapshotLoaded,
    loadStalled,
    hostIsBehind,
    retryableCloseCode,
  } = input;
  useEffect(() => {
    if (snapshotLoaded) {
      clearHostOlderThanDataRefusal({ hostId, epicId });
      return;
    }
    const hostAnswered = retryableCloseCode === CHAT_OPEN_FAILED_CLOSE_CODE;
    const refused =
      fatalCloseCode === HOST_OLDER_THAN_DATA_FATAL_CODE ||
      (loadStalled && hostIsBehind && hostAnswered);
    if (refused) {
      recordHostOlderThanDataRefusal({
        hostId,
        epicId,
        hostVersion,
        now: Date.now(),
      });
    }
  }, [
    hostId,
    epicId,
    hostVersion,
    fatalCloseCode,
    snapshotLoaded,
    loadStalled,
    hostIsBehind,
    retryableCloseCode,
  ]);
}

/**
 * The retryable close a pre-1.3 host answers an unreadable chat store with.
 *
 * Not a protocol export because it is not a protocol constant: it is the
 * `retryableCode` that host's chat stream resolver passes to
 * `terminateClassified` for everything its fatal arms do not match, and it
 * therefore also covers ordinary transport trouble. That breadth is exactly
 * why it is only ever read alongside the other three conditions above, and
 * never on its own.
 */
const CHAT_OPEN_FAILED_CLOSE_CODE = "CHAT_OPEN_FAILED";
