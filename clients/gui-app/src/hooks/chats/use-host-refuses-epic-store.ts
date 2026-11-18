import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  clearHostOlderThanDataRefusal,
  hostOlderThanDataRefusalKey,
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
 * Mounted by `ChatTileSessionView`, which serves BOTH the live tile and the
 * published copy - so it is `isLiveSession`, not the mounting itself, that
 * says whether anything here dialled the store and could have learned the
 * answer.
 *
 * On a live session: a fatal close carrying `HOST_OLDER_THAN_DATA` records the
 * refusal against the build the directory reports for the host; a landed
 * snapshot clears it, because a snapshot is the host proving it reads the file
 * now. When both are showing
 * at once - the chat had loaded, then the host was moved to an older build
 * and closed it - the close wins, because it is the later fact. Each close is
 * recorded once: a directory version change re-runs the effect, and a close
 * the old build sent is not evidence about the new one.
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
  /**
   * Whether this surface is backed by a LIVE session that actually dialled
   * the store. `false` on a published copy, and the hook then does nothing at
   * all - it neither records nor clears.
   *
   * The docblock above says this hook is mounted by the live chat tile. That
   * was not true: `ChatTileSessionView` is shared with `PublishedChatTile`,
   * whose synthesized state carries `snapshotLoaded: true` because the
   * transcript really is present. Nothing had dialled anything, so that flag
   * meant "the copy is here", not "the host reads the file" - and the clear
   * below read it as the latter. The published copy is the surface a reader
   * lands on BECAUSE a refusal was recorded, so opening it erased the verdict
   * that routed them there, and the next open went straight back to the
   * failing live route. Worse when the tab host is not the owner: the pair
   * cleared is `(tab host, epic)`, so it could retire a refusal recorded for
   * an entirely different machine.
   */
  readonly isLiveSession: boolean;
  /**
   * The session's own `retry()`. Called when the directory's version for the
   * host moves while a refusal close is showing - see the effect for why the
   * client asks the host again instead of guessing what the move meant.
   */
  readonly retry: () => void;
}): void {
  const {
    hostId,
    epicId,
    hostVersion,
    fatalCloseCode,
    snapshotLoaded,
    isLiveSession,
    retry,
  } = input;
  // The close this hook has already recorded - which (host, epic) pair, and
  // against which directory version - or `null` while no refusal close is
  // showing. Recording is edge-triggered on the close, not level-triggered on
  // the inputs, because the effect also re-runs when `hostVersion` moves.
  const recordedCloseRef = useRef<{
    readonly key: string;
    readonly hostVersion: string | null;
  } | null>(null);
  // Whether the previous pass saw a loaded snapshot. The clear arm is
  // edge-triggered too: it fires for a snapshot that LANDED (or was already
  // loaded when this hook first ran), never for a `hostVersion` change under a
  // snapshot that has merely stayed loaded since before the host moved builds.
  // That sibling tile - loaded before the swap, never closed - would otherwise
  // clear the epic's refusal on the version move while the refused tile beside
  // it is still refused.
  const sawSnapshotRef = useRef(false);
  useEffect(() => {
    // A published copy has learned nothing about any host. Bail before either
    // ref is touched, so a live session that later renders a copy cannot have
    // its recorded close forgotten by the copy's pass.
    if (!isLiveSession) return;
    // The host's latest word outranks the snapshot that loaded before it. The
    // session store keeps `snapshotLoaded` through a close so the transcript
    // stays readable, so a host that served this chat and was then moved to
    // an older build arrives here with BOTH set - and the close is the newer
    // fact. `retry()` clears both, and the next snapshot clears the record.
    if (fatalCloseCode === HOST_OLDER_THAN_DATA_FATAL_CODE) {
      sawSnapshotRef.current = false;
      const key = hostOlderThanDataRefusalKey(hostId, epicId);
      const recorded = recordedCloseRef.current;
      if (recorded === null || recorded.key !== key) {
        recordedCloseRef.current = { key, hostVersion };
        recordHostOlderThanDataRefusal({
          hostId,
          epicId,
          hostVersion,
          now: Date.now(),
        });
        return;
      }
      if (recorded.hostVersion === hostVersion) return;
      // The version moved under a close this hook recorded. Two very different
      // events look identical from here: the host was upgraded in place and
      // now reads the file (the record must retire), or the host merely
      // RESTARTED into the build that refused - the directory drops the row
      // while a host is down, so its version transits `old → null → old` -
      // and the refusal recorded against a value mid-transit is now keyed to
      // a build the directory no longer reports (the record must survive).
      // A terminal close stopped this session asking, so neither can be told
      // from the other by looking. Ask: the retry either lands a snapshot,
      // which clears through the arm below, or draws a fresh close, which
      // records against the version now current. Once per version move.
      recordedCloseRef.current = { key, hostVersion };
      retry();
      return;
    }
    recordedCloseRef.current = null;
    const snapshotLanded = snapshotLoaded && !sawSnapshotRef.current;
    sawSnapshotRef.current = snapshotLoaded;
    if (snapshotLanded) {
      clearHostOlderThanDataRefusal({ hostId, epicId });
    }
  }, [
    hostId,
    epicId,
    hostVersion,
    fatalCloseCode,
    snapshotLoaded,
    isLiveSession,
    retry,
  ]);
}
