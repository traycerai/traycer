import type { ConfirmedChatMutation } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
/** The zustand adapter over the epic replica runtime. */
import type { EpicAdapterArm } from "./runtime/epic-adapter-selection";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { replaceEqualDeep } from "@tanstack/react-query";
import { persist, createJSONStorage } from "zustand/middleware";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type {
  ChatRecordRemovalReason,
  ChatRecordSummaryV11,
} from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import { basePersistOptions, openEpicKey } from "@/lib/persist";
import type {
  AgentRolesSlice,
  ArtifactsSlice,
  ArtifactRoomsSlice,
  ChatsSlice,
  CommentThreadsSlice,
  DeletedArtifactsSlice,
  EpicArtifactRoomAvailability,
  EpicHeader,
  TerminalAgentsSlice,
  TreeSlice,
} from "./types";
import type { PendingChatCreation } from "./pending-chat-creations";
import { useAuthStore } from "@/stores/auth/auth-store";
import { appLogger } from "@/lib/logger";
// The read seam's own word for "this client has no body to give you", raised HERE because this is
// the layer that sees the grant say so.
import { ArtifactBodyUnavailableError } from "@/lib/epic-replica-reads";
import {
  createArtifactBodyLeaseBridge,
  type ArtifactBodyRetention,
} from "./runtime/worker/artifact-body-lease-bridge";
import { createRendererRuntimeEnvironment } from "./runtime/runtime-environment";
import { ARTIFACT_ROOM_LEASE_POLICY } from "./runtime/artifact-room-tier";
import { createHotBodyBudgetAdapter } from "./runtime/worker/hot-body-budget-adapter";
import { createMainThreadBodyDocStore } from "./runtime/worker/main-thread-body-docs";
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
import { BridgeDisposedError } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import { inertMutationResult } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { EpicRuntimeBodyReturnTarget } from "./runtime/worker/spawn-epic-runtime-worker";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import type {
  EpicMutation,
  EpicMutationResult,
  RuntimeCommand,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { RuntimeWorkerPort } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import type { EpicRuntimeAccountingPort } from "./runtime/epic-runtime-accounting-port";

import {
  EMPTY_RECORDS_PROJECTION,
  EMPTY_ROOMS_PROJECTION,
  INITIAL_CONTROL_PROJECTION,
  INITIAL_HELD_ATTACHMENT_HASHES,
} from "./runtime/epic-runtime-projection";
import type {
  EpicMigrationSlice,
  EpicRuntimeProjection,
  SnapshotFetchError,
} from "./runtime/epic-runtime-projection";
import type { EpicStreamClientFactory } from "./runtime/legacy-epic-stream-adapter";
import { type EpicWriteCommandIntent } from "./runtime/epic-write-command";

export type { EpicStreamClientFactory };
export type {
  EpicMigrationSlice,
  EpicMigrationStatus,
  SnapshotFetchError,
} from "./runtime/epic-runtime-projection";
export { LOCAL_ORIGIN } from "./runtime/epic-records-replica";

/** The relocated runtime, as this store reaches it. Narrow on purpose. */
export interface EpicRuntimeBinding {
  readonly port: RuntimeWorkerPort;
  /** One fire-and-forget command. See `RuntimeCommandMap`. */
  command(command: RuntimeCommand): void;
  /** A local presence frame for one body, out to the arm. */
  awarenessOut(docKey: string, frame: Uint8Array, localClientId: number): void;
  /** Tell the worker who is signed in. See the spawner's member. */
  currentUser(userId: string | null): void;
  /** Ends the transport while the replica lives on. */
  detach(): void;
  /** Ends the worker. */
  dispose(): void;
}

export interface OpenEpicStoreOptions {
  readonly epicId: string;
  /**
   * The host this session is established against. Carried straight onto the
   * returned handle - see {@link OpenEpicStoreHandle.hostId}.
   */
  readonly hostId: string;
  /**
   * What to do when the host's plan-denial deadline says this session's transport is worth probing
   * again. Injected because the store CANNOT do it.
   */
  readonly onRetryTransport: () => void;
  /**
   * The spawned runtime. Constructed by the session provider, because the
   * worker needs the session's real stream client and this store never had one.
   */
  readonly runtime: EpicRuntimeBinding;
  /** The process-backed books, built on MAIN by the same composition that spawned the worker. */
  readonly accounting: EpicRuntimeAccountingPort;
  /**
   * Identity to namespace persisted state under - the CANONICAL `profile.userId`, never the email
   * (two accounts can share an address).
   */
  readonly userId: string | null;
  /** Production's host-pinned requester; omitted by stores that never write. */
  readonly commandRequester?: HostRequester<HostRpcRegistry> | null;
  // `streamClientFactory`, `laneSelection`, `onAuthError` and `commandRequester` are gone: all four
  // were inputs to a runtime this store no longer constructs.
}

/** Disk-persisted slice of per-Epic state. */
interface PersistedSlice {
  readonly lastFocusedArtifactId: string | null;
  readonly lastFocusedThreadId: string | null;
}

/**
 * Raised at every waiter this session can no longer answer. A write command is answered by the
 * AUTHORITY, over a transport this handle owns.
 */
export class EpicSessionEndedError extends Error {
  /** Which teardown ended it - for logs, never for control flow. */
  readonly reason: string;

  constructor(reason: string) {
    super(`The epic session ended before the write was answered (${reason})`);
    this.name = "EpicSessionEndedError";
    this.reason = reason;
  }
}

/**
 * An artifact-body lease that also says WHEN the body became readable. `release` is the same
 * idempotent closure {@link OpenEpicState.acquireArtifactBodyLease} returns.
 */
export interface ArtifactBodyResidentLease {
  /**
   * A PROPERTY holding a closure, not a method: both callers hand this reference on rather than
   * calling it in place, and a method signature makes that an unbound-method read.
   */
  readonly release: () => void;
  /** Resolves when the body doc is RESIDENT. */
  readonly resident: Promise<void>;
}

/**
 * Per-Epic store shape. Mirrors the runtime's three plane projections field for field, plus the
 * live `Y` handles, the persisted focus ids, and the actions.
 */
export interface OpenEpicState {
  readonly epicId: string;
  /** React remount token for live-`Y` bindings, mapped from the runtime's `bindingEpoch`. */
  readonly bindingVersion: number;
  /** Bumped whenever a body doc becomes resident on THIS thread, or stops being. */
  readonly bodyResidencyVersion: number;
  /** Whether the root replica holds bytes for `hash`, SYNCHRONOUSLY. */
  hasAttachmentBytes: (hash: string) => boolean;

  // ── Projected slices (owned by the runtime's records plane) ───────────
  readonly epic: EpicHeader;
  readonly artifacts: ArtifactsSlice;
  /** Deleted-artifact tombstones (`epic.deletedArtifacts`). */
  readonly deletedArtifacts: DeletedArtifactsSlice;
  /**
   * The Y.Doc's own chat entries. The projector's working state, NOT a component-facing slice - read
   * {@link OpenEpicState.chats}, which is this unioned with the host's store-backed records.
   */
  readonly docChats: ChatsSlice;
  /**
   * The host's store-backed chat records (`epic.listChatRecords`), as last served. Empty in doc-only
   * mode: an older host that lacks the method, or before the first response lands.
   */
  readonly chatRecords: ChatsSlice;
  /**
   * Whether `epic.listChatRecords` has produced an answer this session. Missing rows are not
   * deletion evidence until this is true.
   */
  readonly chatRecordListAuthoritative: boolean;
  /** Projected ingest counters - see `EpicRecordsProjection`. */
  /** Projected adapter arm - see `EpicControlProjection`. */
  readonly installedArm: EpicAdapterArm | null;
  /**
   * Every attachment hash the root replica holds, projected. The source `hasAttachmentBytes` answers
   * from.
   */
  readonly heldAttachmentHashes: readonly string[];
  readonly chatIngestSeq: number;
  readonly tuiAgentIngestSeq: number;
  /** Chats the record plane RETRACTED while this session was open, and why. */
  readonly chatRetractions: Readonly<Record<string, ChatRecordRemovalReason>>;
  readonly chats: ChatsSlice;
  /**
   * The Y.Doc's own terminal-agent entries - the projector's working state, NOT a component-facing
   * slice.
   */
  readonly docTuiAgents: TerminalAgentsSlice;
  /** The host's registry-backed terminal-agent rows (`epic.listTuiAgents`), as last served. */
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /**
   * Terminal agents the record plane RETRACTED while this session was open, and why - the terminal
   * twin of {@link OpenEpicState.chatRetractions}, ABSORBING for the session's life for the same
   */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  >;
  /** Doc entries unioned with the host's registry rows. Components read THIS. */
  readonly tuiAgents: TerminalAgentsSlice;
  readonly agentRoles: AgentRolesSlice;
  /** Comment threads the RECORDS LANE has served, grouped by artifact. */
  readonly commentThreads: CommentThreadsSlice;
  readonly tree: TreeSlice;
  /** Per-artifact-room availability mirrored from `epic.subscribe@1.0` `artifactRoomState` frames. */
  readonly artifactRooms: ArtifactRoomsSlice;
  /**
   * Per-artifact-room HOST-side sync state, mirrored from the current `epic.subscribe@1.1`
   * `dirtySnapshot` and later `artifactRoomDirty` deltas: `true` means the host holds work for that
   */
  readonly artifactRoomDirtyByArtifactRoomId: Readonly<Record<string, boolean>>;
  /**
   * Host-side root-doc cloud-durability state from @1.1. `null` means this open cycle has not
   * received an atomic dirty snapshot (including a negotiated @1.0 session that cannot provide one).
   */
  readonly rootDirty: boolean | null;
  /** `true` only after the atomic @1.1 `dirtySnapshot` for this exact open cycle. */
  readonly hasDirtySnapshotForOpenCycle: boolean;

  // ── Connection / permissions / dirty-tracking ────────────────────────
  readonly snapshotMeta: SnapshotMetaEpic | null;
  readonly permissionRole: PermissionRole | null;
  /**
   * VISIBLE connection status: `deriveConnectionStatus(hostTransportStatus, cloudSyncStatus,
   * hasConnectedOnce)`. Write-gating and "can this surface act right now" checks read this.
   */
  readonly connectionStatus: StreamConnectionStatus;
  /** Raw renderer↔host stream status, unblended. */
  readonly hostTransportStatus: StreamConnectionStatus;
  /** The records lane's own status. See the projection's field of this name. */
  readonly recordsTransportStatus: StreamConnectionStatus;
  /**
   * Host-observed state of the host↔cloud link for this Epic, mirrored from `epic.subscribe@1.0`
   * `cloudSyncStatus` frames.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /** `true` only after a cloud-status frame for this exact open cycle. */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Latched by the first genuine cloud `connected` frame on this subscription (never by the
   * optimistic default), and cleared on re-subscribe.
   */
  readonly hasConnectedOnce: boolean;
  readonly accessLost: boolean;
  /**
   * Set once when the host emits `epicDeleted` - a remote delete observed while this session was
   * open - carrying the deletion attribution for the close toast.
   */
  readonly epicDeleted: EpicDeletedAttribution | null;
  readonly snapshotLoaded: boolean;
  /**
   * Live major-migration state for this epic, mirrored from `epic.subscribe@1.0` `migrationStarted`
   * and `migrationProgress` frames.
   */
  readonly migration: EpicMigrationSlice;
  // UNAUTHORIZED stays on `onAuthError` so the sign-out cascade owns it; only
  // non-UNAUTHORIZED fatal closes (e.g. INCOMPATIBLE) land here.
  readonly snapshotFetchError: SnapshotFetchError | null;
  readonly isDirty: boolean;
  readonly dirtyWatermarkStateVectorBase64: string | null;
  readonly latestHostStateVectorBase64: string | null;
  readonly unsyncedQueueSize: number;
  readonly writeCommands: readonly CommandRecord<EpicWriteCommandIntent>[];

  // ── Persisted UI focus ───────────────────────────────────────────────
  readonly lastFocusedArtifactId: string | null;
  readonly lastFocusedThreadId: string | null;

  // ── Actions: focus + connection lifecycle ────────────────────────────
  setLastFocusedArtifactId: (artifactId: string | null) => void;
  setLastFocusedThreadId: (threadId: string | null) => void;
  /**
   * Discards the renderer's local dirty signal and any offline-buffered bytes. Used by
   * quit-and-discard flows where the session is about to be torn down anyway.
   */
  discardUnsyncedEdits: () => void;
  /**
   * Rebinds the live stream so the next host snapshot replaces the local
   * Y.Doc replica without dropping the owning registry/session entry.
   */
  requestFreshSnapshot: () => void;
  /**
   * Asks the session's owner to rebuild this epic's transport, after the host's plan-denial deadline
   * says it is worth probing again. A REQUEST, and a refusable one.
   */
  retryTransport: () => void;
  /**
   * Sends a `retryMigration` client frame so the host re-runs an interrupted major migration without
   * dropping the `epic.subscribe` session.
   */
  retryMigration: () => void;
  enqueueWriteCommand: (
    intent: EpicWriteCommandIntent,
  ) => Promise<string | null>;
  waitForWriteCommand: (
    commandId: string,
  ) => Promise<CommandRecord<EpicWriteCommandIntent>>;
  retryWriteCommand: (commandId: string) => void;
  discardWriteCommand: (commandId: string) => void;
  /** Publishes the host's `epic.listChatRecords` answer into the record table. */
  applyChatRecords: (
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ) => void;
  /**
   * The chat-record ingest counter as it stands now - the value a list request captures at dispatch
   * and passes back to {@link OpenEpicState.applyChatRecords} as `issuedAtSeq`.
   */
  peekChatIngestSeq: () => number;
  /** Marks the record list authoritative after success or unsupported. */
  markChatRecordListAuthoritative: () => void;
  /**
   * Applies ONE `host.chatRecords.subscribe` delta - the push half of the same record table {@link
   * OpenEpicState.applyChatRecords} fills from the poll.
   */
  applyChatRecordDelta: (delta: ChatRecordDelta) => void;
  /** Reconcile an acknowledged mutation without manufacturing a host-stream event. */
  applyConfirmedChatMutation: (mutation: ConfirmedChatMutation) => void;
  applyTuiAgentRecords: (
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ) => void;
  /**
   * The terminal-agent ingest counter as it stands now - the value a list request captures at
   * dispatch and passes back to {@link OpenEpicState.applyTuiAgentRecords} as `issuedAtSeq`.
   */
  peekTuiAgentIngestSeq: () => number;
  /** Which STORE GENERATION the two ingest counters above belong to. */
  ingestFenceIdentity: number;
  /**
   * Applies ONE `host.chatRecords.subscribe@1.1` terminal-agent delta - the push half of the table
   * {@link OpenEpicState.applyTuiAgentRecords} fills from the poll, with {@link
   */
  applyTuiAgentRecordDelta: (delta: TuiAgentRecordDelta) => void;
  /**
   * Rebuilds the record slices for the CURRENTLY signed-in user from the raw rows this session has
   * retained - both tables, chats and terminal agents, since each is built for one owner at ingest.
   */
  republishChatRecordsForCurrentUser: () => void;
  /**
   * Retains a chat this client has had a host create, so it renders from the moment the create is
   * answered instead of when its record completes the round trip - see `./pending-chat-creations`.
   */
  beginPendingChatCreation: (pending: PendingChatCreation) => void;
  /** Drops a retained creation because it will never produce a record - the create call failed. */
  clearPendingChatCreation: (chatId: string) => void;
  /** Forcibly closes the underlying stream session. Idempotent. */
  dispose: () => void;
  /**
   * Closes the transport but KEEPS the Y.Doc, its replica and the unsynced queue alive and readable.
   * Idempotent.
   */
  detachTransport: () => void;

  // ── Actions: artifact + chat mutations (own `doc.transact`) ────────── Creation is deliberately
  // NOT a local doc write: `epic.createArtifact` / `epic.createChat` host RPCs own it, because
  renameArtifact: (artifactId: string, nextTitle: string) => Promise<boolean>;
  // `null` means nothing was stamped (refused, or the value already matches).
  /** Optimistic rename for an artifact, chat, or terminal agent. */
  beginRenameMutation: (
    nodeId: string,
    nextTitle: string,
  ) => Promise<string | null>;
  /** Optimistic epic-header title change. */
  beginEpicTitleMutation: (nextTitle: string) => Promise<string | null>;
  /** Optimistic reparent, validated against the projected tree. */
  beginReparentMutation: (
    nodeId: string,
    newParentId: string | null,
  ) => Promise<string | null>;
  /**
   * Report a mutation's RPC outcome. `"failed"` (terminal failure only - a retryable transport error
   * must stay pending or the row flaps) drops the patch, revealing whatever the host actually has.
   */
  retirePendingMutation: (
    requestId: string,
    outcome: "landed" | "failed",
  ) => Promise<boolean>;
  /**
   * Whether `requestId` is the LAST-STAMPED rename for its node - the guard the persisted canvas-tab
   * snapshot writes on.
   */
  isLatestRenameStamp: (nodeId: string, requestId: string) => Promise<boolean>;
  deleteArtifact: (artifactId: string) => Promise<boolean>;
  /** Move an artifact, chat, or terminal-agent to a new parent within its own family. */
  reparentArtifact: (
    artifactId: string,
    newParentId: string | null,
  ) => Promise<boolean>;

  // ── Actions: live-Y escape hatches ───────────────────────────────────
  getArtifactFragment: (artifactId: string) => Y.XmlFragment | null;
  /**
   * Live-Y escape hatch: reads content-addressed image bytes from the root doc's top-level
   * `attachments` map (the host-deduped image store).
   */
  readAttachmentBytes: (hash: string) => Promise<Uint8Array | null>;
  /**
   * WAITS for bytes that have not synced in yet; `null` only when the caller aborts or the runtime
   * tears down.
   */
  awaitAttachmentBytes: (
    hash: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | null>;
  /** Synchronously reports whether the root attachment map has this hash. */

  getArtifactBodyAwareness: (artifactId: string) => Awareness | null;
  /**
   * Reports the availability of the artifact-room hosting `artifactId`'s body. Returns `unavailable`
   * when the artifact has no `artifactRoomId` yet or when the artifactRoom is not tracked.
   */
  getArtifactBodyAvailability: (
    artifactId: string,
  ) => EpicArtifactRoomAvailability;
  /** Resolves the artifact-room hosting `artifactId`'s body, or `null` when the artifact does not exist or has no room yet. */
  /** Key the artifact-body tier holds this artifact's live doc under, for the consumer that re-takes a lease when that identity changes. */
  getArtifactBodyDocKey: (artifactId: string) => string | null;
  /**
   * Materialize the artifact-room backing `artifactId`'s body and hold it materialized until the
   * returned release is called.
   */
  acquireArtifactBodyLease: (artifactId: string) => () => void;
  /**
   * {@link acquireArtifactBodyLease} for a caller that can WAIT for the body, rather than one that
   * must return a cleanup synchronously.
   */
  acquireResidentArtifactBodyLease: (
    artifactId: string,
    /** What the LAST release does with the body. */
    retention: ArtifactBodyRetention,
  ) => ArtifactBodyResidentLease;
  /** Snapshot-read the title for optimistic-rename rollback. */
  readArtifactTitle: (artifactId: string) => string | null;
}

export interface OpenEpicStoreHandle {
  readonly epicId: string;
  readonly userId: string | null;
  /**
   * Host this session was established against. Fixed for the handle's life; a host change is clone-not-migrate.
   */
  readonly hostId: string;
  /**
   * Transfer this session's root state into another, and take one in. The PORT the two merge sites
   * use instead of reaching for `.doc`.
   */
  readonly encodeRootState: () => Promise<Uint8Array>;
  readonly applyRootUpdate: (
    update: Uint8Array,
    asLocalEdit: boolean,
  ) => Promise<boolean>;
  /** What the spawner reduces this session's projection stream into. */
  readonly projection: RuntimeProjectionHandlers<
    Partial<EpicRuntimeProjection>
  >;
  /**
   * The body plane's return leg, handed OUT for the same reason `projection` is: the store owns the
   * live docs, and the worker that feeds them is spawned before this store exists.
   */
  readonly body: EpicRuntimeBodyReturnTarget;
  readonly store: UseBoundStore<StoreApi<OpenEpicState>>;
  readonly dispose: () => void;
  /** Closes the transport, keeps the doc and its unsynced queue. */
  readonly detachTransport: () => void;
  readonly requestFreshSnapshot: () => void;
  readonly retryTransport: () => void;
  /** True when this renderer has a loaded, locally clean snapshot and can still reach the host. */
  isClean: () => boolean;
  /** Ids of the artifact rooms currently materialized as live `Y.Doc`s. */
  hotArtifactRoomIdsForTests: () => ReadonlyArray<string>;
}

/**
 * Mints {@link OpenEpicState.ingestFenceIdentity} - one value per store construction,
 * module-monotonic so no two generations (even of the same epic) ever share one.
 */
let nextIngestFenceIdentity = 1;

/** A published slice, as far as this layer checks. */
export function isProjectionPatch(
  value: unknown,
): value is Partial<EpicRuntimeProjection> {
  return typeof value === "object" && value !== null;
}

export function createOpenEpicStore(
  options: OpenEpicStoreOptions,
): OpenEpicStoreHandle {
  const { epicId, userId, hostId } = options;
  const mintedIngestFenceIdentity = nextIngestFenceIdentity;
  nextIngestFenceIdentity += 1;

  let storeApi: StoreApi<OpenEpicState> | null = null;
  /** The worker's own dirty verdict, before main-only body refusals are folded into it. */
  let workerReplicaIsDirty = false;
  const refusedBodyUpdateDocKeys = new Set<string>();
  /**
   * Current main-doc lineage per key. Replacement and retirement reuse the docKey, so an async
   * refusal must prove it still belongs to the resident lineage before it can latch that key dirty.
   */
  const bodyDocGenerationByDocKey = new Map<string, symbol>();

  function bodyDocGenerationForDispatch(docKey: string): symbol {
    const currentGeneration = bodyDocGenerationByDocKey.get(docKey);
    if (currentGeneration !== undefined) return currentGeneration;
    const nextGeneration = Symbol();
    bodyDocGenerationByDocKey.set(docKey, nextGeneration);
    return nextGeneration;
  }

  function markBodyUpdateRefused(
    docKey: string,
    dispatchedGeneration: symbol,
  ): void {
    if (bodyDocGenerationByDocKey.get(docKey) !== dispatchedGeneration) return;
    if (refusedBodyUpdateDocKeys.has(docKey)) return;
    refusedBodyUpdateDocKeys.add(docKey);
    storeApi?.setState({ isDirty: true });
  }

  /**
   * Count of `body/update` calls posted but not yet settled, per DISPATCH GENERATION
   * (`bodyDocGenerationForDispatch`'s own token) rather than per `docKey` string.
   */
  const pendingBodyUpdateCallCountByGeneration = new Map<symbol, number>();

  function notePendingBodyUpdate(generation: symbol): void {
    pendingBodyUpdateCallCountByGeneration.set(
      generation,
      (pendingBodyUpdateCallCountByGeneration.get(generation) ?? 0) + 1,
    );
  }

  function clearPendingBodyUpdate(generation: symbol): void {
    const count = pendingBodyUpdateCallCountByGeneration.get(generation);
    if (count === undefined) return;
    if (count > 1) {
      // Another call for this SAME generation is still outstanding - the
      // latch stays forced, and there is nothing new to publish.
      pendingBodyUpdateCallCountByGeneration.set(generation, count - 1);
      return;
    }
    pendingBodyUpdateCallCountByGeneration.delete(generation);
    if (
      refusedBodyUpdateDocKeys.size > 0 ||
      pendingBodyUpdateCallCountByGeneration.size > 0
    ) {
      return;
    }
    storeApi?.setState({ isDirty: workerReplicaIsDirty });
  }

  function retireBodyDoc(docKey: string): void {
    const retiredGeneration = bodyDocGenerationByDocKey.get(docKey);
    bodyDocGenerationByDocKey.delete(docKey);
    const hadRefusal = refusedBodyUpdateDocKeys.delete(docKey);
    // Deletes the bucket outright, not a decrement - see the field's own doc
    // on why a stale settle must find nothing left to touch.
    const hadPending =
      retiredGeneration !== undefined &&
      pendingBodyUpdateCallCountByGeneration.delete(retiredGeneration);
    if (!hadRefusal && !hadPending) return;
    if (
      refusedBodyUpdateDocKeys.size > 0 ||
      pendingBodyUpdateCallCountByGeneration.size > 0
    ) {
      return;
    }
    storeApi?.setState({ isDirty: workerReplicaIsDirty });
  }
  /**
   * Ids for pending attachment WAITS, unique per store. The worker keys its pending waits on this,
   * and `attachment/cancel` names one - so a reused id would cancel somebody else's wait.
   */
  let nextAttachmentAwaitId = 1;

  /** One bridge call, answering `null` when the session has been torn down. */
  const callOrNullOnTeardown = async <T>(
    call: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await call();
    } catch (cause: unknown) {
      if (cause instanceof BridgeDisposedError) return null;
      throw cause;
    }
  };
  /** The last binding epoch main acted on, so an advance is detectable. */

  /** Disposal is a MAIN-side fact now. */
  let disposed = false;
  let unsubscribeAuthUserId: (() => void) | null = null;

  /** Waiters this session promised to settle and can no longer answer. */
  const sessionEndedSettlers = new Set<(reason: string) => void>();
  /**
   * Latched, so a waiter created AFTER the teardown rejects immediately instead
   * of registering into a set nothing will drain again.
   */
  let sessionEndedReason: string | null = null;

  function endSession(reason: string): void {
    if (sessionEndedReason !== null) return;
    sessionEndedReason = reason;
    // Copied before draining: each settler removes itself from the live set.
    const settlers = [...sessionEndedSettlers];
    sessionEndedSettlers.clear();
    for (const settle of settlers) settle(reason);
  }

  /** Doc keys the projection currently calls `ready`. */
  function readyBodyDocKeys(): ReadonlySet<string> {
    const state = storeApi?.getState();
    if (state === undefined) return new Set<string>();
    const ready = new Set<string>();
    for (const [artifactId, availability] of Object.entries(
      state.artifactRooms.stateByArtifactId,
    )) {
      if (availability !== "ready") continue;
      const docKey = state.getArtifactBodyDocKey(artifactId);
      if (docKey !== null) ready.add(docKey);
    }
    return ready;
  }

  function dropBodiesWhoseRoomIsGone(): void {
    const resident = bodyDocs.residentDocKeys();
    if (resident.length === 0) return;
    const ready = readyBodyDocKeys();
    for (const docKey of resident) {
      if (ready.has(docKey)) continue;
      bodyLeases.forget(docKey);
      bodyDocs.drop(docKey);
    }
  }

  /** The completion half of an `"awaiting-seed"` grant. */
  function retryBodiesWhoseRoomBecameReady(): void {
    const ready = readyBodyDocKeys();
    bodyLeases.retryAwaitingBodies((docKey) => ready.has(docKey));
  }

  /** Settles once `getArtifactFragment` will answer for this artifact. */
  function waitForBodyResidency(
    artifactId: string,
    onAbandonReady: (abandon: () => void) => void,
  ): Promise<void> {
    const api = storeApi;
    if (api === null) {
      return Promise.reject(new ArtifactBodyUnavailableError(artifactId));
    }
    if (api.getState().getArtifactFragment(artifactId) !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      /**
       * The two ways this wait ends without a body, both PUSHED rather than noticed: the holder let go,
       * or the session tore down.
       */
      const abandon = (): void => {
        unsubscribe?.();
        sessionEndedSettlers.delete(abandon);
        reject(new ArtifactBodyUnavailableError(artifactId));
      };
      onAbandonReady(abandon);
      // Teardown owes an answer here for the same reason it owes one to a write-command waiter:
      // `dispose()` drops every body doc, so residency can never arrive afterwards.
      sessionEndedSettlers.add(abandon);
      unsubscribe = api.subscribe(() => {
        if (api.getState().getArtifactFragment(artifactId) === null) return;
        unsubscribe?.();
        sessionEndedSettlers.delete(abandon);
        resolve();
      });
    });
  }

  /**
   * The one implementation behind both body-lease members: the sync-in one the layout effect needs,
   * and the awaitable one a reader needs.
   */
  function acquireResidentBodyLease(
    artifactId: string,
    retention: ArtifactBodyRetention,
  ): ArtifactBodyResidentLease {
    let released = false;
    let grantedRelease: (() => void) | null = null;
    let abandonResidency: (() => void) | null = null;
    const resident = bodyLeases
      .acquire(artifactId, retention)
      .catch((cause: unknown) => {
        // A bridge that went away underneath the call is THIS ARTIFACT'S BODY being unavailable, said in
        // the only vocabulary the callers have copy for.
        if (cause instanceof BridgeDisposedError) {
          throw new ArtifactBodyUnavailableError(artifactId);
        }
        throw cause;
      })
      .then((grant) => {
        // Discriminated on the ONE outcome that owes nothing.
        if (grant.kind === "unavailable") {
          throw new ArtifactBodyUnavailableError(artifactId);
        }
        if (released) {
          grant.release();
          throw new ArtifactBodyUnavailableError(artifactId);
        }
        // Wrapped, not referenced: `grant.release` is a method, and handing the
        // bare reference on loses its receiver.
        grantedRelease = () => {
          grant.release();
        };
        // A `"granted"` grant arrived WITH bytes, so the doc is installed by the time this resolves.
        if (grant.kind === "granted") return undefined;
        return waitForBodyResidency(artifactId, (abandon) => {
          abandonResidency = abandon;
        });
      });
    return {
      release: () => {
        if (released) return;
        released = true;
        grantedRelease?.();
        // SETTLED here, not noticed later.
        abandonResidency?.();
      },
      resident,
    };
  }

  function applyProjection(patch: Partial<EpicRuntimeProjection>): void {
    const api = storeApi;
    if (api === null) {
      // UNREACHABLE, and thrown rather than assumed away.
      throw new Error(
        "[open-epic] projection applied before the store attached",
      );
    }
    const { bindingEpoch, ...workerProjected } = patch;
    let projected = workerProjected;
    if (projected.isDirty !== undefined) {
      workerReplicaIsDirty = projected.isDirty;
      if (
        refusedBodyUpdateDocKeys.size > 0 ||
        pendingBodyUpdateCallCountByGeneration.size > 0
      ) {
        projected = { ...projected, isDirty: true };
      }
    }
    const current = api.getState();
    // Read BEFORE the per-key pass, because that pass is what destroys them.
    const aliasGroups = aliasGroupsOf(projected);
    for (const key of Object.keys(projected) as ReadonlyArray<
      keyof typeof projected
    >) {
      stabilizeProjectionKey(current, projected, key);
    }
    restoreAliasGroups(projected, aliasGroups);
    api.setState(
      bindingEpoch === undefined
        ? projected
        : { ...projected, bindingVersion: bindingEpoch },
    );
    dropBodiesWhoseRoomIsGone();
    retryBodiesWhoseRoomBecameReady();
  }

  /** One key of the incoming patch, reconciled against what the store holds. */
  function stabilizeProjectionKey<
    K extends keyof Omit<EpicRuntimeProjection, "bindingEpoch">,
  >(
    current: OpenEpicState,
    projected: Partial<Omit<EpicRuntimeProjection, "bindingEpoch">>,
    key: K,
  ): void {
    const incoming = projected[key];
    if (incoming === undefined) return;
    projected[key] = replaceEqualDeep(current[key], incoming);
  }

  /** Keys of one patch whose incoming values are the SAME OBJECT, grouped. */
  function aliasGroupsOf(patch: object): readonly (readonly string[])[] {
    const byValue = new Map<object, string[]>();
    for (const key of Object.keys(patch)) {
      const value: unknown = Reflect.get(patch, key);
      if (value === null || typeof value !== "object") continue;
      const held = byValue.get(value);
      if (held === undefined) byValue.set(value, [key]);
      else held.push(key);
    }
    return [...byValue.values()].filter((keys) => keys.length > 1);
  }

  /** Put every group back on one reference. */
  function restoreAliasGroups(
    patch: object,
    groups: readonly (readonly string[])[],
  ): void {
    for (const keys of groups) {
      // No empty-group guard: `aliasGroupsOf` returns only groups of two or more, so destructuring types
      // `first` as `string` and a `=== undefined` check is a condition with no overlap - which
      const [first, ...rest] = keys;
      const representative: unknown = Reflect.get(patch, first);
      for (const key of rest) Reflect.set(patch, key, representative);
    }
  }

  /** The relocated runtime, reached through the bridge. This store no longer CONSTRUCTS a runtime. */
  const runtime = options.runtime;

  /**
   * One mutation, over the bridge. Callers narrow on their own literal `kind`.
   */
  const applyMutation = async (
    mutation: EpicMutation,
  ): Promise<EpicMutationResult> => {
    try {
      return await runtime.port.call("mutation/apply", mutation, NO_TRANSFER);
    } catch (cause: unknown) {
      // A DISPOSED session answers INERT, it does not reject.
      if (cause instanceof BridgeDisposedError) {
        return inertMutationResult(mutation);
      }
      throw cause;
    }
  };

  const bodyDocs = createMainThreadBodyDocStore({
    onResidencyChange: () => {
      // Residency is a MAIN-THREAD fact and nothing else publishes it. Availability comes from the
      // projection and says the room is `ready`; this says the fragment exists.
      storeApi?.setState((state) => ({
        bodyResidencyVersion: state.bodyResidencyVersion + 1,
      }));
    },
    onDocRetired: (docKey) => {
      // A lane body retires only after its full main-side state was accepted by the worker's demote, or
      // after an authoritative replacement/drop.
      retireBodyDoc(docKey);
    },
    onLocalDocUpdate: (docKey, update) => {
      // A lane-level transport refusal does NOT reach this caller as loss.
      const dispatchedGeneration = bodyDocGenerationForDispatch(docKey);
      // Latched BEFORE the call, synchronously - see `pendingBodyUpdateCallCountByGeneration`'s own doc
      // for the window this closes.
      notePendingBodyUpdate(dispatchedGeneration);
      storeApi?.setState({ isDirty: true });
      void runtime.port
        .call("body/update", { docKey, update }, NO_TRANSFER)
        .then((answer) => {
          if (answer.outcome.kind !== "dropped") return;
          markBodyUpdateRefused(docKey, dispatchedGeneration);
          appLogger.error(
            "[open-epic] body update refused by the runtime worker",
            { docKey },
            new Error(answer.outcome.reason),
          );
        })
        .catch((cause: unknown) => {
          // Teardown, not a failure: the session is going away and this edit is already in main's live doc.
          if (cause instanceof BridgeDisposedError) return;
          markBodyUpdateRefused(docKey, dispatchedGeneration);
          // LOGGED, not rethrown.
          appLogger.error(
            "[open-epic] body update refused by the runtime worker",
            { docKey },
            cause,
          );
        })
        .finally(() => {
          clearPendingBodyUpdate(dispatchedGeneration);
        });
    },
    onLocalAwareness: (docKey, frame, localClientId) => {
      runtime.awarenessOut(docKey, frame, localClientId);
    },
  });

  const bodyLeases = createArtifactBodyLeaseBridge({
    bridge: runtime.port,
    docs: bodyDocs,
    budget: createHotBodyBudgetAdapter(options.accounting),
    // The renderer's own clock.
    scheduler: createRendererRuntimeEnvironment().scheduler,
    // The SAME value the tier's cooldown used.
    lingerMs: ARTIFACT_ROOM_LEASE_POLICY.cooldownMs,
    // Same source as the linger, and the same reason: the hot docs are here
    // now, so the ceiling on how many of them exist is here too.
    maxHotDocs: ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized,
    // The availability map says this body's room is ready and the runtime still has no bytes for it.
    reportAwaitingStalled: (docKey, artifactId) => {
      appLogger.warn("[open-epic] body ready but still unseeded", {
        epicId: options.epicId,
        docKey,
        artifactId,
      });
    },
  });

  const store = create<OpenEpicState>()(
    persist(
      (set, get, api) => {
        storeApi = api;
        return {
          epicId,
          // The React remount token starts where the runtime's binding epoch
          // does; every later value IS that epoch, translated on delivery.
          bindingVersion: EMPTY_ROOMS_PROJECTION.bindingEpoch,
          bodyResidencyVersion: 0,
          ...EMPTY_RECORDS_PROJECTION,
          artifactRooms: EMPTY_ROOMS_PROJECTION.artifactRooms,
          ...INITIAL_CONTROL_PROJECTION,
          // Its own key now, so its own seed - see the projection's comment on
          // why it left the control slice.
          heldAttachmentHashes: INITIAL_HELD_ATTACHMENT_HASHES,
          // Same: its own key, so its own seed. `null` is "no arm selected
          // yet", which is what every reader already treats it as.
          installedArm: null,
          ingestFenceIdentity: mintedIngestFenceIdentity,
          lastFocusedArtifactId: null,
          lastFocusedThreadId: null,

          setLastFocusedArtifactId: (artifactId) => {
            if (get().lastFocusedArtifactId === artifactId) return;
            set({ lastFocusedArtifactId: artifactId });
          },

          setLastFocusedThreadId: (threadId) => {
            if (get().lastFocusedThreadId === threadId) return;
            set({ lastFocusedThreadId: threadId });
          },

          discardUnsyncedEdits: () => {
            runtime.command({ kind: "discard-unsynced-edits", payload: {} });
          },
          requestFreshSnapshot: () => {
            runtime.command({ kind: "request-fresh-snapshot", payload: {} });
          },

          retryTransport: () => {
            // Ended covers BOTH exits: a disposed handle has nothing to rebuild, and a detached one is frozen
            // by contract ("takes no further input").
            if (sessionEndedReason !== null) return;
            const state = get();
            // THE DATA-LOSS GATE, and the reason this is not upstream's implementation.
            if (state.isDirty || state.writeCommands.length > 0) return;
            options.onRetryTransport();
          },
          retryMigration: () => {
            runtime.command({ kind: "retry-migration", payload: {} });
          },
          /**
           * ASYNC, because the queue is on the other thread and it owns BOTH answers: `CommandQueue.enqueue`
           * mints the id, and it refuses from queue state this side does not hold.
           */
          enqueueWriteCommand: async (intent) => {
            const answer = await callOrNullOnTeardown(() =>
              runtime.port.call("command/enqueue", { intent }, NO_TRANSFER),
            );
            // `null` is the queue's own REFUSAL, and a torn-down session is a refusal too - it minted no id
            // and recorded nothing.
            if (answer === null) return null;
            return answer.outcome === "enqueued" ? answer.commandId : null;
          },
          waitForWriteCommand: (commandId) => {
            const current = get().writeCommands.find(
              (command) => command.commandId === commandId,
            );
            if (current !== undefined && current.state !== "pending") {
              return Promise.resolve(current);
            }
            // `enqueueAndWait` never returned, and the sidebar's bulk delete awaits an `allSettled` whose
            // `.finally` clears `deletePending`, so ONE unanswerable command disabled bulk delete for the life
            if (sessionEndedReason !== null) {
              return Promise.reject(
                new EpicSessionEndedError(sessionEndedReason),
              );
            }
            return new Promise((resolve, reject) => {
              // Declared before the subscription so the two can refer to each
              // other without either reading the other's binding early.
              let unsubscribe: (() => void) | null = null;
              // Registered rather than polled: the queue lives on the worker, and a teardown that has already
              // terminated that thread will never publish again - so nothing else can wake this waiter.
              const abandon = (reason: string): void => {
                unsubscribe?.();
                reject(new EpicSessionEndedError(reason));
              };
              sessionEndedSettlers.add(abandon);
              unsubscribe = api.subscribe((state) => {
                const command = state.writeCommands.find(
                  (candidate) => candidate.commandId === commandId,
                );
                if (command === undefined || command.state === "pending") {
                  return;
                }
                unsubscribe?.();
                sessionEndedSettlers.delete(abandon);
                resolve(command);
              });
            });
          },
          retryWriteCommand: (commandId) => {
            runtime.command({
              kind: "retry-write-command",
              payload: { commandId },
            });
          },
          discardWriteCommand: (commandId) => {
            runtime.command({
              kind: "discard-write-command",
              payload: { commandId },
            });
          },

          applyChatRecords: (records, issuedAtSeq) => {
            runtime.command({
              kind: "apply-chat-records",
              payload: { records, issuedAtSeq },
            });
          },
          peekChatIngestSeq: () => get().chatIngestSeq,
          markChatRecordListAuthoritative: () => {
            runtime.command({
              kind: "mark-chat-records-authoritative",
              payload: {},
            });
          },
          applyConfirmedChatMutation: (mutation) => {
            runtime.command({
              kind: "apply-confirmed-chat-mutation",
              payload: { mutation },
            });
          },
          applyChatRecordDelta: (delta) => {
            runtime.command({
              kind: "apply-chat-record-delta",
              payload: { delta },
            });
          },
          applyTuiAgentRecords: (records, issuedAtSeq) => {
            runtime.command({
              kind: "apply-tui-agent-records",
              payload: { records, issuedAtSeq },
            });
          },
          peekTuiAgentIngestSeq: () => get().tuiAgentIngestSeq,
          applyTuiAgentRecordDelta: (delta) => {
            runtime.command({
              kind: "apply-tui-agent-record-delta",
              payload: { delta },
            });
          },
          republishChatRecordsForCurrentUser: () => {
            runtime.command({
              kind: "republish-records-for-current-user",
              payload: {},
            });
          },
          beginPendingChatCreation: (pending) => {
            runtime.command({
              kind: "begin-pending-chat-creation",
              payload: { pending },
            });
          },
          clearPendingChatCreation: (chatId) => {
            runtime.command({
              kind: "clear-pending-chat-creation",
              payload: { chatId },
            });
          },

          detachTransport: () => {
            // BEFORE the detach, and it is not merely tidy: a retained buffer keeps serving local-state
            // actions, so this handle lives on with no socket.
            endSession("transport-detached");
            runtime.detach();
          },
          dispose: () => {
            if (disposed) return;
            unsubscribeAuthUserId?.();
            unsubscribeAuthUserId = null;
            disposed = true;
            endSession("disposed");
            // BEFORE dropping the docs, and before the worker goes away: a linger is a bet that the user is
            // coming back to this body, and at dispose that bet is already lost.
            bodyLeases.flushLingering();
            bodyDocs.dropAll();
            runtime.dispose();
          },

          /** The eight metadata mutations, over `mutation/apply`. */
          renameArtifact: async (artifactId, nextTitle) => {
            const result = await applyMutation({
              kind: "rename-artifact",
              request: { artifactId, title: nextTitle },
            });
            return result.kind === "rename-artifact"
              ? result.value.changed
              : false;
          },
          deleteArtifact: async (artifactId) => {
            const result = await applyMutation({
              kind: "delete-artifact",
              request: { artifactId },
            });
            return result.kind === "delete-artifact"
              ? result.value.changed
              : false;
          },
          reparentArtifact: async (artifactId, newParentId) => {
            const result = await applyMutation({
              kind: "reparent-artifact",
              request: { artifactId, newParentId },
            });
            return result.kind === "reparent-artifact"
              ? result.value.changed
              : false;
          },
          beginRenameMutation: async (nodeId, nextTitle) => {
            const result = await applyMutation({
              kind: "begin-rename",
              request: { nodeId, title: nextTitle },
            });
            return result.kind === "begin-rename"
              ? result.value.requestId
              : null;
          },
          beginEpicTitleMutation: async (nextTitle) => {
            const result = await applyMutation({
              kind: "begin-epic-title",
              request: { title: nextTitle },
            });
            return result.kind === "begin-epic-title"
              ? result.value.requestId
              : null;
          },
          beginReparentMutation: async (nodeId, newParentId) => {
            const result = await applyMutation({
              kind: "begin-reparent",
              request: { nodeId, newParentId },
            });
            return result.kind === "begin-reparent"
              ? result.value.requestId
              : null;
          },
          retirePendingMutation: async (requestId, outcome) => {
            const result = await applyMutation({
              kind: "retire-pending",
              request: { requestId, outcome },
            });
            return result.kind === "retire-pending"
              ? result.value.retired
              : false;
          },
          isLatestRenameStamp: async (nodeId, requestId) => {
            const result = await applyMutation({
              kind: "is-latest-rename-stamp",
              request: { nodeId, requestId },
            });
            return result.kind === "is-latest-rename-stamp"
              ? result.value.latest
              : false;
          },
          /** The WAITING leg. `signal` is LOAD-BEARING here. */
          awaitAttachmentBytes: async (hash, signal) => {
            if (signal.aborted) return null;
            const awaitId = nextAttachmentAwaitId;
            nextAttachmentAwaitId += 1;
            // Cancel is its own CALL, and the abort listener is what turns the caller's signal into one.
            const onAbort = (): void => {
              void runtime.port
                .call("attachment/cancel", { awaitId }, NO_TRANSFER)
                .catch(() => {
                  // The bridge is gone, so the wait is gone with it. Nothing
                  // to cancel and nobody to tell.
                });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              const answer = await runtime.port.call(
                "attachment/await",
                { awaitId, hash },
                NO_TRANSFER,
              );
              return answer.bytes;
            } catch (cause: unknown) {
              // Teardown settles null, exactly as the prompt read does - see
              // its comment for why this is narrowed on the error type.
              if (cause instanceof BridgeDisposedError) return null;
              throw cause;
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          },
          readAttachmentBytes: async (hash) => {
            try {
              const answer = await runtime.port.call(
                "attachment/read",
                { hash },
                NO_TRANSFER,
              );
              return answer.bytes;
            } catch (cause: unknown) {
              // TEARDOWN SETTLES NULL.
              if (cause instanceof BridgeDisposedError) return null;
              throw cause;
            }
          },
          // Answered from the MAIN-SIDE docs.
          hasAttachmentBytes: (hash) =>
            get().heldAttachmentHashes.includes(hash),
          getArtifactFragment: (artifactId) => {
            const docKey = get().getArtifactBodyDocKey(artifactId);
            return docKey === null
              ? null
              : bodyDocs.fragment(docKey, artifactId);
          },
          getArtifactBodyAwareness: (artifactId) => {
            const docKey = get().getArtifactBodyDocKey(artifactId);
            return docKey === null ? null : bodyDocs.awareness(docKey);
          },
          getArtifactBodyAvailability: (artifactId) =>
            // Zero new payload: the runtime's own implementation was already a projection read -
            // `sink.read().artifactRooms.stateByArtifactId[id] ??
            get().artifactRooms.stateByArtifactId[artifactId] ?? "unavailable",
          getArtifactBodyDocKey: (artifactId) => {
            // The runtime's own rule, against projected inputs: the lanes arm keys the tier by artifact id,
            // `@1` keys it by the artifact's ROOM.
            const state = get();
            if (state.installedArm === "lanes") return artifactId;
            if (!Object.hasOwn(state.artifacts.byId, artifactId)) return null;
            const roomId = state.artifacts.byId[artifactId].artifactRoomId;
            return roomId !== null && roomId.length > 0 ? roomId : null;
          },
          /** SYNCHRONOUS on the way in, asynchronous underneath. */
          acquireArtifactBodyLease: (artifactId) => {
            // The layout-effect holder is an EDITOR mount, which is exactly
            // the bet the cooldown is for.
            const lease = acquireResidentBodyLease(artifactId, "linger");
            // HANDLED, not ignored, and CLASSIFIED rather than blanket.
            lease.resident.catch((cause: unknown) => {
              if (cause instanceof ArtifactBodyUnavailableError) return;
              appLogger.warn("[epic] artifact body lease failed", {
                epicId,
                artifactId,
                error: cause instanceof Error ? cause.name : "unknown",
                message: cause instanceof Error ? cause.message : String(cause),
              });
            });
            return lease.release;
          },
          acquireResidentArtifactBodyLease: (artifactId, retention) =>
            acquireResidentBodyLease(artifactId, retention),
          readArtifactTitle: (artifactId) => {
            // The PROJECTION, in the doc read's own family order: artifacts, then chats, then terminal agents,
            // falling through on ENTRY PRESENCE exactly as the doc version falls through on a missing map
            const state = get();
            if (Object.hasOwn(state.artifacts.byId, artifactId)) {
              return state.artifacts.byId[artifactId].title;
            }
            if (Object.hasOwn(state.chats.byId, artifactId)) {
              return state.chats.byId[artifactId].title;
            }
            if (Object.hasOwn(state.tuiAgents.byId, artifactId)) {
              return state.tuiAgents.byId[artifactId].title;
            }
            return null;
          },
        };
      },
      {
        ...basePersistOptions(openEpicKey(userId, epicId)),
        storage: createJSONStorage(() => localStorage),
        partialize: (state): PersistedSlice => ({
          lastFocusedArtifactId: state.lastFocusedArtifactId,
          lastFocusedThreadId: state.lastFocusedThreadId,
        }),
      },
    ),
  );

  // The worker's projector folds on this and has no other source for it, so it is pushed at
  // construction rather than waited for: a session built before the auth profile hydrates would
  runtime.currentUser(useAuthStore.getState().profile?.userId ?? null);

  unsubscribeAuthUserId = useAuthStore.subscribe((state, prevState) => {
    const nextUserId = state.profile?.userId ?? null;
    const prevUserId = prevState.profile?.userId ?? null;
    if (nextUserId === prevUserId || disposed) return;
    // An answer scoped to the previous viewer cannot authorize absence for the next one. The
    // viewer-keyed query will set this again when its own result is applied.
    runtime.currentUser(nextUserId);
    runtime.command({
      kind: "mark-chat-records-not-authoritative",
      payload: {},
    });
    // Re-derive the record slices from the RETAINED raw rows, then re-project.
    runtime.command({
      kind: "republish-records-for-current-user",
      payload: {},
    });
    runtime.command({ kind: "reproject-for-viewer-change", payload: {} });
  });

  // No `start()` here.

  return {
    epicId,
    userId,
    hostId,
    body: {
      applyDocUpdate: (docKey, update) => {
        bodyDocs.applyRemote(docKey, update);
      },
      applyAwareness: (docKey, frame) => {
        bodyDocs.applyRemoteAwareness(docKey, frame);
      },
    },
    projection: {
      // A cheap envelope check, which the contract explicitly allows: both ends ship in one bundle
      // graph, so this distinguishes a slice from a FOREIGN payload rather than re-validating a shape
      accept: (value) => (isProjectionPatch(value) ? value : null),
      apply: (value) => {
        applyProjection(value);
      },
      reject: (reason, revision) => {
        appLogger.warn("[open-epic] dropped a projection publication", {
          epicId,
          reason,
          revision,
        });
      },
    },
    encodeRootState: async () => {
      const answer = await callOrNullOnTeardown(() =>
        runtime.port.call("root/encode", {}, NO_TRANSFER),
      );
      // Empty bytes on teardown, which is the SAME answer the worker host gives with no core - "an empty
      // update applies as nothing rather than as a document, and the transfer site checks the answer
      return answer === null ? new Uint8Array() : answer.update;
    },
    applyRootUpdate: async (update, asLocalEdit) => {
      // The bytes are TRANSFERRED, not cloned - this is a whole root replica.
      const encoded = takeBytesForTransfer(update);
      const answer = await callOrNullOnTeardown(() =>
        runtime.port.call(
          "root/apply",
          { update: encoded.bytes, asLocalEdit },
          encoded.transfer,
        ),
      );
      // `applied` is a data-loss guard and never optimistic, so a torn-down session answers `false`:
      // nothing was applied, and the caller must not retire its source on the strength of it.
      return answer === null ? false : answer.applied;
    },
    store,
    dispose: () => {
      store.getState().dispose();
    },
    detachTransport: () => {
      store.getState().detachTransport();
    },
    hotArtifactRoomIdsForTests: () => bodyDocs.residentDocKeys(),
    requestFreshSnapshot: () => {
      store.getState().requestFreshSnapshot();
    },
    retryTransport: () => {
      store.getState().retryTransport();
    },
    isClean: () => {
      const state = store.getState();
      return (
        state.snapshotLoaded &&
        !state.isDirty &&
        state.writeCommands.length === 0 &&
        state.hostTransportStatus === "open"
      );
    },
  };
}
