import { useEffect, useMemo, useRef } from "react";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import type { RecordListStamp } from "@traycer/protocol/host/epic/record-list-revision";
import { subscribeRecordListDeltaStamps } from "@/lib/records/record-list-delta-stamps";

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

/**
 * Stage 2: keeps one record plane's held stamp current from the PUSH stream,
 * so an ordinary change stops costing a snapshot.
 *
 * ## The rule
 *
 * A delta's `listRevision` is the composite AFTER the write that produced it.
 * The plane applies and advances only for the immediate successor - same
 * epoch, `held + 1` - and asks for a snapshot for anything else.
 *
 * `+ 1` rather than "any forward jump", for the reason the protocol's own note
 * gives: a consumer that accepted a jump would silently skip the changes in
 * between, and those are exactly what it has no other way to learn. A gap is
 * therefore not an anomaly to tolerate but the signal the mechanism runs on -
 * it is how a doc-resident edit (which produces no delta at all), a missed
 * frame, or a host restart reaches this client. Every one of them lands here
 * as "not the successor" and is answered the same way: drop the stamp, re-read
 * the list.
 *
 * ## Why the epoch check is not redundant
 *
 * Revisions from two epochs do not compare, so `held.revision + 1` could match
 * by coincidence across a host restart or a re-hydrate. `UNSTAMPED_RECORD_LIST_REVISION`
 * makes that concrete rather than theoretical: a delta for an epic whose
 * registry is not hydrated ships with a bare epoch and its own counter, which
 * says nothing about this client's rows. Epoch first, always.
 *
 * ## Dropping the stamp on a gap, rather than leaving it stale
 *
 * Either one produces a snapshot - a stale stamp cannot match a revision that
 * has moved past it, and the host answers with rows. Dropping is what makes
 * the refetch happen ONCE: a burst of deltas arriving during a gap would
 * otherwise each find a non-null held stamp, each read as a gap, and each fire
 * another re-read. With the stamp dropped, the rest of the burst returns at
 * the `null` guard and the answer in flight brings the fresh stamp back.
 *
 * ## What it never does
 *
 * It does not apply rows. The mount routed those into the record tables before
 * announcing, and this is only the bookkeeping that stops the next poll from
 * re-shipping them. A plane holding nothing (`null`) is already asking for a
 * snapshot on every dispatch, so a delta has nothing to tell it.
 */
export function useRecordListStreamStamp(
  epicId: string,
  stamp: RecordListStampHold,
  /**
   * This plane's own list read, re-issued on a gap. The query's `refetch`
   * rather than an invalidation, because the invalidation this hook could
   * reach is method-scoped - it would re-read every other open epic's list
   * too, on every gap - while `refetch` names exactly this observer's key
   * without reconstructing it.
   *
   * Typed at what `refetch` actually returns so it can be passed straight in,
   * with no wrapper closure to churn the ref below on every render. The result
   * is deliberately dropped: the answer lands through the query's own cache
   * and the applying effect, exactly as a poll's does, and a rejection is
   * already the query's `error`.
   */
  refetch: () => Promise<unknown>,
): void {
  // Through a ref so the subscription survives re-renders: `refetch` is read
  // at NOTIFICATION time, and re-subscribing whenever the query result object
  // is rebuilt (every render) would churn the channel for nothing.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  useEffect(
    () =>
      subscribeRecordListDeltaStamps(epicId, (listRevision) => {
        const currentStamp = stamp.read();
        if (currentStamp === null) return;
        if (
          currentStamp.epoch === listRevision.epoch &&
          listRevision.revision === currentStamp.revision + 1
        ) {
          // `touchRevision` rides through untouched: a delta reports a list
          // change, never a quiet write, so the recency watermark this client
          // holds is still exactly where the last answer left it.
          stamp.hold({ ...currentStamp, revision: listRevision.revision });
          return;
        }
        stamp.hold(null);
        void refetchRef.current();
      }),
    [epicId, stamp],
  );
}
