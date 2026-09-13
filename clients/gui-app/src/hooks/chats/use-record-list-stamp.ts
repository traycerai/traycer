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
   * Hold what an answer's `listStamp` carried, along with where the store's
   * incomplete-apply counter stood when that answer was DISPATCHED.
   *
   * Callers must call this only for an answer they routed to a store. That
   * alone is not proof the store took it, which is why the second argument
   * exists: the apply crosses a fire-and-forget command bridge and the
   * request-time fence can hold rows back at the far end, long after this
   * returns. So the stamp is held provisionally and {@link read} re-checks the
   * counter at the next dispatch - if it moved, this answer (or one after it)
   * was applied incompletely and the stamp is dropped.
   *
   * The counter is captured at DISPATCH rather than compared at hold, because at
   * hold time the apply this stamp belongs to has not necessarily reached the
   * worker, let alone published its result. Binding it to the dispatch makes the
   * comparison correct in every interleaving: an incomplete apply's counter move
   * is always later than the dispatch of the answer that caused it, and later
   * than the dispatch of anything that raced ahead of the publish - so every
   * stamp from that window is dropped, and the first stamp captured after the
   * move survives.
   *
   * `null` for the stamp is a legitimate value to hold: it is what a host with
   * no revision to report answers, and it asks for a snapshot next time. `null`
   * for the counter is not a value at all - it means there was no store to read
   * at dispatch - and declines the hold outright.
   */
  readonly hold: (
    stamp: RecordListStamp | null,
    snapshotIncompleteSeqAtDispatch: number | null,
  ) => void;
}

/**
 * What one plane's stamp holder needs. An object rather than positional
 * arguments: four of the five are strings/numbers whose order no reader could
 * verify at a call site, and the two hooks that call this are the two places
 * that must not disagree about them.
 */
export interface RecordListStampInputs {
  readonly epicId: string;
  readonly viewerUserId: string;
  /** The SERVING host - what `useHostQuery` keys this plane's cache entry on. */
  readonly hostId: string | null;
  /** `OpenEpicState.ingestFenceIdentity`, or `null` with no session. */
  readonly storeGeneration: number | null;
  /**
   * The store's incomplete-apply counter for THIS plane, read live - see the
   * section below, and {@link RecordListStampHold.hold}.
   *
   * A getter rather than the number, and it must be referentially stable across
   * the ticks of one session (the hooks wrap it in `useCallback` over `store`),
   * because the holder it produces is a dependency of the applying effect.
   */
  readonly readSnapshotIncompleteSeq: () => number | null;
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
 * comparison is equality-only, with nothing to notice the gap. The four things
 * that can replace it are the four identity inputs:
 *
 *  - `storeGeneration` (`OpenEpicState.ingestFenceIdentity`) is minted once per
 *    store construction, so an epic REOPEN - and renderer parking, which
 *    releases the session and rebuilds it on show - changes it and the next
 *    dispatch asks for a snapshot;
 *  - `viewerUserId`, because the answer is one identity's own rows;
 *  - `epicId`, because one hook instance can be pointed at a different epic;
 *  - `hostId`, because the stamp is one host's own list revision and means
 *    nothing to another. Carried here rather than left to the session: the
 *    cache entry this stamp tracks is keyed on the serving host
 *    (`useHostQuery`'s own key), and `EpicSessionProvider` releasing the
 *    session on a host change - which mints a fresh generation - is a real
 *    guarantee that lives in another file and nothing pins. Keying on it
 *    directly makes the claim above self-evident instead of transitive.
 *
 * The comparison is made at READ and at HOLD rather than by an effect, so a
 * dispatch that raced the change cannot send the superseded stamp: an answer
 * issued for the old identity can only land in the old cache entry, which no
 * longer has an observer.
 *
 * ## What else drops it: an incomplete apply
 *
 * Identity covers a row set being REPLACED. It says nothing about a row set
 * that was never fully received, which the request-time fence in
 * `record-table.ts` produces routinely (one push delta racing one in-flight
 * poll). `readSnapshotIncompleteSeq` is the store's count of those, and a stamp
 * whose dispatch predates a move in it is dropped - see {@link hold}. That is
 * what keeps the "next poll repairs it" promise the fence's own comment makes,
 * now that a poll can answer `unchanged`.
 */
export function useRecordListStamp(
  inputs: RecordListStampInputs,
): RecordListStampHold {
  const {
    epicId,
    viewerUserId,
    hostId,
    storeGeneration,
    readSnapshotIncompleteSeq,
  } = inputs;
  // `sessionKeyOf` rather than a separator join, for the reason
  // `ownerScopedRowKey` gives: it is length-prefixed, so it reserves no
  // character and no pair of inputs can compose to the same key. `null` and
  // the number `0` are distinct strings under it, which is what matters here -
  // "no store" must not read as "generation 0".
  const identity = sessionKeyOf([
    epicId,
    viewerUserId,
    hostId ?? "no-host",
    storeGeneration === null ? "no-store" : String(storeGeneration),
  ]);
  const held = useRef<{
    readonly identity: string;
    readonly stamp: RecordListStamp | null;
    readonly snapshotIncompleteSeq: number | null;
  }>({ identity, stamp: null, snapshotIncompleteSeq: null });
  return useMemo(
    () => ({
      read: () => {
        const current = held.current;
        if (current.identity !== identity) return null;
        // Never held for a real dispatch, so there is nothing to compare and
        // nothing to send.
        if (current.snapshotIncompleteSeq === null) return null;
        // The store applied something incompletely since this stamp's request
        // left. Whatever the host thinks this client holds, it does not.
        if (readSnapshotIncompleteSeq() !== current.snapshotIncompleteSeq) {
          return null;
        }
        return current.stamp;
      },
      hold: (
        stamp: RecordListStamp | null,
        snapshotIncompleteSeqAtDispatch: number | null,
      ) => {
        held.current = {
          identity,
          stamp,
          snapshotIncompleteSeq: snapshotIncompleteSeqAtDispatch,
        };
      },
    }),
    [identity, readSnapshotIncompleteSeq],
  );
}
