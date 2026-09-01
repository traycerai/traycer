/**
 * The one poll/push reconciliation, shared by every record plane.
 *
 * The algorithm is four rules that only make sense together:
 *
 *  1. **A request-time fence.** `revision` orders two versions of ONE row and
 *     says nothing about a row an answer omits. So an omission may only retract
 *     a row that was already held when the answer was ISSUED. `rowSeq` stamps
 *     every accepted write with a monotonic counter; the list caller reads that
 *     counter at dispatch and hands it back with the answer as the fence, so a
 *     row ingested past it survives that answer and an answer issued after the
 *     row landed retracts it at once - a deletion missed while the stream was
 *     down is collected by the very next read, not one read later.
 *     {@link RecordTable.ingestSeq} is what a caller captures; `snapshotFence`
 *     (where the counter stood after the previous answer) is the fallback for
 *     an answer dispatched with no session to read from, and it holds an
 *     omitted row for one extra pass.
 *  2. **A per-row revision guard**, in the same direction on both paths: a row
 *     that does not strictly exceed what is held is a replay, a reorder or a
 *     duplicate, and dropping it is what makes those harmless with no merge
 *     logic anywhere. NOT a timestamp comparison - host clocks skew and
 *     `updatedAt` is display metadata no ordering decision may read. Planes
 *     that have a row shape the comparison cannot judge narrow it through
 *     {@link RecordTablePlane.supersedesOnSnapshot}.
 *  3. **Absorbing retractions.** Removal is terminal for the life of the
 *     session: a retracted id is filtered out of every later answer, poll
 *     included, and no later upsert resurrects it. The list read is a SNAPSHOT
 *     of the host's store and the host applies a removal before it emits one,
 *     so a response that still carries the row was necessarily issued before
 *     the retraction - letting it through would resurrect a row seconds after
 *     its tab said it was gone.
 *  4. **One recompute**, shared by the poll and the push so the two halves of
 *     one table cannot drift in how they publish it, with the change gate on
 *     it: an answer that says the same thing as the last one writes nothing, so
 *     the 20s poll behind it costs no renders while an epic is quiet.
 *
 * Push is the trigger and the poll is the backup, so both write a table and
 * neither owns it: a host without the stream loses latency and nothing else,
 * and a delta lost to a disconnect is repaired by the next 20s list read.
 *
 * ## What is shared and what is declared
 *
 * The mechanism above is shared. Everything a plane can legitimately differ on
 * is a named member of {@link RecordTablePlane} rather than a branch in here -
 * the three that were the stated reason the two copies stayed separate through
 * the extraction (owner keying, the doc-resident revision carve-out, the
 * chat-only pending-creation registry) are each one declaration now, argued at
 * the plane that holds the fact.
 *
 * The delta UNION is deliberately not a type parameter. The two planes' frame
 * grammars are separate unions on purpose (`upsert`/`remove` versus
 * `tuiUpsert`/`tuiRemove`), and narrowing them here would put a dead branch for
 * one plane's frames in the other's path. Each plane narrows its own frame and
 * calls {@link RecordTable.applyUpsert} or {@link RecordTable.applyRemoval},
 * which is two lines and keeps the grammars where the protocol put them.
 */
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";

/**
 * A retained-row key that scopes a host-minted id to the account it was minted
 * for.
 *
 * Every plane built on this table RETAINS rows across an account switch, and
 * re-selects for the current viewer at recompute time. So "the host serves one
 * viewer's rows and its ids are unambiguous within an answer" - true of both
 * planes here - does not make the ids unambiguous in the MAP, which spans
 * answers to different viewers. A collision there is not a re-render: the
 * revision guard rejects the legitimate row against a stranger's held one,
 * `isVisibleToUser` hides the stranger, and the row is gone for the session.
 *
 * `sessionKeyOf`, not a separator join. The wire ids are bare `z.string()`, so
 * "no id can contain U+001F" is a property nobody can hold true across a schema
 * change, and `("a", "b<US>c")` and `("a<US>b", "c")` collide. Length-prefixed,
 * so it reserves no character at all and there is no next "but nothing can
 * contain THIS one" left to be wrong about.
 */
export function ownerScopedRowKey(ownerUserId: string, rowId: string): string {
  return sessionKeyOf([ownerUserId, rowId]);
}

/**
 * A recomputed table, ready to publish. `null` from any apply means the change
 * gate held and nothing needs writing.
 */
export interface RecordTablePublication<TSlice> {
  readonly slice: TSlice;
  /**
   * Non-null only when a retraction moved. The retraction map BYPASSES the
   * change gate, because a removal that leaves the slice unchanged - a row this
   * session never held a record for, opened cross-host from the sidebar - still
   * has to reach the open tab that is rendering it.
   */
  readonly retractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

/**
 * Everything the shared algorithm cannot know about one plane's rows.
 *
 * Every member here is a fact about the plane, not a tuning knob: a wrong
 * answer to any of them is a data defect, so they are all required and none
 * has a default.
 */
export interface RecordTablePlane<TRow, TSlice> {
  /**
   * The row's full identity, which is what the row map is keyed by.
   *
   * NOT necessarily the id a removal frame names - see
   * {@link retractionIdOf}. Where a host-minted id is unique only within an
   * owner, this composes the owner in, so a collaborator's row cannot EVICT
   * the viewer's own same-id row.
   */
  readonly rowKey: (row: TRow) => string;
  /**
   * The id a removal frame would name this row by.
   *
   * Removal addressing can be COARSER than a record identity - a frame that
   * carries no owner retracts every retained row with that id in this epic -
   * so this is the key the retraction map and the removal sweep use. Where the
   * two coincide, a removal names exactly one row and the coarseness has
   * nothing to hit.
   */
  readonly retractionIdOf: (row: TRow) => string;
  /** Whether the plane serves `row` to this viewer right now. */
  readonly isVisibleToUser: (
    row: TRow,
    currentUserId: string | null,
  ) => boolean;
  /**
   * Whether a row an ANSWER served replaces the one held.
   *
   * Separate from {@link supersedesOnUpsert} because a plane can carry a row
   * shape the revision comparison cannot judge, and the waiver is only ever
   * safe in the snapshot direction - a later answer is a fresher read of the
   * same map, while a delta arriving out of order is not.
   */
  readonly supersedesOnSnapshot: (candidate: TRow, held: TRow) => boolean;
  /** Whether a row a DELTA carried replaces the one held. */
  readonly supersedesOnUpsert: (candidate: TRow, held: TRow) => boolean;
  /**
   * The slice this plane publishes, built from the rows visible to the current
   * viewer.
   *
   * Owner selection happens at INGEST (here) rather than being left to the
   * projection's own filter downstream, because the published slice is keyed on
   * the bare id and so can only ever represent one owner's rows - letting a
   * collaborator's same-id row take that slot is the viewer's own row vanishing
   * from their own sidebar. Nothing is frozen by filtering early: the raw rows
   * retain EVERY owner and a user switch re-runs this over them.
   *
   * Collapsing an empty result onto the plane's shared empty constant belongs
   * here too, since the constant is the plane's.
   */
  readonly buildSlice: (
    visibleRows: readonly TRow[],
    currentUserId: string | null,
  ) => TSlice;
  /** The change gate. */
  readonly slicesEq: (a: TSlice, b: TSlice) => boolean;
  /** The slice a table publishes before it has ingested anything. */
  readonly emptySlice: TSlice;
}

/**
 * The plane state a record write has to touch that is not a record.
 *
 * Every hook here runs from inside the one seam its plane's writes flow
 * through, at the exact point the incumbent code ran it, because "roughly when
 * the row lands" is not a specification: the provenance mark has to be captured
 * BEFORE the change gate can early-return, and a stand-in has to be retired at
 * a different point on the two paths.
 */
export interface RecordTableHooks<TRow> {
  readonly getCurrentUserId: () => string | null;
  /**
   * Called from the ONE seam every record write flows through, BEFORE the
   * change gate can early-return: the optimistic overlay's record-plane
   * provenance marks must be captured while the row exists, and a gate that
   * returned first would lose exactly the rows that arrived without changing
   * the published slice.
   */
  readonly onBeforePublish: () => void;
  /**
   * Every row an ANSWER serves, before the revision guard judges it -
   * stale-rejected ones included, since even an old version proves the record
   * exists. That is what lets a later answer retire a stand-in registered while
   * the row was already held.
   */
  readonly onRowServed: (row: TRow) => void;
  /** Every row an upsert DELTA is admitted for, after the revision guard. */
  readonly onUpsertAdmitted: (row: TRow) => void;
  /**
   * A removal, before its idempotence test, so a redelivered removal that is
   * the first one to race a registration still retires it. Returns whether it
   * changed any plane state, which the idempotence test folds in - otherwise a
   * removal that retires a stand-in but touches no row would publish nothing.
   */
  readonly onRemoval: (retractionId: string) => boolean;
}

export interface RecordTable<TRow, TSlice> {
  /** The slice as last published. The projector reads this as an input. */
  current(): TSlice;
  /**
   * The retained RAW row for a full record identity, or `null`.
   *
   * The published slice cannot answer this: it is keyed on the bare id, which
   * is not necessarily a record identity, and it is filtered to the viewer. A
   * plane that needs to carry a field forward across a delta has to read it by
   * the SAME identity the rows are stored under, or it inherits a same-id row
   * belonging to another owner - reachable during the null-viewer boot window
   * and across an account transition.
   */
  retainedRow(rowKey: string): TRow | null;
  /**
   * The ingest counter as it stands now - the value a list request captures at
   * dispatch and passes back as `issuedAtSeq`. Monotonic, per session; every
   * accepted row write advances it.
   */
  ingestSeq(): number;
  /** Whether a removal for `retractionId` has been absorbed this session. */
  isRetracted(retractionId: string): boolean;
  applySnapshot(
    rows: readonly TRow[],
    issuedAtSeq: number | null,
  ): RecordTablePublication<TSlice> | null;
  applyUpsert(row: TRow): RecordTablePublication<TSlice> | null;
  applyRemoval(
    retractionId: string,
    reason: ChatRecordRemovalReason,
  ): RecordTablePublication<TSlice> | null;
  /**
   * Re-derive and publish without ingesting anything.
   *
   * The path a user switch and every plane-side change (a stand-in registered
   * or dropped) publish through, so they cannot reach the slice by any route
   * the record paths do not also take. A user switch REBUILDS rather than
   * re-projects because the slice is keyed on the bare id and so represents one
   * owner's rows; the retained raw rows make that lossless.
   */
  republish(): RecordTablePublication<TSlice> | null;
  /** Whether the record plane serves `nodeId` to this viewer right now. */
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

export function createRecordTable<TRow, TSlice>(
  plane: RecordTablePlane<TRow, TSlice>,
  hooks: RecordTableHooks<TRow>,
): RecordTable<TRow, TSlice> {
  /**
   * The slice as published, held as the projector's INPUT (the mirrored copy in
   * the published projection is what components and tests read). Held here
   * rather than read back out of the projection because the projector runs
   * inside the publish path, where reading what it is about to write is exactly
   * the kind of cycle that produces a projection built from half-updated state.
   */
  let slice: TSlice = plane.emptySlice;

  /**
   * The RAW rows behind {@link slice}, keyed by {@link RecordTablePlane.rowKey}.
   *
   * The published slice cannot serve as the record layer's own state on two
   * counts. It drops `revision`, which is the entire basis of the staleness test
   * a push delta has to make; and it is keyed on the bare id, which is not
   * necessarily a record identity.
   *
   * Held beside the slice rather than folded into the projection, because a
   * revision is sync bookkeeping and nothing that renders should be able to read
   * it.
   */
  const rows = new Map<string, TRow>();

  /**
   * Ids the plane RETRACTED while this session was open, and why - ABSORBING
   * for the life of the session. Keyed by the removal frame's id, which is what
   * {@link RecordTablePlane.retractionIdOf} names.
   */
  const retractions = new Map<string, ChatRecordRemovalReason>();

  /** Local ingest order per row, and the watermark the last answer left. */
  const rowSeq = new Map<string, number>();
  let ingestSeq = 0;
  let snapshotFence = 0;

  function recompute(
    withRetractions: boolean,
  ): RecordTablePublication<TSlice> | null {
    const currentUserId = hooks.getCurrentUserId();
    // Record provenance for any pending mutation this table now backs, BEFORE
    // the change gate below can early-return.
    hooks.onBeforePublish();
    const visible: TRow[] = [];
    for (const row of rows.values()) {
      if (!plane.isVisibleToUser(row, currentUserId)) continue;
      visible.push(row);
    }
    const nextSlice = plane.buildSlice(visible, currentUserId);
    if (!withRetractions && plane.slicesEq(slice, nextSlice)) return null;
    slice = nextSlice;
    return {
      slice: nextSlice,
      retractions: withRetractions ? Object.fromEntries(retractions) : null,
    };
  }

  return {
    current: () => slice,
    retainedRow: (rowKey: string) => rows.get(rowKey) ?? null,
    ingestSeq: () => ingestSeq,
    isRetracted: (retractionId) => retractions.has(retractionId),

    applySnapshot(served, issuedAtSeq) {
      const admitted = new Map<string, TRow>();
      for (const row of served) {
        if (retractions.has(plane.retractionIdOf(row))) continue;
        admitted.set(plane.rowKey(row), row);
      }
      // Omissions first, against the fence - see rule 1 in the module doc.
      // Anything ingested since the answer was issued (a push delta, a faster
      // later answer) is newer than this snapshot by construction and survives
      // it.
      const fence = issuedAtSeq ?? snapshotFence;
      for (const key of [...rows.keys()]) {
        if (admitted.has(key)) continue;
        if ((rowSeq.get(key) ?? 0) > fence) continue;
        rows.delete(key);
        rowSeq.delete(key);
      }
      for (const [key, row] of admitted) {
        hooks.onRowServed(row);
        const held = rows.get(key);
        if (held !== undefined && !plane.supersedesOnSnapshot(row, held)) {
          continue;
        }
        rows.set(key, row);
        ingestSeq += 1;
        rowSeq.set(key, ingestSeq);
      }
      snapshotFence = ingestSeq;
      return recompute(false);
    },

    applyUpsert(row) {
      // Removal is TERMINAL AND ABSORBING - the one lifecycle rule in this
      // design - so no later upsert resurrects the row here.
      if (retractions.has(plane.retractionIdOf(row))) return null;
      const key = plane.rowKey(row);
      const held = rows.get(key);
      if (held !== undefined && !plane.supersedesOnUpsert(row, held)) {
        return null;
      }
      rows.set(key, row);
      // Past the fence the last snapshot left: an answer already in flight
      // cannot carry this row's new version, so its omission - or its stale
      // copy, via the revision test above - must not defeat it.
      ingestSeq += 1;
      rowSeq.set(key, ingestSeq);
      hooks.onUpsertAdmitted(row);
      return recompute(false);
    },

    applyRemoval(retractionId, reason) {
      // Every retained row the frame's id names. Where that addressing is
      // coarser than a record identity this is more than one row, which is the
      // bounded-and-deliberate arm described on `retractionIdOf`.
      const doomed: string[] = [];
      for (const [key, row] of rows) {
        if (plane.retractionIdOf(row) !== retractionId) continue;
        doomed.push(key);
      }
      const changedPlaneState = hooks.onRemoval(retractionId);
      // Idempotent: a redelivered removal for the same reason is not a state
      // change, and re-publishing on it would re-project the epic for nothing.
      if (
        retractions.get(retractionId) === reason &&
        doomed.length === 0 &&
        !changedPlaneState
      ) {
        return null;
      }
      retractions.set(retractionId, reason);
      for (const key of doomed) {
        rows.delete(key);
        rowSeq.delete(key);
      }
      return recompute(true);
    },

    republish: () => recompute(false),

    servesNodeToViewer(nodeId, currentUserId) {
      for (const row of rows.values()) {
        if (plane.retractionIdOf(row) !== nodeId) continue;
        if (plane.isVisibleToUser(row, currentUserId)) return true;
      }
      return false;
    },
  };
}
