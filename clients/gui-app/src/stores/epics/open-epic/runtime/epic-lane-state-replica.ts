/**
 * The records lane's read model: `epic.state.subscribe@1.0` rows in, the same
 * raw populations the `@1` root doc produces out.
 *
 * This is the second HEAD of one projection, not a second projection. The `@1`
 * head reads artifacts, tombstones, the epic header and the role claims out of
 * a `Y.Doc`; this one decodes them from typed rows. Both hand
 * `EpicRawProjectionSources` to `composeEpicProjection`, which owns the unions,
 * the dead-mutation sweep, the role-claim visibility filter, the optimistic
 * overlay and the tree. That is what makes the cutover's exit line -
 * "indistinguishable to the projection layer from the legacy adapter on
 * identical epic content" - a structural property rather than an aspiration:
 * the only thing two adapters CAN differ on is what they put in, which is
 * exactly what the equivalence test compares.
 *
 * ## One keyed set, one reconciliation
 *
 * The lane carries five populations and the seam gives them one map from
 * `rowId` to row, so this composes ONE `createRecordTable` over the whole
 * `EpicStateRow` union rather than one table per population. That is not a
 * convenience: a `remove` change carries a bare `rowId`, so a per-population
 * table would have to parse the key prefix back apart to decide which table
 * owns it - and `epic-state-rows.ts` states plainly that the prefixes are
 * opaque to the replica and are never parsed by it. One table keyed by the
 * seam's own `rowId` never asks the question.
 *
 * `buildSlice` is where the union is demultiplexed, by `row.kind`, once per
 * recompute. Everything above it sees five ordinary slices.
 *
 * ## `epic-meta-patch` is merged BEFORE the table sees it
 *
 * The table's upsert REPLACES the row it holds, which is right for every other
 * population and wrong for exactly one: a delta's `epicMeta` carries only the
 * fields that commit changed, and installing it wholesale drops the field the
 * host deliberately did not restate. So a patch is folded onto the held whole
 * value here and handed down as a whole `epic-meta` row at the patch's own
 * revision. The alternative - teaching the shared table to merge - would put a
 * population-specific rule inside the one algorithm every plane shares.
 *
 * A patch with nothing held is dropped rather than installed as if it were
 * whole: a partial `EpicMeta` is not an `EpicMeta`, and the snapshot that
 * establishes the entity is the only thing that may create it.
 *
 * ## What this replica does NOT do
 *
 * It does not consume `epic.listCommentThreads`. The seam's
 * `RecordPollAnswerEvent` is in the union because the same replica shape serves
 * a polled plane elsewhere, but that unary answers PER ARTIFACT, and feeding a
 * one-artifact answer through a whole-set snapshot would retract every artifact
 * row, every claim and the epic header along with the threads it did not carry.
 * A scoped-snapshot arm is a second reconciliation algorithm by another name.
 * The poll therefore stays where it is - `epic.listCommentThreads` is on the
 * released floor, so it is the source on EVERY host and the cold-read path on
 * both arms - and consumers prefer whichever source has spoken about the
 * artifact in hand.
 *
 * It also does not decide replacement. A frame whose epoch is not this
 * replica's answers `"requires-replacement"` and the RUNTIME drives the
 * rebuild, so two lanes reporting one epoch change coalesce into a single
 * replacement instead of racing two.
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
 * A lane row as the table holds it: the seam's envelope, flattened.
 *
 * The revision is lifted out of `RecordRow` and onto the held row because the
 * shared table's staleness test is `(candidate, held) => boolean` over the ROW,
 * not over the envelope - so a row that kept its revision one level up could
 * not be judged at all.
 */
interface HeldLaneRow {
  readonly rowId: string;
  readonly revision: number;
  readonly row: EpicStateRow;
}

/**
 * The populations this lane produces, in the shape the shared composition
 * consumes. A subset of `EpicRawProjectionSources` - the doc arms are not this
 * head's to produce - plus the comment threads, which the `@1` head has no
 * source for at all.
 */
export interface EpicLaneStateSlices {
  readonly artifacts: ArtifactsSlice;
  readonly deletedArtifacts: DeletedArtifactsSlice;
  readonly epicHeader: EpicHeader;
  readonly roleClaims: readonly RoleClaim[];
  readonly commentThreads: CommentThreadsSlice;
}

/**
 * The lane head's populations before its first snapshot. Exported because the
 * records replica holds this as its starting value on the lane arm - one shared
 * reference, so a session that has not yet heard from the lane publishes the
 * same empty projection every time it recomputes.
 */
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
  /**
   * The furthest point on this lane this replica has fully APPLIED, or `null`
   * when it holds nothing.
   *
   * This is what the state adapter's `readAppliedCursor` must be wired to, and
   * the distinction is the whole reason it lives on the replica: an
   * adapter-held arrival counter would advance on a delta the replica ignored -
   * a stale revision, an absorbed tombstone, a torn apply - and the next resume
   * would ask the host to continue from work this client never finished. It
   * moves only after the envelope is fully applied, never before.
   */
  appliedCursor(): LaneCursor | null;
  /** The epoch this replica's rows belong to, or `null` before the first lead. */
  authorityEpoch(): string | null;
  /**
   * The serving host's trust in the rows it sent, or `null` before any lead.
   * Current-session state: a restart under the same epoch surfaces `false`
   * only via a fresh lead, and there is never a mid-session `trustChanged`
   * carrying `false`.
   */
  trust(): SeedTrust | null;
  reset(cause: ReplicaResetCause): void;
}

function applied(cursor: LaneCursor | null): ReplicaApplyOutcome {
  return { kind: "applied", cursor };
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
    // Reference equality per thread: every thread object on this lane is
    // rebuilt only when its own row is re-ingested, so a recompute that
    // re-groups untouched threads hands back the same objects.
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

/**
 * Demultiplex the one keyed set into the five populations.
 *
 * The `@1` head's own field-for-field mapping, applied to typed rows instead of
 * `Y.Map` reads - so a field that means one thing in one head cannot mean
 * another in the other. Where the wire row already IS the projection's shape
 * (comment threads), it is passed through by reference rather than copied, so a
 * recompute that touched one artifact does not churn every thread object.
 */
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
          // ALWAYS `null` on this head, and structurally so: the lane's
          // artifact row OMITS `artifactRoomId` (`epicArtifactRecordSchema`
          // strips it from every arm), because room routing is not this
          // wire's addressing model - a body is attached by ARTIFACT ID over
          // `artifact.subscribe`, under an authority epoch, and there is no
          // room name to carry. Synthesising one would be a fabricated
          // authority-side fact; leaving it null says exactly what the lane
          // knows. This is the one projected field the two heads cannot agree
          // on, and the equivalence test states it rather than papering over
          // it.
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
        const bucket = threadsByArtifactId[record.artifactId];
        // The wire row extends `commentThreadWireSchema` verbatim, so the
        // thread the surface reads IS this row minus the two fields the lane
        // wrapped it in. Passed by reference - a copy here would hand every
        // consumer a fresh object on every unrelated recompute.
        if (bucket === undefined) {
          threadsByArtifactId[record.artifactId] = [record];
        } else {
          bucket.push(record);
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
        // Unreachable: a patch is folded onto the held whole value before the
        // table ever sees it (see the module doc), so nothing of this shape is
        // ever HELD. Kept as an explicit arm rather than a default so a future
        // row kind is a compile error here instead of a silently dropped
        // population.
        break;
    }
  }

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

/**
 * This head's populations, in the shape the shared composition consumes.
 *
 * The doc arms are EMPTY here and that is structural rather than a stub: a lane
 * connection has no root `Y.Doc`, so there is no doc-side chat or terminal-agent
 * entry to union in, and the record plane covers both populations on any host
 * that serves the lanes at all. Production and the equivalence test go through
 * this one function so the test cannot prove a mapping the runtime does not use.
 */
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
        /**
         * The same key the row is held by. A lane `remove` names one `rowId`
         * exactly, so the shared algorithm's coarser-removal arm has nothing to
         * hit here - unlike the chat plane, whose removal frame carries no owner.
         */
        retractionIdOf: (row) => row.rowId,
        /**
         * Every row on this lane is visible to whoever can see the epic. Artifacts,
         * tombstones and comment threads have no owner at all, and the role-claim
         * SET is filtered per viewer downstream, inside the shared composition,
         * where the chats and terminal agents it is filtered against are also in
         * hand. Filtering here would need a claim set this table cannot see the
         * inputs for.
         */
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
        // This plane holds no optimistic stand-ins and no provenance marks: the
        // overlay's record-plane marks are the chat and terminal planes' concern,
        // and an artifact's optimistic rename rides the metadata overlay, which
        // reads the composed projection rather than this table.
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

  /**
   * A row as the table should hold it, with a metadata patch already folded.
   *
   * `null` means the change must be dropped: a patch with nothing held is a
   * partial `EpicMeta`, and a partial is not an `EpicMeta`. Only a snapshot may
   * establish the entity.
   */
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
      // - a chat-plane enum on the one algorithm every plane shares, which is a
      // seam wart rather than a statement about this lane. It is carried into a
      // retraction map that THIS plane never publishes (only the chat and
      // terminal planes surface `chatRetractions`), so the mapping is lossless
      // in effect; the adapter's own closed constant
      // (`ARTIFACT_TOMBSTONE_REMOVE_REASON` / `COMMENT_THREAD_REMOVE_REASON`)
      // stays the diagnostic, and both of them ARE deletions.
      return table.applyRemoval(change.rowId, "deleted") !== null;
    }
    const held = heldRowFor(change.row);
    if (held === null) return false;
    return table.applyUpsert(held) !== null;
  }

  return {
    apply(event: EpicStateLaneEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      switch (event.kind) {
        case "record-snapshot": {
          epoch = event.watermark.authorityEpoch;
          seedTrust = event.trust;
          // The fence is "everything currently held is older than this answer",
          // which is exactly true for a lane snapshot: it is the authority's
          // complete row set at a watermark the client has not reached. Passing
          // the poll's `null` would use the previous answer's fence and retain
          // rows this snapshot deliberately omits.
          const fence = table.ingestSeq();
          const rows: HeldLaneRow[] = [];
          for (const row of event.rows) {
            const held = heldRowFor(row);
            // A snapshot never carries a patch - the contract restates the
            // metadata whole - so `null` here would be a contract violation
            // rather than a drop worth tolerating silently. Skipping it keeps
            // the apply total; the row simply does not exist.
            if (held !== null) rows.push(held);
          }
          const publication = table.applySnapshot(rows, fence);
          cursor = event.watermark;
          if (publication !== null) onChanged();
          return applied(cursor);
        }
        case "record-transaction": {
          if (epoch !== null && event.cursor.authorityEpoch !== epoch) {
            // The epoch moved. The replica does not rebuild itself: the runtime
            // does, so two lanes reporting one change coalesce into one
            // replacement instead of racing.
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
          // The cursor advances ONLY here, after every change in the envelope
          // has been offered to the replica - never per change, and never on
          // arrival. A position persisted mid-envelope would let a resume ask
          // the host to continue past a tombstone this client had not absorbed.
          cursor = event.cursor;
          if (moved) onChanged();
          return applied(cursor);
        }
        case "record-trust": {
          if (epoch !== null && event.authorityEpoch !== epoch) {
            return { kind: "ignored", reason: "epoch-mismatch" };
          }
          // OVERWRITE, with no revision guard: trust is not an entity, the host
          // is its sole writer, and there is nothing to be stale against. It
          // arrives from the `trustChanged` transition AND from every `resumed`
          // lead, because a resuming client cannot inherit it - the serving
          // host may have restarted seed-only since the cursor was persisted.
          seedTrust = event.trust;
          onChanged();
          return applied(cursor);
        }
        case "record-poll-answer":
          // Never emitted by this lane's adapter, and deliberately not wired -
          // see the module doc. Ignored with a reason rather than dropped, so a
          // replay that produces one is a diagnosable event.
          return { kind: "ignored", reason: "before-fence" };
      }
    },

    slices: () => table.current(),
    appliedCursor: () => cursor,
    authorityEpoch: () => epoch,
    trust: () => seedTrust,

    reset(_cause: ReplicaResetCause): void {
      // Everything goes, including the epoch and the trust: a replica that kept
      // its watermark would offer a resume for a position space that has been
      // replaced, and one that kept `reconciled-with-cloud` would label the
      // next host's seed bytes with the previous host's verdict.
      cursor = null;
      epoch = null;
      seedTrust = null;
      table.applySnapshot([], table.ingestSeq());
      onChanged();
    },
  };
}
