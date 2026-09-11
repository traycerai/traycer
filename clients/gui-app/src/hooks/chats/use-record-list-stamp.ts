import { useMemo, useRef } from "react";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import type { RecordListStamp } from "@traycer/protocol/host/epic/record-list-revision";

/**
 * The stamp seam one revision-gated record poll uses: what to SEND on the next
 * dispatch, and where to put what an answer said.
 */
export interface RecordListStampHold {
  /**
   * The stamp to send as `knownRevision`, or `null` for "I hold nothing, send
   * me a snapshot".
   *
   * Read at DISPATCH (from `useHostQuery`'s `buildRequest`), never at render:
   * the whole point is that it moves between two dispatches of one query key.
   */
  readonly read: () => RecordListStamp | null;
  /**
   * Hold what an answer's `listStamp` carried, verbatim.
   *
   * Callers must call this only for an answer they APPLIED. The stamp is the
   * host's record of what this client holds, so holding one whose rows or
   * recency patches never reached the store would make the host answer
   * `unchanged` about a change the store never saw - and equality-only
   * comparison leaves nothing to detect that with. `null` is a legitimate
   * value to hold: it is what a host with no revision to report answers, and
   * it asks for a snapshot next time.
   */
  readonly hold: (stamp: RecordListStamp | null) => void;
}

/**
 * Holds one record plane's last applied `listStamp` across the dispatches of
 * one poll, and DROPS it whenever the rows it describes stop being the rows
 * this client holds.
 *
 * ## Why it is not in the query key, and not in the store either
 *
 * Not the key: `params` is the query key, and a stamp that varied it would
 * mint a fresh cache entry every tick - the 20s poll would refetch from
 * scratch forever and the gating would never fire. So the stamp rides
 * `buildRequest` (the dispatch-time payload seam) and lives here.
 *
 * Not the store: the record tables live behind the runtime worker's
 * fire-and-forget command bridge, so a stamp written into them could not be
 * read back synchronously at the next dispatch. It belongs on the main thread
 * beside the query that sends it.
 *
 * ## What resets it
 *
 * A stamp describes a specific client-side ROW SET, not a point in time, so it
 * is worthless - and actively dangerous - the moment that row set is replaced:
 * the host would answer `unchanged` to a client whose rows are gone, and the
 * comparison is equality-only, with nothing to notice the gap. The three
 * things that can replace it are the three identity inputs:
 *
 *  - `storeGeneration` (`OpenEpicState.ingestFenceIdentity`) is minted once per
 *    store construction, so an epic REOPEN - and renderer parking, which
 *    releases the session and rebuilds it on show - changes it and the next
 *    dispatch asks for a snapshot;
 *  - `viewerUserId`, because the answer is one identity's own rows;
 *  - `epicId`, because one hook instance can be pointed at a different epic.
 *
 * The comparison is made at READ and at HOLD rather than by an effect, so a
 * dispatch that raced the change cannot send the superseded stamp: an answer
 * issued for the old identity can only land in the old cache entry, which no
 * longer has an observer.
 */
export function useRecordListStamp(
  epicId: string,
  viewerUserId: string,
  storeGeneration: number | null,
): RecordListStampHold {
  // `sessionKeyOf` rather than a separator join, for the reason
  // `ownerScopedRowKey` gives: it is length-prefixed, so it reserves no
  // character and no pair of inputs can compose to the same key. `null` and
  // the number `0` are distinct strings under it, which is what matters here -
  // "no store" must not read as "generation 0".
  const identity = sessionKeyOf([
    epicId,
    viewerUserId,
    storeGeneration === null ? "no-store" : String(storeGeneration),
  ]);
  const held = useRef<{
    readonly identity: string;
    readonly stamp: RecordListStamp | null;
  }>({ identity, stamp: null });
  return useMemo(
    () => ({
      read: () =>
        held.current.identity === identity ? held.current.stamp : null,
      hold: (stamp: RecordListStamp | null) => {
        held.current = { identity, stamp };
      },
    }),
    [identity],
  );
}
