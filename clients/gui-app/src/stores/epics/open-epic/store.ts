/**
 * The zustand adapter over the epic replica runtime.
 *
 * Everything that owns state moved into `./runtime`: the root replica and its
 * projector, the artifact-body hot/cold tier, the record tables, the optimistic
 * overlay, the unsynced queue, host coverage, and the `epic.subscribe@1`
 * decoding that used to be thirty-odd callbacks writing UI state directly. What
 * is left here is the consumer side of the seam, and it is deliberately only
 * three things:
 *
 *  1. **A store shape.** `OpenEpicState`'s projected fields are named exactly as
 *     the runtime publishes them, so a delivery is a `setState` with no
 *     translation in between.
 *  2. **The two couplings the runtime may not have.** `bindingVersion` is a
 *     React remount token and stays on this side (the runtime publishes a
 *     monotonic `bindingEpoch` and knows nothing about remounts); the auth store
 *     is read here and handed in as a getter, because a runtime scheduled for a
 *     Web Worker cannot import a React store.
 *  3. **Delivery.** Subscription, equality-based re-render skipping and the
 *     batching that keeps a multi-plane frame at one `setState` are consumer
 *     concerns by contract.
 *
 * `doc` and `awareness` are the one thing on this state that is not a
 * projection: they are live `Y` objects, which cannot cross a sink and will not
 * cross a worker boundary. They are republished here, from the runtime's
 * getters, whenever the replica is REPLACED - which is what
 * `replicaGeneration()` exists to tell us.
 */
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
// The read seam's own word for "this client has no body to give you", raised
// HERE because this is the layer that sees the grant say so. The edge back is
// type-only (`OpenEpicStoreHandle`), so there is no runtime cycle.
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

/**
 * The relocated runtime, as this store reaches it.
 *
 * Narrow on purpose. `port` is `call` and nothing else - the spawner hands out
 * no `onEvent`, so a second projection reducer over one stream is unreachable
 * rather than merely discouraged - and `command` is the one way to push a
 * fire-and-forget member. Handing the store the bridge itself would put both
 * of those back within reach.
 */
export interface EpicRuntimeBinding {
  readonly port: RuntimeWorkerPort;
  /** One fire-and-forget command. See `RuntimeCommandMap`. */
  command(command: RuntimeCommand): void;
  /**
   * A local presence frame for one body, out to the arm.
   *
   * An EVENT, not a call, and deliberately not a `command`: presence is
   * per-keystroke and self-correcting, so it neither wants an answer nor
   * belongs in a vocabulary whose members are user gestures. See
   * `spawn-epic-runtime-worker`'s member of the same name.
   */
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
   * What to do when the host's plan-denial deadline says this session's
   * transport is worth probing again.
   *
   * Injected because the store CANNOT do it. Upstream's version of
   * `retryTransport` closed and reopened the stream client the store owned;
   * this store owns no client - the worker holds them over a proxied
   * transport, and the session provider owns the socket - so a transport
   * reopen here is a new SESSION, which is the provider's to build.
   */
  readonly onRetryTransport: () => void;
  /**
   * The spawned runtime. Constructed by the session provider, because the
   * worker needs the session's real stream client and this store never had one.
   */
  readonly runtime: EpicRuntimeBinding;
  /**
   * The process-backed books, built on MAIN by the same composition that
   * spawned the worker. The main-side body plane charges through this one;
   * the worker's runtime charges through it too, over the bridge.
   */
  readonly accounting: EpicRuntimeAccountingPort;
  /**
   * Identity to namespace persisted state under - the CANONICAL
   * `profile.userId`, never the email (two accounts can share an address).
   * When provided, the local `lastFocusedArtifactId` survives the same user
   * signing in again but stays isolated from any other user that signs into
   * this device - a different `userId` (or `null`) yields a disjoint persist
   * key, so prior focus state never leaks across signed-in identities.
   */
  readonly userId: string | null;
  /** Production's host-pinned requester; omitted by stores that never write. */
  readonly commandRequester?: HostRequester<HostRpcRegistry> | null;
  // `streamClientFactory`, `laneSelection`, `onAuthError` and
  // `commandRequester` are gone: all four were inputs to a runtime this store
  // no longer constructs. The worker's composition root takes their
  // equivalents, and the session provider is what hands them over.
}

/**
 * Disk-persisted slice of per-Epic state. Only the focused-artifact /
 * focused-thread ids survive full app relaunch - Y.Doc contents, unsynced
 * edit queue, and connection state are rehydrated from the host snapshot
 * on next open. Projected slices (artifacts/chats/tree/messages) are
 * deliberately NOT persisted to avoid stale projection drift.
 */
interface PersistedSlice {
  readonly lastFocusedArtifactId: string | null;
  readonly lastFocusedThreadId: string | null;
}

/**
 * Raised at every waiter this session can no longer answer.
 *
 * A write command is answered by the AUTHORITY, over a transport this handle
 * owns. Both teardowns take that transport away for good - `dispose()` ends the
 * worker, and `detachTransport()` is one-way (`epic-replica-runtime.ts`'s
 * `transportDetached` is set and never cleared) - so a command still in flight
 * at that moment has no route to an answer for the rest of its life.
 *
 * Named rather than a bare `Error` because it is an ORDINARY outcome, not a
 * fault: a re-point mid-write is a supported gesture, and `enqueueAndWait`'s
 * callers already toast and consume a rejection. What they could not survive
 * was the promise never settling at all.
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
 * An artifact-body lease that also says WHEN the body became readable.
 *
 * `release` is the same idempotent closure
 * {@link OpenEpicState.acquireArtifactBodyLease} returns. `resident` is the
 * part a synchronous caller has no use for: it settles once
 * `getArtifactFragment` will answer for this artifact, so a reader can take
 * the lease and then read, rather than reading in the same tick and calling a
 * body that has not been served yet "unavailable".
 */
export interface ArtifactBodyResidentLease {
  /**
   * A PROPERTY holding a closure, not a method: both callers hand this
   * reference on rather than calling it in place, and a method signature makes
   * that an unbound-method read.
   */
  readonly release: () => void;
  /**
   * Resolves when the body doc is RESIDENT.
   *
   * Rejects with `ArtifactBodyUnavailableError` in every case where no body is
   * coming: the `"unavailable"` grant, which owes nothing (no such artifact, or
   * a body this client cannot be served); a bridge disposed underneath the
   * acquire, mapped here so callers render "still loading" rather than a
   * transport's own words; the holder releasing before residency lands, which
   * drops the very demand the seed would have answered; and the session tearing
   * down, after which `bodyDocs.dropAll()` guarantees residency can never
   * arrive.
   *
   * An `"awaiting-seed"` grant is NOT one of those and does not reject: the
   * demand is held and it is the demand that makes the seed arrive.
   *
   * Every one of those settles the promise PUSHED - from `release()` or from
   * the session teardown - never by waiting for a store notification that, in
   * exactly these cases, is what has stopped coming.
   */
  readonly resident: Promise<void>;
}

/**
 * Per-Epic store shape. Mirrors the runtime's three plane projections field for
 * field, plus the live `Y` handles, the persisted focus ids, and the actions.
 *
 * Components subscribe to projected slices (`artifacts.byId[id]`, `tree.rootIds`,
 * etc.) - they should NOT read `doc` directly. The `getArtifactFragment(id)`
 * action is the single sanctioned escape hatch (Tiptap collaboration binding
 * needs the live `Y.XmlFragment` reference).
 */
export interface OpenEpicState {
  readonly epicId: string;
  /**
   * React remount token for live-`Y` bindings, mapped from the runtime's
   * `bindingEpoch`. Bumped when the `Y.Doc` / `XmlFragment` / `Awareness`
   * identity behind an artifact body is replaced, so anything holding one by
   * reference re-reads it.
   */
  readonly bindingVersion: number;
  /**
   * Bumped whenever a body doc becomes resident on THIS thread, or stops being.
   *
   * The re-render signal for `getArtifactFragment` / `getArtifactBodyAwareness`,
   * which are synchronous reads of a set that fills in asynchronously. Distinct
   * from `bindingVersion` (a replica replacement) and from availability (the
   * host's view of the room): a room can be `ready` for some time before its
   * bytes have crossed and been installed here.
   */
  readonly bodyResidencyVersion: number;
  /**
   * Whether the root replica holds bytes for `hash`, SYNCHRONOUSLY.
   *
   * The one member of the attachment-read class that cannot become a promise:
   * three paste handlers read it inside a ProseMirror handler that decides
   * whether to accept a paste and cannot await. It stays on the store, as
   * `lib/epic-replica-reads.ts`'s header always said it would - what changed
   * is the answer's source, which is now the projected hash set rather than a
   * live doc read.
   */
  hasAttachmentBytes: (hash: string) => boolean;

  // ── Projected slices (owned by the runtime's records plane) ───────────
  readonly epic: EpicHeader;
  readonly artifacts: ArtifactsSlice;
  /**
   * Deleted-artifact tombstones (`epic.deletedArtifacts`). Lets the chat's
   * `artifact_operation` delete card resolve a removed artifact's kind/title/
   * last-status after its live `artifacts` entry is gone. Projected, not a
   * tree input.
   */
  readonly deletedArtifacts: DeletedArtifactsSlice;
  /**
   * The Y.Doc's own chat entries. The projector's working state, NOT a
   * component-facing slice - read {@link OpenEpicState.chats}, which is this
   * unioned with the host's store-backed records.
   */
  readonly docChats: ChatsSlice;
  /**
   * The host's store-backed chat records (`epic.listChatRecords`), as last
   * served. Empty in doc-only mode: an older host that lacks the method, or
   * before the first response lands.
   */
  readonly chatRecords: ChatsSlice;
  /**
   * Whether `epic.listChatRecords` has produced an answer this session.
   * Missing rows are not deletion evidence until this is true. Transient
   * failures leave it false; `E_HOST_UNSUPPORTED` marks it true because an
   * older host's doc projection is its authoritative record table.
   */
  readonly chatRecordListAuthoritative: boolean;
  /** Projected ingest counters - see `EpicRecordsProjection`. */
  /** Projected adapter arm - see `EpicControlProjection`. */
  readonly installedArm: EpicAdapterArm | null;
  /**
   * Every attachment hash the root replica holds, projected.
   *
   * The source `hasAttachmentBytes` answers from. Declared here rather than
   * inherited because this interface names its projected fields explicitly.
   */
  readonly heldAttachmentHashes: readonly string[];
  readonly chatIngestSeq: number;
  readonly tuiAgentIngestSeq: number;
  /**
   * Chats the record plane RETRACTED while this session was open, and why.
   *
   * The only signal that distinguishes the two honest end states an OPEN tab
   * can show - "this chat was deleted" versus "this chat is no longer shared
   * with you". The record table alone cannot: a row that left for either
   * reason is simply a row that is gone.
   *
   * ABSORBING for the life of the session: an id in here is filtered out of
   * every later record answer, poll included, so an in-flight
   * `epic.listChatRecords` that was issued before the retraction cannot
   * resurrect the row seconds after the tab announced it was gone. The cost is
   * the re-share case - a chat unshared and then shared again stays hidden
   * until the epic session is disposed and rebuilt (closing and reopening the
   * epic) - which is the contract the stream declares ("removal is terminal and
   * absorbing; no later upsert resurrects the row on this client") and is
   * strictly preferable to a tile that flickers back to life after saying it
   * was revoked.
   */
  readonly chatRetractions: Readonly<Record<string, ChatRecordRemovalReason>>;
  readonly chats: ChatsSlice;
  /**
   * The Y.Doc's own terminal-agent entries - the projector's working state,
   * NOT a component-facing slice. Read {@link OpenEpicState.tuiAgents}, which
   * is this unioned with the host's registry rows. Kept separate for the same
   * reason as {@link OpenEpicState.docChats}: a doc-side removal (a migrated
   * host sweeping its own entries) must reconcile against the doc's history,
   * not against the union, or it would take a live registry row with it.
   */
  readonly docTuiAgents: TerminalAgentsSlice;
  /**
   * The host's registry-backed terminal-agent rows (`epic.listTuiAgents`), as
   * last served. Empty in doc-only mode: an older host that lacks the method
   * (and therefore still writes the doc's `tuiAgents` map), or before the
   * first response lands.
   */
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /**
   * Terminal agents the record plane RETRACTED while this session was open,
   * and why - the terminal twin of {@link OpenEpicState.chatRetractions},
   * ABSORBING for the session's life for the same reason: an in-flight
   * `epic.listTuiAgents` answer issued before the retraction must not
   * resurrect the row seconds after its tab said it was gone.
   */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  >;
  /** Doc entries unioned with the host's registry rows. Components read THIS. */
  readonly tuiAgents: TerminalAgentsSlice;
  readonly agentRoles: AgentRolesSlice;
  /**
   * Comment threads the RECORDS LANE has served, grouped by artifact. Empty on
   * every legacy connection - that arm's wire carries no comment records - so
   * `epic.listCommentThreads` remains the source there and the cold-read path
   * on both. A MISSING artifact key means nothing has been said about that
   * artifact, which is not the same as "no threads"; see `CommentThreadsSlice`.
   */
  readonly commentThreads: CommentThreadsSlice;
  readonly tree: TreeSlice;
  /**
   * Per-artifact-room availability mirrored from `epic.subscribe@1.0` `artifactRoomState`
   * frames. The body of an artifact is renderable only when the artifactRoom
   * referenced by `artifacts.byId[id].artifactRoomId` reports `ready`. ArtifactRooms
   * absent from this slice are implicitly `unavailable`.
   */
  readonly artifactRooms: ArtifactRoomsSlice;
  /**
   * Per-artifact-room HOST-side sync state, mirrored from the current
   * `epic.subscribe@1.1` `dirtySnapshot` and later `artifactRoomDirty`
   * deltas: `true` means the host holds work for that room its cloud
   * connection has not acknowledged.
   *
   * Deliberately separate from `artifactRooms` (availability) - artifact rooms
   * are local-first, so a room stays `ready` and editable across a cloud drop
   * while accumulating unsynced bodies. Once `hasDirtySnapshotForOpenCycle`
   * is true, a room absent from this record is clean; before that snapshot,
   * the entire record is unknown rather than implicitly clean.
   *
   * Also distinct from the `dirtyWatermark*` fields below, which track the
   * RENDERER's local replica against the host. This is the leg further down
   * the chain - host against cloud - and it is the one that was missing when
   * the sync pill claimed "All changes synced" over bodies that existed
   * nowhere but the host's SQLite.
   */
  readonly artifactRoomDirtyByArtifactRoomId: Readonly<Record<string, boolean>>;
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

  // ── Connection / permissions / dirty-tracking ────────────────────────
  readonly snapshotMeta: SnapshotMetaEpic | null;
  readonly permissionRole: PermissionRole | null;
  /**
   * VISIBLE connection status: `deriveConnectionStatus(hostTransportStatus,
   * cloudSyncStatus, hasConnectedOnce)`. Write-gating and "can this surface
   * act right now" checks read this.
   *
   * It is a lossy blend by design - "host unreachable" and "host reachable,
   * cloud link down" both collapse to `reconnecting`. Anything that needs to
   * know WHERE unsynced work is sitting must read the three raw fields below
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
  /** The records lane's own status. See the projection's field of this name. */
  readonly recordsTransportStatus: StreamConnectionStatus;
  /**
   * Host-observed state of the host↔cloud link for this Epic, mirrored from
   * `epic.subscribe@1.0` `cloudSyncStatus` frames. It remains optimistically
   * `connected` for compatibility with functional connection gates; the
   * separate freshness bit prevents that display default from becoming sync
   * proof.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /** `true` only after a cloud-status frame for this exact open cycle. */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Latched by the first genuine cloud `connected` frame on this subscription
   * (never by the optimistic default), and cleared on re-subscribe. Separates a
   * first-time bootstrap from a real reconnect for display purposes only.
   */
  readonly hasConnectedOnce: boolean;
  readonly accessLost: boolean;
  /**
   * Set once when the host emits `epicDeleted` - a remote delete observed
   * while this session was open - carrying the deletion attribution for the
   * close toast. Terminal: the app-level access coordinator force-closes the
   * tab in response, so it is never cleared within a session's lifetime.
   */
  readonly epicDeleted: EpicDeletedAttribution | null;
  readonly snapshotLoaded: boolean;
  /**
   * Live major-migration state for this epic, mirrored from `epic.subscribe@1.0`
   * `migrationStarted` and `migrationProgress` frames. `idle` is the default
   * and the value snapshot frames return to on success. `running` drives the
   * migration-progress modal; `error` drives the same modal's failure state.
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
   * Discards the renderer's local dirty signal and any offline-buffered
   * bytes. Used by quit-and-discard flows where the session is about to
   * be torn down anyway.
   */
  discardUnsyncedEdits: () => void;
  /**
   * Rebinds the live stream so the next host snapshot replaces the local
   * Y.Doc replica without dropping the owning registry/session entry.
   */
  requestFreshSnapshot: () => void;
  /**
   * Asks the session's owner to rebuild this epic's transport, after the
   * host's plan-denial deadline says it is worth probing again.
   *
   * A REQUEST, and a refusable one. Upstream's version of this reopened the
   * stream client in place and so preserved the replica and buffered edits;
   * here a rebuild is a new session, so this refuses outright while the
   * session holds unsynced edits rather than trading them for a reconnect.
   * A clean session rebuilds silently - no failure is presented for
   * something the user did not do.
   */
  retryTransport: () => void;
  /**
   * Sends a `retryMigration` client frame so the host re-runs an
   * interrupted major migration without dropping the `epic.subscribe`
   * session. The store immediately moves migration state from `error` back
   * to `running` so the modal shows progress for the retry attempt.
   * No-op when no migration has been observed on this session.
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
  /**
   * Publishes the host's `epic.listChatRecords` answer into the record table.
   *
   * Idempotent and change-gated: an answer that says the same thing as the last
   * one writes nothing, so the poll behind it costs no renders while an epic is
   * quiet.
   *
   * MERGED against what the push has already delivered, not clear-and-replace:
   * a served row is revision-guarded like an `upsert` delta (an answer issued
   * before a push carries an OLDER version of the row, and overwriting with it
   * would regress a version the client has already shown - and hand the
   * optimistic overlay's dead sweep a stale value it reads as terminal
   * supersession, killing a healthy pending chain), and a row the answer omits
   * is retracted only if it was already held when the answer was ISSUED.
   * `issuedAtSeq` is where {@link OpenEpicState.peekChatIngestSeq} stood when
   * the request was dispatched - the caller captures it immediately before the
   * RPC and hands it back with the answer. `null` (no session to read at
   * dispatch) falls back to the previous answer's watermark, which holds an
   * omitted row for one extra pass instead.
   *
   * Never called in doc-only mode - an older host answers `E_HOST_UNSUPPORTED`
   * and the caller simply does not call this, leaving the record slice empty and
   * `chats` identical to the doc projection.
   */
  applyChatRecords: (
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ) => void;
  /**
   * The chat-record ingest counter as it stands now - the value a list
   * request captures at dispatch and passes back to
   * {@link OpenEpicState.applyChatRecords} as `issuedAtSeq`. Monotonic, per
   * session; every accepted row write advances it.
   */
  peekChatIngestSeq: () => number;
  /** Marks the record list authoritative after success or unsupported. */
  markChatRecordListAuthoritative: () => void;
  /**
   * Applies ONE `host.chatRecords.subscribe` delta - the push half of the same
   * record table {@link OpenEpicState.applyChatRecords} fills from the poll.
   *
   * Push is the trigger and the poll is the backup, so both write the same
   * slice and neither owns it: a host without the stream loses latency and
   * nothing else, and a delta lost to a disconnect is repaired by the next
   * 20s list read.
   *
   * `upsert` is REVISION-GUARDED: `revision` is per-chat monotonic and the only
   * ordering fact on a row, so a delta whose revision does not strictly exceed
   * the one already held is dropped. That is what makes replayed, reordered and
   * duplicated frames harmless without any merge logic. `remove` carries no
   * revision and needs none - it applies unconditionally and idempotently, and
   * is remembered in {@link OpenEpicState.chatRetractions}.
   *
   * Callers must route by `delta.epicId` before calling: the subscription is
   * host-scoped and covers every open epic, and this store is one of them.
   */
  applyChatRecordDelta: (delta: ChatRecordDelta) => void;
  /**
   * Publishes the host's `epic.listTuiAgents` answer into the terminal-agent
   * record table - the terminal twin of {@link OpenEpicState.applyChatRecords},
   * with the same contract: idempotent, change-gated, and never called in
   * doc-only mode.
   *
   * MERGED against what the push has already delivered, not clear-and-replace:
   * a served row is revision-guarded exactly as a `tuiUpsert` is, and a row the
   * answer omits is retracted only if it was already held when the answer was
   * ISSUED. A list read issued before an agent was committed would otherwise
   * delete the `tuiUpsert` that announced it.
   */
  applyTuiAgentRecords: (
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ) => void;
  /**
   * The terminal-agent ingest counter as it stands now - the value a list
   * request captures at dispatch and passes back to
   * {@link OpenEpicState.applyTuiAgentRecords} as `issuedAtSeq`. Monotonic,
   * per session; every accepted row write advances it.
   */
  peekTuiAgentIngestSeq: () => number;
  /**
   * Which STORE GENERATION the two ingest counters above belong to. The
   * counters are per-store and restart at zero when an epic session is
   * rebuilt after eviction, while the TanStack cache can retain a list
   * answer whose `issuedAtSeq` was captured against the PREVIOUS store - a
   * fence from another generation is numerically meaningless here, and
   * replayed as-is its (typically larger) value lets the omission pass
   * retract rows the old counter never covered. The record hooks capture
   * this WITH the fence and hand back `null` instead when the applying
   * store is not the one the fence was read from - the same conservative
   * "no session to read at dispatch" path, which holds omitted rows one
   * extra pass. Module-monotonic; never reused across generations.
   */
  ingestFenceIdentity: number;
  /**
   * Applies ONE `host.chatRecords.subscribe@1.1` terminal-agent delta - the
   * push half of the table {@link OpenEpicState.applyTuiAgentRecords} fills
   * from the poll, with {@link OpenEpicState.applyChatRecordDelta}'s exact
   * rules: `tuiUpsert` is revision-guarded (strictly-exceeds or dropped),
   * `tuiRemove` is unconditional, idempotent and remembered in
   * {@link OpenEpicState.tuiAgentRetractions}. Callers route by `delta.epicId`
   * first; the subscription is host-scoped.
   */
  applyTuiAgentRecordDelta: (delta: TuiAgentRecordDelta) => void;
  /**
   * Rebuilds the record slices for the CURRENTLY signed-in user from the raw
   * rows this session has retained - both tables, chats and terminal agents,
   * since each is built for one owner at ingest.
   *
   * Internal, and driven by exactly one caller: the auth subscription, on a
   * user switch. The slice is keyed on the record id alone and so can only
   * ever represent one owner's rows, which means a user switch has to REBUILD
   * it - re-projecting alone would keep serving the previous identity's
   * selection. Retained rows make that lossless.
   */
  republishChatRecordsForCurrentUser: () => void;
  /**
   * Retains a chat this client has had a host create, so it renders from the
   * moment the create is answered instead of when its record completes the
   * round trip - see `./pending-chat-creations`.
   *
   * Idempotent per `(ownerUserId, chatId)`. Refused for a chat this session has
   * already seen retracted (removal is absorbing, and a creation cannot argue
   * with it), and refused while no user is signed in (a stand-in that cannot say
   * whose it is could be retired by a stranger's same-id row, or shown to
   * whoever signs in next). Every creation surface gets this for free: the shared
   * `epic.createChat` mutation hooks call it, so the registration cannot drift
   * from the request the way a per-surface copy would.
   */
  beginPendingChatCreation: (pending: PendingChatCreation) => void;
  /**
   * Drops a retained creation because it will never produce a record - the
   * create call failed.
   *
   * Keyed by `chatId` ALONE, unlike the retention itself, because the failing
   * caller knows the id it sent and not the profile that was signed in when the
   * retention happened. Deliberate rather than sloppy: this map holds only
   * creations THIS session initiated, so an id names at most one of them, while
   * narrowing to the currently signed-in user would strand a ghost row for a
   * chat that does not exist whenever the account moves between a request and
   * its refusal. It is NOT a claim that `chatId` is unique - it is not, and
   * every path that reconciles against a RECORD keys on the owner too.
   *
   * NOT the success path - a creation that lands is expired by its own record
   * arriving, through whichever of the poll or the delta stream gets there
   * first, so the row never blinks out between the two.
   */
  clearPendingChatCreation: (chatId: string) => void;
  /** Forcibly closes the underlying stream session. Idempotent. */
  dispose: () => void;
  /**
   * Closes the transport but KEEPS the Y.Doc, its replica and the unsynced
   * queue alive and readable. Idempotent.
   *
   * The partial teardown a retained-dirty buffer needs (F10): after a host
   * re-point the previous handle still holds unsynced edits the user has not
   * been offered a decision about, so it cannot be disposed - but it must not
   * keep dialing either. `EpicStreamClient` subscribes through the shared
   * `WsStreamClient`, whose dial reports feed the selection authority's
   * `ingestDial`; a retained handle reconnect-looping against a host the
   * window has left would report dials from it, into the very evidence stream
   * host-death detection reads. Its staleness guard does not filter them - it
   * drops on `incarnationId` mismatch, and a retained handle is the same
   * renderer incarnation. It would also reintroduce an idle-publish floor
   * driven by write activity on a machine the user is no longer on.
   *
   * The store's projected state (`isDirty`, `unsyncedQueueSize`) deliberately
   * freezes at its retention-time values: the detached handle takes no further
   * input, so the frozen reading IS the honest one, and it is what the
   * unsynced-edits projection reports. `discardUnsyncedEdits` still works -
   * it operates on local state only - which is what lets the user act on a
   * retained buffer.
   */
  detachTransport: () => void;

  // ── Actions: artifact + chat mutations (own `doc.transact`) ──────────
  // Creation is deliberately NOT a local doc write: `epic.createArtifact` /
  // `epic.createChat` host RPCs own it, because creation needs host-side
  // setup the renderer cannot fake. The actions below are the optimistic
  // fast path layered under those same host RPCs.
  /** Returns true when the title actually changed in the Y.Doc. */
  renameArtifact: (artifactId: string, nextTitle: string) => Promise<boolean>;
  // ── Optimistic metadata overlay (Phase 1.1) ──────────────────────────
  // Each `begin*` stamps a client request id, patches the published
  // projection, and returns that id; the caller fires the RPC and reports
  // its outcome through `retirePendingMutation` - "landed" on ack, "failed"
  // on terminal failure - riding the mutation PROMISE, never a per-call
  // `onSettled` (TanStack drops those on unmount and on consecutive
  // `mutate()` calls). `null` means nothing was stamped (refused, or the
  // value already matches).
  //
  // These cover EVERY plane, which the doc write above does not: a
  // registry-backed chat or terminal agent has no doc entry, so
  // `renameArtifact` no-ops for it and has done since chats moved off YJS.
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
   * Report a mutation's RPC outcome. `"failed"` (terminal failure only - a
   * retryable transport error must stay pending or the row flaps) drops the
   * patch, revealing whatever the host actually has. `"landed"` marks the
   * entry acked: it keeps patching the display until the authoritative row
   * catches up - the ack proves the host holds this value, so dropping it at
   * ack time would snap the row back to a stale slice - and is swept from the
   * map by the first full projection that sees the row caught up or
   * overwritten.
   */
  retirePendingMutation: (
    requestId: string,
    outcome: "landed" | "failed",
  ) => Promise<boolean>;
  /**
   * Whether `requestId` is the LAST-STAMPED rename for its node - the guard
   * the persisted canvas-tab snapshot writes on. RPC settles are not
   * ordered: with two renames in flight, the older one's success arm can
   * run after the newer one's, and writing its captured title into the
   * snapshot would preserve the superseded value across cold renders.
   *
   * Deliberately answered from a stamp TOMBSTONE rather than the live
   * chain: a successful rename's own echo can reach the store before its
   * RPC settles, and the dead sweep then removes the chain as an off-anchor
   * move - a chain-membership answer would refuse the only persisted-tab
   * write of a rename that SUCCEEDED. The tombstone survives the sweep, so
   * the only acks it refuses are ones a newer stamp genuinely superseded.
   */
  isLatestRenameStamp: (nodeId: string, requestId: string) => Promise<boolean>;
  /** Returns true when a delete actually happened. Reparents children. */
  deleteArtifact: (artifactId: string) => Promise<boolean>;
  /**
   * Move an artifact, chat, or terminal-agent to a new parent within its own
   * family.
   *
   * Validated against the PROJECTED TREE, not the doc, so a record-backed
   * parent is a legal target: a doc-only terminal agent can be nested under a
   * registry-backed chat, which is what the sidebar has always displayed as
   * possible. REJECTS when the PROJECTION rejects the move - and what a
   * caller receives is a `BridgeCallError` whose `remoteName` is
   * `MissingNodeError`, `CrossFamilyParentError` or `ReparentCycleError`, not
   * an instance of those classes.
   *
   * That is the boundary, not a downgrade: an `Error` does not survive a
   * structured clone, so the endpoint carries the error's own `name` across
   * and `remoteName` is the discriminator that still tells a cycle from a
   * missing node. This comment promised the classes themselves until the
   * replica moved; a caller writing `instanceof` on that promise would have
   * silently stopped matching.
   *
   * Returns `false` without throwing when the node has no doc entry to write:
   * that node is registry-backed and `epic.reparentChat` owns its pointer.
   */
  reparentArtifact: (
    artifactId: string,
    newParentId: string | null,
  ) => Promise<boolean>;
  /** Returns true when the title actually changed. */

  // ── Actions: live-Y escape hatches ───────────────────────────────────
  /**
   * Returns the live `Y.XmlFragment` backing an artifact's body. The
   * fragment is the doc-owned reference Tiptap's
   * `@tiptap/extension-collaboration` binds to - handing back a snapshot
   * copy would defeat the live sync.
   *
   * Artifact-room-routed: resolves the artifact's `artifactRoomId` from root metadata,
   * then returns `artifact-body:{artifactId}` from the matching artifact-room doc.
   * Returns `null` when the artifact does not exist, has no `artifactRoomId`
   * yet, or its artifactRoom is not currently `ready`. Editors must call
   * {@link getArtifactBodyAvailability} to differentiate
   * "still loading" from "no body".
   */
  getArtifactFragment: (artifactId: string) => Y.XmlFragment | null;
  /**
   * Live-Y escape hatch: reads content-addressed image bytes from the root
   * doc's top-level `attachments` map (the host-deduped image store). Waits
   * for the hash to sync in (surviving replica swaps); resolves null only when
   * the caller's `signal` aborts.
   */
  readAttachmentBytes: (hash: string) => Promise<Uint8Array | null>;
  /**
   * WAITS for bytes that have not synced in yet; `null` only when the caller
   * aborts or the runtime tears down.
   *
   * A SEPARATE member from {@link readAttachmentBytes}, not a flag on it, and
   * the two must not be merged - `epic-replica-reads.ts` says so in its own
   * headers. The prompt read answers "does the replica hold this NOW"; this
   * one is the acquisition an image referenced by a still-replicating artifact
   * depends on. Collapsing them turns "still syncing" into "missing" for
   * exactly the images the design expects to be late.
   *
   * The `signal` is load-bearing here, unlike on the prompt read: it is what
   * drives `attachment/cancel`, and without it a caller that unmounts leaves
   * the worker holding a wait forever.
   */
  awaitAttachmentBytes: (
    hash: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | null>;
  /** Synchronously reports whether the root attachment map has this hash. */

  /**
   * Returns the artifact-room-scoped Awareness instance hosting `artifactId`'s body
   * presence channel, or `null` when the artifactRoom is not currently `ready`.
   *
   * CollaborationCaret bindings on artifact-room-doc fragments must consume this
   * instance - feeding the root Epic awareness into a artifact-room-doc-bound
   * editor would mis-route per-artifact-room presence frames through the root
   * channel and lose the per-artifact-room caret/cursor topology.
   */
  getArtifactBodyAwareness: (artifactId: string) => Awareness | null;
  /**
   * Reports the availability of the artifact-room hosting `artifactId`'s body.
   * Returns `unavailable` when the artifact has no `artifactRoomId` yet or
   * when the artifactRoom is not tracked. Editors render an unavailable/retrying
   * placeholder for any value other than `ready` - and bind a live
   * fragment only when this returns `ready`.
   */
  getArtifactBodyAvailability: (
    artifactId: string,
  ) => EpicArtifactRoomAvailability;
  /**
   * Resolves the artifact-room hosting `artifactId`'s body, or `null` when the
   * artifact does not exist or has not been assigned a room yet. Exposed so a
   * lease holder can re-acquire when the artifact's room changes underneath
   * it, which is not always visible in {@link getArtifactBodyAvailability}.
   */
  /**
   * The key the artifact-body tier holds this artifact's live doc under, for the
   * one consumer that re-takes a lease when that doc's identity changes. The
   * `@1` arm answers with the artifact's room; the lane arm answers with the
   * artifact id, because `artifact.subscribe` has no rooms. See the runtime.
   */
  getArtifactBodyDocKey: (artifactId: string) => string | null;
  /**
   * Materialize the artifact-room backing `artifactId`'s body and hold it
   * materialized until the returned release is called.
   *
   * Rooms the host opens are cached as encoded update bytes, not as live
   * `Y.Doc`s - a Yjs doc keeps one `Item` struct per edit forever, so a room
   * an agent has rewritten many times is orders of magnitude larger
   * materialized than encoded. {@link getArtifactFragment} therefore returns
   * `null` for a room with no lease: every caller that needs a live fragment
   * (editors, export) must take one first.
   *
   * Release is idempotent, and safe to call after the store is disposed. The
   * room is not demoted immediately on the last release - it lingers so tile
   * remounts do not pay to re-materialize - and never while local edits are
   * still unacknowledged by the host.
   */
  acquireArtifactBodyLease: (artifactId: string) => () => void;
  /**
   * {@link acquireArtifactBodyLease} for a caller that can WAIT for the body,
   * rather than one that must return a cleanup synchronously.
   *
   * The lease above is deliberately sync-in / async-underneath, because its
   * caller is a `useLayoutEffect`. A holder that reads the fragment right
   * after taking it therefore reads it before any grant has landed, and
   * `getArtifactFragment` answers `null` for a doc that is not resident yet -
   * which on the lane arm's ordinary cold open is the NORMAL outcome, not a
   * failure: the grant resolves `"awaiting-seed"` with no bytes and the
   * install arrives later through `retryAwaitingBodies`.
   *
   * A SECOND member rather than a `ready` field on the one above, because the
   * sync caller's signature is the reason that one exists at all.
   */
  acquireResidentArtifactBodyLease: (
    artifactId: string,
    /**
     * What the LAST release does with the body. `"linger"` for anything a
     * human may return to; `"immediate"` for a transient programmatic hold
     * whose caller knows it will not - see `ArtifactBodyRetention`.
     */
    retention: ArtifactBodyRetention,
  ) => ArtifactBodyResidentLease;
  /** Snapshot-read the title for optimistic-rename rollback. */
  readArtifactTitle: (artifactId: string) => string | null;
}

export interface OpenEpicStoreHandle {
  readonly epicId: string;
  readonly userId: string | null;
  /**
   * Transfer this session's root state into another, and take one in.
   *
   * The PORT the two merge sites use instead of reaching for `.doc`. It exists
   * now, in-process, so that the flip changes an implementation rather than a
   * call site - and `doc` above leaves this interface at the flip, while these
   * two stay.
   */
  readonly encodeRootState: () => Promise<Uint8Array>;
  readonly applyRootUpdate: (
    update: Uint8Array,
    asLocalEdit: boolean,
  ) => Promise<boolean>;
  /**
   * What the spawner reduces this session's projection stream into.
   *
   * Handed OUT rather than taken in, because the store is what knows the
   * slice's shape - and the spawner owns the one watermark, so a second
   * reducer over the same stream is unreachable. The provider wires these into
   * the spawn; nothing else may.
   */
  readonly projection: RuntimeProjectionHandlers<
    Partial<EpicRuntimeProjection>
  >;
  /**
   * The body plane's return leg, handed OUT for the same reason `projection`
   * is: the store owns the live docs, and the worker that feeds them is
   * spawned before this store exists. The provider wires these into the spawn;
   * nothing else may.
   */
  readonly body: EpicRuntimeBodyReturnTarget;
  readonly store: UseBoundStore<StoreApi<OpenEpicState>>;
  readonly dispose: () => void;
  /**
   * Closes the transport, keeps the doc and its unsynced queue. See
   * {@link OpenEpicState.detachTransport} - a retained-dirty buffer must stop
   * dialing a host the window has left without losing the edits it holds.
   */
  readonly detachTransport: () => void;
  readonly requestFreshSnapshot: () => void;
  readonly retryTransport: () => void;
  /**
   * True when this renderer has a loaded, locally clean snapshot and can
   * still reach the host. Cloud acknowledgement is intentionally not part of
   * this eviction/readiness predicate; it is a stricter concern owned by the
   * sync pill's fresh cloud and host-dirty gates.
   */
  isClean: () => boolean;
  /**
   * Ids of the artifact rooms currently materialized as live `Y.Doc`s.
   *
   * A test seam, and a necessary one: whether a room is hot or cold is the
   * entire point of the cold cache, but it is deliberately invisible through
   * the normal read path - `getArtifactFragment` materializes on demand, so
   * reading a fragment to check is the one thing that destroys the property
   * being checked.
   */
  hotArtifactRoomIdsForTests: () => ReadonlyArray<string>;
}

/**
 * Mints {@link OpenEpicState.ingestFenceIdentity} - one value per store
 * construction, module-monotonic so no two generations (even of the same
 * epic) ever share one.
 */
let nextIngestFenceIdentity = 1;

/**
 * Constructs a fresh per-Epic session.
 *
 * Responsibilities, all of them adapter-shaped:
 *   - Build the replica runtime and give it a delivery that lands in this
 *     store, coalescing a multi-plane frame into one `setState`
 *   - Map the runtime's `bindingEpoch` onto the React remount token, and
 *     republish the live `Y` handles when the replica is replaced
 *   - Feed the runtime the signed-in identity, and rebuild the owner-selected
 *     record slices when it changes
 *   - Persist only `lastFocusedArtifactId` + `lastFocusedThreadId` to
 *     localStorage under a key scoped to `epicId`
 */
/**
 * A published slice, as far as this layer checks.
 *
 * A predicate rather than an assertion, and a CHEAP one on purpose: the
 * contract says this "may legitimately be a cheap envelope check rather than a
 * full validator" because both ends ship in one bundle graph. What it must do
 * is distinguish a slice from a FOREIGN payload - a frame from a stale chunk,
 * or something that is not a publication at all - which is what a non-null
 * object check answers. Re-validating every key would be a second copy of the
 * projection's shape, and that copy is what rots.
 */
export function isProjectionPatch(
  value: unknown,
): value is Partial<EpicRuntimeProjection> {
  return typeof value === "object" && value !== null;
}

export function createOpenEpicStore(
  options: OpenEpicStoreOptions,
): OpenEpicStoreHandle {
  const { epicId, userId } = options;
  const mintedIngestFenceIdentity = nextIngestFenceIdentity;
  nextIngestFenceIdentity += 1;

  let storeApi: StoreApi<OpenEpicState> | null = null;
  /**
   * The worker's own dirty verdict, before main-only body refusals are folded
   * into it.
   *
   * A rejected/dropped `body/update` for the still-resident lineage leaves the
   * live main-thread doc as the only proven holder of that edit. The worker
   * cannot publish dirtiness for bytes it never accepted, so main latches the
   * doc key below and ORs that fact into every later projection until the doc
   * is retired after a full demote/replacement. Keeping the worker verdict
   * separately is what lets that retirement restore the honest projected
   * value instead of guessing that the rest of the replica is clean.
   */
  let workerReplicaIsDirty = false;
  const refusedBodyUpdateDocKeys = new Set<string>();
  /**
   * Current main-doc lineage per key. Replacement and retirement reuse the
   * docKey, so an async refusal must prove it still belongs to the resident
   * lineage before it can latch that key dirty. Retirement deletes the token:
   * this bounds the map to live lineages and guarantees a same-key replacement
   * mints an identity no predecessor callback can match.
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

  function retireBodyDoc(docKey: string): void {
    bodyDocGenerationByDocKey.delete(docKey);
    if (!refusedBodyUpdateDocKeys.delete(docKey)) return;
    if (refusedBodyUpdateDocKeys.size > 0) return;
    storeApi?.setState({ isDirty: workerReplicaIsDirty });
  }
  /**
   * Ids for pending attachment WAITS, unique per store.
   *
   * The worker keys its pending waits on this, and `attachment/cancel` names
   * one - so a reused id would cancel somebody else's wait.
   */
  let nextAttachmentAwaitId = 1;

  /**
   * One bridge call, answering `null` when the session has been torn down.
   *
   * Every member below had a falsy no-op answer before the relocation - a
   * refusal, empty bytes, `false` - because an operation against a torn-down
   * replica has always been a no-op rather than an error. Across the bridge
   * that same teardown arrives as a REJECTION, so each caller maps it back to
   * the answer its own contract already promised.
   *
   * Narrowed on the error TYPE, never a blanket catch: a decode failure or a
   * worker that threw is a real fault, and swallowing it as "the session
   * closed" would turn a bug into a silent no-op.
   */
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
  /**
   * The last binding epoch main acted on, so an advance is detectable.
   *
   * Separate from the store's `bindingVersion` (which is the same number, for
   * React remounts) because this fires BEFORE `setState` and must not depend
   * on the store existing yet.
   */

  /**
   * Disposal is a MAIN-side fact now.
   *
   * `isDisposed()` used to ask the runtime. Asking a worker whether it is
   * disposed is asking a thread that may not be there to answer, and the
   * question is really about this session's own lifetime - which this side
   * owns.
   */
  let disposed = false;
  let unsubscribeAuthUserId: (() => void) | null = null;

  /**
   * Waiters this session promised to settle and can no longer answer.
   *
   * Both teardowns end the route to an authority permanently, so anything still
   * waiting on one has to be told rather than left pending. Kept MAIN-side for
   * the same reason `disposed` is: the thread that owned the queue may already
   * be gone, and asking it to publish a final word is asking a thread that is
   * not there.
   */
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

  /**
   * Publishes that arrived before the store existed.
   *
   * Unreachable today - the runtime projects nothing until `start()`, which
   * runs last - but HELD rather than dropped, because dropping one would
   * desynchronise the sinks from the store silently: a sink's own `read()`
   * would carry a value no subscriber ever saw, and every later change gate
   * would compare against it.
   */

  /**
   * The one write into zustand, and now the PROJECTION HANDLER's apply.
   *
   * `bindingEpoch` is translated here rather than published under its final
   * name, because the translation IS the seam: the runtime reports that a live
   * binding was invalidated, and only this side knows the consequence is a
   * React remount.
   *
   * The `doc` / `awareness` republish that used to ride this write is gone
   * with them. They were live `Y` objects the runtime exposed as getters plus
   * a generation counter; the root replica is worker-side now, so there is no
   * pair to republish and no generation to compare - which is why
   * `replicaGeneration` stopped having a question to answer.
   *
   * Batching is gone too, and deliberately: the WORKER batches, publishing one
   * coalesced slice per commit. Re-batching here would be a second window over
   * an already-windowed stream.
   */
  /**
   * Release main's copy of any body whose ROOM is no longer `ready`.
   *
   * Main holds the live docs; the worker holds the replicas they are copies
   * of. When the worker destroys a replica - a reset after a fresh root
   * snapshot, a room leaving `ready`, a viewer downgrade discarding unsent
   * edits - main's copy becomes a document nothing will ever settle, and a
   * re-acquire REVIVES it rather than materializing the new replica. That is
   * how a discarded offline edit came back after a reconnect.
   *
   * Keyed on AVAILABILITY rather than on `bindingEpoch`, which was the obvious
   * signal and the wrong one: the epoch advances on every room SEED
   * (`epic-rooms-replica.ts:281`), so acting on it dropped every live body
   * each time any room was seeded. Availability says which rooms exist right
   * now, which is the question actually being asked.
   *
   * Entries are forgotten WITHOUT posting: there is nothing on the far side to
   * settle into, and a demote would sit pending on a `not-held`.
   */
  /**
   * Doc keys the projection currently calls `ready`.
   *
   * ONE reader of the availability map for both body-plane reconcilers, so
   * "which rooms are ready" cannot be answered two ways in the same frame.
   */
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

  /**
   * The completion half of an `"awaiting-seed"` grant.
   *
   * Sibling of {@link dropBodiesWhoseRoomIsGone}, at the same site and off the
   * same slice: that one retires a resident body whose room stopped being
   * ready, this one materializes an awaiting body whose room STARTED being
   * ready. Together they are the body plane reconciled against the projection,
   * which is the only signal main has and the only one it needs - a body lane's
   * `doc` frame is what turns its availability `ready`, so "ready" and "the
   * bytes exist now" are the same event seen from the two sides.
   */
  function retryBodiesWhoseRoomBecameReady(): void {
    const ready = readyBodyDocKeys();
    bodyLeases.retryAwaitingBodies((docKey) => ready.has(docKey));
  }

  /**
   * Settles once `getArtifactFragment` will answer for this artifact.
   *
   * The predicate is the FRAGMENT rather than `bodyResidencyVersion`, because
   * the fragment is what the caller is about to read: a residency bump for
   * some other doc is not this artifact's answer, and a body whose doc key
   * only resolves once the projection carries its room (`@1`) becomes
   * readable on a projection change rather than on a residency one. Any store
   * notification re-checks it, so both arrivals are covered by one
   * subscription.
   *
   * Waiting is UNBOUNDED on purpose, exactly as the attachment-byte
   * acquisition in `epic-replica-reads.ts` is: `"awaiting-seed"` means the
   * demand is held and the seed is coming. The bounded case is the grant that
   * owes nothing, and the caller rejects on that before ever reaching here.
   */
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
       * The two ways this wait ends without a body, both PUSHED rather than
       * noticed: the holder let go, or the session tore down.
       *
       * This used to be an `isReleased()` test inside the subscription below,
       * which could only fire if some later store notification happened to
       * arrive - and releasing drops the demand, which is exactly when no seed,
       * and therefore no notification, ever comes. The doc on
       * `ArtifactBodyResidentLease.resident` promised this rejection and it
       * could not happen.
       */
      const abandon = (): void => {
        unsubscribe?.();
        sessionEndedSettlers.delete(abandon);
        reject(new ArtifactBodyUnavailableError(artifactId));
      };
      onAbandonReady(abandon);
      // Teardown owes an answer here for the same reason it owes one to a
      // write-command waiter: `dispose()` drops every body doc, so residency
      // can never arrive afterwards.
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
   * The one implementation behind both body-lease members: the sync-in one
   * the layout effect needs, and the awaitable one a reader needs. Two
   * acquires would be two demands on the same room, and the second would
   * outlive the first's release.
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
        // A bridge that went away underneath the call is THIS ARTIFACT'S BODY
        // being unavailable, said in the only vocabulary the callers have copy
        // for. Unconverted, it reached the export toast verbatim and a user
        // closing an Epic mid-export read "The runtime worker bridge was
        // disposed with calls in flight."
        if (cause instanceof BridgeDisposedError) {
          throw new ArtifactBodyUnavailableError(artifactId);
        }
        throw cause;
      })
      .then((grant) => {
        // Discriminated on the ONE outcome that owes nothing. `"awaiting-seed"`
        // is a grant a holder must release exactly like a granted one - the
        // retained worker-side demand is the body lane's subscription - so a
        // `!== "granted"` test here would drop the release for every cold open
        // on the lane arm and leave the tab subscribed for the session.
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
        // A `"granted"` grant arrived WITH bytes, so the doc is installed by
        // the time this resolves. Only the awaiting arm has anything left to
        // wait for, and what completes it is `retryAwaitingBodies` above.
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
        // SETTLED here, not noticed later. Releasing drops the demand, so the
        // seed that would have woken the residency wait is exactly what is no
        // longer coming - which made the documented "rejects when the holder
        // releases before residency lands" unreachable for the one ordering it
        // was written for: release AFTER an `awaiting-seed` grant. (Release
        // BEFORE the grant resolves was already handled above.)
        abandonResidency?.();
      },
      resident,
    };
  }

  function applyProjection(patch: Partial<EpicRuntimeProjection>): void {
    const api = storeApi;
    if (api === null) {
      // UNREACHABLE, and thrown rather than assumed away.
      //
      // This had been a BUFFER, which was correct under the old topology: the
      // runtime was constructed inside this store, so its construction-time
      // publishes really could land before `create()` had assigned `storeApi`.
      // After the relocation there is no such caller. `applyProjection` has
      // exactly two: this file's own projection handler, which the CALLER
      // wires only after `createOpenEpicStore` returns, and nothing else -
      // and `storeApi` is assigned inside the zustand initializer, which
      // `create()` runs synchronously long before that return.
      //
      // A buffer for a window with no writer is worse than nothing: it reads
      // as evidence the state occurs, and its contents would sit in a drawer
      // nobody flushes. If a future wiring re-creates a pre-attach caller,
      // this fails AT that call site rather than silently swallowing the
      // first projection of the session.
      throw new Error(
        "[open-epic] projection applied before the store attached",
      );
    }
    const { bindingEpoch, ...workerProjected } = patch;
    let projected = workerProjected;
    if (projected.isDirty !== undefined) {
      workerReplicaIsDirty = projected.isDirty;
      if (refusedBodyUpdateDocKeys.size > 0) {
        projected = { ...projected, isDirty: true };
      }
    }
    // ── Re-stabilise nested identity, at the grain the projector owns it ──
    //
    // The worker's projector re-allocates ONLY what changed - a rename mints a
    // fresh slot and every sibling keeps its reference - and selectors skip
    // work on exactly that discipline. `structuredClone` erases it one level
    // below the wire's key-grain diff: a slice whose reference moved arrives
    // with EVERY nested slot re-minted, changed or not. `replaceEqualDeep`
    // (TanStack's default structural sharing, already the precedent in
    // `worktrees-enrichment-batcher.ts`) restores it: a deep-equal subtree
    // keeps the object already in state, a changed one stays fresh - so
    // `===` again means "unchanged", clone or no clone.
    //
    // Per delivered key only - the wire diff already omits keys whose
    // reference never moved, so this walks what actually crossed.
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

  /**
   * One key of the incoming patch, reconciled against what the store holds.
   *
   * A single-key generic rather than an inline loop body because TypeScript
   * cannot correlate `projected[key]` reads and writes across a union of
   * keys; pinning `K` makes the read, the reconcile and the write agree.
   * `undefined` never means "publish undefined" here - projection fields use
   * `null` per the repo's no-optionals rule - so it only ever means the key
   * was absent and there is nothing to stabilise.
   */
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

  /**
   * Keys of one patch whose incoming values are the SAME OBJECT, grouped.
   *
   * The projector aliases deliberately: `unionChats` returns `docChats` itself
   * when no record answered (`projection-helpers.ts`, `if
   * (records.allIds.length === 0) return docChats;`), and `unionTerminalAgents`
   * does the same with `docAgents`. "Doc-only mode hands the doc slice through
   * by reference" is a contract a consumer reads with `===`, not a coincidence.
   *
   * {@link stabilizeProjectionKey} reconciles each key against ITS OWN previous
   * value, independently - which is right per key and severs the alias across
   * keys, because `replaceEqualDeep(current.chats, X)` and
   * `replaceEqualDeep(current.docChats, X)` each return a value that shares
   * structure with a DIFFERENT previous object. Two deep-equal results, no
   * `===`.
   *
   * So the alias is captured here, before the pass, and restored after it. Only
   * object identity is grouped: primitives and `null` are compared by value
   * downstream, so "two keys hold the same number" is not an alias anyone can
   * observe, and grouping them would force unrelated keys to move together.
   */
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

  /**
   * Put every group back on one reference.
   *
   * The first member's stabilised value is the representative, and WHICH member
   * wins does not matter: the group's members were `===` on the way in, so
   * every stabilised result is deep-equal to every other. What matters is that
   * they end `===` again.
   *
   * `Reflect` rather than indexed access because the keys are dynamic and the
   * members of a group have different declared types even though their runtime
   * values are one object - the same reason `deliverInto` reaches for it.
   */
  function restoreAliasGroups(
    patch: object,
    groups: readonly (readonly string[])[],
  ): void {
    for (const keys of groups) {
      // No empty-group guard: `aliasGroupsOf` returns only groups of two or
      // more, so destructuring types `first` as `string` and a `=== undefined`
      // check is a condition with no overlap - which `no-unnecessary-condition`
      // rejects. The bound lives at the producer, and this is the reader that
      // depends on it.
      const [first, ...rest] = keys;
      const representative: unknown = Reflect.get(patch, first);
      for (const key of rest) Reflect.set(patch, key, representative);
    }
  }

  /**
   * The relocated runtime, reached through the bridge.
   *
   * This store no longer CONSTRUCTS a runtime. The composition root moved into
   * the worker (`install-epic-runtime-core.ts`), so what is left here is the
   * binding the session provider spawned: `call` for the four ask-shaped
   * members, `command` for the fifteen fire-and-forget ones, and the two
   * lifetime members. Everything below that used to read `runtime.*`
   * synchronously either became one of those, moved to the main-side body
   * plane, or is answered from the projection.
   */
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
      //
      // Every one of these members had a falsy no-op answer before the
      // relocation - `false` for a retire, `null` for a mint - because a
      // mutation against a torn-down replica has always been a no-op rather
      // than an error. Across the bridge that same teardown arrives as a
      // rejection, so a caller that used to read `false` now gets an unhandled
      // one.
      //
      // `inertMutationResult` is the SHARED answer the worker already returns
      // for a mutation it cannot serve, so the two sides agree on the shape
      // rather than this file inventing a second one per kind.
      //
      // Narrowed on the error type: a mutation that genuinely threw (an
      // illegal reparent) must still reach its caller as a rejection, which is
      // how a cycle is told from a no-op.
      if (cause instanceof BridgeDisposedError) {
        return inertMutationResult(mutation);
      }
      throw cause;
    }
  };

  const bodyDocs = createMainThreadBodyDocStore({
    onResidencyChange: () => {
      // Residency is a MAIN-THREAD fact and nothing else publishes it.
      // Availability comes from the projection and says the room is `ready`;
      // this says the fragment exists. Without the bump an editor that
      // re-rendered on availability alone would read `null` at `ready` and
      // never look again.
      storeApi?.setState((state) => ({
        bodyResidencyVersion: state.bodyResidencyVersion + 1,
      }));
    },
    onDocRetired: (docKey) => {
      // A lane body retires only after its full main-side state was accepted
      // by the worker's demote, or after an authoritative replacement/drop.
      // Either way main is no longer the sole holder of the refused edit, so
      // this doc-local latch has reached its proof-based clearing point.
      retireBodyDoc(docKey);
    },
    onLocalDocUpdate: (docKey, update) => {
      // A lane-level transport refusal does NOT reach this caller as loss.
      // The worker first applies the update to its tier; that tier marks the
      // room dirty and either sends or queues the bytes, then answers `sent`
      // because it accepted ownership. That is the lane-arm proof the old
      // "next cycle regardless" comment was missing.
      //
      // `dropped` is different: the worker held no replica, so main's live doc
      // is the only proven holder. A non-teardown handler rejection is the
      // same ownership fact with no parsed outcome. While the dispatch still
      // belongs to this resident doc lineage, both latch it into `isDirty`
      // until its full state crosses on demote or an authoritative replacement
      // retires it. The edit remains visually successful; state and the log
      // make the recovery obligation observable without turning typing into a
      // rejected user action.
      const dispatchedGeneration = bodyDocGenerationForDispatch(docKey);
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
          // Teardown, not a failure: the session is going away and this edit
          // is already in main's live doc. Narrowed on the error type so a
          // real fault is still reported rather than being swallowed as "the
          // session closed".
          if (cause instanceof BridgeDisposedError) return;
          markBodyUpdateRefused(docKey, dispatchedGeneration);
          // LOGGED, not rethrown. Rethrowing from inside a `.catch` returns a
          // freshly rejected promise, and this chain is `void`ed - so the
          // rethrow did not reach the console the comment above promised, it
          // became an unhandled rejection. In this app it does not even
          // surface: `vitest.config.ts` ignores them under test and a
          // process-level handler swallows them at runtime. And because this
          // fires on EVERY local Yjs update, one broken worker handler
          // produced one per edit for as long as the person kept typing.
          appLogger.error(
            "[open-epic] body update refused by the runtime worker",
            { docKey },
            cause,
          );
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
    // The renderer's own clock. Constructed here rather than taken as an
    // option because the linger is an internal fact about the lifetime of
    // main's hot docs, not something a caller chooses - and every caller that
    // builds this store already runs on this same clock.
    scheduler: createRendererRuntimeEnvironment().scheduler,
    // The SAME value the tier's cooldown used. Imported, never restated: the
    // UX property this preserves is "a tab switch must not pay to
    // re-materialize", and a second number beside the first is how one
    // silently becomes the other.
    lingerMs: ARTIFACT_ROOM_LEASE_POLICY.cooldownMs,
    // Same source as the linger, and the same reason: the hot docs are here
    // now, so the ceiling on how many of them exist is here too.
    maxHotDocs: ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized,
    // The availability map says this body's room is ready and the runtime
    // still has no bytes for it. The retry stays armed - the next projection
    // push tries again - but the disagreement is reported, because the symptom
    // it produces on screen is an editor that never fills in and there would
    // otherwise be nothing anywhere to read.
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
            // Ended covers BOTH exits: a disposed handle has nothing to
            // rebuild, and a detached one is frozen by contract ("takes no
            // further input").
            if (sessionEndedReason !== null) return;
            const state = get();
            // THE DATA-LOSS GATE, and the reason this is not upstream's
            // implementation. That one closed and reopened the stream client
            // the store itself owned, so the replica and the buffered edits
            // survived underneath it. This store owns no client - the worker
            // holds them over a proxied transport and the provider owns the
            // socket - so a retry here is a NEW session, and nothing persists
            // the replica or the unsynced queue. Rebuilding a dirty session
            // would therefore destroy the only copy of those edits, which is
            // the rule `session-registry` states as "never evict a session
            // holding unsynced edits" and whose violation is on record as the
            // F10 data loss.
            //
            // Gated on `isDirty` + pending writes rather than on `isClean()`,
            // deliberately: `isClean()` ALSO requires an open transport,
            // which a plan-denied one has by definition lost - so it reads
            // false for every session this can ever be called about and the
            // rebuild would never once fire. `snapshotLoaded` is excluded for
            // the same shape of reason: a session that never loaded has
            // nothing to lose, and requiring it would block exactly the
            // sessions this exists to recover. The registry's cap predicate
            // (`holdsNothingToLose`) and its re-point gate read the same
            // three work fields for the same reason.
            if (state.isDirty || state.writeCommands.length > 0) return;
            options.onRetryTransport();
          },
          retryMigration: () => {
            runtime.command({ kind: "retry-migration", payload: {} });
          },
          /**
           * ASYNC, because the queue is on the other thread and it owns BOTH
           * answers: `CommandQueue.enqueue` mints the id, and it refuses from
           * queue state this side does not hold. Minting here and pushing
           * would hand back an id for a command the queue may have refused,
           * and `waitForWriteCommand` would then watch the projection for a
           * record that never arrives.
           *
           * `null` is still the refusal at this boundary - callers already
           * branch on it - but it is now a REFUSED arm on the wire rather than
           * a nullable, so "refused" and "something went wrong" stay distinct
           * on the way here.
           */
          enqueueWriteCommand: async (intent) => {
            const answer = await callOrNullOnTeardown(() =>
              runtime.port.call("command/enqueue", { intent }, NO_TRANSFER),
            );
            // `null` is the queue's own REFUSAL, and a torn-down session is a
            // refusal too - it minted no id and recorded nothing. Pre-flip
            // this answered `null` for both; across the bridge the second
            // arrives as a rejection, so it is mapped back.
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
            // TOTAL, which it was not: this used to be a `resolve`-only
            // promise, so every teardown route leaked it forever - the
            // re-point's `replaceMounted`, the `isDirty`-only sibling gate,
            // `retireIfDead`, and the retention path. `enqueueAndWait` never
            // returned, and the sidebar's bulk delete awaits an `allSettled`
            // whose `.finally` clears `deletePending`, so ONE unanswerable
            // command disabled bulk delete for the life of the tab.
            if (sessionEndedReason !== null) {
              return Promise.reject(
                new EpicSessionEndedError(sessionEndedReason),
              );
            }
            return new Promise((resolve, reject) => {
              // Declared before the subscription so the two can refer to each
              // other without either reading the other's binding early.
              let unsubscribe: (() => void) | null = null;
              // Registered rather than polled: the queue lives on the worker,
              // and a teardown that has already terminated that thread will
              // never publish again - so nothing else can wake this waiter.
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
            // BEFORE the detach, and it is not merely tidy: a retained buffer
            // keeps serving local-state actions, so this handle lives on with
            // no socket. Its in-flight commands are the ones with nowhere to
            // go, and nothing later in this handle's life settles them.
            endSession("transport-detached");
            runtime.detach();
          },
          dispose: () => {
            if (disposed) return;
            unsubscribeAuthUserId?.();
            unsubscribeAuthUserId = null;
            disposed = true;
            endSession("disposed");
            // BEFORE dropping the docs, and before the worker goes away: a
            // linger is a bet that the user is coming back to this body, and
            // at dispose that bet is already lost. Waiting it out would hold
            // both sides' state for a full window after everything that could
            // use it is gone - a sixty-second park wearing a UX feature's
            // clothes. Ordering matters: `flushLingering` reads the docs it is
            // settling, so it cannot run after `dropAll`.
            bodyLeases.flushLingering();
            bodyDocs.dropAll();
            runtime.dispose();
          },

          /**
           * The eight metadata mutations, over `mutation/apply`.
           *
           * Each narrows on its own literal `kind`, which is what lets the
           * answer be typed without an assertion - a generic dispatch over the
           * result union cannot be made to compile without one, at exactly the
           * point where a wrong-shaped answer would be bound to a kind.
           *
           * They became async because the replica is on another thread; every
           * caller is a handler or a promise arm and none reads one during
           * render, which was checked call site by call site before this
           * landed.
           */
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
          /**
           * The WAITING leg. `signal` is LOAD-BEARING here.
           *
           * This header used to describe the prompt read and said the opposite
           * - that the signal bounded nothing and survived only because
           * callers held one. That was true of `readAttachmentBytes`, which
           * has since dropped the parameter entirely; it is false of this
           * member, whose signal is what drives `attachment/cancel`. A reader
           * trusting the old text would delete the parameter this depends on.
           *
           * The two legs are deliberately separate members - see the
           * declaration and `epic-replica-reads.ts`, whose own headers say
           * they must not be merged.
           */
          awaitAttachmentBytes: async (hash, signal) => {
            if (signal.aborted) return null;
            const awaitId = nextAttachmentAwaitId;
            nextAttachmentAwaitId += 1;
            // Cancel is its own CALL, and the abort listener is what turns the
            // caller's signal into one. Registered BEFORE the await is posted:
            // an abort that fires between posting and subscribing would
            // otherwise never be delivered, and the worker would hold the wait
            // for the life of the session.
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
              // TEARDOWN SETTLES NULL. Disposing the session rejects every
              // call still in flight, but this read's contract has always been
              // "bytes, or `null` when they are not coming" - a session going
              // away is the second case, not an error the caller can act on.
              //
              // Before the relocation this was structurally impossible: the
              // read was in-process and teardown cancelled its waiter, which
              // resolved null. Across the bridge the same teardown arrives as
              // a rejection, and a paste handler awaiting it would get an
              // unhandled one instead of a decision.
              //
              // Narrowed to the disposal case ON THE ERROR TYPE, not a blanket
              // catch: a decode failure or a worker that threw is a real
              // fault, and swallowing it as "no bytes" would turn a bug into a
              // paste that silently does nothing.
              if (cause instanceof BridgeDisposedError) return null;
              throw cause;
            }
          },
          // Answered from the MAIN-SIDE docs. Both stay SYNCHRONOUS, which
          // is the whole reason the hot half is on this thread: a
          // `Y.XmlFragment` is what Tiptap binds to by reference and cannot
          // become a promise at the binding site.
          // Answered from the PROJECTION, one push of staleness and no call.
          // A hash that just landed reads as absent until the next publish,
          // and the paste path treats absent as "not ours to accept" - the
          // fail-closed direction, which is why the staleness is acceptable.
          // `includes` rather than a memoised `Set`: this is read once per
          // paste against a handful of hashes, and a cache here is a
          // cache-invalidation bug waiting for the next projection field.
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
            // Zero new payload: the runtime's own implementation was already a
            // projection read - `sink.read().artifactRooms.stateByArtifactId[id]
            // ?? "unavailable"` (`epic-rooms-replica.ts:411`). This is the same
            // expression against the same slice, one layer up, so the value and
            // its default are identical rather than merely equivalent.
            get().artifactRooms.stateByArtifactId[artifactId] ?? "unavailable",
          getArtifactBodyDocKey: (artifactId) => {
            // The runtime's own rule, against projected inputs: the lanes arm
            // keys the tier by artifact id, `@1` keys it by the artifact's
            // ROOM. `artifactRoomId` is already projected (`types.ts:46`) with
            // the same `length > 0` guard the doc read applies.
            const state = get();
            if (state.installedArm === "lanes") return artifactId;
            if (!Object.hasOwn(state.artifacts.byId, artifactId)) return null;
            const roomId = state.artifacts.byId[artifactId].artifactRoomId;
            return roomId !== null && roomId.length > 0 ? roomId : null;
          },
          /**
           * SYNCHRONOUS on the way in, asynchronous underneath.
           *
           * The caller is a `useLayoutEffect` that must return its cleanup
           * immediately (`lib/epic-selectors.ts:1147-1150`), so this cannot
           * become a promise. The materialize it starts is a bridge call, so
           * the grant arrives later - which makes RELEASE-BEFORE-GRANT a real
           * ordering: a tile unmounted before its materialize resolves must
           * still release the lease the grant is about to hand it, or the room
           * never cools.
           */
          acquireArtifactBodyLease: (artifactId) => {
            // The layout-effect holder is an EDITOR mount, which is exactly
            // the bet the cooldown is for.
            const lease = acquireResidentBodyLease(artifactId, "linger");
            // HANDLED, not ignored, and CLASSIFIED rather than blanket. This
            // caller has no residency question - it is holding the room open
            // for an editor that binds the fragment by reference and re-reads
            // it on the residency bump - so an unavailable body, a released
            // lease and a torn-down session are all ordinary here, and every
            // one of them arrives as `ArtifactBodyUnavailableError` (a disposed
            // bridge included, mapped at the acquire above). Attaching a
            // handler is what keeps those from surfacing as unhandled
            // rejections for every tile that opens a body the host cannot
            // serve; the promise still carries the rejection to
            // `acquireResidentArtifactBodyLease`'s own callers.
            //
            // A `BridgeCallError` or a `BridgeResponseMismatchError` is none of
            // those - it is a real transport fault - and swallowing all of them
            // alike made each one invisible. Same rule the lease bridge already
            // applies to a body that answers byteless while its room reads
            // ready: report it, because the failure it produces is a tile that
            // never fills in, with nothing in any log.
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
            // The PROJECTION, in the doc read's own family order: artifacts,
            // then chats, then terminal agents, falling through on ENTRY
            // PRESENCE exactly as the doc version falls through on a missing
            // map entry.
            //
            // RESIDUAL, stated precisely rather than waved at: the projected
            // maps carry `readMaybeString`, which collapses "no `title` key"
            // and `""` into `""`. So the two forms differ in exactly one case -
            // an entry that EXISTS in an earlier family with no `title` key
            // AND the same id existing in a later family. The doc read falls
            // through on the missing key and finds the later title; this
            // returns `""`. For every id that lives in one family, which is
            // every id the projector builds, the two are identical.
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

  // The worker's projector folds on this and has no other source for it, so
  // it is pushed at construction rather than waited for: a session built
  // before the auth profile hydrates would otherwise project its first frames
  // for a null user, which is the fail-OPEN direction - foreign rows visible.
  //
  // Read from the AUTH STORE, not from `options.userId`. The two are the same
  // value in production and are not the same FACT: `options.userId` is the
  // identity persisted state is namespaced under, while the projector's
  // question is who is signed in right now - which is what the subscription
  // below tracks. Pushing the option instead made a caller that namespaces by
  // nothing (every test harness) start the worker with no viewer, and a null
  // viewer hides nothing.
  runtime.currentUser(useAuthStore.getState().profile?.userId ?? null);

  unsubscribeAuthUserId = useAuthStore.subscribe((state, prevState) => {
    const nextUserId = state.profile?.userId ?? null;
    const prevUserId = prevState.profile?.userId ?? null;
    if (nextUserId === prevUserId || disposed) return;
    // An answer scoped to the previous viewer cannot authorize absence for the
    // next one. The viewer-keyed query will set this again when its own result
    // is applied.
    //
    // Through the runtime, never `store.setState` directly: this is a PROJECTED
    // field, so the sink holds the value its own change gate compares against.
    // Writing it here would leave the two disagreeing, and the gate would then
    // refuse to restore the flag the store had cleared.
    // FIRST, before every command below: `republish-records-for-current-user`
    // re-derives the record slices for "the current user", and the worker's
    // answer to that question is whatever this last pushed. Pushing after
    // would rebuild them for the identity being replaced.
    runtime.currentUser(nextUserId);
    runtime.command({
      kind: "mark-chat-records-not-authoritative",
      payload: {},
    });
    // Re-derive the record slices from the RETAINED raw rows, then re-project.
    // The slices are built for one owner (a `byId` keyed on `chatId` can hold
    // no more), so a user switch has to rebuild them rather than merely
    // re-filter downstream - a re-projection alone would keep serving the
    // previous identity's selection. This is what makes the ingest-time owner
    // selection safe.
    runtime.command({
      kind: "republish-records-for-current-user",
      payload: {},
    });
    runtime.command({ kind: "reproject-for-viewer-change", payload: {} });
  });

  // No `start()` here. The worker's composition root calls `runtime.start()`
  // itself, after `installCore` and before it answers `ready` - so by the time
  // this store exists the runtime is already projecting.

  return {
    epicId,
    userId,
    body: {
      applyDocUpdate: (docKey, update) => {
        bodyDocs.applyRemote(docKey, update);
      },
      applyAwareness: (docKey, frame) => {
        bodyDocs.applyRemoteAwareness(docKey, frame);
      },
    },
    projection: {
      // A cheap envelope check, which the contract explicitly allows: both
      // ends ship in one bundle graph, so this distinguishes a slice from a
      // FOREIGN payload rather than re-validating a shape the compiler
      // already agreed on.
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
      // Empty bytes on teardown, which is the SAME answer the worker host
      // gives with no core - "an empty update applies as nothing rather than
      // as a document, and the transfer site checks the answer before
      // retiring the source". A rejection here would break a transfer that
      // races a dispose.
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
      // `applied` is a data-loss guard and never optimistic, so a torn-down
      // session answers `false`: nothing was applied, and the caller must not
      // retire its source on the strength of it.
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
