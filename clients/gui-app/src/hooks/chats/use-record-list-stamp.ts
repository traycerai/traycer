import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
  /**
   * Move the held stamp forward with NO dispatch behind it - what a push
   * delta's immediate successor does.
   *
   * Separate from {@link hold} rather than `hold(next, <some counter>)`,
   * because there is no dispatch here to bind a counter to and neither
   * argument a caller could pass is right. `null` declines the hold and costs
   * a snapshot on every delta, which is the entire saving. Re-reading the
   * counter binds the stamp to NOW rather than to the dispatch that produced
   * the rows - so a stamp already invalidated by an incomplete apply would be
   * re-issued a clean binding, which is the hole {@link hold}'s dispatch
   * capture exists to close.
   *
   * The right answer is the binding the stamp ALREADY carries - the row set is
   * the one that dispatch produced plus this delta - so this preserves it and
   * changes only the revision.
   *
   * It re-checks that binding first and declines when nothing valid is held.
   * Today's only caller reads {@link read} immediately before (it needs the
   * held revision to recognise the successor at all), which makes the check
   * redundant FOR THAT CALLER and equivalent to re-reading the counter. It is
   * kept so the guarantee is this function's own rather than a property of
   * one call site: the laundering above is what a caller without that read
   * would otherwise get.
   */
  readonly advance: (stamp: RecordListStamp) => void;
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
  return useMemo(() => {
    // The held entry when it may still be used, `null` when it may not. Three
    // ways it may not, and `read` and `advance` owe the same answer to all
    // three - which is why this is one function rather than a guard repeated
    // at each of them.
    const validHeld = (): {
      readonly identity: string;
      readonly stamp: RecordListStamp | null;
      readonly snapshotIncompleteSeq: number | null;
    } | null => {
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
      return current;
    };
    return {
      read: () => validHeld()?.stamp ?? null,
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
      advance: (stamp: RecordListStamp) => {
        const current = validHeld();
        if (current === null) return;
        held.current = { ...current, stamp };
      },
    };
  }, [identity, readSnapshotIncompleteSeq]);
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
/**
 * One of the record projection's counters, read reactively off an open-epic
 * store, or `null` with no session.
 *
 * Both record hooks need this and neither needs a slice: the counters are
 * plain numbers on the projection, so `useSyncExternalStore` over the store's
 * own subscribe is the whole mechanism and a selector library would only add
 * an equality function for `===`.
 */
export function useProjectedRecordCounter(
  subscribeToStore: (onChange: () => void) => () => void,
  readCounter: () => number | null,
): number | null {
  return useSyncExternalStore(subscribeToStore, readCounter, readCounter);
}

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
  /**
   * This plane's live repair inputs, as ONE argument rather than two - they
   * are read together by the single effect below, and a fifth positional
   * parameter is over this package's `max-params` ceiling.
   */
  incomplete: {
    /**
     * This plane's projected `deltaIncompleteSeq`, or `null` with no session.
     *
     * A move in it means a delta INTRODUCED a row the store cannot fully
     * state - a chat with no home, an agent with no session facet - so the
     * rows this client holds are not the rows the host's list describes, and
     * the stamp the same delta advanced is a claim to hold them.
     *
     * Read as a value rather than through the stamp's own getter, because
     * this is the one input that has to drive a RENDER: the counter crosses
     * the runtime worker's command bridge long after the delta was
     * announced, so there is no callback to hang the repair off.
     */
    readonly deltaIncompleteSeq: number | null;
    /**
     * Whether this plane's list read is in flight right now.
     *
     * The division of labour between the two incomplete-apply clauses, and
     * the reason they compose instead of overlapping. A read already on the
     * wire is a repair already happening: its answer either states the field
     * the delta could not - and there is nothing left to do - or it cannot,
     * in which case the row it was dispatched before is held back by the
     * request-time fence, `snapshotIncompleteSeq` moves, and the DISPATCH
     * comparison declines its stamp. Either way the snapshot clause owns it.
     *
     * Re-reading over the top would not merely be wasteful: it replaces the
     * in-flight answer, so the fence skip that is the snapshot clause's whole
     * trigger never happens and that repair path is disabled by the one meant
     * to complement it.
     */
    readonly listIsFetching: boolean;
  },
): void {
  const { deltaIncompleteSeq, listIsFetching } = incomplete;
  // Through a ref so the subscription survives re-renders: `refetch` is read
  // at NOTIFICATION time, and re-subscribing whenever the query result object
  // is rebuilt (every render) would churn the channel for nothing.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  // THE GAP RULE, reached by the other route.
  //
  // The delta whose apply turned out to be incomplete has already advanced
  // the held stamp by the time this fires - the announcement is synchronous
  // and the apply is not - so this is the correction, not a pre-check. It is
  // the same two moves a non-contiguous revision makes, and for the same
  // reason: this client cannot describe the list it just claimed to hold, and
  // only a snapshot can fix that.
  //
  // Not folded into the dispatch comparison (`snapshotIncompleteSeq`), which
  // would also work but only at the NEXT scheduled poll - up to 20s of a
  // just-created chat rendering as unadopted, with rename, archive, reparent
  // and delete closed on it. A delta has no dispatch of its own to bind to,
  // so there is nothing here for that mechanism to be the repair of.
  const seenDeltaIncompleteSeq = useRef(deltaIncompleteSeq);
  // Synced in an effect rather than written during render, and DECLARED
  // ABOVE the one that reads it so effect order makes it current: when this
  // value and the counter move in the same commit, this runs first.
  const listIsFetchingRef = useRef(listIsFetching);
  useEffect(() => {
    listIsFetchingRef.current = listIsFetching;
  }, [listIsFetching]);
  useEffect(() => {
    if (deltaIncompleteSeq === null) return;
    // Also the mount case: the ref seeds from the first render's value, so a
    // session that already has a non-zero counter does not re-read on mount.
    if (seenDeltaIncompleteSeq.current === deltaIncompleteSeq) return;
    // Marked seen even when the read below is skipped, so one counter move
    // costs at most one action. Not marking it would re-read the moment the
    // in-flight answer settled, which is the one point at which a re-read is
    // guaranteed to be redundant.
    seenDeltaIncompleteSeq.current = deltaIncompleteSeq;
    // The stamp goes regardless. It was advanced by a delta whose apply this
    // client cannot describe, so it may not be sent whatever repairs it.
    stamp.hold(null, null);
    // Read through a ref rather than a dependency: this is a decision about
    // the instant the counter moved, and re-running the effect when the
    // query later settles would act on a world that has already changed.
    if (listIsFetchingRef.current) return;
    void refetchRef.current();
  }, [deltaIncompleteSeq, stamp]);
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
          // holds is still exactly where the last answer left it. `advance`
          // rather than `hold`, so the incomplete-apply binding this stamp
          // came with survives the move - see {@link RecordListStampHold}.
          stamp.advance({ ...currentStamp, revision: listRevision.revision });
          return;
        }
        // Dropped. A `null` counter is the decline: the next `read` finds
        // nothing held for a dispatch and asks for a snapshot.
        stamp.hold(null, null);
        void refetchRef.current();
      }),
    [epicId, stamp],
  );
}
