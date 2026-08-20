/**
 * `epic.subscribe@1.0` - versioned streaming-RPC contract for the host's
 * single-epic Y.Doc subscription.
 *
 * The host multiplexes two doc scopes onto a single subscription:
 *
 * - **Root scope** - the metadata-only Epic Y.Doc. Carries epic header,
 *   artifact metadata (with `artifactRoomId` references), chats, tuiAgents, and
 *   room-metadata. Frames that target the root doc do NOT carry a
 *   `artifactRoomId` - the root doc is implicit.
 * - **ArtifactRoom scope** - a per-artifact-room body Y.Doc. Each artifact-room hosts one root
 *   `Y.XmlFragment` per artifact under the deterministic key
 *   `artifact-body:{artifactId}`. Every artifact-room-scoped frame MUST identify
 *   itself with a `artifactRoomId`.
 *
 * Server frames:
 *
 * - `snapshot`     - initial state for the root Epic doc. Text envelope
 *                    carries the snapshot metadata; a Y.Doc snapshot rides
 *                    the paired binary payload. The meta shape is the one
 *                    field that varies by minor: `@1.0`/`@1.1` carry the
 *                    frozen `snapshotMetaEpicSchemaV10`, while **@1.2** adds
 *                    `roomId` (`snapshotMetaEpicSchema`).
 * - `update`       - incremental Y.Doc update for the root Epic doc.
 * - `awareness`    - awareness update (cursors, selections, presence) for
 *                    the root Epic doc.
 * - `permissionChanged` - permission change for the subscribing user.
 * - `cloudSyncStatus`  - host-observed Tiptap/cloud room connection state.
 *                    Also the carrier for the optional status keys added by
 *                    later minors: `durability` / `pauseReason` (**@1.3**),
 *                    `promotionState` (**@1.4**), and the s5 status pass's
 *                    widened `pauseReason` + `localProtection` + `freshness`
 *                    (**@1.5**). No new frame kind - it is the same
 *                    host-observed tick.
 * - `pong`         - heartbeat response.
 * - `artifactRoomSnapshot`  - initial state for a healthy artifact-room doc keyed by
 *                    `artifactRoomId`. Binary payload is `Y.encodeStateAsUpdate`
 *                    over the artifact-room doc. Carries
 *                    `hostArtifactRoomStateVectorBase64` so the GUI can
 *                    reconcile per-artifact-room dirty state.
 * - `artifactRoomUpdate`    - incremental Y.Doc update for a artifact-room doc. Carries
 *                    `hostArtifactRoomStateVectorBase64` so the GUI can advance
 *                    per-artifact-room host coverage without waiting for a
 *                    full snapshot.
 * - `artifactRoomAwareness` - awareness update for a artifact-room doc.
 * - `artifactRoomState`     - unavailable/retrying/ready state for a artifactRoom. Text-only.
 *                    Drives the GUI's per-artifact body availability UI.
 * - `dirtySnapshot`         - **@1.1 only** - atomic per-subscription dirtiness
 *                    snapshot: `rootDirty` plus every live room's dirty
 *                    boolean (including clean rooms). Receipt of this one
 *                    frame *is* snapshot completion. Emitted once per
 *                    subscribe / resubscribe cycle.
 * - `artifactRoomDirty`     - **@1.1 only** - transition delta for one room
 *                    after the cycle's `dirtySnapshot`. Text-only.
 * - `rootDirty`             - **@1.1 only** - transition delta for the root
 *                    doc after the cycle's `dirtySnapshot`. Same composition
 *                    as per-room dirty (unsynced provider ∨ unflushed buffer
 *                    ∨ retained pending row).
 *
 * Client frames:
 *
 * - `applyUpdate`     - incremental Y.Doc update pushed by the client for
 *                        the root Epic doc.
 * - `awareness`       - awareness update for the root Epic doc.
 * - `ping`            - heartbeat.
 * - `artifactRoomApplyUpdate`  - Y.Doc update for a artifact-room doc.
 * - `artifactRoomAwareness`    - awareness update for a artifact-room doc.
 *
 * Comment-thread payloads ride the Y.Doc `update` channel - there is **no**
 * typed `commentThread` frame. Adding one in the future would be a breaking
 * change and would need a new major.
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
} from "@traycer/protocol/host/epic/snapshot-meta";

export const epicSubscribeOpenRequestSchema = z.object({
  epicId: z.string(),
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

/**
 * Coarse phase reported alongside `migrationProgress` frames. The renderer
 * collapses the host's underlying migration steps into three user-visible
 * buckets so the modal can render a short step list without leaking schema
 * vocabulary:
 *
 * - `prepare`  - connect to the new room and seed the metadata-only root.
 * - `upload`   - publish artifact-room bodies (the long, fraction-bearing phase).
 * - `finalize` - write the final root and tear down the migration provider.
 */
export const epicMigrationPhaseSchema = z.enum([
  "prepare",
  "upload",
  "finalize",
]);
export type EpicMigrationPhase = z.infer<typeof epicMigrationPhaseSchema>;

/**
 * Host-observed Tiptap/cloud room connection state for the opened Epic. The
 * renderer's own `/stream` socket can remain connected to the local host
 * while the host's cloud room websocket is offline, so this frame is the
 * source of truth for whether "All changes synced" is safe to show.
 */
export const epicCloudSyncStatusSchema = z.enum([
  "connected",
  "reconnecting",
  "disconnected",
]);
export type EpicCloudSyncStatus = z.infer<typeof epicCloudSyncStatusSchema>;

/**
 * Where the open epic is currently durable. This deliberately answers a
 * different question from {@link epicCloudSyncStatusSchema}: a local mirror
 * can report its local connection as healthy while cloud sync is paused.
 */
export const epicDurabilityStatusSchema = z.enum([
  "local",
  "promoting",
  "paused",
  "offline",
]);
export type EpicDurabilityStatus = z.infer<typeof epicDurabilityStatusSchema>;

/**
 * The live state behind a durable promotion reservation. `pending` means the
 * one-way reservation survived but no uploader is running in this process;
 * `active` means the host is presently attempting the promotion. This stays
 * separate from the frozen durability enum so an older GUI keeps its existing
 * `promoting` behavior while a negotiated @1.4 peer can render the distinction.
 * This is a closed wire union: a future unrecognised durable source state must
 * be omitted, falling back to today's rendering just as it does for a host
 * that does not speak @1.4, rather than widening this released enum.
 */
export const epicPromotionStateSchema = z.enum(["pending", "active"]);
export type EpicPromotionState = z.infer<typeof epicPromotionStateSchema>;

/**
 * The two pause reasons the renderer must act on differently. The persisted
 * registry field is intentionally wider, so the host maps recognised values
 * to this closed wire union and omits unknown values.
 */
export const epicDurabilityPauseReasonSchema = z.enum([
  "entitlement-lapsed",
  "access-revoked",
]);
export type EpicDurabilityPauseReason = z.infer<
  typeof epicDurabilityPauseReasonSchema
>;

/**
 * `@1.5` widening of {@link epicDurabilityPauseReasonSchema} for
 * **`s5-orphaned-epic-recovery`** (which supersedes
 * `s4-tombstone-pause-reason-surfacing` and absorbs its enum widening).
 *
 * The three added reasons are delete-path states the host already records
 * durably and had no way to say on the wire:
 *
 * - `delete-pending-acknowledgement` - informational; the delete is recorded
 *   locally and is waiting for the cloud to acknowledge it.
 * - `delete-tombstone-unscoped-cleared` - informational; an unscoped tombstone
 *   was cleared, so the pause is bookkeeping rather than a user decision.
 * - `orphaned-local-edits-after-cloud-delete` - the ACTIONABLE one: completion
 *   was refused to protect never-uploaded bytes, so the epic holds local edits
 *   the deleted cloud copy never received. Making such an epic reachable at all
 *   is the other half of that ticket; this value is what that recovery surface
 *   renders and acts on.
 *
 * Value growth, so it is emission-gated rather than backfilled: the `@1.3` /
 * `@1.4` enum above stays FROZEN and a peer that negotiated those minors must
 * never be sent one of the new values - its schema REFUSES them, where an
 * unrecognised reason is meant to degrade to a neutral paused state. The host
 * maps the wider persisted registry value onto whichever closed union the
 * negotiated minor speaks, and omits the key when that minor has no member for
 * it.
 */
export const epicDurabilityPauseReasonSchemaV15 = z.enum([
  "entitlement-lapsed",
  "access-revoked",
  "delete-pending-acknowledgement",
  "delete-tombstone-unscoped-cleared",
  "orphaned-local-edits-after-cloud-delete",
]);
export type EpicDurabilityPauseReasonV15 = z.infer<
  typeof epicDurabilityPauseReasonSchemaV15
>;

/**
 * `@1.5` widening of {@link epicDurabilityStatusSchema} for
 * **`s5-unarmed-session`** and the status-truthfulness class rule it cites.
 *
 * Through `@1.4` the durability datum is optional and has no indeterminate
 * member, so "the host cannot answer" and "there is nothing to worry about"
 * are the SAME wire state - an absent key - and the renderer resolves that
 * ambiguity in the reassuring direction. That is precisely the defect: a
 * session with no local protection renders identically to a protected one.
 *
 * `unknown` makes the indeterminate state expressible POSITIVELY, and `cloud`
 * does the same for the calm state: the epic is cloud-homed and served by a
 * live cloud connection, so there is no local-durability claim to make. Both
 * exist because the absence rule (see the frame below) leaves absence meaning
 * UNKNOWN, never synced - so "fine" needs its own member or it has no
 * representation at all. Review found the earlier revision of this minor
 * saying both that absence means unknown AND that a peer can tell unknown
 * from fine, which cannot simultaneously hold with a five-member enum; the
 * client was resolving the contradiction by reading absence-beside-armed as
 * the calm arm, which is precisely the silence-as-reassurance inference this
 * minor exists to break.
 *
 * Value growth on the same emission-gated terms as the pause-reason widening:
 * `@1.3` / `@1.4` stay frozen and are never sent `unknown` or `cloud`.
 */
export const epicDurabilityStatusSchemaV15 = z.enum([
  "local",
  "promoting",
  "paused",
  "offline",
  "unknown",
  "cloud",
]);
export type EpicDurabilityStatusV15 = z.infer<
  typeof epicDurabilityStatusSchemaV15
>;

/**
 * Whether this session has local (WAL) protection at all -
 * **`s5-unarmed-session`**.
 *
 * A DIFFERENT question from {@link epicDurabilityStatusSchemaV15}, which says
 * where the epic is durable given a working local store. When the local store
 * is refused - fence lost, topology refused, a mid-migration throw, a
 * split-device layout - the session serves cloud-only with no WAL behind it,
 * and today that fact never reaches the wire at all. While disconnected such a
 * session is strictly LESS durable than pre-WAL builds, so silence is not an
 * acceptable rendering of it.
 *
 * - `armed`       - a local store is armed for this session; edits are
 *                   WAL-durable before the cloud acknowledges them.
 * - `unavailable` - no local store is armed. Offline edits live only in the
 *                   doc and do not survive process exit, graceful quit
 *                   included.
 * - `unknown`     - the host cannot currently determine it. Rendered as
 *                   unknown, never as protected.
 *
 * Optional on the frame, and its absence at `@1.5` means `unknown` - the same
 * conservative reading as `durability`, for the same reason.
 */
export const epicLocalProtectionSchema = z.enum([
  "armed",
  "unavailable",
  "unknown",
]);
export type EpicLocalProtection = z.infer<typeof epicLocalProtectionSchema>;

/**
 * How the served document stands relative to the cloud -
 * **`s5-mirror-first-serving`**.
 *
 * Mirror-first serving paints a WAL-backed root before cloud revalidation, so
 * availability and freshness stop being the same fact and the renderer needs a
 * datum that can say "this is a local copy" while the document is already
 * usable. The first snapshot of a mirror must read `local-copy`, `syncing` or
 * `stale` - never `current`.
 *
 * A NEW datum, not a relabelling. `snapshot-meta.lastSyncedAt` is
 * repo/workspace freshness and `local_room_confirmation.updated_at` is an
 * upload-frontier confirmation; neither answers "when was this DOCUMENT last
 * reconciled against the cloud", so neither may be reused here without an
 * equivalence proof.
 */
export const epicCloudFreshnessStateSchema = z.enum([
  /** Served from the local mirror; no cloud contact has been made yet. */
  "local-copy",
  /** Cloud is attached to the same Y.Doc and reconciliation is in flight. */
  "syncing",
  /** Known to be behind the cloud, or too old to claim otherwise. */
  "stale",
  /** A full root cloud reconciliation succeeded and recorded its timestamp. */
  "current",
]);
export type EpicCloudFreshnessState = z.infer<
  typeof epicCloudFreshnessStateSchema
>;

/**
 * The states expressible WITHOUT a recorded reconciliation timestamp.
 * `current` is deliberately absent: a closed mirror does not refresh in the
 * background, so a transition label alone cannot survive a restart, and only a
 * successful full root cloud reconciliation may record the timestamp that
 * licenses the `current` claim.
 */
export const epicCloudFreshnessUnknownStateSchema = z.enum([
  "local-copy",
  "syncing",
  "stale",
]);
export type EpicCloudFreshnessUnknownState = z.infer<
  typeof epicCloudFreshnessUnknownStateSchema
>;

/**
 * The conservative freshness datum: a recorded last-cloud-sync timestamp, or
 * an explicit statement that there is none. Structural rather than a nullable
 * number, so `current` is UNREACHABLE without the timestamp that licenses it -
 * the safety contract holds by construction instead of by convention.
 */
export const epicCloudFreshnessSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lastCloudSyncAt"),
    /**
     * Epoch milliseconds of the last SUCCESSFUL full root cloud reconciliation
     * for this epic. Persisted, so it survives a restart of a closed mirror.
     */
    reconciledAtEpochMs: z.number().int().nonnegative(),
    state: epicCloudFreshnessStateSchema,
  }),
  z.object({
    kind: z.literal("freshnessUnknown"),
    state: epicCloudFreshnessUnknownStateSchema,
  }),
]);
export type EpicCloudFreshness = z.infer<typeof epicCloudFreshnessSchema>;

// ─── Frozen `epic.subscribe@1.0` server-frame set (as shipped) ────────────
//
// IMMUTABLE. A renderer that negotiated @1.0 agreed to exactly these frame
// kinds, so this array must never learn a new one - sending a peer a frame it
// did not negotiate is the host breaking the contract, not a "graceful"
// degrade the peer happens to drop. New frames go on a new minor's union
// below, and the host gates their emission on the NEGOTIATED version.

/**
 * The frozen `@1.0`/`@1.1` snapshot frame.
 *
 * Split out of the shared array below so a later minor can swap in a grown
 * `meta` shape without duplicating the other fourteen frame kinds and without
 * disturbing this one - see {@link epicSubscribeSnapshotServerFrameSchemaV12}.
 */
const epicSubscribeSnapshotServerFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  epicId: z.string(),
  meta: snapshotMetaEpicSchemaV10,
  hasBinaryPayload: z.literal(true),
});

/**
 * The frozen `@1.0` frames between `snapshot` and `cloudSyncStatus`. Two frame
 * positions vary by minor - `snapshot` (whose `meta` grows at `@1.2`) and
 * `cloudSyncStatus` (whose optional status keys grow at `@1.3`+) - so the
 * remainder is split around them and spread into each minor's union instead of
 * being duplicated.
 */
const epicSubscribeServerFrameSchemasBeforeCloudSyncStatus = [
  /**
   * Metadata-only frame emitted at the start of the `epic.subscribe`
   * lifecycle, BEFORE the host's Tiptap WS sync completes. Carries the
   * workspace context (repos, workspaces, repoMapping, workspaceFolders,
   * unresolvedRepos, epicLight, permissionRole) the host already has
   * after `resolveWorkspaceContext` - typically at ~200 ms vs ~8-11 s for
   * the full snapshot on a cold cloud sync.
   *
   * Renderers apply this to `snapshotMeta` so workspace-derived UI (git
   * status, file tree, sidebar repo chip, permission gating) starts working
   * immediately, while the canvas continues to show the loading skeleton
   * until the real snapshot lands. `hostStateVectorBase64` is the empty
   * state vector here (placeholder) - the real snapshot overwrites the full
   * meta when it arrives.
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
] as const;

const epicSubscribeCloudSyncStatusServerFrameSchemaV10 = z.object({
  kind: z.literal("cloudSyncStatus"),
  epicId: z.string(),
  status: epicCloudSyncStatusSchema,
  hasBinaryPayload: z.literal(false),
});

const epicSubscribeServerFrameSchemasAfterCloudSyncStatus = [
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("artifactRoomSnapshot"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    /**
     * Base64-encoded `Y.encodeStateVector` of the host-side artifactRoom Y.Doc
     * AFTER applying the bytes carried by this frame. The GUI compares it
     * against any local dirty watermark on the corresponding artifactRoom replica
     * to decide whether the artifactRoom is converged or still needs a reconcile
     * update fan-out.
     */
    hostArtifactRoomStateVectorBase64: z.string(),
    hasBinaryPayload: z.literal(true),
  }),
  z.object({
    kind: z.literal("artifactRoomUpdate"),
    epicId: z.string(),
    artifactRoomId: z.string().min(1),
    /**
     * Base64-encoded `Y.encodeStateVector` of the host-side artifactRoom Y.Doc
     * AFTER applying the update bytes carried by this frame. Mirrors
     * `artifactRoomSnapshot` so the GUI can advance per-artifact-room host coverage on
     * incremental updates without waiting for a full snapshot.
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
  /**
   * One-shot signal that the host is about to begin a major migration for
   * this epic. Emitted before any `migrationProgress` frame so the GUI can
   * show the migration-progress modal immediately and replace the silent
   * skeleton state.
   */
  z.object({
    kind: z.literal("migrationStarted"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * Progress update for an in-flight major migration. `chunksDone` and
   * `chunksTotal` carry an opaque tick fraction for the active `phase`; the
   * renderer only displays a determinate bar when `phase === "upload"`. For
   * `prepare`/`finalize` the host sends `chunksDone: 0, chunksTotal: 1`
   * and the renderer ignores the numbers in favour of a spinner.
   */
  z.object({
    kind: z.literal("migrationProgress"),
    epicId: z.string(),
    phase: epicMigrationPhaseSchema,
    chunksDone: z.number().int().nonnegative(),
    chunksTotal: z.number().int().positive(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * Terminal failure signal for an in-flight major migration. Emitted in
   * lieu of a fatal-error WS close so the session stays alive and the GUI
   * modal can fire a `retryMigration` client frame against the same
   * subscription. `reason` is a short, user-safe summary used only for
   * host-side logging; the modal copy is fixed and never displays this
   * string.
   */
  z.object({
    kind: z.literal("migrationFailed"),
    epicId: z.string(),
    reason: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * One-shot, terminal signal that this epic needs a major migration but the
   * caller lacks the write access (owner/editor) required to perform it. The
   * host emits this INSTEAD of attempting the migration, so the session stays
   * alive but no migration is started and there is nothing to retry. The GUI
   * renders a fixed, non-retryable message asking an owner/editor to open the
   * epic once so it upgrades. Distinct from `migrationFailed` precisely because
   * a retry from this caller can never succeed.
   */
  z.object({
    kind: z.literal("migrationNotAllowed"),
    epicId: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  /**
   * One-shot signal that the host observed a REMOTE `meta.deleted`
   * transition on the epic room (someone else deleted the epic while this
   * client had it open), carrying the deletion attribution so the renderer
   * can force-close the tab and toast who deleted it.
   */
  z.object({
    kind: z.literal("epicDeleted"),
    epicId: z.string(),
    deletedByDisplayName: z.string().nullable(),
    deletedByTraycerUserId: z.string().nullable(),
    hasBinaryPayload: z.literal(false),
  }),
] as const;

/**
 * Every frozen `@1.0` frame EXCEPT `snapshot`, shared verbatim by `@1.0`,
 * `@1.1` and `@1.2`: across those three minors only the snapshot frame's
 * `meta` differs, so this remainder is defined once and spread into each.
 */
const epicSubscribeSharedNonSnapshotServerFrameSchemasV10 = [
  ...epicSubscribeServerFrameSchemasBeforeCloudSyncStatus,
  epicSubscribeCloudSyncStatusServerFrameSchemaV10,
  ...epicSubscribeServerFrameSchemasAfterCloudSyncStatus,
] as const;

/**
 * The complete frozen `@1.0` frame set: `snapshot` followed by the remainder,
 * in their original order, so `@1.0`/`@1.1` union membership is byte-for-byte
 * what shipped.
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
 * Per-artifact-room sync-state signal: the room holds local work the host's
 * cloud connection has not acknowledged (unsynced provider updates, an
 * unflushed in-memory buffer, or a retained durable pending row).
 *
 * A SEPARATE dimension from {@link epicArtifactRoomAvailabilitySchema}, and a
 * separate frame for that reason. Availability answers "is this body
 * materialized and usable"; this answers "is there work in it the cloud has
 * not taken". Artifact rooms are local-first - a room stays `ready` across a
 * websocket drop and keeps accepting edits - so the two dimensions move
 * independently, and folding `dirty` onto `artifactRoomState` would force the
 * host to restate an availability it did not re-derive every time dirtiness
 * flapped.
 *
 * NOT per-room offline: every room of an epic is multiplexed onto that epic's
 * single websocket (`shardKey = epicId`), so per-room offline is degenerate.
 * Offline is an epic-level fact and stays on the `cloudSyncStatus` frame.
 *
 * Transition delta after the cycle's {@link epicSubscribeDirtySnapshotServerFrameSchema}.
 * Within a negotiated `@1.1` session, **absence means clean only after that
 * cycle's `dirtySnapshot` has been received**. Pre-snapshot silence is not
 * clean (A1 / finding 10): under-reporting dirtiness is the dangerous
 * direction for the sync pill.
 *
 * Absence is NOT correct degradation against a pre-@1.1 host that never emits
 * these frames: that host may still hold unacknowledged bytes. A @1.1 client
 * against an old host must treat dirtiness as **unknown**, not clean. Gate on
 * negotiated version / frame support instead.
 */
const epicSubscribeArtifactRoomDirtyServerFrameSchema = z.object({
  kind: z.literal("artifactRoomDirty"),
  epicId: z.string(),
  artifactRoomId: z.string().min(1),
  dirty: z.boolean(),
  hasBinaryPayload: z.literal(false),
});

/**
 * Root-doc transition delta after the cycle's `dirtySnapshot`. Same three-term
 * composition as per-room dirtiness (provider unsynced ∨ unflushed buffer ∨
 * retained pending row).
 */
const epicSubscribeRootDirtyServerFrameSchema = z.object({
  kind: z.literal("rootDirty"),
  epicId: z.string(),
  dirty: z.boolean(),
  hasBinaryPayload: z.literal(false),
});

/**
 * Atomic per-subscription dirtiness snapshot for `@1.1`.
 *
 * Emitted **once per subscribe / resubscribe cycle**. Enumerates root dirty
 * plus every live room (including clean ones). Receipt of this single frame
 * *is* snapshot completion — no sentinel frame and no ordering contract on
 * N separate per-room frames. After this, transitions use
 * `artifactRoomDirty` / `rootDirty` deltas.
 */
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
//
// Adds `dirtySnapshot`, `artifactRoomDirty`, and `rootDirty`. @1.0 stays
// installed and FROZEN: a renderer that negotiated it never receives the new
// kinds, and the resolver gates on the negotiated version rather than assuming
// the peer will tolerate an unknown frame. Both minors share the same V10 base
// array so the frozen set cannot drift.
export const epicSubscribeServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  ...epicSubscribeSharedServerFrameSchemasV10,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.2` - additive: room identity on snapshot meta ──────
//
// The `snapshot` frame's `meta` gains `roomId` (see `snapshotMetaEpicSchema`),
// so the renderer's merge-vs-plain-swap seam can tell a same-room failover
// from a migration-cutover repoint. @1.0 and @1.1 stay installed and FROZEN,
// still carrying the pre-roomId `snapshotMetaEpicSchemaV10`.
//
// WHY THIS MINOR NEEDS NO EMISSION GATE, while @1.1's frames do. The two
// kinds of additive growth are not symmetric:
//
//   - A new frame KIND (@1.1's `dirtySnapshot` / `artifactRoomDirty` /
//     `rootDirty`) MUST be gated on the negotiated version, because the peer
//     decodes with a DISCRIMINATED UNION: an unrecognized `kind` matches no
//     variant and the whole frame fails to parse. The host therefore checks
//     `supportsDirtyFrames()` (`epic-stream-resolver.ts`) before emitting.
//   - A new PROPERTY on an EXISTING frame (this minor's `roomId`) needs no
//     gate, because zod objects are non-strict: a @1.0/@1.1 peer parsing with
//     its own frozen schema silently STRIPS the unknown key. The host may
//     publish it unconditionally - which is what the epic resolver does, and
//     what `agent.inbox.subscribe@1.2` established for `eventId`.
//
// So the version fact lives entirely in the schema, not in a resolver branch;
// a negotiated-minor check on the producer could only ever suppress a key the
// peer already discards.
//
// The grown `meta` is nonetheless a real wire-shape change on the snapshot
// frame, which is exactly why it rides a new minor instead of being tolerated
// on the shipped line: `.optional()` is parse-time hardening, not a
// versioning mechanism.

/**
 * The `@1.2` snapshot frame - identical to
 * {@link epicSubscribeSnapshotServerFrameSchemaV10} except that `meta`
 * carries the room identity. Later minors (`@1.3`+) keep this exact frame:
 * their growth rides the `cloudSyncStatus` frame instead.
 */
const epicSubscribeSnapshotServerFrameSchemaV12 = z.object({
  kind: z.literal("snapshot"),
  epicId: z.string(),
  meta: snapshotMetaEpicSchema,
  hasBinaryPayload: z.literal(true),
});

export const epicSubscribeServerFrameSchemaV12 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV12,
  ...epicSubscribeSharedNonSnapshotServerFrameSchemasV10,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.3` - additive per-epic durability status ───────────
//
// The fields live on the existing cloudSyncStatus frame, rather than adding a
// new kind, because it is the same host-observed connection tick. They are
// optional so a @1.3 GUI remains compatible with an older host. @1.0 through
// @1.2 remain frozen: the resolver omits these keys unless this minor was
// negotiated.
const epicSubscribeCloudSyncStatusServerFrameSchemaV13 = z.object({
  kind: z.literal("cloudSyncStatus"),
  epicId: z.string(),
  status: epicCloudSyncStatusSchema,
  durability: epicDurabilityStatusSchema.optional(),
  // Meaningful only with durability=paused. Kept optional (rather than a
  // discriminated union) so an unrecognised host registry value degrades to a
  // neutral paused state and the additive compatibility gate stays simple.
  pauseReason: epicDurabilityPauseReasonSchema.optional(),
  hasBinaryPayload: z.literal(false),
});

export const epicSubscribeServerFrameSchemaV13 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV12,
  ...epicSubscribeServerFrameSchemasBeforeCloudSyncStatus,
  epicSubscribeCloudSyncStatusServerFrameSchemaV13,
  ...epicSubscribeServerFrameSchemasAfterCloudSyncStatus,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.4` - additive live promotion state ─────────────────
//
// `durability` remains exactly the @1.3 field: existing clients use
// `promoting` as they always have. The optional field below gives a negotiated
// peer the missing distinction between an in-progress upload and a durable,
// currently wedged reservation. @1.3 remains frozen and the host gates this
// key on the negotiated minor.
const epicSubscribeCloudSyncStatusServerFrameSchemaV14 = z.object({
  kind: z.literal("cloudSyncStatus"),
  epicId: z.string(),
  status: epicCloudSyncStatusSchema,
  durability: epicDurabilityStatusSchema.optional(),
  pauseReason: epicDurabilityPauseReasonSchema.optional(),
  promotionState: epicPromotionStateSchema.optional(),
  hasBinaryPayload: z.literal(false),
});

export const epicSubscribeServerFrameSchemaV14 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV12,
  ...epicSubscribeServerFrameSchemasBeforeCloudSyncStatus,
  epicSubscribeCloudSyncStatusServerFrameSchemaV14,
  ...epicSubscribeServerFrameSchemasAfterCloudSyncStatus,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

// ─── `epic.subscribe@1.5` - one additive minor for the s5 status pass ─────
//
// THREE tickets land on this one frame because they are three readings of the
// same host-observed connection tick, and splitting them across three minors
// would make a peer's rendering depend on which subset it happened to
// negotiate:
//
// - `s5-orphaned-epic-recovery` widens `pauseReason` (three delete-path
//   reasons, one of them actionable).
// - `s5-unarmed-session` adds `localProtection`, and widens `durability` with
//   `unknown` so an indeterminate answer is expressible rather than silent.
// - `s5-mirror-first-serving` adds `freshness`, the conservative
//   last-cloud-sync datum a mirror-first open must paint with.
//
// Every key stays optional, so an older GUI negotiates down to @1.4 (or lower)
// and keeps exactly its current rendering. @1.0 through @1.4 remain FROZEN:
// the two widened enums carry values those minors' schemas REFUSE, so the host
// gates emission on the negotiated version rather than assuming the peer will
// tolerate them.
//
// ABSENCE RULE for a negotiated @1.5 peer: an absent `durability` or
// `localProtection` key means UNKNOWN, never "synced" and never "protected".
// Optionality here is a wire-compat affordance (an older host on this line may
// omit them), not permission to render silence as reassurance - that reading
// is the class of status defect this minor exists to correct.
const epicSubscribeCloudSyncStatusServerFrameSchemaV15 = z.object({
  kind: z.literal("cloudSyncStatus"),
  epicId: z.string(),
  status: epicCloudSyncStatusSchema,
  durability: epicDurabilityStatusSchemaV15.optional(),
  pauseReason: epicDurabilityPauseReasonSchemaV15.optional(),
  promotionState: epicPromotionStateSchema.optional(),
  localProtection: epicLocalProtectionSchema.optional(),
  freshness: epicCloudFreshnessSchema.optional(),
  hasBinaryPayload: z.literal(false),
});

export const epicSubscribeServerFrameSchemaV15 = z.discriminatedUnion("kind", [
  epicSubscribeSnapshotServerFrameSchemaV12,
  ...epicSubscribeServerFrameSchemasBeforeCloudSyncStatus,
  epicSubscribeCloudSyncStatusServerFrameSchemaV15,
  ...epicSubscribeServerFrameSchemasAfterCloudSyncStatus,
  epicSubscribeDirtySnapshotServerFrameSchema,
  epicSubscribeArtifactRoomDirtyServerFrameSchema,
  epicSubscribeRootDirtyServerFrameSchema,
]);

/** The latest installed shape. Host code builds frames against this. */
export const epicSubscribeServerFrameSchema = epicSubscribeServerFrameSchemaV15;
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
   * Client-initiated retry of a failed major migration. The host resolver
   * tears down the current epic lease and re-runs `openEpic`, which is
   * retry-safe (server prepare skips duplicates, transformDuplicatedRoom is
   * idempotent). Emitted from the migration-progress modal's Retry button.
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
  openRequestSchema: epicSubscribeOpenRequestSchema,
  serverFrameSchema: epicSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV11 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchema,
  serverFrameSchema: epicSubscribeServerFrameSchemaV11,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV12 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchema,
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

export const epicSubscribeV14 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 4 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchema,
  serverFrameSchema: epicSubscribeServerFrameSchemaV14,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});

export const epicSubscribeV15 = defineStreamRpcContract({
  method: "epic.subscribe",
  schemaVersion: { major: 1, minor: 5 } as const,
  openRequestSchema: epicSubscribeOpenRequestSchema,
  serverFrameSchema: epicSubscribeServerFrameSchemaV15,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});
