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
 *                    carries `snapshotMetaEpicSchema`; a Y.Doc snapshot
 *                    rides the paired binary payload.
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
import {
  defineStreamRpcContract,
} from "@traycer/protocol/framework/versioned-stream-rpc";

/**
 * Awareness state field under which each host publishes the ids of its
 * locally-working agents (the `hasActivity` level) for an epic. The cloud-merged
 * awareness (one entry per host) is the cross-host union, so a client sees
 * working agents regardless of which host runs them. Written by the host's
 * per-epic awareness publisher; read by the gui-app Active Agents panel. Shared
 * here so writer and reader cannot drift.
 */
export const AGENT_WORKING_AWARENESS_FIELD = "agentWorking";

/**
 * Awareness state field under which each host publishes the subset of its
 * {@link AGENT_WORKING_AWARENESS_FIELD} ids whose work is an actual agent
 * **turn** (running or activating), as opposed to background-only work
 * (`run_in_background` / a subagent / Monitor / a scheduled wakeup) that keeps
 * a session non-idle while the agent itself is not executing.
 *
 * Additive and OPTIONAL by design. Awareness rides an opaque binary payload
 * (the `awareness` frame is `hasBinaryPayload: true`), so this value is NOT
 * schema-validated and is NOT covered by the stream contract's
 * `major`/`minor` negotiation - a reader cannot learn from the handshake
 * whether its peer publishes this field. Two rules follow, and both are
 * load-bearing:
 *
 * 1. NEVER change the shape of `agentWorking` itself. Existing readers do
 *    `Array.isArray(...)` on it and skip the whole entry otherwise, so
 *    repurposing it makes agents silently vanish from the working set on older
 *    clients.
 * 2. Absence is per-HOST, and must be read that way. Cloud-merged awareness
 *    carries one entry per host, so a single client can see an old host (field
 *    absent) and a new host (field present) simultaneously - indefinitely, not
 *    just during a rollout. Readers must therefore decide per entry:
 *      - field absent  -> tier unknown for that host; treat its working ids
 *                         conservatively as turns (the pre-existing behaviour).
 *      - field present -> ids listed here are turns; working ids NOT listed
 *                         here are genuinely background-only.
 *
 * Because "turn" is the conservative default, a publisher only needs to list
 * ids it can positively classify; agents with no turn/background distinction
 * (terminal agents, CLI/TUI runs) simply stay in the turn set.
 */
export const AGENT_WORKING_TURN_AWARENESS_FIELD = "agentWorkingTurn";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role", "latest");
import {
  earlyMetaEpicSchema,
  snapshotMetaEpicSchema,
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
export type EpicArtifactRoomAvailability = z.infer<typeof epicArtifactRoomAvailabilitySchema>;

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

export const epicSubscribeServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    epicId: z.string(),
    meta: snapshotMetaEpicSchema,
    hasBinaryPayload: z.literal(true),
  }),
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
]);
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
  serverFrameSchema: epicSubscribeServerFrameSchema,
  clientFrameSchema: epicSubscribeClientFrameSchema,
});
