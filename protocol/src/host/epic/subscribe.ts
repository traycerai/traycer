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
 *                    frozen `snapshotMetaEpicSchemaV10`, **@1.2** adds
 *                    `roomId` (`snapshotMetaEpicSchemaV12`), and **@1.3**
 *                    adds `seededFromOffer` (`snapshotMetaEpicSchema`) - the
 *                    marker that the payload is a DELTA against the state
 *                    vector the client offered, not a self-sufficient
 *                    snapshot.
 *
 * The open request likewise varies by minor: `@1.0`-`@1.2` carry the frozen
 * `{epicId}` (`epicSubscribeOpenRequestSchemaV10`), while **@1.3** adds the
 * optional `seedOffer` that makes a reattach cost what actually changed
 * rather than re-shipping the whole document.
 * - `update`       - incremental Y.Doc update for the root Epic doc.
 * - `awareness`    - awareness update (cursors, selections, presence) for
 *                    the root Epic doc.
 * - `permissionChanged` - permission change for the subscribing user.
 * - `cloudSyncStatus`  - host-observed Tiptap/cloud room connection state.
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
  snapshotMetaEpicSchemaV12,
} from "@traycer/protocol/host/epic/snapshot-meta";

/**
 * The frozen `@1.0` / `@1.1` / `@1.2` open request, as shipped.
 *
 * IMMUTABLE, like every other frozen-per-minor shape in this file. A key added
 * here would be a same-version wire-shape change on three already-released
 * lines. `@1.3` extends it below.
 */
export const epicSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string(),
});
export type EpicSubscribeOpenRequestV10 = z.infer<
  typeof epicSubscribeOpenRequestSchemaV10
>;

/**
 * A reattaching client's offer of the root-doc state it ALREADY holds, so the
 * host can answer with a Yjs delta instead of re-shipping the whole document.
 *
 * The two fields travel together as one object rather than as two sibling
 * request keys because neither is meaningful alone: a state vector without its
 * provenance is precisely the hazard `@1.2`'s `roomId` was introduced for. The
 * nesting makes "both or neither" structural, so there is no cross-field
 * runtime check for a later reader to overlook.
 */
export const epicSubscribeClientSeedOfferSchema = z.object({
  /**
   * Base64-encoded `Y.encodeStateVector` of the live root Epic doc the client
   * still holds. The host answers `Y.encodeStateAsUpdate(doc, thisVector)` -
   * everything it has that the client does not.
   */
  stateVectorBase64: z.string().min(1),
  /**
   * The room the offered state came from - the `roomId` off the snapshot meta
   * that seeded this client's doc. The host serves a delta only when this
   * names the room it is about to encode from, and otherwise falls back to a
   * full snapshot.
   *
   * Required inside the offer, not optional. A major schema migration mints a
   * NEW room for the same `epicId`, so a state vector alone cannot distinguish
   * "what this client is missing from this room" from "state belonging to the
   * pre-migration room": diffing against the latter would union two logically
   * different documents. A client that cannot name its room - one seeded by a
   * pre-`@1.2` host, which never sent `roomId` - therefore sends NO offer and
   * takes a full snapshot rather than guessing.
   */
  roomId: z.string().min(1),
});
export type EpicSubscribeClientSeedOffer = z.infer<
  typeof epicSubscribeClientSeedOfferSchema
>;

/**
 * The LATEST installed open request (`@1.3`): the frozen shape plus an
 * optional {@link epicSubscribeClientSeedOfferSchema}.
 *
 * `.optional()` and never `.default()`. A `.default()` request field
 * materializes a key the caller never wrote, which splits the GUI's query
 * cache between the caller's params and the parsed params for what is
 * logically one subscription.
 *
 * NOTE - the offer needs no capability gate on either side, and that falls out
 * of the dispatcher rather than being arranged. The host validates params with
 * the NEGOTIATED contract's `openRequestSchema` and passes the PARSED result
 * downstream (`stream-dispatcher.ts`), so a client that negotiated `@1.0`-
 * `@1.2` has this key stripped before any resolver sees it, and a pre-`@1.3`
 * host strips it the same way because zod objects are non-strict. A client may
 * therefore offer unconditionally - it cannot know the negotiated minor when
 * it builds its first open request anyway - and an unrecognized offer degrades
 * to today's full snapshot with no error on any path.
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
 * Every frozen `@1.0` frame EXCEPT `snapshot`, shared verbatim by `@1.0`,
 * `@1.1` and `@1.2`: across those three minors only the snapshot frame's
 * `meta` differs, so this remainder is defined once and spread into each.
 */
const epicSubscribeSharedNonSnapshotServerFrameSchemasV10 = [
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
 * carries the room identity.
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
//
// The open request gains an optional `seedOffer` (the state vector of the root
// doc a reattaching client still holds), and the `snapshot` frame's `meta`
// gains `seededFromOffer` marking a payload that is a delta against that
// offer. `@1.0`-`@1.2` stay installed and FROZEN, on both the request and the
// meta.
//
// Both halves are the SAME kind of additive growth as `@1.2`'s `roomId` - a
// new PROPERTY on an existing shape, not a new frame KIND - so neither needs
// an emission gate. But they are safe for DIFFERENT reasons, and the two are
// chained rather than parallel:
//
//   - Response: `seededFromOffer` is @1.2's argument exactly - consumer
//     tolerance. A peer below `@1.3` parses the meta with its own frozen
//     schema and strips a key it does not know, so the host may publish
//     unconditionally.
//   - Request: STRONGER than tolerance. The dispatcher validates params
//     against the NEGOTIATED contract and hands the resolver the PARSED
//     value, so an offer arriving on a connection that settled below `@1.3`
//     is dropped before any resolver sees it. Not "no harm if it arrives" -
//     it does not arrive. Note the party: the offer comes from a
//     `@1.3`-CAPABLE client, which offers unconditionally because it cannot
//     know the negotiated minor when it builds its first open request. A peer
//     that predates the field has no `seedOffer` to strip.
//
// The chain: the response claim ("can only be set when an offer arrived")
// holds BECAUSE the request-side gate does. Lose that gate and the response
// half goes with it.
//
// So there is no `supportsDeltaSeed()` sibling to `supportsDirtyFrames()`, and
// deliberately so: the gate that does not exist has no degraded path to get
// wrong.

/**
 * The `@1.3` snapshot frame - identical to
 * {@link epicSubscribeSnapshotServerFrameSchemaV12} except that `meta` can
 * carry the delta-seed basis marker.
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
