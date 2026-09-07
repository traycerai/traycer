/**
 * `epic.subscribe@1.0` - legacy Y.Doc subscription; `@1.0`-`@1.3` are released and frozen. New work goes on the lanes (`epic.state.subscribe`, `epic.status.subscribe`, `artifact.subscribe`).
 * Root frames omit `artifactRoomId`; artifact-room frames must carry it. Comment threads ride Y.Doc `update` - no typed `commentThread` frame.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);
import {
  earlyMetaEpicSchema,
  snapshotMetaEpicSchema,
  snapshotMetaEpicSchemaV10,
  snapshotMetaEpicSchemaV12,
} from "@traycer/protocol/host/epic/snapshot-meta";

/**
 * The frozen `@1.0` / `@1.1` / `@1.2` open request, as shipped.
 * IMMUTABLE, like every other frozen-per-minor shape in this file.
 */
export const epicSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string(),
});
export type EpicSubscribeOpenRequestV10 = z.infer<
  typeof epicSubscribeOpenRequestSchemaV10
>;

/**
 * A reattaching client's offer of the root-doc state it ALREADY holds, so the host can answer with a Yjs delta instead of re-shipping the whole document.
 */
export const epicSubscribeClientSeedOfferSchema = z.object({
  /** Base64-encoded `Y.encodeStateVector` of the live root Epic doc the client still holds. */
  stateVectorBase64: z.string().min(1),
  /**
   * The room the offered state came from - the `roomId` off the snapshot meta that seeded this client's doc.
   * A client that cannot name its room - one seeded by a pre-`@1.2` host, which never sent `roomId` - therefore sends NO offer and takes a full snapshot rather than guessing.
   */
  roomId: z.string().min(1),
});
export type EpicSubscribeClientSeedOffer = z.infer<
  typeof epicSubscribeClientSeedOfferSchema
>;

/**
 * The LATEST installed open request (`@1.3`): the frozen shape plus an optional {@link epicSubscribeClientSeedOfferSchema}.
 * A `.default()` request field materializes a key the caller never wrote, which splits the GUI's query cache between the caller's params and the parsed params for what is logically one subscription.
 */
export const epicSubscribeOpenRequestSchema =
  epicSubscribeOpenRequestSchemaV10.extend({
    seedOffer: epicSubscribeClientSeedOfferSchema.optional(),
  });
export type EpicSubscribeOpenRequest = z.infer<
  typeof epicSubscribeOpenRequestSchema
>;

/**
 * Per-artifact-room availability surfaced to the GUI. Mirrors
 * `EpicArtifactRoomManager`'s {@link ArtifactRoomAvailability}.
 */
export const epicArtifactRoomAvailabilitySchema = z.enum([
  "ready",
  "unavailable",
  "retrying",
]);
export type EpicArtifactRoomAvailability = z.infer<
  typeof epicArtifactRoomAvailabilitySchema
>;

/** Coarse phase reported alongside `migrationProgress` frames. */
export const epicMigrationPhaseSchema = z.enum([
  "prepare",
  "upload",
  "finalize",
]);
export type EpicMigrationPhase = z.infer<typeof epicMigrationPhaseSchema>;

/** Host-observed Tiptap/cloud room connection state for the opened Epic. */
export const epicCloudSyncStatusSchema = z.enum([
  "connected",
  "reconnecting",
  "disconnected",
]);
export type EpicCloudSyncStatus = z.infer<typeof epicCloudSyncStatusSchema>;

// ─── Frozen `epic.subscribe@1.0` server-frame set (as shipped) ────────────

/** The frozen `@1.0`/`@1.1` snapshot frame. */
const epicSubscribeSnapshotServerFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  epicId: z.string(),
  meta: snapshotMetaEpicSchemaV10,
  hasBinaryPayload: z.literal(true),
});

/**
 * Every frozen `@1.0` frame EXCEPT `snapshot`, shared verbatim by `@1.0`, `@1.1` and `@1.2`: across those three minors only the snapshot frame's `meta` differs, so this remainder is defined once and spread into each.
 */
const epicSubscribeSharedNonSnapshotServerFrameSchemasV10 = [
  /**
   * Metadata-only frame emitted at the start of the `epic.subscribe` lifecycle, BEFORE the host's Tiptap WS sync completes.
   */
  z.object({
    kind: z.literal("earlyMeta"),
    epicId: z.string(),
    meta: earlyMetaEpicSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("update"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("awareness"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("permissionChanged"),
    epicId: z.string(),
    permissionRole: permissionRoleSchema.nullable(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("cloudSyncStatus"),
    epicId: z.string(),
    status: epicCloudSyncStatusSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("artifactRoomSnapshot"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    /**
     * Base64-encoded `Y.encodeStateVector` of the host-side artifactRoom Y.Doc AFTER applying the bytes carried by this frame.
     */
    hostArtifactRoomStateVectorBase64: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("artifactRoomUpdate"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    /**
     * Base64-encoded `Y.encodeStateVector` of the host-side artifactRoom Y.Doc AFTER applying the update bytes carried by this frame.
     */
    hostArtifactRoomStateVectorBase64: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("artifactRoomAwareness"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("artifactRoomState"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    state: epicArtifactRoomAvailabilitySchema,
    hasBinaryPayload: z.literal(false),
  }),
  /** One-shot signal that the host is about to begin a major migration for this epic. */
  z.object({
    kind: z.literal("migrationStarted"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  /** Progress update for an in-flight major migration. */
  z.object({
    kind: z.literal("migrationProgress"),
    epicId: z.string(),
    phase: epicMigrationPhaseSchema,
    chunksDone: z.number().int().nonnegative(),
    chunksTotal: z.number().int().positive(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * Terminal failure signal for an in-flight major migration.
   * `reason` is a short, user-safe summary used only for host-side logging; the modal copy is fixed and never displays this string.
   */
  z.object({
    kind: z.literal("migrationFailed"),
    epicId: z.string(),
    reason: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * One-shot, terminal signal that this epic needs a major migration but the caller lacks the write access (owner/editor) required to perform it.
   * Distinct from `migrationFailed` precisely because a retry from this caller can never succeed.
   */
  z.object({
    kind: z.literal("migrationNotAllowed"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("epicDeleted"),
    epicId: z.string(),
    deletedByDisplayName: z.string().nullable(),
    deletedByTraycerUserId: z.string().nullable(),
    hasBinaryPayload: z.literal(false),
  }),
] as const;

/**
 * The complete frozen `@1.0` frame set: `snapshot` followed by the remainder, in their original order, so `@1.0`/`@1.1` union membership is byte-for-byte what shipped.
 */
const epicSubscribeSharedServerFrameSchemasV10 = [
  epicSubscribeSnapshotServerFrameSchemaV10,
  ...epicSubscribeSharedNonSnapshotServerFrameSchemasV10,
] as const;

export const epicSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  epicSubscribeSharedServerFrameSchemasV10,
);

/**
 * Per-artifact-room sync-state signal: the room holds local work the host's cloud connection has not acknowledged (unsynced provider updates, an unflushed in-memory buffer, or a retained durable pending row).
 * A @1.1 client against an old host must treat dirtiness as **unknown**, not clean.
 */
const epicSubscribeArtifactRoomDirtyServerFrameSchema = z.object({
  kind: z.literal("artifactRoomDirty"),
  epicId: z.string(),
  artifactRoomId: z.string().min(1),
  dirty: z.boolean(),
  hasBinaryPayload: z.literal(false),
});

/** Root-doc transition delta after the cycle's `dirtySnapshot`. */
const epicSubscribeRootDirtyServerFrameSchema = z.object({
  kind: z.literal("rootDirty"),
  epicId: z.string(),
  dirty: z.boolean(),
  hasBinaryPayload: z.literal(false),
});

/** Atomic per-subscription dirtiness snapshot for `@1.1`. */
const epicSubscribeDirtySnapshotServerFrameSchema = z.object({
  kind: z.literal("dirtySnapshot"),
  epicId: z.string(),
  rootDirty: z.boolean(),
  rooms: z.array(
    z.object({
      artifactRoomId: z.string().min(1),
      dirty: z.boolean(),
    }),
  ),
  hasBinaryPayload: z.literal(false),
});

// ─── `epic.subscribe@1.1` - additive: dirtySnapshot + dirty deltas ────────
// Both minors share the same V10 base array so the frozen set cannot drift.
export const epicSubscribeServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  ...epicSubscribeSharedServerFrameSchemasV10,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.2` - additive: room identity on snapshot meta ──────

/**
 * The `@1.2` snapshot frame - identical to {@link epicSubscribeSnapshotServerFrameSchemaV10} except that `meta` carries the room identity.
 */
const epicSubscribeSnapshotServerFrameSchemaV12 = z.object({
  kind: z.literal("snapshot"),
  epicId: z.string(),
  meta: snapshotMetaEpicSchemaV12,
  hasBinaryPayload: z.literal(true),
});

export const epicSubscribeServerFrameSchemaV12 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV12,
  ...epicSubscribeSharedNonSnapshotServerFrameSchemasV10,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.3` - additive: delta-seeded reattach ───────────────
// `@1.0`-`@1.2` stay installed and FROZEN, on both the request and the meta.

/**
 * The `@1.3` snapshot frame - identical to {@link epicSubscribeSnapshotServerFrameSchemaV12} except that `meta` can carry the delta-seed basis marker.
 */
const epicSubscribeSnapshotServerFrameSchemaV13 = z.object({
  kind: z.literal("snapshot"),
  epicId: z.string(),
  meta: snapshotMetaEpicSchema,
  hasBinaryPayload: z.literal(true),
});

export const epicSubscribeServerFrameSchemaV13 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV13,
  ...epicSubscribeSharedNonSnapshotServerFrameSchemasV10,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

/** The latest installed shape. Host code builds frames against this. */
export const epicSubscribeServerFrameSchema = epicSubscribeServerFrameSchemaV13;
export type EpicSubscribeServerFrame = z.infer<
  typeof epicSubscribeServerFrameSchema
>;

export const epicSubscribeClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("applyUpdate"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("awareness"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("artifactRoomApplyUpdate"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("artifactRoomAwareness"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    hasBinaryPayload: z.literal(true),
  }),
  /**
   * Client-initiated retry of a failed major migration.
   * The host resolver tears down the current epic lease and re-runs `openEpic`, which is retry-safe (server prepare skips duplicates, transformDuplicatedRoom is idempotent).
   */
  z.object({
    kind: z.literal("retryMigration"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type EpicSubscribeClientFrame = z.infer<
  typeof epicSubscribeClientFrameSchema
>;

export const epicSubscribeV10 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV11 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicSubscribeServerFrameSchemaV11,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV12 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicSubscribeServerFrameSchemaV12,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV13 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchema,
  serverFrameSchema: epicSubscribeServerFrameSchemaV13,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

// ─── `epic.subscribe@2.0` - RETIRED, never released ───────────────────────
// The protocol definitions are never deleted on either path.
