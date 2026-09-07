/**
 * `epic.state.subscribe@1.0` - records lane. Text-only (`hasBinaryPayload: false`); snapshot-then-deltas on one channel; one lead frame (`snapshot` or `resumed`).
 * Apply upserts only at strictly higher `revision`; removals are terminal and absorbing. Do not derive trust from the control lane's `cloudSyncStatus`.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicLaneCursorSchema,
  epicLaneEpochFrameFields,
  epicLanePositionSchema,
  epicLaneRowRevisionFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
import { commentThreadWireSchema } from "@traycer/protocol/host/epic/unary-schemas";
import {
  deletedReviewArtifactSchema,
  deletedSpecArtifactSchema,
  deletedStoryArtifactSchema,
  deletedTicketArtifactSchema,
  reviewArtifactSchema,
  specArtifactSchema,
  storyArtifactSchema,
  ticketArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import { roleClaimSchema } from "@traycer/protocol/persistence/epic/role-claims";

/**
 * Artifact row on the records lane. `revision` is wire-layer, not persisted; `updatedAt` is display, never ordering. Omit `artifactRoomId`.
 */
export const epicArtifactRecordSchema = z.discriminatedUnion("kind", [
  specArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  ticketArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  storyArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  reviewArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
]);
export type EpicArtifactRecord = z.infer<typeof epicArtifactRecordSchema>;

/**
 * Tombstone counterpart. Absence is not deletion; a lower-revision tombstone still absorbs.
 */
export const epicDeletedArtifactRecordSchema = z.discriminatedUnion("kind", [
  deletedSpecArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedTicketArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedStoryArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedReviewArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
]);
export type EpicDeletedArtifactRecord = z.infer<
  typeof epicDeletedArtifactRecordSchema
>;

/** Epic-level metadata this lane owns. Tab-open context is `epic.getWorkspaceContext`, not this record. */
export const epicMetaSchema = z.object({
  title: z.string(),
  updatedAt: z.number(),
});
export type EpicMeta = z.infer<typeof epicMetaSchema>;

/**
 * Epic meta as one revisioned entity (not per-field). Wrapper, not inline `revision`, because the delta is a partial.
 */
export const epicStateMetaProjectionSchema = z.object({
  ...epicLaneRowRevisionFields,
  meta: epicMetaSchema,
});
export type EpicStateMetaProjection = z.infer<
  typeof epicStateMetaProjectionSchema
>;

/** Meta fields this commit changed. `revision` is required and describes the record after the commit, not the patch. */
export const epicStateMetaPatchSchema = z.object({
  ...epicLaneRowRevisionFields,
  meta: epicMetaSchema.partial(),
});
export type EpicStateMetaPatch = z.infer<typeof epicStateMetaPatchSchema>;

/**
 * Whole-set replacement, revisioned as a set. Treat this lane as authoritative over `agent.roles.list` until that unary carries a revision.
 */
export const epicStateRoleClaimsProjectionSchema = z.object({
  ...epicLaneRowRevisionFields,
  claims: z.array(roleClaimSchema),
});
export type EpicStateRoleClaimsProjection = z.infer<
  typeof epicStateRoleClaimsProjectionSchema
>;

/**
 * Thread row. `commentThreadWireSchema` is frozen by `epic.listCommentThreads@1.0`; fork a versioned copy for the next field. Apply upserts only at strictly higher `revision`.
 */
export const epicCommentThreadRecordSchema = commentThreadWireSchema.extend({
  artifactId: z.string().min(1),
  ...epicLaneRowRevisionFields,
});
export type EpicCommentThreadRecord = z.infer<
  typeof epicCommentThreadRecordSchema
>;

/** Thread removal. Absorbing at any revision; the number records position, it does not gate apply. */
export const epicCommentThreadRemovalSchema = z.object({
  artifactId: z.string().min(1),
  threadId: z.string().min(1),
  ...epicLaneRowRevisionFields,
});
export type EpicCommentThreadRemoval = z.infer<
  typeof epicCommentThreadRemovalSchema
>;

/**
 * Why a full snapshot was sent instead of a resume. Closed enum: widening is a new minor.
 * `authorityEpochChanged` voids per-artifact body state; `resumeTooOld` does not.
 */
export const epicStateSnapshotBasisSchema = z.enum([
  "cold",
  "authorityEpochChanged",
  "resumeTooOld",
]);
export type EpicStateSnapshotBasis = z.infer<
  typeof epicStateSnapshotBasisSchema
>;

/** `resume` is required and nullable: omit vs `null` must not be the same request. */
export const epicStateSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
  /** Furthest applied point on this lane, or `null` for a cold open. Unservable resume yields a snapshot naming the basis, never an error. */
  resume: epicLaneCursorSchema.nullable(),
});
export type EpicStateSubscribeOpenRequestV10 = z.infer<
  typeof epicStateSubscribeOpenRequestSchemaV10
>;

/** Lead frame. Complete replacement of the client's row set, not a merge. */
const epicStateSubscribeSnapshotFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  ...epicLaneEpochFrameFields,
  /** High-water mark of the row set. Drop deltas at or below it. */
  position: epicLanePositionSchema,
  basis: epicStateSnapshotBasisSchema,
  /** Freshness label, not authorization. A later cloud denial terminates the lane; it does not flip this field. */
  reconciledWithCloud: z.boolean(),
  epicMeta: epicStateMetaProjectionSchema,
  artifactRecords: z.array(epicArtifactRecordSchema),
  /** Tombstones ride the snapshot because deleted artifacts still render; removed threads do not. */
  deletedArtifacts: z.array(epicDeletedArtifactRecordSchema),
  roleClaims: epicStateRoleClaimsProjectionSchema,
  /** Live threads only. Removed threads are absent. */
  commentThreads: z.array(epicCommentThreadRecordSchema),
  ...epicLaneTextFrameFields,
});

/**
 * Lead frame: cursor accepted, no rows. Restate `reconciledWithCloud` - trust is the serving host's replica, not inherited session state.
 */
const epicStateSubscribeResumedFrameSchemaV10 = z.object({
  kind: z.literal("resumed"),
  ...epicLaneEpochFrameFields,
  position: epicLanePositionSchema,
  reconciledWithCloud: z.boolean(),
  ...epicLaneTextFrameFields,
});

/**
 * Seed-trust flipped with no row change. Carries no `seq`. Do not derive this from `epic.status.subscribe` `cloudSyncStatus`.
 */
const epicStateSubscribeTrustChangedFrameSchemaV10 = z.object({
  kind: z.literal("trustChanged"),
  ...epicLaneEpochFrameFields,
  reconciledWithCloud: z.boolean(),
  ...epicLaneTextFrameFields,
});

/**
 * One commit, atomically. All six change fields are required (empty/`null` means none, not omitted). Applying one envelope must not yield a tree that could not exist.
 */
const epicStateSubscribeDeltaFrameSchemaV10 = z.object({
  kind: z.literal("delta"),
  ...epicLaneEpochFrameFields,
  /** Lane position of this commit. Persist as the resume cursor only after the envelope is fully applied. */
  seq: epicLanePositionSchema,
  artifactUpserts: z.array(epicArtifactRecordSchema),
  /** Absorbing: do not resurrect from a later upsert in this envelope or a stale held row. */
  artifactTombstones: z.array(epicDeletedArtifactRecordSchema),
  commentThreadUpserts: z.array(epicCommentThreadRecordSchema),
  commentThreadRemovals: z.array(epicCommentThreadRemovalSchema),
  epicMeta: epicStateMetaPatchSchema.nullable(),
  roleClaims: epicStateRoleClaimsProjectionSchema.nullable(),
  ...epicLaneTextFrameFields,
});

/** Hand-declared so the refine can be shared across minors without a circular inferred type. */
type EmptinessCheckedFrame =
  | {
      readonly kind: "delta";
      readonly artifactUpserts: readonly unknown[];
      readonly artifactTombstones: readonly unknown[];
      readonly commentThreadUpserts: readonly unknown[];
      readonly commentThreadRemovals: readonly unknown[];
      readonly epicMeta: unknown;
      readonly roleClaims: unknown;
    }
  | { readonly kind: "snapshot" }
  | { readonly kind: "resumed" }
  | { readonly kind: "trustChanged" }
  | { readonly kind: "pong" };

/** Empty envelopes are invalid: they consume a lane position for a commit that never happened. */
function refineDeltaCarriesChange(
  frame: EmptinessCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "delta") return;
  const carriesChange =
    frame.artifactUpserts.length > 0 ||
    frame.artifactTombstones.length > 0 ||
    frame.commentThreadUpserts.length > 0 ||
    frame.commentThreadRemovals.length > 0 ||
    frame.epicMeta !== null ||
    frame.roleClaims !== null;
  if (carriesChange) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["kind"],
    message:
      "A delta envelope must carry at least one change - an empty envelope consumes a lane position for a commit that never happened.",
  });
}

export const epicStateSubscribeServerFrameSchemaV10 = z
  .discriminatedUnion("kind", [
    epicStateSubscribeSnapshotFrameSchemaV10,
    epicStateSubscribeResumedFrameSchemaV10,
    epicStateSubscribeDeltaFrameSchemaV10,
    epicStateSubscribeTrustChangedFrameSchemaV10,
    z.object({
      kind: z.literal("pong"),
      // No epoch stamp: pong is intercepted before a resolver is selected.
      ...epicLaneTextFrameFields,
    }),
  ])
  .superRefine(refineDeltaCarriesChange);
export type EpicStateSubscribeServerFrameV10 = z.infer<
  typeof epicStateSubscribeServerFrameSchemaV10
>;

/** `ping` only. This lane is read-only; mutations ride unaries with client-generated command ids. */
export const epicStateSubscribeClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStateSubscribeClientFrameV10 = z.infer<
  typeof epicStateSubscribeClientFrameSchemaV10
>;

export const epicStateSubscribeV10 = defineStreamRpcContract({
  method: "epic.state.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicStateSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicStateSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicStateSubscribeClientFrameSchemaV10,
});
