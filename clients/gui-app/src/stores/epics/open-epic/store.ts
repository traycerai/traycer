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
import { persist, createJSONStorage } from "zustand/middleware";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type {
  ChatRecordRemovalReason,
  ChatRecordSummaryV11,
} from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
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
import { createArtifactBodyLeaseBridge } from "./runtime/worker/artifact-body-lease-bridge";
import { createHotBodyBudgetAdapter } from "./runtime/worker/hot-body-budget-adapter";
import { createMainThreadBodyDocStore } from "./runtime/worker/main-thread-body-docs";
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
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
  /** Ends the transport while the replica lives on. */
  detach(): void;
  /** Ends the worker. */
  dispose(): void;
}

export interface OpenEpicStoreOptions {
  readonly epicId: string;
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
    records: readonly TuiAgentRecordSummaryV11[],
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
   * possible. Throws `MissingNodeError`, `CrossFamilyParentError`, or
   * `ReparentCycleError` when the PROJECTION rejects the move.
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
  readAttachmentBytes: (
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
function isProjectionPatch(
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
   * Publishes that arrived before the store existed.
   *
   * Unreachable today - the runtime projects nothing until `start()`, which
   * runs last - but HELD rather than dropped, because dropping one would
   * desynchronise the sinks from the store silently: a sink's own `read()`
   * would carry a value no subscriber ever saw, and every later change gate
   * would compare against it.
   */
  let preStorePatch: Partial<EpicRuntimeProjection> | null = null;

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
  function applyProjection(patch: Partial<EpicRuntimeProjection>): void {
    const api = storeApi;
    if (api === null) {
      preStorePatch =
        preStorePatch === null
          ? { ...patch }
          : Object.assign(preStorePatch, patch);
      return;
    }
    const held = preStorePatch;
    preStorePatch = null;
    const { bindingEpoch, ...projected } =
      held === null ? patch : { ...held, ...patch };
    api.setState(
      bindingEpoch === undefined
        ? projected
        : { ...projected, bindingVersion: bindingEpoch },
    );
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
  const applyMutation = (mutation: EpicMutation): Promise<EpicMutationResult> =>
    runtime.port.call("mutation/apply", mutation, NO_TRANSFER);

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
    onLocalDocUpdate: (docKey, update) => {
      // The lane's verdict is deliberately DISCARDED here. A refused body
      // update is not a failed user action: the edit is already in main's
      // live doc, and the bytes reach the host on the next materialize or
      // demote cycle regardless. Surfacing it would put an error in front of
      // someone whose typing worked.
      void runtime.port.call("body/update", { docKey, update }, NO_TRANSFER);
    },
    onLocalAwareness: (docKey, frame, localClientId) => {
      runtime.awarenessOut(docKey, frame, localClientId);
    },
  });

  const bodyLeases = createArtifactBodyLeaseBridge({
    bridge: runtime.port,
    docs: bodyDocs,
    budget: createHotBodyBudgetAdapter(options.accounting),
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
            const answer = await runtime.port.call(
              "command/enqueue",
              { intent },
              NO_TRANSFER,
            );
            return answer.outcome === "enqueued" ? answer.commandId : null;
          },
          waitForWriteCommand: (commandId) => {
            const current = get().writeCommands.find(
              (command) => command.commandId === commandId,
            );
            if (current !== undefined && current.state !== "pending") {
              return Promise.resolve(current);
            }
            return new Promise((resolve) => {
              const unsubscribe = api.subscribe((state) => {
                const command = state.writeCommands.find(
                  (candidate) => candidate.commandId === commandId,
                );
                if (command === undefined || command.state === "pending") {
                  return;
                }
                unsubscribe();
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
            runtime.detach();
          },
          dispose: () => {
            if (disposed) return;
            unsubscribeAuthUserId?.();
            unsubscribeAuthUserId = null;
            disposed = true;
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
           * `signal` is accepted and no longer used to bound a WAIT.
           *
           * The runtime's read waited indefinitely for a hash that had not
           * synced, and `hasAttachmentBytes` existed solely to stop callers
           * parking on it - "the guard is not optional". Across the bridge the
           * worker answers not-held promptly (its own `hasAttachmentBytes`
           * check is inside `attachment/read`), so the guard has no caller-side
           * job left and is gone. The parameter stays because callers hold one
           * and dropping it would be a second change to their call shape.
           */
          readAttachmentBytes: async (hash, _signal) => {
            const answer = await runtime.port.call(
              "attachment/read",
              { hash },
              NO_TRANSFER,
            );
            return answer.bytes;
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
            let released = false;
            let grantedRelease: (() => void) | null = null;
            void bodyLeases.acquire(artifactId).then((grant) => {
              if (grant.kind !== "granted") return;
              if (released) {
                grant.release();
                return;
              }
              grantedRelease = grant.release;
            });
            return () => {
              if (released) return;
              released = true;
              grantedRelease?.();
            };
          },
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
      const answer = await runtime.port.call("root/encode", {}, NO_TRANSFER);
      return answer.update;
    },
    applyRootUpdate: async (update, asLocalEdit) => {
      // The bytes are TRANSFERRED, not cloned - this is a whole root replica.
      const encoded = takeBytesForTransfer(update);
      const answer = await runtime.port.call(
        "root/apply",
        { update: encoded.bytes, asLocalEdit },
        encoded.transfer,
      );
      return answer.applied;
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
