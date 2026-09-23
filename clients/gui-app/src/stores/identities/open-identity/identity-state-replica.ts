/**
 * The identity index lane's read model: `agentIdentity.state.subscribe@1.0`
 * rows in, the three populations the Identities surface renders out.
 *
 * A reduced copy of `open-epic/runtime/epic-lane-state-replica.ts`, and
 * deliberately the same shape: one `createRecordTable` over the whole
 * `IdentityStateRow` union, keyed by the seam's own `rowId`, with the union
 * demultiplexed by `row.kind` once per recompute. The reasoning that file
 * gives for one table rather than one per population holds verbatim here - a
 * `remove` carries a bare `rowId`, and the row-id prefixes are opaque to the
 * replica.
 *
 * ## Slices are keyed by PATH, and the row id is never parsed
 *
 * Row ids on this lane are incarnation-aware: the host mints a fresh id when a
 * row comes into existence at a path, so a rename-back or a delete-and-recreate
 * is a new row rather than a resurrection of an absorbed one. The tree and the
 * body lanes address a file by its PATH, so `buildSlices` scans each held row's
 * `path` data field and groups by that. When two held rows momentarily claim
 * one path - the window inside a rename envelope before the old incarnation's
 * removal applies - the later-held row wins, which is the one the same
 * envelope is about to leave standing.
 *
 * ## `identity-patch` is merged BEFORE the table sees it
 *
 * The table's upsert REPLACES the held row, which is wrong for exactly one
 * population: a delta's `identity` carries only the fields that commit
 * changed. So a patch is folded onto the held whole record and handed down as
 * a whole `identity` row at the patch's revision. A patch with nothing held is
 * dropped: only a snapshot may establish the record.
 *
 * ## Shard availability is held beside the table, not in it
 *
 * `identity-shard-availability` is not a row - the wire replaces the whole set
 * on every change and the frame carries no cursor - so it is a plain value with
 * an epoch guard, replaced wholesale, exactly as `lane-events.ts` asks.
 */
import type {
  IdentityStateLaneEvent,
  IdentityStateRow,
  IdentityRecordFields,
} from "@traycer-clients/shared/identity-lanes";
import type {
  LaneCursor,
  RecordChange,
  RecordRow,
  ReplicaApplyOutcome,
  ReplicaResetCause,
  SeedTrust,
} from "@traycer-clients/shared/replica-runtime";
import type { AgentIdentityShardAvailability } from "@traycer/protocol/host/agent-identity/state-subscribe";
import {
  createRecordTable,
  type RecordTable,
} from "@/stores/epics/open-epic/runtime/record-table";
import {
  EMPTY_ARRAY,
  EMPTY_IDENTITY_DOCUMENTS_SLICE,
  EMPTY_IDENTITY_FILES_SLICE,
  EMPTY_IDENTITY_STATE_SLICES,
  type IdentityDocumentProjection,
  type IdentityFileProjection,
  type IdentityStateSlices,
} from "./types";

/**
 * Whether a reset means the next snapshot may come from a store that never saw
 * this session's removals. Copied from the epic lane replica, where the
 * per-reason argument is written out; the answer is the same on this lane.
 */
function replacesThePositionSpace(cause: ReplicaResetCause): boolean {
  if (cause.origin === "client") return false;
  switch (cause.reason) {
    case "resume-too-old":
    case "security-epoch-changed":
      return false;
    case "authority-epoch-changed":
    case "migration-completed":
    case "manifest-changed":
    case "host-repointed":
      return true;
  }
}

/** A lane row as the table holds it: the seam's envelope, flattened. */
interface HeldIdentityRow {
  readonly rowId: string;
  readonly revision: number;
  readonly row: IdentityStateRow;
}

export interface IdentityStateReplicaSources {
  readonly getCurrentUserId: () => string | null;
  readonly isDisposed: () => boolean;
  /** Called once per envelope that actually changed something observable. */
  readonly onChanged: () => void;
}

export interface IdentityStateReplica {
  apply(event: IdentityStateLaneEvent): ReplicaApplyOutcome;
  /** The populations, as last recomputed. */
  slices(): IdentityStateSlices;
  /** The whole shard set as last reported; empty before the first lead. */
  shards(): readonly AgentIdentityShardAvailability[];
  /**
   * The furthest point on this lane fully APPLIED, or `null` when nothing is
   * held. This is what the adapter's `readAppliedCursor` is wired to.
   */
  appliedCursor(): LaneCursor | null;
  /** The epoch this replica's rows belong to, or `null` before the first lead. */
  authorityEpoch(): string | null;
  trust(): SeedTrust | null;
  reset(cause: ReplicaResetCause): void;
}

function applied(cursor: LaneCursor | null): ReplicaApplyOutcome {
  return { kind: "applied", cursor };
}

function identityRecordsEq(
  a: IdentityRecordFields | null,
  b: IdentityRecordFields | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.evolution.intervalTurns === b.evolution.intervalTurns &&
    a.evolution.reviewHarnessId === b.evolution.reviewHarnessId &&
    a.evolution.reviewModel === b.evolution.reviewModel &&
    a.evolution.reviewReasoningEffort === b.evolution.reviewReasoningEffort
  );
}

function pathsEq(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((path, index) => path === b[index]);
}

function documentsEq(
  a: IdentityStateSlices["documents"],
  b: IdentityStateSlices["documents"],
): boolean {
  if (a === b) return true;
  if (!pathsEq(a.allPaths, b.allPaths)) return false;
  return a.allPaths.every((path) => {
    const left = a.byPath[path];
    const right = b.byPath[path];
    if (left === undefined || right === undefined) return left === right;
    return (
      left.shardRoomId === right.shardRoomId &&
      left.fragmentName === right.fragmentName &&
      left.updatedAt === right.updatedAt &&
      left.provenance === right.provenance
    );
  });
}

function filesEq(
  a: IdentityStateSlices["files"],
  b: IdentityStateSlices["files"],
): boolean {
  if (a === b) return true;
  if (!pathsEq(a.allPaths, b.allPaths)) return false;
  // Reference equality per entry: an entry object is rebuilt only when its own
  // row is re-ingested, so a recompute that touched another path hands back
  // the same object.
  return a.allPaths.every(
    (path) => a.byPath[path]?.entry === b.byPath[path]?.entry,
  );
}

function slicesEq(a: IdentityStateSlices, b: IdentityStateSlices): boolean {
  if (a === b) return true;
  return (
    identityRecordsEq(a.identity, b.identity) &&
    documentsEq(a.documents, b.documents) &&
    filesEq(a.files, b.files)
  );
}

/**
 * Demultiplex the one keyed set into the three populations, grouping the two
 * file populations by their `path` data field. See the module doc for why the
 * row id is never consulted here.
 */
function buildSlices(rows: readonly HeldIdentityRow[]): IdentityStateSlices {
  const documentsByPath: Record<string, IdentityDocumentProjection> = {};
  const filesByPath: Record<string, IdentityFileProjection> = {};
  let identity: IdentityRecordFields | null = null;

  for (const held of rows) {
    const row = held.row;
    switch (row.kind) {
      case "identity":
        identity = row.identity;
        break;
      case "identity-patch":
        // Unreachable: a patch is folded onto the held whole record before the
        // table ever sees it. Kept as an explicit arm so a future row kind is
        // a compile error rather than a silently dropped population.
        break;
      case "document":
        documentsByPath[row.row.path] = {
          path: row.row.path,
          shardRoomId: row.row.shardRoomId,
          fragmentName: row.row.fragmentName,
          updatedAt: row.row.updatedAt,
          provenance: row.row.provenance,
        };
        break;
      case "file":
        filesByPath[row.row.path] = {
          path: row.row.path,
          entry: row.row.entry,
        };
        break;
    }
  }

  const documentPaths = Object.keys(documentsByPath).sort();
  const filePaths = Object.keys(filesByPath).sort();
  return {
    identity,
    documents:
      documentPaths.length === 0
        ? EMPTY_IDENTITY_DOCUMENTS_SLICE
        : { byPath: documentsByPath, allPaths: documentPaths },
    files:
      filePaths.length === 0
        ? EMPTY_IDENTITY_FILES_SLICE
        : { byPath: filesByPath, allPaths: filePaths },
  };
}

export function createIdentityStateReplica(
  sources: IdentityStateReplicaSources,
): IdentityStateReplica {
  const { getCurrentUserId, isDisposed, onChanged } = sources;

  const table: RecordTable<HeldIdentityRow, IdentityStateSlices> =
    createRecordTable(
      {
        rowKey: (row) => row.rowId,
        retractionIdOf: (row) => row.rowId,
        // Every row on this lane is visible to whoever can open the identity.
        isVisibleToUser: () => true,
        supersedesOnSnapshot: (candidate, held) =>
          candidate.revision > held.revision,
        supersedesOnUpsert: (candidate, held) =>
          candidate.revision > held.revision,
        // No recency patch can reach this plane - see the epic lane replica.
        recency: null,
        buildSlice: (visibleRows) => buildSlices(visibleRows),
        slicesEq,
        emptySlice: EMPTY_IDENTITY_STATE_SLICES,
      },
      {
        getCurrentUserId,
        onBeforePublish: () => {},
        onRowServed: () => {},
        onUpsertAdmitted: () => {},
        onRemoval: () => false,
      },
    );

  let cursor: LaneCursor | null = null;
  let epoch: string | null = null;
  let seedTrust: SeedTrust | null = null;
  let shards: readonly AgentIdentityShardAvailability[] = EMPTY_SHARDS;

  /**
   * A row as the table should hold it, with a record patch already folded.
   * `null` means the change must be dropped: a partial record is not a record.
   */
  function heldRowFor(
    row: RecordRow<IdentityStateRow>,
  ): HeldIdentityRow | null {
    if (row.row.kind !== "identity-patch") {
      return { rowId: row.rowId, revision: row.revision, row: row.row };
    }
    const held = table.current().identity;
    if (held === null) return null;
    const patch = row.row.identity;
    return {
      rowId: row.rowId,
      revision: row.revision,
      row: {
        kind: "identity",
        identity: {
          title: patch.title ?? held.title,
          description:
            patch.description === undefined
              ? held.description
              : patch.description,
          evolution: patch.evolution ?? held.evolution,
        },
      },
    };
  }

  function applyChange(change: RecordChange<IdentityStateRow>): boolean {
    if (change.kind === "remove") {
      // The shared table types its removal reason in the chat plane's enum;
      // the mapping is lossless in effect because this plane never publishes
      // its retraction map. See the epic lane replica for the longer note.
      return table.applyRemoval(change.rowId, "deleted") !== null;
    }
    const held = heldRowFor(change.row);
    if (held === null) return false;
    return table.applyUpsert(held, "complete") !== null;
  }

  function applyRecordSnapshot(
    event: Extract<IdentityStateLaneEvent, { kind: "record-snapshot" }>,
  ): ReplicaApplyOutcome {
    epoch = event.watermark.authorityEpoch;
    seedTrust = event.trust;
    const fence = table.ingestSeq();
    const rows: HeldIdentityRow[] = [];
    for (const row of event.rows) {
      const held = heldRowFor(row);
      if (held !== null) rows.push(held);
    }
    const publication = table.applySnapshot(rows, fence);
    cursor = event.watermark;
    if (publication !== null) onChanged();
    return applied(cursor);
  }

  function applyRecordTransaction(
    event: Extract<IdentityStateLaneEvent, { kind: "record-transaction" }>,
  ): ReplicaApplyOutcome {
    if (epoch !== null && event.cursor.authorityEpoch !== epoch) {
      return {
        kind: "requires-replacement",
        reason: "authority-epoch-changed",
      };
    }
    if (cursor !== null && event.cursor.position <= cursor.position) {
      return { kind: "ignored", reason: "duplicate" };
    }
    let moved = false;
    for (const change of event.changes) {
      if (applyChange(change)) moved = true;
    }
    // The cursor advances ONLY here, after every change in the envelope has
    // been offered - never per change, and never on arrival.
    cursor = event.cursor;
    if (moved) onChanged();
    return applied(cursor);
  }

  function applyRecordTrust(
    event: Extract<IdentityStateLaneEvent, { kind: "record-trust" }>,
  ): ReplicaApplyOutcome {
    if (epoch !== null && event.authorityEpoch !== epoch) {
      return { kind: "ignored", reason: "epoch-mismatch" };
    }
    seedTrust = event.trust;
    onChanged();
    return applied(cursor);
  }

  function applyShardAvailability(
    event: Extract<
      IdentityStateLaneEvent,
      { kind: "identity-shard-availability" }
    >,
  ): ReplicaApplyOutcome {
    if (epoch !== null && event.authorityEpoch !== epoch) {
      return { kind: "ignored", reason: "epoch-mismatch" };
    }
    // The WHOLE set, replaced. Never merged - see `IdentityShardAvailabilityEvent`.
    shards = event.shards;
    onChanged();
    return applied(cursor);
  }

  return {
    apply(event: IdentityStateLaneEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      switch (event.kind) {
        case "record-snapshot":
          return applyRecordSnapshot(event);
        case "record-transaction":
          return applyRecordTransaction(event);
        case "record-trust":
          return applyRecordTrust(event);
        case "identity-shard-availability":
          return applyShardAvailability(event);
        case "record-poll-answer":
          // Never emitted by this lane's adapter. Ignored with a reason so a
          // replay that produces one is diagnosable.
          return { kind: "ignored", reason: "before-fence" };
      }
    },

    slices: () => table.current(),
    shards: () => shards,
    appliedCursor: () => cursor,
    authorityEpoch: () => epoch,
    trust: () => seedTrust,

    reset(cause: ReplicaResetCause): void {
      cursor = null;
      epoch = null;
      seedTrust = null;
      shards = EMPTY_SHARDS;
      if (replacesThePositionSpace(cause)) table.forgetRetractions();
      table.applySnapshot([], table.ingestSeq());
      onChanged();
    },
  };
}

const EMPTY_SHARDS: readonly AgentIdentityShardAvailability[] = Object.freeze(
  [],
);

/** Re-exported so the store's tests can assert against one empty reference. */
export { EMPTY_ARRAY };
