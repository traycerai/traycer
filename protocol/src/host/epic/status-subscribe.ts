/**
 * `epic.status.subscribe@1.0` - control lane. No resume cursor: every non-`snapshot` frame kind must project onto the snapshot (except `pong`).
 * Do not terminate the lane on failed open; `dirty: null` and `deletion.state === "unknown"` are not-established, never clean/not-deleted.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  epicLaneEpochFrameFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
// Both enums are frozen by `epic.subscribe@1.x`. Fork a `...V11` copy here if this lane needs a value the monolith never shipped.
import {
  epicCloudSyncStatusSchema,
  epicMigrationPhaseSchema,
} from "@traycer/protocol/host/epic/subscribe";

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);

/**
 * Attribution on `epicDeleted` and the snapshot `deleted` arm. Both members nullable: host may know the epic is gone without knowing who.
 */
export const epicDeletionAttributionSchema = z.object({
  deletedByDisplayName: z.string().nullable(),
  deletedByTraycerUserId: z.string().nullable(),
});
export type EpicDeletionAttribution = z.infer<
  typeof epicDeletionAttributionSchema
>;

/**
 * Deletion as three states: `unknown` is not-established (not "not deleted") and is not a latch across `authorityEpoch` changes.
 */
export const epicDeletionStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }),
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("deleted"),
    attribution: epicDeletionAttributionSchema,
  }),
]);
export type EpicDeletionStatus = z.infer<typeof epicDeletionStatusSchema>;

/**
 * Snapshot projection of a major migration. No `completed` state: `null` covers never-needed and finished. `notAllowed` is terminal and not retryable.
 */
export const epicMigrationStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    progress: z
      .object({
        phase: epicMigrationPhaseSchema,
        chunksDone: z.number().int().nonnegative(),
        chunksTotal: z.number().int().positive(),
      })
      .nullable(),
  }),
  z.object({
    state: z.literal("failed"),
    reason: z.string(),
  }),
  z.object({
    state: z.literal("notAllowed"),
  }),
]);
export type EpicMigrationStatus = z.infer<typeof epicMigrationStatusSchema>;

/**
 * Host-local authorization epoch. Monotonic per host and not comparable across hosts; key it with the tab's `hostId`.
 */
export const epicSecurityEpochSchema = z.number().int().nonnegative();
export type EpicSecurityEpoch = z.infer<typeof epicSecurityEpochSchema>;

/** `epicId` only - no resume cursor at `@1.0`. */
export const epicStatusSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
});
export type EpicStatusSubscribeOpenRequestV10 = z.infer<
  typeof epicStatusSubscribeOpenRequestSchemaV10
>;

/**
 * First frame of each subscribe cycle. Receipt is snapshot completion; until it arrives, every field including `dirty` is unknown.
 */
const epicStatusSubscribeSnapshotFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  ...epicLaneEpochFrameFields,
  securityEpoch: epicSecurityEpochSchema,
  /** Caller's role, or `null` meaning not known here (not "no access"). */
  permissionRole: permissionRoleSchema.nullable(),
  /** Host-observed cloud room state. Pre-open `disconnected` is an observation, not a placeholder. */
  cloudSyncStatus: epicCloudSyncStatusSchema,
  /**
   * Aggregate dirty flag. `null` is not-established (never synthesize `false` pre-open); not a latch across `authorityEpoch` changes.
   */
  dirty: z.boolean().nullable(),
  /** Current migration, or `null` when none is running, failed, or blocked. Truthful pre-open. */
  migration: epicMigrationStatusSchema.nullable(),
  /** Current-state projection of `epicDeleted`. Three states; never a bare nullable. */
  deletion: epicDeletionStatusSchema,
  ...epicLaneTextFrameFields,
});

/** Permission transition stamped with the epoch that produced it. */
const epicStatusSubscribePermissionChangedFrameSchemaV10 = z.object({
  kind: z.literal("permissionChanged"),
  ...epicLaneEpochFrameFields,
  securityEpoch: epicSecurityEpochSchema,
  permissionRole: permissionRoleSchema.nullable(),
  ...epicLaneTextFrameFields,
});

export const epicStatusSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    epicStatusSubscribeSnapshotFrameSchemaV10,
    epicStatusSubscribePermissionChangedFrameSchemaV10,
    /** Host-observed cloud room connection. Client transport can be healthy while this is `disconnected`. */
    z.object({
      kind: z.literal("cloudSyncStatus"),
      ...epicLaneEpochFrameFields,
      status: epicCloudSyncStatusSchema,
      ...epicLaneTextFrameFields,
    }),
    /**
     * Post-snapshot dirty delta. Plain boolean (never null); first frame after a null snapshot is what establishes the fact.
     */
    z.object({
      kind: z.literal("dirtyChanged"),
      ...epicLaneEpochFrameFields,
      dirty: z.boolean(),
      ...epicLaneTextFrameFields,
    }),
    /** Remote deletion of this epic. One-shot and terminal for the epic. */
    z.object({
      kind: z.literal("epicDeleted"),
      ...epicLaneEpochFrameFields,
      attribution: epicDeletionAttributionSchema,
      ...epicLaneTextFrameFields,
    }),
    /** Migration starting. While these frames run, `epic.state.subscribe` holds its snapshot. */
    z.object({
      kind: z.literal("migrationStarted"),
      ...epicLaneEpochFrameFields,
      ...epicLaneTextFrameFields,
    }),
    /** Opaque tick fraction for the active `phase`; only `upload` is determinate. */
    z.object({
      kind: z.literal("migrationProgress"),
      ...epicLaneEpochFrameFields,
      phase: epicMigrationPhaseSchema,
      chunksDone: z.number().int().nonnegative(),
      chunksTotal: z.number().int().positive(),
      ...epicLaneTextFrameFields,
    }),
    /**
     * Terminal for the attempt, not the lane. Emitted instead of a fatal close so `epic.retryMigration` can reuse this session.
     */
    z.object({
      kind: z.literal("migrationFailed"),
      ...epicLaneEpochFrameFields,
      reason: z.string(),
      ...epicLaneTextFrameFields,
    }),
    /** Epic needs a migration this caller cannot perform. Terminal and not retryable. */
    z.object({
      kind: z.literal("migrationNotAllowed"),
      ...epicLaneEpochFrameFields,
      ...epicLaneTextFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStatusSubscribeServerFrameV10 = z.infer<
  typeof epicStatusSubscribeServerFrameSchemaV10
>;

/** `ping` only. Retry is `epic.retryMigration` unary, not a stream frame. */
export const epicStatusSubscribeClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStatusSubscribeClientFrameV10 = z.infer<
  typeof epicStatusSubscribeClientFrameSchemaV10
>;

export const epicStatusSubscribeV10 = defineStreamRpcContract({
  method: "epic.status.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicStatusSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicStatusSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicStatusSubscribeClientFrameSchemaV10,
});
