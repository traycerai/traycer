/**
 * What each plane of the epic runtime PUBLISHES. Plain serializable objects, every one - no
 * `Y.Doc`, no `Awareness`, no store handle, nothing that cannot survive a structured clone.
 */
import type { EpicAdapterArm } from "./epic-adapter-selection";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicCloudSyncStatus,
  EpicMigrationPhase,
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
   * Direction-aware version-skew signal (R4-D2), carried through only for an `INCOMPATIBLE` close -
   * `null` for every other fatal code. See `describeVersionSkew` (`@/lib/host/version-skew-copy`).
   */
  readonly upgradeGuidance: FatalErrorDetails["upgradeGuidance"];
}

/**
 * Per-epic major-migration slice. The renderer's modal reads these fields directly; the host owns
 * the transitions:
 */
export type EpicMigrationStatus = "idle" | "running" | "error" | "not-allowed";
export interface EpicMigrationSlice {
  readonly status: EpicMigrationStatus;
  readonly phase: EpicMigrationPhase | null;
  readonly chunksDone: number;
  readonly chunksTotal: number;
}

/**
 * Shared identity for "nothing retracted", so a session that never sees a removal - every session,
 * almost always - hands the same reference to every subscriber and re-renders nobody.
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

/** The record plane's read model. */
export interface EpicRecordsProjection extends EpicProjectedSlices {
  /**
   * The host's store-backed chat records (`epic.listChatRecords`), as last served. Empty in doc-only
   * mode: an older host that lacks the method, or before the first response lands.
   */
  readonly chatRecords: ChatsSlice;
  /**
   * Whether `epic.listChatRecords` has produced an answer this session.
   * Missing rows are not deletion evidence until this is true.
   */
  readonly chatRecordListAuthoritative: boolean;
  /** The record tables' ingest counters, projected. */
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
  /** Comment threads as the RECORDS LANE serves them, grouped by artifact. */
  readonly commentThreads: CommentThreadsSlice;
  readonly snapshotMeta: SnapshotMetaEpic | null;
  readonly snapshotLoaded: boolean;
  /** Renderer-local divergence: this replica holds root or body bytes the host has not acknowledged. */
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
  // The same shared "nothing retracted" identity as the chats': one frozen empty object serves both,
  // so neither table's quiet state ever hands subscribers a fresh reference.
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
   * Per-artifact-room availability. The body of an artifact is renderable only when the room
   * referenced by `artifacts.byId[id].artifactRoomId` reports `ready`.
   */
  readonly artifactRooms: ArtifactRoomsSlice;
  /**
   * Monotonic invalidation counter for LIVE-Y BINDINGS. The runtime's half of what the store
   * publishes as `bindingVersion`.
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
   * VISIBLE connection status: `deriveConnectionStatus(hostTransportStatus, cloudSyncStatus,
   * hasConnectedOnce)`. Write-gating and "can this surface act right now" checks read this.
   */
  readonly connectionStatus: StreamConnectionStatus;
  /** Raw renderer↔host stream status, unblended. */
  readonly hostTransportStatus: StreamConnectionStatus;
  /**
   * The RECORDS lane's own transport status, as distinct from the blended {@link
   * hostTransportStatus}.
   */
  readonly recordsTransportStatus: StreamConnectionStatus;
  /** Host-observed state of the host↔cloud link for this Epic. */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /** `true` only after a cloud-status frame for this exact open cycle. */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Latched by the first genuine cloud `connected` frame on this subscription
   * (never by the optimistic default), and cleared on re-subscribe.
   */
  readonly hasConnectedOnce: boolean;
  readonly accessLost: boolean;
  /**
   * Set once when the host emits `epicDeleted`. Terminal: the app-level access coordinator
   * force-closes the tab in response, so it is never cleared within a session's lifetime.
   */
  readonly epicDeleted: EpicDeletedAttribution | null;
  readonly migration: EpicMigrationSlice;
  // UNAUTHORIZED stays on `onAuthError` so the sign-out cascade owns it; only
  // non-UNAUTHORIZED fatal closes (e.g. INCOMPATIBLE) land here.
  readonly snapshotFetchError: SnapshotFetchError | null;
  /**
   * Host-side root-doc cloud-durability state from @1.1. `null` means this open cycle has not
   * received an atomic dirty snapshot (including a negotiated @1.0 session that cannot provide one).
   */
  readonly rootDirty: boolean | null;
  /** `true` only after the atomic @1.1 `dirtySnapshot` for this exact open cycle. */
  readonly hasDirtySnapshotForOpenCycle: boolean;
  /**
   * Per-artifact-room HOST-side sync state: `true` means the host holds work for that room its cloud
   * connection has not acknowledged.
   */
  readonly artifactRoomDirtyByArtifactRoomId: Readonly<Record<string, boolean>>;
}

/** The bootstrap control state. */
export const INITIAL_CONTROL_PROJECTION: EpicControlProjection = Object.freeze({
  permissionRole: null,
  connectionStatus: "connecting",
  hostTransportStatus: "connecting",
  recordsTransportStatus: "connecting",
  cloudSyncStatus: "connected",
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

/** Everything the three planes publish, as one object. */
export interface EpicRuntimeProjection
  extends EpicRecordsProjection, EpicRoomsProjection, EpicControlProjection {
  /** Every content-addressed attachment hash the root replica currently holds. */
  readonly heldAttachmentHashes: readonly string[];
  /** Which adapter arm is installed, projected. `null` before the first selection. */
  readonly installedArm: EpicAdapterArm | null;
}

/** The initial held-hash set. Its own constant because its key is its own. */
export const INITIAL_HELD_ATTACHMENT_HASHES: readonly string[] = [];
