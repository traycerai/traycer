/**
 * What each plane of the epic runtime PUBLISHES.
 *
 * Plain serializable objects, every one - no `Y.Doc`, no `Awareness`, no store
 * handle, nothing that cannot survive a structured clone. That is the property
 * the worker relocation rests on, and the reason the live-Y escape hatches
 * (`getArtifactFragment`, `getArtifactBodyAwareness`) are runtime METHODS
 * rather than projected fields: a fragment reference is exactly what a
 * projection may not carry.
 *
 * Field names match `OpenEpicState` one-for-one so the zustand adapter can
 * deliver a projection with `setState(projection)` and nothing in between has
 * to translate. That is a deliberate coupling in ONE direction: the runtime
 * names these fields, and the store shape follows. Nothing here imports the
 * store, which is what finally breaks the projector's circular import.
 */
import type { EpicAdapterArm } from "./epic-adapter-selection";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicCloudFreshness,
  EpicCloudSyncStatus,
  EpicDurabilityPauseReasonV15,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
  EpicMigrationPhase,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactRoomsSlice,
  ChatsSlice,
  CommentThreadsSlice,
  EpicProjectedSlices,
  TerminalAgentsSlice,
} from "../types";
import type { EpicWriteCommandIntent } from "./epic-write-command";
import {
  EMPTY_ARTIFACT_ROOM_DIRTY,
  EMPTY_ARTIFACT_ROOMS_SLICE,
  EMPTY_CHATS_SLICE,
  EMPTY_COMMENT_THREADS_SLICE,
  EMPTY_PROJECTED_SLICES,
  EMPTY_TERMINAL_AGENTS_SLICE,
} from "../types";

export interface SnapshotFetchError {
  readonly code: FatalErrorDetails["code"];
  readonly message: string;
  /**
   * Direction-aware version-skew signal (R4-D2), carried through only for an
   * `INCOMPATIBLE` close — `null` for every other fatal code. See
   * `describeVersionSkew` (`@/lib/host/version-skew-copy`).
   */
  readonly upgradeGuidance: FatalErrorDetails["upgradeGuidance"];
  /** The local-store repair copy is carried separately from the error text. */
  readonly localStoreRemedy?: string;
}

/**
 * Per-epic major-migration slice. The renderer's modal reads these fields
 * directly; the host owns the transitions:
 *
 * - `idle`    - no migration observed, or the snapshot has landed.
 * - `running` - host emitted `migrationStarted`. `phase` carries the
 *   active step and `chunksDone`/`chunksTotal` give the upload fraction
 *   (placeholder `0/1` for prepare/finalize so the modal can pick a
 *   spinner).
 * - `error`   - the stream closed with a fatal error after a migration
 *   started, or the host explicitly reported the migration failed.
 * - `not-allowed` - the epic needs a major migration but the caller lacks the
 *   owner/editor access required to perform it. Terminal and NOT retryable
 *   (unlike `error`): the modal asks an owner/editor to open the epic instead.
 */
export type EpicMigrationStatus = "idle" | "running" | "error" | "not-allowed";
export interface EpicMigrationSlice {
  readonly status: EpicMigrationStatus;
  readonly phase: EpicMigrationPhase | null;
  readonly chunksDone: number;
  readonly chunksTotal: number;
}

/**
 * Shared identity for "nothing retracted", so a session that never sees a
 * removal - every session, almost always - hands the same reference to every
 * subscriber and re-renders nobody.
 */
export const EMPTY_CHAT_RETRACTIONS: Readonly<
  Record<string, ChatRecordRemovalReason>
> = Object.freeze({});

export const IDLE_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "idle",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

export const ERROR_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "error",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

export const NOT_ALLOWED_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "not-allowed",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

// ─── Records plane ────────────────────────────────────────────────────────

/**
 * The record plane's read model.
 *
 * Extends {@link EpicProjectedSlices} rather than sitting beside it because the
 * projected slices ARE this plane's projection - the record tables, the
 * snapshot metadata and the divergence triple are the same plane's answer about
 * the same rows, and splitting them across two sinks would let a consumer
 * observe a projection built from record rows the mirrored copy does not show
 * yet.
 */
export interface EpicRecordsProjection extends EpicProjectedSlices {
  /**
   * The host's store-backed chat records (`epic.listChatRecords`), as last
   * served. Empty in doc-only mode: an older host that lacks the method, or
   * before the first response lands.
   */
  readonly chatRecords: ChatsSlice;
  /**
   * Whether `epic.listChatRecords` has produced an answer this session.
   * Missing rows are not deletion evidence until this is true.
   */
  readonly chatRecordListAuthoritative: boolean;
  /**
   * The record tables' ingest counters, projected.
   *
   * A caller captures one of these before issuing a list RPC and compares it
   * after, to tell "my response is still the newest thing that happened" from
   * "a delta landed while I was in flight". That is a READ of replica state,
   * so it belongs in the projection rather than in a synchronous call into the
   * replica - which is what it was.
   *
   * Published from the ONE `publish` helper rather than from each ingest path:
   * the counter moves inside the record table, and a patch that had to name it
   * at every call site would go stale the first time somebody added a path.
   */
  readonly chatIngestSeq: number;
  readonly tuiAgentIngestSeq: number;
  /** Chats the record plane RETRACTED while this session was open, and why. */
  readonly chatRetractions: Readonly<Record<string, ChatRecordRemovalReason>>;
  /** The host's registry-backed terminal-agent rows (`epic.listTuiAgents`). */
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /** The terminal twin of {@link chatRetractions}. */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  >;
  /**
   * Comment threads as the RECORDS LANE serves them, grouped by artifact.
   *
   * Empty on every legacy connection, and that is this arm's true value rather
   * than a placeholder: `epic.subscribe@1` carries no comment records at all,
   * so `epic.listCommentThreads` is the only source there. The lane path fills
   * it, the poll remains the cold-read path on BOTH, and a consumer prefers
   * whichever source has said something about the artifact in hand.
   *
   * Absence of an artifact key is NOT emptiness - see `CommentThreadsSlice`.
   */
  readonly commentThreads: CommentThreadsSlice;
  readonly snapshotMeta: SnapshotMetaEpic | null;
  readonly snapshotLoaded: boolean;
  /**
   * Renderer-local divergence: this replica holds root or body bytes the host
   * has not acknowledged. Leg (iv) of the sync indicator's inputs, and NOT the
   * host's own durability (that is {@link EpicControlProjection.rootDirty}).
   */
  readonly isDirty: boolean;
  readonly dirtyWatermarkStateVectorBase64: string | null;
  readonly latestHostStateVectorBase64: string | null;
  readonly unsyncedQueueSize: number;
  /** Pending and terminal-unacknowledged write commands, in issue order. */
  readonly writeCommands: readonly CommandRecord<EpicWriteCommandIntent>[];
}

export const EMPTY_RECORDS_PROJECTION: EpicRecordsProjection = Object.freeze({
  ...EMPTY_PROJECTED_SLICES,
  chatRecords: EMPTY_CHATS_SLICE,
  chatRecordListAuthoritative: false,
  chatIngestSeq: 0,
  tuiAgentIngestSeq: 0,
  chatRetractions: EMPTY_CHAT_RETRACTIONS,
  tuiAgentRecords: EMPTY_TERMINAL_AGENTS_SLICE,
  // The same shared "nothing retracted" identity as the chats': one frozen
  // empty object serves both, so neither table's quiet state ever hands
  // subscribers a fresh reference.
  tuiAgentRetractions: EMPTY_CHAT_RETRACTIONS,
  commentThreads: EMPTY_COMMENT_THREADS_SLICE,
  snapshotMeta: null,
  snapshotLoaded: false,
  isDirty: false,
  dirtyWatermarkStateVectorBase64: null,
  latestHostStateVectorBase64: null,
  unsyncedQueueSize: 0,
  writeCommands: Object.freeze([]),
});

// ─── Artifact-body doc plane ──────────────────────────────────────────────

export interface EpicRoomsProjection {
  /**
   * Per-artifact-room availability. The body of an artifact is renderable only
   * when the room referenced by `artifacts.byId[id].artifactRoomId` reports
   * `ready`. Rooms absent from this slice are implicitly `unavailable`.
   */
  readonly artifactRooms: ArtifactRoomsSlice;
  /**
   * Monotonic invalidation counter for LIVE-Y BINDINGS.
   *
   * The runtime's half of what the store publishes as `bindingVersion`. It says
   * one thing only: the `Y.Doc` / `XmlFragment` / `Awareness` identity behind
   * some artifact body has been replaced, so anything holding one by reference
   * must re-read it. Turning that into a React remount token is the UI's job
   * and stays on the UI's side of the seam - the runtime cannot know what a
   * remount is, and will not be able to even ask once it lives in a worker.
   *
   * Bumped on: a room materialising under a new lease, a snapshot seeding a
   * room that had no prior replica, a room leaving `ready`, a viewer downgrade
   * that drops every room, and a replica replacement.
   */
  readonly bindingEpoch: number;
}

export const EMPTY_ROOMS_PROJECTION: EpicRoomsProjection = Object.freeze({
  artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
  bindingEpoch: 0,
});

// ─── Control plane ────────────────────────────────────────────────────────

export interface EpicControlProjection {
  readonly permissionRole: PermissionRole | null;
  /**
   * VISIBLE connection status: `deriveConnectionStatus(hostTransportStatus,
   * cloudSyncStatus, hasConnectedOnce)`. Write-gating and "can this surface
   * act right now" checks read this.
   *
   * It is a lossy blend by design - "host unreachable" and "host reachable,
   * cloud link down" both collapse to `reconnecting`. Anything that needs to
   * know WHERE unsynced work is sitting must read the three raw legs below
   * instead; see `@/lib/epic-sync-pill-state`.
   */
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Raw renderer↔host stream status, unblended. `open` means the host is
   * reachable and local edits are reaching a process that persists them
   * durably; anything else means unsent edits are held only in this window's
   * memory.
   */
  readonly hostTransportStatus: StreamConnectionStatus;
  /**
   * The RECORDS lane's own transport status, as distinct from the blended
   * {@link hostTransportStatus}. Read this when the question is whether record
   * rows are arriving; read the blended one for session-level connectivity.
   */
  readonly recordsTransportStatus: StreamConnectionStatus;
  /**
   * Host-observed state of the host↔cloud link for this Epic. It remains
   * optimistically `connected` for compatibility with functional connection
   * gates; the separate freshness bit prevents that display default from
   * becoming sync proof.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Where the epic is durable, at `@1.6` width.
   *
   * `null` here means the host said NOTHING, and at `@1.6` that reads as
   * unknown - never as synced. It is not a licence for the calm rendering;
   * see `deriveEpicDurabilityView`, which requires a POSITIVE statement
   * before it will resolve a missing durability claim as fine.
   */
  readonly durabilityStatus: EpicDurabilityStatusV15 | null;
  /** Present for a recognised paused reason, at `@1.6` width. */
  readonly durabilityPauseReason: EpicDurabilityPauseReasonV15 | null;
  /** Optional @1.5 distinction behind a durable promotion reservation. */
  readonly durabilityPromotionState: EpicPromotionState | null;
  /**
   * Whether this session has local (WAL) protection - `@1.6`.
   *
   * `null` means the host did not say, which is `unknown`: an unarmed session
   * used to be indistinguishable from an armed one, so the ONLY reading that
   * closes that hole is that silence is not protection.
   */
  readonly localProtection: EpicLocalProtection | null;
  /**
   * How the served document stands relative to the cloud - `@1.6`,
   * `s5-mirror-first-serving`.
   *
   * `null` means the host did not say, and the rule that already governs
   * `durabilityStatus` and `localProtection` governs this too: silence is
   * UNKNOWN, and unknown is not `current`. Mirror-first serving makes an epic
   * usable before it is up to date, so "the document rendered" stopped being
   * evidence that it is the cloud's document.
   */
  readonly cloudFreshness: EpicCloudFreshness | null;
  /**
   * Whether the peer serving this stream negotiated the `@1.6` minor that
   * carries the three legs above - `s5-status-truthfulness`.
   *
   * Recorded because every one of those legs is optional on the wire, so
   * `null` alone cannot say WHICH silence it is. A pre-`@1.6` peer has no
   * durability opinion and keeps its prior rendering; a `@1.6` peer that omits
   * a leg has stated UNKNOWN, and unknown may not render as reassurance. Both
   * arrive here as `null`, and this bit is what separates them.
   */
  readonly durabilityLegsNegotiated: boolean;
  /** Whether this connection can report `epic.subscribe@1.4` durability. */
  readonly durabilityStatusNegotiated: boolean;
  /**
   * The last durability the host actually STATED, kept across subscription
   * cycles - unlike {@link durabilityStatus}, which a reconnect clears.
   *
   * The two answer different questions. `durabilityStatus` is "what has THIS
   * cycle's peer told us", and clearing it is right: last cycle's answer is no
   * evidence about this one. But where an epic is durable is a property of the
   * EPIC - a local-homed epic does not acquire a cloud room by reconnecting -
   * and a gate that fails dangerous on silence needs the retained fact rather
   * than the cycle's.
   *
   * Written only by a positive statement, so it never manufactures an answer
   * the host has not given, and cleared by `requestFreshSnapshot`, which
   * bootstraps from scratch rather than reconnecting.
   */
  readonly retainedDurabilityStatus: EpicDurabilityStatusV15 | null;
  /** The pause reason observed beside {@link retainedDurabilityStatus}. */
  readonly retainedDurabilityPauseReason: EpicDurabilityPauseReasonV15 | null;
  /** `true` only after a cloud-status frame for this exact open cycle. */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Latched by the first genuine cloud `connected` frame on this subscription
   * (never by the optimistic default), and cleared on re-subscribe.
   */
  readonly hasConnectedOnce: boolean;
  readonly accessLost: boolean;
  /**
   * Set once when the host emits `epicDeleted`. Terminal: the app-level access
   * coordinator force-closes the tab in response, so it is never cleared
   * within a session's lifetime.
   */
  readonly epicDeleted: EpicDeletedAttribution | null;
  readonly migration: EpicMigrationSlice;
  // UNAUTHORIZED stays on `onAuthError` so the sign-out cascade owns it; only
  // non-UNAUTHORIZED fatal closes (e.g. INCOMPATIBLE) land here.
  readonly snapshotFetchError: SnapshotFetchError | null;
  /**
   * Host-side root-doc cloud-durability state from @1.1. `null` means this
   * open cycle has not received an atomic dirty snapshot (including a
   * negotiated @1.0 session that cannot provide one).
   */
  readonly rootDirty: boolean | null;
  /**
   * `true` only after the atomic @1.1 `dirtySnapshot` for this exact open
   * cycle. This is the authority boundary between unknown and clean: deltas
   * never establish it because their ordering cannot prove completeness.
   */
  readonly hasDirtySnapshotForOpenCycle: boolean;
  /**
   * Per-artifact-room HOST-side sync state: `true` means the host holds work
   * for that room its cloud connection has not acknowledged. Deliberately
   * separate from `artifactRooms` (availability) and from the records plane's
   * `isDirty` (the RENDERER's replica against the host); this is the leg
   * further down the chain, host against cloud.
   */
  readonly artifactRoomDirtyByArtifactRoomId: Readonly<Record<string, boolean>>;
}

/**
 * The bootstrap control state.
 *
 * `cloudSyncStatus: "connected"` is load-bearing rather than optimistic
 * decoration: `deriveConnectionStatus` blends it into the `connectionStatus`
 * that gates the chat handoff, so a `"disconnected"` default would make every
 * fresh session read as reconnecting before a single frame arrived.
 */
export const INITIAL_CONTROL_PROJECTION: EpicControlProjection = Object.freeze({
  permissionRole: null,
  connectionStatus: "connecting",
  hostTransportStatus: "connecting",
  recordsTransportStatus: "connecting",
  cloudSyncStatus: "connected",
  durabilityStatus: null,
  durabilityPauseReason: null,
  durabilityPromotionState: null,
  localProtection: null,
  cloudFreshness: null,
  durabilityLegsNegotiated: false,
  durabilityStatusNegotiated: false,
  retainedDurabilityStatus: null,
  retainedDurabilityPauseReason: null,
  hasFreshCloudSyncStatus: false,
  hasConnectedOnce: false,
  accessLost: false,
  epicDeleted: null,
  migration: IDLE_MIGRATION_SLICE,
  snapshotFetchError: null,
  rootDirty: null,
  hasDirtySnapshotForOpenCycle: false,
  artifactRoomDirtyByArtifactRoomId: EMPTY_ARTIFACT_ROOM_DIRTY,
});

/**
 * Everything the three planes publish, as one object.
 *
 * The zustand adapter's delivery takes a `Partial` of this: each plane hands
 * over its own projection, the adapter coalesces whatever a frame produced into
 * ONE `setState`, and the store's shape is a superset (it adds the persisted
 * focus ids and the action closures, which are not projections and never cross
 * a sink).
 */
export interface EpicRuntimeProjection
  extends EpicRecordsProjection, EpicRoomsProjection, EpicControlProjection {
  /**
   * Every content-addressed attachment hash the root replica currently holds.
   *
   * A PROJECTION rather than a call, and it is the one member of the
   * attachment-read class that could not be anything else: three paste
   * handlers read it synchronously inside a ProseMirror handler that decides
   * whether to accept a paste and cannot await
   * (`new-conversation-modal.tsx:698`, `chat-message-user-body.tsx:642`,
   * `chat-composer.tsx:280`). `lib/epic-replica-reads.ts`'s header named this
   * shape before the relocation started: "answered from a projected set of
   * held hashes rather than from a live doc read - a projection, not a call".
   *
   * One push of staleness is acceptable - a hash that just landed reads as
   * absent until the next publish, and the paste path treats absent as "not
   * ours to accept", which is the fail-closed direction.
   *
   * **Top-level, and deliberately NOT on the control slice**, which is where
   * it lived until it was found always-empty. The key was DECLARED on
   * `EpicControlProjection` but PUBLISHED by the runtime's own
   * `delivery.publish`, so the control sink carried a copy it seeded from the
   * initial constant and never updated - and every whole-slice control
   * delivery (the reset at `epic-control-replica.ts:564` most of all)
   * republished that stale `[]` over the real value. One key, two publishers,
   * and the wrong one won on every control change.
   *
   * A key belongs on the slice whose sink OWNS its publishes. This one's
   * publisher is the runtime, so it lives here.
   */
  readonly heldAttachmentHashes: readonly string[];
  /**
   * Which adapter arm is installed, projected.
   *
   * `null` before the first selection. A READ of runtime state that the store
   * needs synchronously - `getArtifactBodyDocKey` answers the artifact id on
   * the lanes arm and the artifact's ROOM id on `@1` - so it belongs in the
   * projection rather than in a call into the replica.
   *
   * Top-level for the same reason as the key above, and its old comment was
   * already describing the hazard without drawing the conclusion: it noted
   * that the runtime publishes this through `delivery.publish` and that "the
   * per-replica sinks are typed to their own sub-projection". Declaring it on
   * the CONTROL slice anyway gave that sink a copy it seeded from the initial
   * constant and never updated - so every whole-slice control delivery
   * republished `null` over the real arm. Not owning the publish is what makes
   * a slice the wrong home; it does not matter WHICH sink-owned slice it is.
   */
  readonly installedArm: EpicAdapterArm | null;
}

/** The initial held-hash set. Its own constant because its key is its own. */
export const INITIAL_HELD_ATTACHMENT_HASHES: readonly string[] = [];
