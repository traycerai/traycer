/**
 * One record table over the whole EpicStateRow union; prefixes are opaque.
 * Merge epic-meta-patch before the table sees it; a patch with nothing held is dropped.
 */
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { EpicMeta } from "@traycer/protocol/host/epic/state-subscribe";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicStateLaneEvent,
  EpicStateRow,
} from "@traycer-clients/shared/epic-lanes";
import type {
  LaneCursor,
  RecordChange,
  RecordRow,
  ReplicaApplyOutcome,
  ReplicaResetCause,
  SeedTrust,
} from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  CommentThreadsSlice,
  DeletedArtifactProjection,
  DeletedArtifactsSlice,
  EpicHeader,
} from "../types";
import {
  EMPTY_ARRAY,
  EMPTY_CHATS_SLICE,
  EMPTY_COMMENT_THREADS_SLICE,
  EMPTY_PROJECTED_SLICES,
  EMPTY_TERMINAL_AGENTS_SLICE,
} from "../types";
import type { EpicRawProjectionSources } from "../projection-helpers";
import { artifactProjectionsEq, arrayShallowEq } from "../projection-helpers";
import { createRecordTable, type RecordTable } from "./record-table";

/**
 * Whether a reset means the next snapshot may come from a store that never saw this session's
 * removals. The question the absorbing-retraction rule turns on.
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
interface HeldLaneRow {
  readonly rowId: string;
  readonly revision: number;
  readonly row: EpicStateRow;
}

/** The populations this lane produces, in the shape the shared composition consumes. */
export interface EpicLaneStateSlices {
  readonly artifacts: ArtifactsSlice;
  readonly deletedArtifacts: DeletedArtifactsSlice;
  readonly epicHeader: EpicHeader;
  readonly roleClaims: readonly RoleClaim[];
  readonly commentThreads: CommentThreadsSlice;
}

/** The lane head's populations before its first snapshot. */
export const EMPTY_LANE_STATE_SLICES: EpicLaneStateSlices = Object.freeze({
  artifacts: EMPTY_PROJECTED_SLICES.artifacts,
  deletedArtifacts: EMPTY_PROJECTED_SLICES.deletedArtifacts,
  epicHeader: EMPTY_PROJECTED_SLICES.epic,
  roleClaims: Object.freeze([]),
  commentThreads: EMPTY_COMMENT_THREADS_SLICE,
});

export interface EpicLaneStateReplicaSources {
  readonly getCurrentUserId: () => string | null;
  readonly isDisposed: () => boolean;
  /** Called once per envelope that actually changed the slices. */
  readonly onChanged: () => void;
}

export interface EpicLaneStateReplica {
  apply(event: EpicStateLaneEvent): ReplicaApplyOutcome;
  /** The populations, as last recomputed. */
  slices(): EpicLaneStateSlices;
  /** The furthest point on this lane this replica has fully APPLIED, or `null` when it holds nothing. */
  appliedCursor(): LaneCursor | null;
  /** The epoch this replica's rows belong to, or `null` before the first lead. */
  authorityEpoch(): string | null;
  /** The serving host's trust in the rows it sent, or `null` before any lead. */
  trust(): SeedTrust | null;
  reset(cause: ReplicaResetCause): void;
}

function applied(cursor: LaneCursor | null): ReplicaApplyOutcome {
  return { kind: "applied", cursor };
}

/** Give every artifact the lane knows about, and has no threads for, an AUTHORITATIVELY EMPTY list. */
function seedAuthoritativeEmptyThreadLists(
  threadsByArtifactId: Record<string, CommentThreadWire[]>,
  artifactIds: readonly string[],
): void {
  for (const artifactId of artifactIds) {
    if (Object.hasOwn(threadsByArtifactId, artifactId)) continue;
    threadsByArtifactId[artifactId] = [];
  }
}

function commentThreadsEq(
  a: CommentThreadsSlice,
  b: CommentThreadsSlice,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a.byArtifactId);
  const bKeys = Object.keys(b.byArtifactId);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    if (!Object.hasOwn(b.byArtifactId, key)) return false;
    const left = a.byArtifactId[key];
    const right = b.byArtifactId[key];
    if (left === right) return true;
    if (left.length !== right.length) return false;
    // Reference equality per thread: every thread object on this lane is rebuilt only when its own row
    // is re-ingested, so a recompute that re-groups untouched threads hands back the same objects.
    return left.every((thread, index) => thread === right[index]);
  });
}

function artifactsSliceEq(a: ArtifactsSlice, b: ArtifactsSlice): boolean {
  if (a === b) return true;
  if (!arrayShallowEq(a.allIds, b.allIds)) return false;
  return a.allIds.every((id) => artifactProjectionsEq(a.byId[id], b.byId[id]));
}

function deletedArtifactsSliceEq(
  a: DeletedArtifactsSlice,
  b: DeletedArtifactsSlice,
): boolean {
  if (a === b) return true;
  if (!arrayShallowEq(a.allIds, b.allIds)) return false;
  return a.allIds.every((id) => {
    const left = a.byId[id];
    const right = b.byId[id];
    return (
      left.id === right.id &&
      left.kind === right.kind &&
      left.title === right.title &&
      left.deletedAt === right.deletedAt &&
      left.status === right.status
    );
  });
}

function laneSlicesEq(a: EpicLaneStateSlices, b: EpicLaneStateSlices): boolean {
  if (a === b) return true;
  return (
    artifactsSliceEq(a.artifacts, b.artifacts) &&
    deletedArtifactsSliceEq(a.deletedArtifacts, b.deletedArtifacts) &&
    a.epicHeader.title === b.epicHeader.title &&
    a.epicHeader.updatedAt === b.epicHeader.updatedAt &&
    arrayShallowEq(
      a.roleClaims.map((claim) => claim.claimId),
      b.roleClaims.map((claim) => claim.claimId),
    ) &&
    commentThreadsEq(a.commentThreads, b.commentThreads)
  );
}

/** Demultiplex the one keyed set into the five populations. */
function buildLaneSlices(rows: readonly HeldLaneRow[]): EpicLaneStateSlices {
  const artifactsById: Record<string, ArtifactProjection> = {};
  const artifactIds: string[] = [];
  const deletedById: Record<string, DeletedArtifactProjection> = {};
  const deletedIds: string[] = [];
  const threadsByArtifactId: Record<string, CommentThreadWire[]> = {};
  let roleClaims: readonly RoleClaim[] = EMPTY_LANE_STATE_SLICES.roleClaims;
  let epicHeader: EpicHeader = EMPTY_LANE_STATE_SLICES.epicHeader;

  for (const held of rows) {
    const row = held.row;
    switch (row.kind) {
      case "artifact": {
        const record = row.record;
        artifactsById[record.id] = {
          id: record.id,
          kind: record.kind,
          title: record.title,
          folderName: record.folderName,
          parentId: record.parentId,
          // ALWAYS `null` on this head, and structurally so: the lane's artifact row OMITS `artifactRoomId`
          // (`epicArtifactRecordSchema` strips it from every arm), because room routing is not this wire's
          artifactRoomId: null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          // Only ticket and story carry a status; the union is discriminated on
          // `kind`, exactly as the `@1` head's `projectArtifact` narrows it.
          status:
            record.kind === "ticket" || record.kind === "story"
              ? record.status
              : null,
          createdManually: record.createdManually,
        };
        artifactIds.push(record.id);
        break;
      }
      case "artifact-tombstone": {
        const record = row.record;
        deletedById[record.id] = {
          id: record.id,
          kind: record.kind,
          title: record.title,
          deletedAt: record.deletedAt,
          status:
            record.kind === "ticket" || record.kind === "story"
              ? record.status
              : null,
        };
        deletedIds.push(record.id);
        break;
      }
      case "comment-thread": {
        const record = row.record;
        // The wire row extends `commentThreadWireSchema` verbatim, so the thread the surface reads IS this
        // row minus the two fields the lane wrapped it in.
        if (Object.hasOwn(threadsByArtifactId, record.artifactId)) {
          threadsByArtifactId[record.artifactId].push(record);
        } else {
          threadsByArtifactId[record.artifactId] = [record];
        }
        break;
      }
      case "role-claims":
        roleClaims = row.claims;
        break;
      case "epic-meta":
        epicHeader = { title: row.meta.title, updatedAt: row.meta.updatedAt };
        break;
      case "epic-meta-patch":
        // Unreachable: a patch is folded onto the held whole value before the table ever sees it (see the
        // module doc), so nothing of this shape is ever HELD.
        break;
    }
  }

  seedAuthoritativeEmptyThreadLists(threadsByArtifactId, artifactIds);

  return {
    artifacts: {
      byId: artifactsById,
      allIds: artifactIds.length === 0 ? EMPTY_ARRAY : artifactIds,
    },
    deletedArtifacts: {
      byId: deletedById,
      allIds: deletedIds.length === 0 ? EMPTY_ARRAY : deletedIds,
    },
    epicHeader,
    roleClaims,
    commentThreads:
      Object.keys(threadsByArtifactId).length === 0
        ? EMPTY_COMMENT_THREADS_SLICE
        : { byArtifactId: threadsByArtifactId },
  };
}

/** This head's populations, in the shape the shared composition consumes. */
export function laneRawProjectionSources(
  slices: EpicLaneStateSlices,
): EpicRawProjectionSources {
  return {
    artifacts: slices.artifacts,
    deletedArtifacts: slices.deletedArtifacts,
    docChats: EMPTY_CHATS_SLICE,
    docTuiAgents: EMPTY_TERMINAL_AGENTS_SLICE,
    epicHeader: slices.epicHeader,
    roleClaims: slices.roleClaims,
  };
}

export function createEpicLaneStateReplica(
  sources: EpicLaneStateReplicaSources,
): EpicLaneStateReplica {
  const { getCurrentUserId, isDisposed, onChanged } = sources;

  const table: RecordTable<HeldLaneRow, EpicLaneStateSlices> =
    createRecordTable(
      {
        rowKey: (row) => row.rowId,
        /** The same key the row is held by. */
        retractionIdOf: (row) => row.rowId,
        /** Every row on this lane is visible to whoever can see the epic. */
        isVisibleToUser: () => true,
        supersedesOnSnapshot: (candidate, held) =>
          candidate.revision > held.revision,
        supersedesOnUpsert: (candidate, held) =>
          candidate.revision > held.revision,
        buildSlice: (visibleRows) => buildLaneSlices(visibleRows),
        slicesEq: laneSlicesEq,
        emptySlice: EMPTY_LANE_STATE_SLICES,
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

  /** The whole `EpicMeta` currently held, for folding a patch onto. */
  function heldEpicMeta(): EpicMeta | null {
    const header = table.current().epicHeader;
    if (header === EMPTY_LANE_STATE_SLICES.epicHeader) return null;
    return { title: header.title, updatedAt: header.updatedAt };
  }

  /** A row as the table should hold it, with a metadata patch already folded. */
  function heldRowFor(row: RecordRow<EpicStateRow>): HeldLaneRow | null {
    if (row.row.kind !== "epic-meta-patch") {
      return { rowId: row.rowId, revision: row.revision, row: row.row };
    }
    const held = heldEpicMeta();
    if (held === null) return null;
    return {
      rowId: row.rowId,
      revision: row.revision,
      row: { kind: "epic-meta", meta: { ...held, ...row.row.meta } },
    };
  }

  function applyChange(change: RecordChange<EpicStateRow>): boolean {
    if (change.kind === "remove") {
      // The shared table types its removal reason as `ChatRecordRemovalReason`
      return table.applyRemoval(change.rowId, "deleted") !== null;
    }
    const held = heldRowFor(change.row);
    if (held === null) return false;
    return table.applyUpsert(held) !== null;
  }

  function applyRecordSnapshot(
    event: Extract<EpicStateLaneEvent, { kind: "record-snapshot" }>,
  ): ReplicaApplyOutcome {
    epoch = event.watermark.authorityEpoch;
    seedTrust = event.trust;
    // The fence is "everything currently held is older than this answer", which is exactly true for a
    // lane snapshot: it is the authority's complete row set at a watermark the client has not reached.
    const fence = table.ingestSeq();
    const rows: HeldLaneRow[] = [];
    for (const row of event.rows) {
      const held = heldRowFor(row);
      // A snapshot never carries a patch - the contract restates the metadata whole - so `null` here
      // would be a contract violation rather than a drop worth tolerating silently.
      if (held !== null) rows.push(held);
    }
    const publication = table.applySnapshot(rows, fence);
    cursor = event.watermark;
    if (publication !== null) onChanged();
    return applied(cursor);
  }

  function applyRecordTransaction(
    event: Extract<EpicStateLaneEvent, { kind: "record-transaction" }>,
  ): ReplicaApplyOutcome {
    if (epoch !== null && event.cursor.authorityEpoch !== epoch) {
      // The epoch moved. The replica does not rebuild itself: the runtime does, so two lanes reporting
      // one change coalesce into one replacement instead of racing.
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
    // The cursor advances ONLY here, after every change in the envelope has been offered to the
    // replica - never per change, and never on arrival.
    cursor = event.cursor;
    if (moved) onChanged();
    return applied(cursor);
  }

  function applyRecordTrust(
    event: Extract<EpicStateLaneEvent, { kind: "record-trust" }>,
  ): ReplicaApplyOutcome {
    if (epoch !== null && event.authorityEpoch !== epoch) {
      return { kind: "ignored", reason: "epoch-mismatch" };
    }
    // OVERWRITE, with no revision guard: trust is not an entity, the host is its sole writer, and
    // there is nothing to be stale against.
    seedTrust = event.trust;
    onChanged();
    return applied(cursor);
  }

  return {
    apply(event: EpicStateLaneEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      switch (event.kind) {
        case "record-snapshot":
          return applyRecordSnapshot(event);
        case "record-transaction":
          return applyRecordTransaction(event);
        case "record-trust":
          return applyRecordTrust(event);
        case "record-poll-answer":
          // Never emitted by this lane's adapter, and deliberately not wired - see the module doc. Ignored
          // with a reason rather than dropped, so a replay that produces one is a diagnosable event.
          return { kind: "ignored", reason: "before-fence" };
      }
    },

    slices: () => table.current(),
    appliedCursor: () => cursor,
    authorityEpoch: () => epoch,
    trust: () => seedTrust,

    reset(cause: ReplicaResetCause): void {
      // Everything goes, including the epoch and the trust: a replica that kept its watermark would
      // offer a resume for a position space that has been replaced, and one that kept
      cursor = null;
      epoch = null;
      seedTrust = null;
      // ...and, for a REPLACEMENT, the absorbed retractions with them.
      if (replacesThePositionSpace(cause)) table.forgetRetractions();
      table.applySnapshot([], table.ingestSeq());
      onChanged();
    },
  };
}
