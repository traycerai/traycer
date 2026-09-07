/**
 * Request-time fence plus per-row revision plus absorbing retractions.
 * Revision is not a timestamp; ingestSeq is the fence the caller captures at dispatch.
 */
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";

/** A retained-row key that scopes a host-minted id to the account it was minted for. */
export function ownerScopedRowKey(ownerUserId: string, rowId: string): string {
  return sessionKeyOf([ownerUserId, rowId]);
}

/**
 * A recomputed table, ready to publish. `null` from any apply means the change
 * gate held and nothing needs writing.
 */
export interface RecordTablePublication<TSlice> {
  readonly slice: TSlice;
  /** Non-null only when a retraction moved. */
  readonly retractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

/** Everything the shared algorithm cannot know about one plane's rows. */
export interface RecordTablePlane<TRow, TSlice> {
  /**
   * The row's full identity, which is what the row map is keyed by. NOT necessarily the id a removal
   * frame names - see {@link retractionIdOf}.
   */
  readonly rowKey: (row: TRow) => string;
  /** The id a removal frame would name this row by. */
  readonly retractionIdOf: (row: TRow) => string;
  /** Whether the plane serves `row` to this viewer right now. */
  readonly isVisibleToUser: (
    row: TRow,
    currentUserId: string | null,
  ) => boolean;
  /** Whether a row an ANSWER served replaces the one held. */
  readonly supersedesOnSnapshot: (candidate: TRow, held: TRow) => boolean;
  /** Whether a row a DELTA carried replaces the one held. */
  readonly supersedesOnUpsert: (candidate: TRow, held: TRow) => boolean;
  /** The slice this plane publishes, built from the rows visible to the current viewer. */
  readonly buildSlice: (
    visibleRows: readonly TRow[],
    currentUserId: string | null,
  ) => TSlice;
  /** The change gate. */
  readonly slicesEq: (a: TSlice, b: TSlice) => boolean;
  /** The slice a table publishes before it has ingested anything. */
  readonly emptySlice: TSlice;
}

/** The plane state a record write has to touch that is not a record. */
export interface RecordTableHooks<TRow> {
  readonly getCurrentUserId: () => string | null;
  readonly onBeforePublish: () => void;
  /**
   * Every row an ANSWER serves, before the revision guard judges it - stale-rejected ones included,
   * since even an old version proves the record exists.
   */
  readonly onRowServed: (row: TRow) => void;
  /** Every row an upsert DELTA is admitted for, after the revision guard. */
  readonly onUpsertAdmitted: (row: TRow) => void;
  /**
   * A removal, before its idempotence test, so a redelivered removal that is the first one to race a
   * registration still retires it.
   */
  readonly onRemoval: (retractionId: string) => boolean;
}

export interface RecordTable<TRow, TSlice> {
  /** The slice as last published. The projector reads this as an input. */
  current(): TSlice;
  /** The retained RAW row for a full record identity, or `null`. */
  retainedRow(rowKey: string): TRow | null;
  /**
   * The ingest counter as it stands now - the value a list request captures at dispatch and passes
   * back as `issuedAtSeq`. Monotonic, per session; every accepted row write advances it.
   */
  ingestSeq(): number;
  /** Whether a removal for `retractionId` has been absorbed this session. */
  isRetracted(retractionId: string): boolean;
  applySnapshot(
    rows: readonly TRow[],
    issuedAtSeq: number | null,
  ): RecordTablePublication<TSlice> | null;
  applyUpsert(row: TRow): RecordTablePublication<TSlice> | null;
  /** A single authoritative list row, retaining snapshot supersession rules. */
  applyPointRead(row: TRow): RecordTablePublication<TSlice> | null;
  /** Remove a retained identity without announcing an id-wide retraction. */
  removeRow(rowKey: string): RecordTablePublication<TSlice> | null;
  applyRemoval(
    retractionId: string,
    reason: ChatRecordRemovalReason,
  ): RecordTablePublication<TSlice> | null;
  /** Re-derive and publish without ingesting anything. */
  republish(): RecordTablePublication<TSlice> | null;
  /** Forget every absorbed retraction. */
  forgetRetractions(): void;
  /** Whether the record plane serves `nodeId` to this viewer right now. */
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

export function createRecordTable<TRow, TSlice>(
  plane: RecordTablePlane<TRow, TSlice>,
  hooks: RecordTableHooks<TRow>,
): RecordTable<TRow, TSlice> {
  /**
   * The slice as published, held as the projector's INPUT (the mirrored copy in the published
   * projection is what components and tests read).
   */
  let slice: TSlice = plane.emptySlice;

  /**
   * The RAW rows behind {@link slice}, keyed by {@link RecordTablePlane.rowKey}. The published slice
   * cannot serve as the record layer's own state on two counts.
   */
  const rows = new Map<string, TRow>();

  /**
   * Ids the plane RETRACTED while this session was open, and why - ABSORBING for the life of the
   * session.
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

    forgetRetractions(): void {
      retractions.clear();
    },

    applySnapshot(served, issuedAtSeq) {
      const admitted = new Map<string, TRow>();
      for (const row of served) {
        if (retractions.has(plane.retractionIdOf(row))) continue;
        admitted.set(plane.rowKey(row), row);
      }
      // Omissions first, against the fence - see rule 1 in the module doc.
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
        if (held !== undefined) {
          // THE FENCE AGAIN, on the carried half - see rule 1.
          if ((rowSeq.get(key) ?? 0) > fence) continue;
          if (!plane.supersedesOnSnapshot(row, held)) continue;
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
      // Past the fence the last snapshot left: an answer already in flight cannot carry this row's new
      // version, so its omission - or its stale copy, via the revision test above - must not defeat it.
      ingestSeq += 1;
      rowSeq.set(key, ingestSeq);
      hooks.onUpsertAdmitted(row);
      return recompute(false);
    },
    applyPointRead(row) {
      if (retractions.has(plane.retractionIdOf(row))) return null;
      hooks.onRowServed(row);
      const key = plane.rowKey(row);
      const held = rows.get(key);
      if (held === undefined || plane.supersedesOnSnapshot(row, held)) {
        rows.set(key, row);
        ingestSeq += 1;
        rowSeq.set(key, ingestSeq);
      }
      return recompute(false);
    },
    removeRow(rowKey) {
      if (!rows.delete(rowKey)) return null;
      rowSeq.delete(rowKey);
      return recompute(false);
    },

    applyRemoval(retractionId, reason) {
      // Every retained row the frame's id names.
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
