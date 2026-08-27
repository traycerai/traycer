import { create, type StoreApi, type UseBoundStore } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicCloudSyncStatus,
  EpicMigrationPhase,
} from "@traycer/protocol/host/epic/subscribe";
import type {
  ChatRecordRemovalReason,
  ChatRecordSummary,
} from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  EpicDeletedAttribution,
  EpicStreamCallbacks,
  EpicStreamClient,
} from "@traycer-clients/shared/host-transport/epic-stream-client";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import type { DeletedEpicArtifact } from "@traycer/protocol/persistence/epic/artifacts";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils";
import { resolveReparentNode } from "@/lib/reparent-rules";
import {
  evaluateProjectedReparent,
  projectedReparentRejectionError,
} from "@/lib/reparent-projection-rules";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";
import { basePersistOptions, openEpicKey } from "@/lib/persist";
import type {
  AgentRolesSlice,
  ArtifactsSlice,
  ArtifactRoomsSlice,
  ChatsSlice,
  DeletedArtifactsSlice,
  EpicArtifactRoomAvailability,
  EpicHeader,
  TerminalAgentsSlice,
  TreeSlice,
} from "./types";
import {
  EMPTY_ARTIFACT_ROOM_DIRTY,
  EMPTY_ARTIFACT_ROOMS_SLICE,
  EMPTY_CHATS_SLICE,
  EMPTY_PROJECTED_SLICES,
  EMPTY_TERMINAL_AGENTS_SLICE,
} from "./types";
import {
  chatRecordsSlice,
  chatSlicesEq,
  isChatVisibleToUser,
  isTerminalAgentVisibleToUser,
  terminalAgentSlicesEq,
  tuiAgentRecordsSlice,
  getArtifactEntry,
  getArtifactsMap,
  getChatEntry,
  getChatsMap,
  getDeletedArtifactsMap,
  getEpicMap,
  getTerminalAgentEntry,
  getTerminalAgentsMap,
  readArtifactKind,
  readMaybeString,
} from "./projection-helpers";
import {
  unionPendingChatCreations,
  type PendingChatCreation,
  type RetainedChatCreation,
} from "./pending-chat-creations";
import { createEpicProjector, type EpicProjector } from "./epic-projector";
import type { PendingMetadataMutation } from "./pending-metadata-overlay";
import { useAuthStore } from "@/stores/auth/auth-store";
import { appLogger } from "@/lib/logger";

/**
 * Factory contract for the stream-client layer. Production wires this to
 * `new EpicStreamClient({ wsStreamClient, epicId, callbacks })`; tests pass a
 * fake that invokes the callbacks on their own schedule so store behaviour
 * can be asserted without real network I/O.
 */
export type EpicStreamClientFactory = (
  epicId: string,
  callbacks: EpicStreamCallbacks,
  /**
   * Reports the host-originated root state this store already holds, so a
   * reattach is served as a delta instead of the whole document. Passed
   * straight through to `EpicStreamClient`, which re-reads it before every
   * wire subscribe — so it must stay a live read, never a captured value.
   */
  seedOfferProvider: () => EpicSubscribeClientSeedOffer | null,
) => Pick<
  EpicStreamClient,
  | "applyUpdate"
  | "awareness"
  | "applyArtifactRoomUpdate"
  | "artifactRoomAwareness"
  | "retryMigration"
  | "close"
>;

export interface SnapshotFetchError {
  readonly code: FatalErrorDetails["code"];
  readonly message: string;
  /**
   * Direction-aware version-skew signal (R4-D2), carried through only for an
   * `INCOMPATIBLE` close — `null` for every other fatal code. See
   * `describeVersionSkew` (`@/lib/host/version-skew-copy`).
   */
  readonly upgradeGuidance: FatalErrorDetails["upgradeGuidance"];
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
const EMPTY_CHAT_RETRACTIONS: Readonly<
  Record<string, ChatRecordRemovalReason>
> = Object.freeze({});

const IDLE_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "idle",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

const ERROR_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "error",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

const NOT_ALLOWED_MIGRATION_SLICE: EpicMigrationSlice = {
  status: "not-allowed",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

type FatalStreamCloseReason = Extract<
  StreamCloseReason,
  { readonly kind: "fatalError" }
>;

function isFatalClose(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): reason is FatalStreamCloseReason {
  return status === "closed" && reason !== null && reason.kind === "fatalError";
}

function isFatalMigrationClose(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
  migrationStatus: EpicMigrationStatus,
): boolean {
  return (
    isFatalClose(status, reason) &&
    reason.details.code !== "UNAUTHORIZED" &&
    migrationStatus === "running"
  );
}

function isUnavailableFatal(details: FatalErrorDetails): boolean {
  return isUnavailableEpicCode(details.code);
}

function snapshotFetchErrorFrom(
  details: FatalErrorDetails,
): SnapshotFetchError {
  return {
    code: details.code,
    message: details.reason,
    upgradeGuidance: details.upgradeGuidance,
  };
}

// Derives the VISIBLE connection status shown in the UI pill: an open
// renderer↔host transport still reads as "reconnecting" while the host's
// cloud link is down. This is display-only - outbound write routing gates on
// `transportStatus` directly (the host owns durable offline persistence and
// replay), so a cloud-sync drop must NOT stop edits from reaching the local
// host.
//
// `hasConnectedOnce` separates first-time bootstrapping from a genuine
// reconnect: before the initial successful connect, the transport handshake and
// the first cloud-sync catch-up are "connecting", not "reconnecting", so a
// freshly created/opened Epic never flashes "Reconnecting…" while it's really
// just coming up for the first time.
function deriveConnectionStatus(
  transportStatus: StreamConnectionStatus,
  cloudSyncStatus: EpicCloudSyncStatus,
  hasConnectedOnce: boolean,
): StreamConnectionStatus {
  if (transportStatus !== "open") {
    // A transport that has never opened is bootstrapping; only a drop after a
    // prior connect is a "reconnecting". "closed" stays "closed" either way.
    if (transportStatus === "reconnecting" && !hasConnectedOnce) {
      return "connecting";
    }
    return transportStatus;
  }
  if (cloudSyncStatus === "connected") {
    return "open";
  }
  // Transport open, cloud link still catching up: bootstrapping the first
  // time, a genuine reconnect once we've been connected before.
  return hasConnectedOnce ? "reconnecting" : "connecting";
}

type OpenEpicStreamClient = Pick<
  EpicStreamClient,
  | "applyUpdate"
  | "awareness"
  | "applyArtifactRoomUpdate"
  | "artifactRoomAwareness"
  | "retryMigration"
  | "close"
>;

export interface OpenEpicStoreOptions {
  readonly epicId: string;
  readonly streamClientFactory: EpicStreamClientFactory;
  /**
   * Identity to namespace persisted state under - the CANONICAL
   * `profile.userId`, never the email (two accounts can share an address).
   * When provided, the local `lastFocusedArtifactId` survives the same user
   * signing in again but stays isolated from any other user that signs into
   * this device - a different `userId` (or `null`) yields a disjoint persist
   * key, so prior focus state never leaks across signed-in identities.
   */
  readonly userId: string | null;
  /**
   * Invoked when the host closes the epic stream with an `UNAUTHORIZED`
   * fatal error. Production wires this to
   * `AuthService.revalidateCurrentContext()` so a stale bearer is either
   * confirmed-valid (transient host failure) or evicted with a
   * sign-out cascade. May be `null` in tests that do not exercise the
   * auth-recovery path.
   */
  readonly onAuthError: (() => void) | null;
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
 * Per-Epic store shape. Holds the live Y.Doc + Awareness, host stream
 * connection state, dirty-tracking watermarks, and the deterministically
 * projected slices produced by `epic-projector.ts`.
 *
 * Components subscribe to projected slices (`artifacts.byId[id]`, `tree.rootIds`,
 * etc.) - they should NOT read `doc` directly. The `getArtifactFragment(id)`
 * action is the single sanctioned escape hatch (Tiptap collaboration binding
 * needs the live `Y.XmlFragment` reference).
 */
export interface OpenEpicState {
  readonly epicId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly bindingVersion: number;

  // ── Projected slices (owned by epic-projector.ts) ────────────────────
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
  /**
   * Chats the record plane RETRACTED while this session was open, and why.
   *
   * Written only by {@link OpenEpicState.applyChatRecordDelta}'s `remove` arm,
   * which is the only signal that distinguishes the two honest end states an
   * OPEN tab can show - "this chat was deleted" versus "this chat is no longer
   * shared with you". The record table alone cannot: a row that left for either
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
   * written only by {@link OpenEpicState.applyTuiAgentRecordDelta}'s
   * `tuiRemove` arm and ABSORBING for the session's life for the same reason:
   * an in-flight `epic.listTuiAgents` answer issued before the retraction must
   * not resurrect the row seconds after its tab said it was gone.
   */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  >;
  /** Doc entries unioned with the host's registry rows. Components read THIS. */
  readonly tuiAgents: TerminalAgentsSlice;
  readonly agentRoles: AgentRolesSlice;
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

  // ── Persisted UI focus ───────────────────────────────────────────────
  readonly lastFocusedArtifactId: string | null;
  readonly lastFocusedThreadId: string | null;

  // ── Actions: focus + connection lifecycle ────────────────────────────
  setLastFocusedArtifactId: (artifactId: string | null) => void;
  setLastFocusedThreadId: (threadId: string | null) => void;
  applyLocalUpdate: (updateBytes: Uint8Array) => void;
  sendAwareness: (awarenessBytes: Uint8Array) => void;
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
  /**
   * Publishes the host's `epic.listChatRecords` answer into the record table.
   *
   * The store-backed half of `chats` (chat-sync-v2 ticket 49). Idempotent and
   * change-gated: an answer that says the same thing as the last one writes
   * nothing, so the poll behind it costs no renders while an epic is quiet.
   *
   * MERGED against what the push has already delivered, not clear-and-replace,
   * on {@link OpenEpicState.applyTuiAgentRecords}' exact contract: a served row
   * is revision-guarded like an `upsert` delta (an answer issued before a push
   * carries an OLDER version of the row, and overwriting with it would regress
   * a version the client has already shown - and hand the optimistic overlay's
   * dead sweep a stale value it reads as terminal supersession, killing a
   * healthy pending chain), and a row the answer omits is retracted only if it
   * was already held when the answer was ISSUED. `issuedAtSeq` is where
   * {@link OpenEpicState.peekChatIngestSeq} stood when the request was
   * dispatched - the caller captures it immediately before the RPC and hands
   * it back with the answer. `null` (no session to read at dispatch) falls
   * back to the previous answer's watermark, which holds an omitted row for
   * one extra pass instead.
   *
   * Never called in doc-only mode - an older host answers `E_HOST_UNSUPPORTED`
   * and the caller simply does not call this, leaving the record slice empty and
   * `chats` identical to the doc projection.
   */
  applyChatRecords: (
    records: readonly ChatRecordSummary[],
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
   * doc-only mode (an older host answers `E_HOST_UNSUPPORTED`, the record
   * slice stays empty, and `tuiAgents` is the doc projection by reference).
   *
   * MERGED against what the push has already delivered, not clear-and-replace:
   * a served row is revision-guarded exactly as a `tuiUpsert` is, and a row the
   * answer omits is retracted only if it was already held when the answer was
   * ISSUED. A list read issued before an agent was committed would otherwise
   * delete the `tuiUpsert` that announced it.
   *
   * `issuedAtSeq` is where {@link OpenEpicState.peekTuiAgentIngestSeq} stood
   * when the request was dispatched - the caller captures it immediately
   * before the RPC and hands it back with the answer. `null` (no session to
   * read at dispatch) falls back to the previous answer's watermark, which
   * holds an omitted row for one extra pass instead.
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
   * selection. Retained rows make that lossless; see `applyChatRecords`.
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
   * from the request the way a per-surface copy would. A surface with a create
   * slow enough to want a row BEFORE the answer may call it earlier and pair it
   * with {@link OpenEpicState.clearPendingChatCreation}.
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
  renameArtifact: (artifactId: string, nextTitle: string) => boolean;
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
  beginRenameMutation: (nodeId: string, nextTitle: string) => string | null;
  /** Optimistic epic-header title change. */
  beginEpicTitleMutation: (nextTitle: string) => string | null;
  /** Optimistic reparent, validated against the projected tree. */
  beginReparentMutation: (
    nodeId: string,
    newParentId: string | null,
  ) => string | null;
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
  ) => boolean;
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
  isLatestRenameStamp: (nodeId: string, requestId: string) => boolean;
  /** Returns true when a delete actually happened. Reparents children. */
  deleteArtifact: (artifactId: string) => boolean;
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
  reparentArtifact: (artifactId: string, newParentId: string | null) => boolean;
  /** Returns true when the title actually changed. */
  setEpicTitle: (nextTitle: string) => boolean;

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
  hasAttachmentBytes: (hash: string) => boolean;
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
  getArtifactRoomId: (artifactId: string) => string | null;
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
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
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

const STREAM_ORIGIN = "stream";
/**
 * Origin tag for renderer-local Y.Doc mutations. Exported for test seeding
 * helpers that must route through `handleDocUpdate` exactly like a local
 * user mutation.
 */
export const LOCAL_ORIGIN = "local";
const EMPTY_Y_UPDATE_BYTES = 2;
/**
 * How long a LANDED metadata mutation may keep patching the display while its
 * own echo is still missing from the authoritative slices. One full
 * record-poll interval (20s, `HOST_METHOD_POLL_TABLE`) plus refetch slack:
 * past this, `authoritative === baseline` is more plausibly a peer's write
 * back to the old value than a stale slice, and the row wins. See the timer
 * in `retirePendingMutation`.
 */
const LANDED_MUTATION_TTL_MS = 30_000;

/**
 * Mints {@link OpenEpicState.ingestFenceIdentity} - one value per store
 * construction, module-monotonic so no two generations (even of the same
 * epic) ever share one.
 */
let nextIngestFenceIdentity = 1;

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function encodeDocStateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
}

function latestHostCoversDirtyWatermark(
  latestHostStateVectorBase64: string | null,
  dirtyWatermarkStateVectorBase64: string | null,
): boolean {
  if (dirtyWatermarkStateVectorBase64 === null) return true;
  if (latestHostStateVectorBase64 === null) return false;
  const latestHostStateVector = Y.decodeStateVector(
    decodeBase64(latestHostStateVectorBase64),
  );
  return Array.from(
    Y.decodeStateVector(
      decodeBase64(dirtyWatermarkStateVectorBase64),
    ).entries(),
  ).every(
    ([clientId, clock]) => (latestHostStateVector.get(clientId) ?? 0) >= clock,
  );
}

function resolveDirtyState(
  dirtyWatermarkStateVectorBase64: string | null,
  latestHostStateVectorBase64: string | null,
): Pick<
  OpenEpicState,
  "isDirty" | "dirtyWatermarkStateVectorBase64" | "latestHostStateVectorBase64"
> {
  if (
    latestHostCoversDirtyWatermark(
      latestHostStateVectorBase64,
      dirtyWatermarkStateVectorBase64,
    )
  ) {
    return {
      isDirty: false,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64,
    };
  }
  return {
    isDirty: true,
    dirtyWatermarkStateVectorBase64,
    latestHostStateVectorBase64,
  };
}

function knownCleanDirtyState(): Pick<
  OpenEpicState,
  "isDirty" | "dirtyWatermarkStateVectorBase64" | "latestHostStateVectorBase64"
> {
  return {
    isDirty: false,
    dirtyWatermarkStateVectorBase64: null,
    latestHostStateVectorBase64: null,
  };
}

function isNonTrivialYUpdate(updateBytes: Uint8Array): boolean {
  return updateBytes.length > EMPTY_Y_UPDATE_BYTES;
}

function isWritablePermissionRole(role: PermissionRole | null): boolean {
  return role !== "viewer" && role !== null;
}

function emitCurrentAwareness(
  awareness: Awareness,
  doc: Y.Doc,
  client: OpenEpicStreamClient | null,
): void {
  if (client === null) return;
  if (awareness.getLocalState() === null) return;
  client.awareness(encodeAwarenessUpdate(awareness, [doc.clientID]));
}

// Reparent validation lives in `@/lib/reparent-projection-rules`
// (`evaluateProjectedReparent`) for the DnD preview, the DnD commit AND this
// store's write path - one evaluator over the projected tree, so preview and
// write cannot disagree. `@/lib/reparent-rules` is now consulted for one thing
// only: `resolveReparentNode`, which finds the Y.Map entry to write to. It
// still owns the doc-side evaluator for callers that genuinely mean the doc.

/**
 * Constructs a fresh per-Epic session.
 *
 * Responsibilities:
 *   - Own a new `Y.Doc` + `Awareness` pair plus a deterministic projector
 *     that mirrors the doc into typed slices on the store
 *   - Open the stream via the injected factory, bind every callback to
 *     mutate the Zustand state
 *   - Buffer outbound updates in memory only while the renderer↔host
 *     transport is closed / reconnecting - NOT while the host's cloud
 *     link is down. The host owns durable offline persistence + replay,
 *     so edits keep streaming to the (local, healthy) host during a
 *     cloud-sync drop; buffering them here would strand them in memory and
 *     lose them on restart. Used as an offline-buffer diagnostic while
 *     snapshot reconcile proves host convergence on reopen
 *   - Persist only `lastFocusedArtifactId` + `lastFocusedThreadId` to
 *     localStorage under a key scoped to `epicId`
 */
export function createOpenEpicStore(
  options: OpenEpicStoreOptions,
): OpenEpicStoreHandle {
  const { epicId, userId } = options;
  let doc = new Y.Doc();
  let awareness = new Awareness(doc);
  let hostCoverageDoc = new Y.Doc();
  /**
   * The room {@link hostCoverageDoc}'s contents came from, or `null` when it
   * holds nothing attributable to a room — a fresh store, a replica reset, or
   * state seeded by a pre-`@1.2` host that never reported a `roomId`.
   *
   * Gates the reattach seed offer: without a room name there is nothing safe
   * to offer, because a major migration mints a NEW room for the same
   * `epicId` and a host diffing against the wrong room's state would omit
   * bytes this client genuinely lacks.
   */
  let hostCoverageRoomId: string | null = null;
  /**
   * Bumped every time {@link hostCoverageDoc} is REPLACED (never when it is
   * merged into). Identifies the doc instance a seed offer was taken from, so
   * a delta can be checked against the doc it was actually diffed against
   * rather than against whatever `hostCoverageDoc` happens to name when the
   * reply lands.
   *
   * Needed because doc identity is not carried on the wire: the offer says
   * "here is my state vector" and the reply says "this is a delta", and
   * nothing in that pair names the doc. Between the two lies a network round
   * trip in which the store may have thrown the doc away.
   *
   * DO NOT MAKE THIS BUMP ON EVERY UPDATE. A counter sitting beside a Y.Doc
   * looks like it should track every change, and tightening it that way would
   * silently disable delta-seed for any actively-syncing epic — every offer
   * would be invalidated by the next inbound update before its reply landed,
   * every reattach would fall back to the full document, and every test would
   * stay green. `applyRootSeedToHostCoverage`'s "forward movement still
   * merges" test exists to catch exactly that edit.
   *
   * The reason only replacement counts is an asymmetry in Yjs itself: a delta
   * computed against an OLDER state vector is a SUPERSET of what the doc still
   * needs, and applying it is idempotent. So coverage moving FORWARD under an
   * in-flight offer is harmless — ordinary updates, and even a resolver
   * re-emitting a second delta against the original offer (`retryMigration`
   * re-runs the host's `initialize()` without re-reading params), all converge.
   * REPLACEMENT is the only thing that destroys the basis the host diffed
   * against, so replacement is the only thing that invalidates an offer.
   *
   * This guard is the WHOLE protection, deliberately. Two of the three paths
   * that replace coverage happen to be safe without it — `requestFreshSnapshot`
   * runs synchronously and ends by bumping `streamGeneration`, so its stale
   * frames are dropped; a room migration cannot produce a delta at all, since
   * the host rejects an offer naming a different room. Neither of those is a
   * declared property: the first survives only until someone makes a step in
   * that block async, and nothing anywhere pins it. Do not restore either as
   * the reason this is safe. The third path — `onPermissionChanged(null)`,
   * which clears coverage WITHOUT ending the stream cycle — was never covered
   * by them at all.
   */
  let hostCoverageGeneration = 0;
  /**
   * The value of {@link hostCoverageGeneration} at the moment the live seed
   * offer was read, or `null` when no offer is outstanding.
   */
  let offeredCoverageGeneration: number | null = null;

  // In-flight `readAttachmentBytes` waits. Held here (not per call) so a replica
  // swap can re-point each one at the live doc's attachments map instead of
  // leaving it observing a destroyed doc.
  type AttachmentReadWaiter = {
    readonly hash: string;
    readonly onChange: () => void;
    readonly settle: (bytes: Uint8Array | null) => void;
    observedMap: Y.Map<unknown> | null;
  };
  const attachmentReadWaiters = new Set<AttachmentReadWaiter>();
  const bindAttachmentWaiter = (waiter: AttachmentReadWaiter): void => {
    if (waiter.observedMap !== null) {
      waiter.observedMap.unobserve(waiter.onChange);
    }
    const map = doc.getMap("attachments");
    waiter.observedMap = map;
    map.observe(waiter.onChange);
    waiter.onChange();
  };

  let disposed = false;
  /**
   * Set by `detachTransport`. Deliberately NOT `disposed`: a detached handle
   * must keep serving local-state actions (`discardUnsyncedEdits` above all),
   * which every `if (disposed) return` guard would turn into silent no-ops -
   * leaving the user a retained buffer they can see and cannot drain.
   * `dispose()` after a detach stays safe: both steps it repeats are
   * idempotent (`detachInternal` returns on a null attachment,
   * `closeStreamClient` on a null client).
   */
  let transportDetached = false;
  /**
   * Local root updates produced while the renderer↔host transport is down.
   *
   * Collapsed with `Y.mergeUpdates` once it grows past either threshold below.
   * The merge is lossless, and a merged update is bounded by the document's
   * own size rather than by how many edits produced it - so a long offline
   * stretch costs O(doc) instead of O(edits). Nothing is ever dropped: the
   * queue is the in-memory propagation path for edits the host has not seen,
   * and discarding it would lose user work that the reconnect reconcile is
   * only a backstop for.
   */
  const unsyncedQueue: Uint8Array[] = [];
  /** Logical edit count, tracked separately from the buffer because
   * collapsing must not make the UI under-report how much is unsynced. */
  let unsyncedOps = 0;
  /**
   * Bytes appended since the last collapse.
   *
   * The collapse trigger MUST be measured against this rather than against the
   * queue's total size. A merged buffer is frequently larger than the
   * threshold all by itself, so a total-size trigger never falls back below
   * the line once it is crossed: every subsequent push would see a
   * two-element, over-threshold queue and re-merge the entire buffer, turning
   * an occasional O(doc) collapse into an O(doc) merge on every single edit.
   * Resetting this to zero after each merge is what makes the trigger latch.
   */
  let unsyncedBytesSinceCollapse = 0;
  const UNSYNCED_COLLAPSE_BYTES = 4 * 1024 * 1024;
  const UNSYNCED_COLLAPSE_ENTRIES = 32;

  const clearUnsyncedQueue = (): void => {
    unsyncedQueue.length = 0;
    unsyncedOps = 0;
    unsyncedBytesSinceCollapse = 0;
  };

  /** Hand the buffered bytes to a caller that is about to send them, leaving
   * the queue empty. */
  const takeUnsyncedQueue = (): Uint8Array[] => {
    const pending = unsyncedQueue.slice();
    clearUnsyncedQueue();
    return pending;
  };

  const pushUnsyncedUpdate = (updateBytes: Uint8Array): void => {
    unsyncedQueue.push(updateBytes);
    unsyncedOps += 1;
    unsyncedBytesSinceCollapse += updateBytes.byteLength;
    if (unsyncedQueue.length < 2) return;
    if (
      unsyncedBytesSinceCollapse <= UNSYNCED_COLLAPSE_BYTES &&
      unsyncedQueue.length <= UNSYNCED_COLLAPSE_ENTRIES
    ) {
      return;
    }
    const merged = Y.mergeUpdates(unsyncedQueue);
    unsyncedQueue.length = 0;
    unsyncedQueue.push(merged);
    unsyncedBytesSinceCollapse = 0;
  };
  let transportStatus: StreamConnectionStatus = "connecting";
  // Keep the historical optimistic value for functional users of the blended
  // connection status. The sync pill must instead consult
  // `hasFreshCloudSyncStatus`, which is the per-cycle acknowledgement proof.
  let cloudSyncStatus: EpicCloudSyncStatus = "connected";
  let hasFreshCloudSyncStatus = false;
  let currentStatus: StreamConnectionStatus = "connecting";
  // Flips true on the first successful connect so a later drop reads as
  // "reconnecting" rather than the bootstrap-only "connecting".
  let hasConnectedOnce = false;
  let currentRole: PermissionRole | null = null;
  let hasFreshRootSnapshotForOpenCycle = false;
  let streamGeneration = 0;
  let streamClient: OpenEpicStreamClient | null = null;
  let routeLocalUpdate: ((updateBytes: Uint8Array) => void) | null = null;
  let routeOutboundAwareness: ((bytes: Uint8Array) => void) | null = null;
  let requestFreshSnapshotImpl: (() => void) | null = null;
  let markDirtyFromLocalDocUpdate: (() => void) | null = null;
  let refreshPublicDirtyState: (() => void) | null = null;
  let unsubscribeAuthUserId: (() => void) | null = null;

  // ── Body artifactRoom replicas ────────────────────────────────────────────────
  // Per-artifact-room Y.Doc replicas mirroring the host-side artifact-rooms. The store
  // treats these as the GUI-side authority for artifact body fragments;
  // editors bind to `artifactRoom.doc.getXmlFragment(artifact-body:{id})` rather
  // than to anything inside the root Epic doc (per Decision 7 in the
  // artifact-room approach spec). Kept outside Zustand state because Y.Doc
  // mutates in place - the store exposes its own `bindingVersion` /
  // `artifactRooms` slice for reactivity, and selectors call
  // `getArtifactFragment` to read the live fragment ref.
  type ArtifactRoomReplicaEntry = {
    doc: Y.Doc;
    awareness: Awareness;
    docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
    awarenessUpdateHandler: (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => void;
    /**
     * Local artifact-room-body updates produced while the stream is not ready to send
     * are queued here and replayed once the fresh root snapshot confirms
     * write permission. This mirrors the root-doc `unsyncedQueue` behavior
     * so reconnect windows do not silently discard user edits - see ticket
     * 4a598302-ac79-47a5-a686-cc9e35bde18b "GUI artifact-room-doc awareness and
     * reconnect-safe body edits".
     *
     * On viewer downgrade the queue is cleared (fail-closed). When a
     * `artifactRoomSnapshot` arrives, the queue is collapsed into a single
     * merged-replica reconcile - sent immediately only after the current
     * open cycle has received a fresh root snapshot/permission role, or
     * stashed in `pendingReconcileUpdate` until that root snapshot confirms
     * owner/editor permission.
     */
    pendingUpdates: Uint8Array[];
    /** Byte size of `pendingUpdates`, so the queue can be collapsed with
     * `Y.mergeUpdates` before a long offline stretch turns it into O(edits)
     * of retained buffers. Kept alongside rather than recomputed because the
     * push path runs on every keystroke-level edit. */
    pendingBytes: number;
    /** Bytes appended since the last collapse - the collapse trigger. Using
     * `pendingBytes` instead would never latch: a merged buffer routinely
     * exceeds the threshold on its own, so every later keystroke would see an
     * over-threshold two-element queue and re-merge everything. */
    pendingBytesSinceCollapse: number;
    /**
     * Reconcile bytes computed at `artifactRoomSnapshot` time when the stream was
     * not ready to send (the stream is not `open`, or the current open
     * cycle has not received a fresh root snapshot/permission role). The
     * next owner/editor root snapshot flushes this single update before
     * draining `pendingUpdates`. The reconcile is derived from the merged
     * local replica's state-as-update against the host's state vector at
     * snapshot time, so it subsumes every local artifact-room-body edit produced
     * during the reconnect window.
     *
     * Cleared on viewer/null downgrade (fail-closed), on a successful
     * send, and on artifactRoom destruction.
     */
    pendingReconcileUpdate: Uint8Array | null;
    /**
     * Local dirty watermark for the artifactRoom replica (base64 state vector at
     * the time of the most recent local edit). `null` when there is no
     * outstanding local divergence.
     */
    dirtyWatermarkStateVectorBase64: string | null;
    /**
     * Latest host-side artifactRoom state vector observed via `artifactRoomSnapshot` or
     * `artifactRoomUpdate` - base64. Compared against the watermark to clear
     * dirty state once the host catches up.
     */
    latestHostStateVectorBase64: string | null;
  };
  const artifactRoomReplicas = new Map<string, ArtifactRoomReplicaEntry>();

  /**
   * A room the host has sent us, held as encoded update bytes with no live
   * `Y.Doc` behind it.
   *
   * This is the memory-shaped half of the artifact-room cache. Yjs retains one
   * `Item` struct per edit for the lifetime of a doc - garbage collection only
   * collapses deleted *content*, never the structs - so a room an agent has
   * rewritten a few hundred times costs O(edits) live objects while it is
   * materialized, but only O(body) bytes once it is encoded back down. A
   * renderer that materialized every room the host opened was paying the
   * former for rooms nothing was looking at.
   *
   * Cold rooms are read-only by construction: the only writer of a room doc is
   * a bound editor, and a bound editor holds a lease that keeps its room hot.
   */
  type ColdArtifactRoomEntry = {
    /** Host update bytes, collapsed with `Y.mergeUpdates` past the thresholds
     * below so a chatty room does not accumulate one buffer per frame. */
    updates: Uint8Array[];
    bytes: number;
    /** Bytes appended since the last compaction - the compaction trigger.
     * See `pushColdArtifactRoomUpdate` for why the total must not be used. */
    bytesSinceCollapse: number;
    latestHostStateVectorBase64: string | null;
    /**
     * Recent remote awareness frames, replayed when the room materializes.
     *
     * A cold room has no `Awareness` instance, so inbound presence frames
     * would otherwise be dropped and a collaborator already sitting in the
     * body would be invisible when the local user finally opens it. Bounded
     * because these arrive continuously: y-protocols renews each client's
     * state every `outdatedTimeout / 2` (15s), so the newest few frames
     * always cover every currently-present peer, and anything staler than
     * `outdatedTimeout` is culled by Awareness itself after replay.
     */
    awarenessFrames: Uint8Array[];
  };
  const coldArtifactRooms = new Map<string, ColdArtifactRoomEntry>();
  /** Outstanding materialization leases per room id. A room with a live lease
   * is never cooled - see `isArtifactRoomPinned`. */
  const artifactRoomLeases = new Map<string, number>();
  const artifactRoomCooldownTimers = new Map<string, number>();
  /** Monotonic touch stamps driving the hot-room LRU. A counter rather than a
   * clock so eviction order is deterministic under fake timers. */
  const artifactRoomTouchSeq = new Map<string, number>();
  let artifactRoomTouchCounter = 0;
  const BIN_STREAM_ORIGIN = Symbol("open-epic/artifact-room-stream");
  const BIN_AWARENESS_REMOTE_ORIGIN = "artifact-room-stream-remote";
  const ROOM_PENDING_COLLAPSE_BYTES = 2 * 1024 * 1024;
  const ROOM_PENDING_COLLAPSE_ENTRIES = 32;
  /** Frames retained per cold room; see `ColdArtifactRoomEntry.awarenessFrames`.
   * One renewal cycle across a realistic number of collaborators. */
  const COLD_ROOM_AWARENESS_FRAMES = 32;
  const COLD_ROOM_COLLAPSE_BYTES = 1024 * 1024;
  const COLD_ROOM_COLLAPSE_ENTRIES = 32;
  /**
   * How long a room stays materialized after its last editor unmounts. Tile
   * remounts (tab switches, canvas virtualization, a re-render that swaps the
   * editor) are common and re-materializing costs a full `Y.applyUpdate` of
   * the body, so an immediate demote would trade memory for visible latency.
   */
  const ARTIFACT_ROOM_COOLDOWN_MS = 60_000;
  /**
   * Backstop ceiling on simultaneously materialized rooms.
   *
   * The linger timer, not this cap, is the reclaim mechanism. The cap only
   * exists so a pathological epic cannot hold an unbounded number of rooms hot
   * inside the linger window. It is set well above a realistic canvas viewport
   * on purpose: at 8 it evicted on ordinary scrolling of a large epic, so
   * every scroll-in paid a full `Y.encodeStateAsUpdate` of the evicted body
   * and every scroll-back paid a compaction plus `Y.applyUpdate` of its own -
   * churn that cost more than the memory it reclaimed. A pinned room is never
   * evicted, so the cap can still be exceeded by editors genuinely in use.
   */
  const MAX_HOT_ARTIFACT_ROOMS = 32;

  function clearPendingRoomUpdates(entry: ArtifactRoomReplicaEntry): void {
    entry.pendingUpdates.length = 0;
    entry.pendingBytes = 0;
    entry.pendingBytesSinceCollapse = 0;
  }

  function takePendingRoomUpdates(
    entry: ArtifactRoomReplicaEntry,
  ): Uint8Array[] {
    const pending = entry.pendingUpdates.slice();
    clearPendingRoomUpdates(entry);
    return pending;
  }

  /**
   * Queue a local room edit the stream cannot carry yet, collapsing the queue
   * once it outgrows either threshold. `Y.mergeUpdates` is lossless and its
   * result is bounded by the room body's own size, so an editor left open
   * through a long disconnect costs O(body) rather than O(keystrokes).
   * Nothing is discarded - these bytes are the only outbound path for edits
   * made during the window.
   */
  function pushPendingRoomUpdate(
    entry: ArtifactRoomReplicaEntry,
    update: Uint8Array,
  ): void {
    entry.pendingUpdates.push(update);
    entry.pendingBytes += update.byteLength;
    entry.pendingBytesSinceCollapse += update.byteLength;
    if (entry.pendingUpdates.length < 2) return;
    if (
      entry.pendingBytesSinceCollapse <= ROOM_PENDING_COLLAPSE_BYTES &&
      entry.pendingUpdates.length <= ROOM_PENDING_COLLAPSE_ENTRIES
    ) {
      return;
    }
    const merged = Y.mergeUpdates(entry.pendingUpdates);
    entry.pendingUpdates.length = 0;
    entry.pendingUpdates.push(merged);
    entry.pendingBytes = merged.byteLength;
    entry.pendingBytesSinceCollapse = 0;
  }

  function canSendArtifactRoomBodyWritesNow(): boolean {
    return (
      transportStatus === "open" &&
      hasFreshRootSnapshotForOpenCycle &&
      isWritablePermissionRole(currentRole)
    );
  }

  function hasDirtyArtifactRoomReplicas(): boolean {
    for (const entry of artifactRoomReplicas.values()) {
      if (entry.dirtyWatermarkStateVectorBase64 !== null) return true;
      if (entry.pendingReconcileUpdate !== null) return true;
      if (entry.pendingUpdates.length > 0) return true;
    }
    return false;
  }

  function resolvePublicDirtyState(
    dirtyWatermarkStateVectorBase64: string | null,
    latestHostStateVectorBase64: string | null,
  ): Pick<
    OpenEpicState,
    | "isDirty"
    | "dirtyWatermarkStateVectorBase64"
    | "latestHostStateVectorBase64"
  > {
    const rootDirtyState = resolveDirtyState(
      dirtyWatermarkStateVectorBase64,
      latestHostStateVectorBase64,
    );
    return {
      ...rootDirtyState,
      isDirty: rootDirtyState.isDirty || hasDirtyArtifactRoomReplicas(),
    };
  }

  function getOrCreateArtifactRoomReplica(
    artifactRoomId: string,
  ): ArtifactRoomReplicaEntry {
    const existing = artifactRoomReplicas.get(artifactRoomId);
    if (existing !== undefined) return existing;
    const replicaDoc = new Y.Doc();
    const replicaAwareness = new Awareness(replicaDoc);
    const docUpdateHandler = (update: Uint8Array, origin: unknown): void => {
      // Host-originated applies must not be echoed; locally-originated
      // edits become outbound `artifactRoomApplyUpdate` frames.
      if (origin === BIN_STREAM_ORIGIN) return;
      const role = currentRole;
      if (!isWritablePermissionRole(role)) {
        // Permission downgrade - fail-closed: stop sending and drop any
        // queued writes that have not been confirmed by a snapshot.
        const replica = artifactRoomReplicas.get(artifactRoomId);
        if (replica !== undefined) {
          clearPendingRoomUpdates(replica);
          replica.pendingReconcileUpdate = null;
          replica.dirtyWatermarkStateVectorBase64 = null;
        }
        refreshPublicDirtyState?.();
        // The clear above removed this room's dirty pin - re-arm the linger so
        // an unleased room is not stranded hot.
        scheduleArtifactRoomCooldown(artifactRoomId);
        return;
      }
      // Mark the replica dirty against the host's last-seen view.
      const replica = artifactRoomReplicas.get(artifactRoomId);
      if (replica !== undefined) {
        replica.dirtyWatermarkStateVectorBase64 = encodeDocStateVectorBase64(
          replica.doc,
        );
      }
      refreshPublicDirtyState?.();
      if (canSendArtifactRoomBodyWritesNow()) {
        streamClient?.applyArtifactRoomUpdate(artifactRoomId, update);
        return;
      }
      // Queue while reconnecting/closed, or while a raw-open stream is still
      // waiting on its fresh root snapshot/permission role. Snapshots
      // collapse the queue into a single merged-replica reconcile (stashed as
      // `pendingReconcileUpdate`) - they never clear the queue without
      // preserving an outbound propagation path.
      if (replica !== undefined) {
        pushPendingRoomUpdate(replica, update);
      }
    };
    const awarenessUpdateHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === BIN_AWARENESS_REMOTE_ORIGIN) return;
      const role = currentRole;
      if (role === "viewer" || role === null) return;
      if (transportStatus !== "open") return;
      const touched = changes.added
        .concat(changes.updated)
        .concat(changes.removed);
      if (touched.length === 0) return;
      streamClient?.artifactRoomAwareness(
        artifactRoomId,
        encodeAwarenessUpdate(replicaAwareness, touched),
      );
    };
    replicaDoc.on("update", docUpdateHandler);
    replicaAwareness.on("update", awarenessUpdateHandler);
    const entry: ArtifactRoomReplicaEntry = {
      doc: replicaDoc,
      awareness: replicaAwareness,
      docUpdateHandler,
      awarenessUpdateHandler,
      pendingUpdates: [],
      pendingBytes: 0,
      pendingBytesSinceCollapse: 0,
      pendingReconcileUpdate: null,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64: null,
    };
    artifactRoomReplicas.set(artifactRoomId, entry);
    return entry;
  }

  function destroyArtifactRoomReplica(artifactRoomId: string): void {
    const entry = artifactRoomReplicas.get(artifactRoomId);
    if (entry === undefined) return;
    entry.doc.off("update", entry.docUpdateHandler);
    entry.awareness.off("update", entry.awarenessUpdateHandler);
    entry.awareness.destroy();
    entry.doc.destroy();
    artifactRoomReplicas.delete(artifactRoomId);
  }

  function destroyAllArtifactRoomReplicas(): void {
    for (const id of Array.from(artifactRoomReplicas.keys())) {
      destroyArtifactRoomReplica(id);
    }
    for (const timer of artifactRoomCooldownTimers.values()) {
      window.clearTimeout(timer);
    }
    artifactRoomCooldownTimers.clear();
    coldArtifactRooms.clear();
    artifactRoomTouchSeq.clear();
    // Leases are deliberately NOT cleared: they are owned by mounted editors,
    // which survive a replica swap / resubscribe and will re-materialize their
    // room from the next snapshot. Clearing them here would leave a mounted
    // editor holding a release closure for a lease nobody is counting.
  }

  function isArtifactRoomLeased(artifactRoomId: string): boolean {
    return (artifactRoomLeases.get(artifactRoomId) ?? 0) > 0;
  }

  /**
   * True when the room must stay materialized.
   *
   * Three reasons, all of which cost correctness rather than memory if
   * ignored:
   *  - an editor holds a lease;
   *  - the replica carries local divergence the host has not acknowledged,
   *    where cooling would encode away the very bytes the reconnect reconcile
   *    is supposed to ship and silently lose user edits;
   *  - a remote collaborator is present in the room. Cooling destroys the
   *    room's `Awareness`, and while cold every inbound awareness frame is
   *    dropped with no way to ask for a resync, so a peer who was sitting in
   *    the body would simply vanish - caret, selection and avatar - until they
   *    happened to move again. Presence is exactly what a shared room is for,
   *    so a room someone else is in is not a room worth reclaiming.
   */
  function isArtifactRoomPinned(artifactRoomId: string): boolean {
    if (isArtifactRoomLeased(artifactRoomId)) return true;
    const entry = artifactRoomReplicas.get(artifactRoomId);
    if (entry === undefined) return false;
    if (hasRemoteArtifactRoomPeers(entry)) return true;
    return (
      entry.dirtyWatermarkStateVectorBase64 !== null ||
      entry.pendingReconcileUpdate !== null ||
      entry.pendingUpdates.length > 0
    );
  }

  /**
   * Encode the room's currently-known REMOTE peers as a single awareness
   * update, for replay after a demote. The local client is excluded: the
   * editor sets its own state when it rebinds, and replaying a stale copy of
   * it would fight that.
   */
  function encodeArtifactRoomPeerAwareness(
    entry: ArtifactRoomReplicaEntry,
  ): Uint8Array[] {
    const remote = Array.from(entry.awareness.getStates().keys()).filter(
      (clientId) => clientId !== entry.awareness.clientID,
    );
    if (remote.length === 0) return [];
    return [encodeAwarenessUpdate(entry.awareness, remote)];
  }

  function recordColdArtifactRoomAwareness(
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ): void {
    const cold = coldArtifactRooms.get(artifactRoomId);
    // Only rooms the host has actually snapshotted are worth holding presence
    // for - an unseeded room cannot be materialized, so there is nothing to
    // replay into.
    if (cold === undefined) return;
    cold.awarenessFrames.push(awarenessBytes);
    while (cold.awarenessFrames.length > COLD_ROOM_AWARENESS_FRAMES) {
      cold.awarenessFrames.shift();
    }
  }

  /** Any awareness client other than our own local one. */
  function hasRemoteArtifactRoomPeers(
    entry: ArtifactRoomReplicaEntry,
  ): boolean {
    const states = entry.awareness.getStates();
    if (states.size === 0) return false;
    if (states.size > 1) return true;
    return !states.has(entry.awareness.clientID);
  }

  /**
   * Compact a cold room's buffered frames into a single garbage-collected
   * update.
   *
   * `Y.mergeUpdates` alone concatenates history losslessly, keeping the
   * CONTENT of every deleted item. Replaying into a throwaway doc and
   * re-encoding runs Yjs's GC, which drops that deleted content. Measured
   * against this repo's yjs on the workload this targets (an agent rewriting a
   * body repeatedly): 85.9 KB -> 7.5 KB at 40 rewrites, 657 KB -> 48.8 KB at
   * 300 - a 6-13x reduction that widens with edit count.
   *
   * What it does NOT do, and must not be described as doing: it does not reset
   * client clocks or discard the struct skeleton. Struct COUNT is unchanged by
   * compaction (measured identical either way), so the encoding still grows
   * with edit history, just far more slowly, and re-materializing a
   * long-rewritten room rebuilds the same number of structs. The win here is
   * that a cold room holds bytes instead of a live doc full of `Item` objects;
   * bounding the struct skeleton itself would need a document rewrite, which
   * would break synchronization with the host.
   *
   * The temporary doc is destroyed immediately; only the bytes are retained.
   */
  function compactColdArtifactRoomBytes(updates: Uint8Array[]): Uint8Array {
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, Y.mergeUpdates(updates));
      return Y.encodeStateAsUpdate(scratch);
    } finally {
      scratch.destroy();
    }
  }

  function pushColdArtifactRoomUpdate(
    entry: ColdArtifactRoomEntry,
    update: Uint8Array,
  ): void {
    entry.updates.push(update);
    entry.bytes += update.byteLength;
    entry.bytesSinceCollapse += update.byteLength;
    if (entry.updates.length < 2) return;
    // Measured against bytes appended SINCE the last collapse, never against
    // the total: a compacted buffer can exceed the threshold by itself, and a
    // total-size trigger would then re-compact on every single inbound frame.
    if (
      entry.bytesSinceCollapse <= COLD_ROOM_COLLAPSE_BYTES &&
      entry.updates.length <= COLD_ROOM_COLLAPSE_ENTRIES
    ) {
      return;
    }
    const compacted = compactColdArtifactRoomBytes(entry.updates);
    entry.updates.length = 0;
    entry.updates.push(compacted);
    entry.bytes = compacted.byteLength;
    entry.bytesSinceCollapse = 0;
  }

  function recordColdArtifactRoomBytes(
    artifactRoomId: string,
    update: Uint8Array,
    hostStateVectorBase64: string | null,
  ): void {
    const existing = coldArtifactRooms.get(artifactRoomId);
    if (existing === undefined) {
      coldArtifactRooms.set(artifactRoomId, {
        updates: [update],
        bytes: update.byteLength,
        bytesSinceCollapse: 0,
        latestHostStateVectorBase64: hostStateVectorBase64,
        awarenessFrames: [],
      });
      return;
    }
    pushColdArtifactRoomUpdate(existing, update);
    if (hostStateVectorBase64 !== null) {
      existing.latestHostStateVectorBase64 = hostStateVectorBase64;
    }
  }

  /**
   * Coalesce `bindingVersion` bumps to one per microtask.
   *
   * Zustand notifies every subscriber on every `set`, and each notification
   * re-runs the selector of every mounted `useStore` consumer. Opening a
   * canvas materializes one room per tile, so bumping per room turned a single
   * invalidation into N full notification rounds over N tiles. One bump per
   * tick delivers the same signal at O(1) rounds.
   */
  let bindingVersionBumpScheduled = false;
  let bumpBindingVersionImpl: (() => void) | null = null;
  function scheduleBindingVersionBump(): void {
    if (disposed || bindingVersionBumpScheduled) return;
    bindingVersionBumpScheduled = true;
    queueMicrotask(() => {
      bindingVersionBumpScheduled = false;
      if (disposed) return;
      bumpBindingVersionImpl?.();
    });
  }

  function touchArtifactRoom(artifactRoomId: string): void {
    artifactRoomTouchCounter += 1;
    artifactRoomTouchSeq.set(artifactRoomId, artifactRoomTouchCounter);
  }

  function cancelArtifactRoomCooldown(artifactRoomId: string): void {
    const timer = artifactRoomCooldownTimers.get(artifactRoomId);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    artifactRoomCooldownTimers.delete(artifactRoomId);
  }

  /**
   * Encode a materialized room back down to update bytes and drop its doc.
   * Returns false when the room is pinned or was not hot to begin with.
   */
  function coolArtifactRoomReplica(artifactRoomId: string): boolean {
    const entry = artifactRoomReplicas.get(artifactRoomId);
    if (entry === undefined) return false;
    if (isArtifactRoomPinned(artifactRoomId)) return false;
    // Encode the whole replica, not just the frames we happened to receive:
    // the doc is the merge of the host snapshot plus every update since, and
    // its state-as-update is the smallest lossless representation of that.
    const encoded = Y.encodeStateAsUpdate(entry.doc);
    const latestHostStateVectorBase64 = entry.latestHostStateVectorBase64;
    destroyArtifactRoomReplica(artifactRoomId);
    coldArtifactRooms.set(artifactRoomId, {
      updates: [encoded],
      bytes: encoded.byteLength,
      bytesSinceCollapse: 0,
      latestHostStateVectorBase64,
      // Carry the peers this replica currently knows about across the demote,
      // so cooling a room does not blank presence when it comes back.
      awarenessFrames: encodeArtifactRoomPeerAwareness(entry),
    });
    return true;
  }

  /**
   * Arm the linger timer for a room nothing is holding. No-op while a lease or
   * local divergence pins the room, and re-armable: the pinned case is
   * re-tested when the next frame lands, so a room that finishes syncing after
   * its editor closed still cools rather than staying hot forever.
   */
  function scheduleArtifactRoomCooldown(artifactRoomId: string): void {
    if (disposed) return;
    if (isArtifactRoomPinned(artifactRoomId)) return;
    if (!artifactRoomReplicas.has(artifactRoomId)) return;
    if (artifactRoomCooldownTimers.has(artifactRoomId)) return;
    const timer = window.setTimeout(() => {
      artifactRoomCooldownTimers.delete(artifactRoomId);
      if (disposed) return;
      coolArtifactRoomReplica(artifactRoomId);
    }, ARTIFACT_ROOM_COOLDOWN_MS);
    artifactRoomCooldownTimers.set(artifactRoomId, timer);
  }

  function enforceHotArtifactRoomCap(): void {
    while (artifactRoomReplicas.size > MAX_HOT_ARTIFACT_ROOMS) {
      let victim: string | null = null;
      let victimSeq = Number.POSITIVE_INFINITY;
      for (const id of artifactRoomReplicas.keys()) {
        if (isArtifactRoomPinned(id)) continue;
        const seq = artifactRoomTouchSeq.get(id) ?? 0;
        if (seq < victimSeq) {
          victimSeq = seq;
          victim = id;
        }
      }
      if (victim === null) return;
      cancelArtifactRoomCooldown(victim);
      if (!coolArtifactRoomReplica(victim)) return;
    }
  }

  /**
   * Bring a room back up to a live `Y.Doc`, or return `null` when the room has
   * no content to bring up.
   *
   * Returning `null` for an unseeded room is load-bearing. `artifactRoomState`
   * reports `ready` on first observation and on every recovery transition,
   * independently of `artifactRoomSnapshot`, so there is a window where the
   * room is `ready` with no bytes anywhere. Fabricating an empty `Y.Doc` there
   * would make `getArtifactFragment` hand back a live-but-EMPTY fragment where
   * it used to return `null` - which reads as a real, empty body: export would
   * skip its "still loading" guard and write an empty file, and an editor
   * would bind to a blank document. An empty room and an unseeded room must
   * stay distinguishable.
   */
  function materializeArtifactRoomReplica(
    artifactRoomId: string,
  ): ArtifactRoomReplicaEntry | null {
    touchArtifactRoom(artifactRoomId);
    cancelArtifactRoomCooldown(artifactRoomId);
    const hot = artifactRoomReplicas.get(artifactRoomId);
    if (hot !== undefined) {
      armCooldownForUnleasedMaterialization(artifactRoomId);
      return hot;
    }
    const cold = coldArtifactRooms.get(artifactRoomId);
    if (cold === undefined) return null;
    const entry = getOrCreateArtifactRoomReplica(artifactRoomId);
    coldArtifactRooms.delete(artifactRoomId);
    // `BIN_STREAM_ORIGIN` so the replay does not read as a local edit and
    // get echoed back to the host as an outbound update.
    Y.applyUpdate(entry.doc, Y.mergeUpdates(cold.updates), BIN_STREAM_ORIGIN);
    entry.latestHostStateVectorBase64 = cold.latestHostStateVectorBase64;
    // Replay presence that arrived while the room was cold, so a peer already
    // in the body is visible immediately rather than after their next renewal.
    // `BIN_AWARENESS_REMOTE_ORIGIN` keeps these from echoing back to the host.
    for (const frame of cold.awarenessFrames) {
      applyAwarenessUpdate(entry.awareness, frame, BIN_AWARENESS_REMOTE_ORIGIN);
    }
    enforceHotArtifactRoomCap();
    armCooldownForUnleasedMaterialization(artifactRoomId);
    return entry;
  }

  /**
   * Re-arm the linger after materializing, in case nothing pinned the room.
   *
   * `scheduleArtifactRoomCooldown` no-ops while the room is pinned, and
   * `acquireArtifactBodyLease` increments its count BEFORE materializing, so
   * this is inert on the lease path - which is the only caller today. It stays
   * as the guarantee for any future one: a materialization cancels the pending
   * cooldown, so a caller that does not pin the room would otherwise strand a
   * live `Y.Doc` for the rest of the session.
   */
  function armCooldownForUnleasedMaterialization(artifactRoomId: string): void {
    scheduleArtifactRoomCooldown(artifactRoomId);
  }

  function flushPendingArtifactRoomUpdates(artifactRoomId: string): void {
    const entry = artifactRoomReplicas.get(artifactRoomId);
    if (entry === undefined) return;
    if (transportStatus !== "open") return;
    if (!hasFreshRootSnapshotForOpenCycle) return;
    const role = currentRole;
    if (!isWritablePermissionRole(role)) {
      clearPendingRoomUpdates(entry);
      entry.pendingReconcileUpdate = null;
      entry.dirtyWatermarkStateVectorBase64 = null;
      refreshPublicDirtyState?.();
      // Dropping the dirty state just removed this room's last non-lease pin.
      // Nothing else will re-arm the timer for it, so an unleased room would
      // otherwise stay materialized for the rest of the session.
      scheduleArtifactRoomCooldown(artifactRoomId);
      return;
    }
    // Flush the snapshot-derived reconcile first (if any). It already
    // subsumes every queued local edit captured before the snapshot
    // merge, so a successful send lets us drop the queue without
    // double-shipping bytes. The queue still drains afterwards to
    // cover edits produced AFTER the snapshot but before reopen.
    const reconcile = entry.pendingReconcileUpdate;
    if (reconcile !== null) {
      entry.pendingReconcileUpdate = null;
      streamClient?.applyArtifactRoomUpdate(artifactRoomId, reconcile);
    }
    if (entry.pendingUpdates.length === 0) {
      // The reconcile above may have been the last pin.
      scheduleArtifactRoomCooldown(artifactRoomId);
      return;
    }
    const pending = takePendingRoomUpdates(entry);
    for (const update of pending) {
      streamClient?.applyArtifactRoomUpdate(artifactRoomId, update);
    }
    // Everything queued is now in flight; if no lease holds this room it is
    // free to cool again.
    scheduleArtifactRoomCooldown(artifactRoomId);
  }

  function flushAllPendingArtifactRoomUpdates(): void {
    for (const id of Array.from(artifactRoomReplicas.keys())) {
      flushPendingArtifactRoomUpdates(id);
    }
  }

  /**
   * Drop every room's unsent local state (discard-changes, viewer downgrade,
   * access loss).
   *
   * Each clear removes the divergence that was pinning that room, so each one
   * has to re-arm the linger timer: `scheduleArtifactRoomCooldown` is
   * otherwise only reachable from a lease release or an inbound frame for
   * that specific room, and neither follows a discard. Without this the rooms
   * a user actually edited - precisely the ones that accumulated the most Yjs
   * structs - would stay materialized for the rest of the session.
   */
  function clearAllPendingArtifactRoomUpdates(): void {
    for (const [artifactRoomId, entry] of artifactRoomReplicas) {
      clearPendingRoomUpdates(entry);
      entry.pendingReconcileUpdate = null;
      entry.dirtyWatermarkStateVectorBase64 = null;
      scheduleArtifactRoomCooldown(artifactRoomId);
    }
  }

  function readArtifactArtifactRoomId(artifactId: string): string | null {
    const entry = getArtifactEntry(doc, artifactId);
    if (entry === null) return null;
    const v = entry.get("artifactRoomId");
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  const getCurrentChatProjectionUserId = (): string | null =>
    useAuthStore.getState().profile?.userId ?? null;

  /**
   * The host's store-backed chat records, held OUTSIDE the store state as the
   * projector's input (the mirrored copy in `state.chatRecords` is what
   * components and tests read). A closure variable rather than a state read
   * because the projector runs inside `setState` computations, where reading
   * the store it is about to write is exactly the kind of cycle that produces a
   * projection built from half-updated state.
   */
  let chatRecords: ChatsSlice = EMPTY_CHATS_SLICE;

  /**
   * The RAW rows behind `chatRecords`, keyed by OWNER AND CHAT.
   *
   * The projected slice cannot serve as the record layer's own state on two
   * counts. It drops `revision`, which is the entire basis of the staleness
   * test a push delta has to make; and it is keyed on `chatId` ALONE, which is
   * not a record identity. A record is `(epicId, ownerUserId, chatId)` - the
   * id is host-minted, so two users can legitimately hold the same one inside
   * a single task, and this store is already scoped to one epic. Keying this
   * map on the id alone would let a collaborator's row EVICT the viewer's own
   * same-id chat, which reads as the viewer's chat vanishing from their own
   * sidebar.
   *
   * Held beside the slice rather than folded into `ChatProjection`, because a
   * revision is sync bookkeeping and nothing that renders should be able to
   * read it.
   */
  const chatRecordRows = new Map<string, ChatRecordSummary>();
  const recordKey = (ownerUserId: string, chatId: string): string =>
    `${ownerUserId}\u001f${chatId}`;
  /**
   * See `OpenEpicState.chatRetractions` - absorbing for the session's life.
   *
   * Keyed by `chatId` alone, unlike {@link chatRecordRows}, because that is all
   * a `remove` frame carries: the delta names `(epicId, chatId, reason)` and no
   * owner. The frame's addressing is therefore COARSER than a record identity,
   * so a removal retracts every retained row with that id in this epic. Bounded
   * and invisible today - the display filter already withholds every row whose
   * owner is not the signed-in user, so the only rows that can render are ones
   * for which `chatId` IS unique. Widening the frame is a protocol change, not
   * something to guess at here.
   */
  const chatRetractions = new Map<string, ChatRecordRemovalReason>();
  /**
   * Local ingest order for the chat rows, and the watermark the last
   * `epic.listChatRecords` answer left behind - the chat halves of
   * `tuiAgentRowSeq` / `tuiAgentIngestSeq` / `tuiAgentSnapshotFence` below,
   * keyed like {@link chatRecordRows} on `(ownerUserId, chatId)`. See the
   * terminal-agent block for the full rationale: `revision` orders two
   * versions of ONE row and says nothing about a row an answer omits, so an
   * omission may only retract a row that was already held when the answer was
   * issued, and a served row may only replace a strictly older version.
   */
  const chatRowSeq = new Map<string, number>();
  let chatIngestSeq = 0;
  let chatSnapshotFence = 0;
  // See {@link OpenEpicState.ingestFenceIdentity}: which generation the two
  // ingest counters belong to, so a cached fence can never cross stores.
  const mintedIngestFenceIdentity = nextIngestFenceIdentity;
  nextIngestFenceIdentity += 1;

  /**
   * Locally initiated creations with no record back yet, keyed like
   * {@link chatRecordRows} - `(ownerUserId, chatId)` - and held in their OWN map
   * rather than seeded into that one.
   *
   * Separate because these are not records and must not be treated as any: the
   * row map's entries carry a per-chat `revision` that the delta path's
   * staleness test compares against, and a synthesized entry would have to
   * invent one. A fabricated `revision: 0` would then make the real row's first
   * delta (also revision 0) read as a replay and be DROPPED - the optimistic row
   * would outlive the truth it stands in for. Held apart, the record path's
   * ordering rules are untouched and the union happens at publish.
   */
  const pendingChatCreations = new Map<string, RetainedChatCreation>();
  /**
   * Retires the stand-in that an ARRIVING RECORD has just made redundant.
   *
   * Keyed on the record's full identity, not on its id: `chatId` is not globally
   * unique, and a collaborator's legitimate same-id row must not be able to
   * retire the viewer's own in-flight creation - the row that replaces a
   * stand-in has to be the SAME chat, not merely a chat with the same id. This
   * is the pending-side half of the invariant `chatRecordRows`' own keying
   * exists for; see the collaborator regression test in
   * `__tests__/chat-records-union.test.ts`.
   */
  const expirePendingChatCreationForRecord = (
    ownerUserId: string,
    chatId: string,
  ): boolean => pendingChatCreations.delete(recordKey(ownerUserId, chatId));
  /**
   * Drops every retained creation for `chatId`, whoever it was registered for.
   *
   * The id-coarse arm, for the two callers that genuinely have no owner to
   * narrow by, both of which are addressing THIS CLIENT'S OWN creations rather
   * than reconciling somebody's record:
   *
   *  - a `remove` frame, which carries `(epicId, chatId, reason)` and no owner
   *    at all - the same coarseness `chatRetractions` is keyed at, and bounded
   *    the same way;
   *  - a create that failed, whose caller knows the id it sent and not the
   *    profile that was signed in when the retention happened.
   *
   * Scoping the failure arm to the CURRENT user instead was considered and
   * rejected: it strands a stand-in for a chat that does not exist whenever the
   * account moves between the request and its refusal, and a ghost row for a
   * chat nobody can open is worse than dropping a stand-in for one that exists
   * (which the record channel restores on its next answer). This map only ever
   * holds creations THIS session initiated, and an id names at most one of
   * them, so the coarseness has nothing to hit in practice.
   */
  const dropPendingChatCreationsForChat = (chatId: string): boolean => {
    let dropped = false;
    for (const [key, retained] of pendingChatCreations) {
      if (retained.pending.chatId !== chatId) continue;
      pendingChatCreations.delete(key);
      dropped = true;
    }
    return dropped;
  };

  /**
   * The terminal-agent halves of the same record layer, mirroring the three
   * chat structures above. The raw-row table is keyed by `tuiAgentId` ALONE,
   * unlike `chatRecordRows`: the host serves the CALLER'S OWN rows only
   * (terminal agents are structurally owner-private, per the
   * `epic.listTuiAgents` contract), so within one viewer's answer the id is
   * unambiguous. Rows are still retained regardless of owner - a delta could
   * in principle carry another identity's row after an account switch - and
   * the publish below re-selects for the current user, so the keying only has
   * to be safe for what the host actually serves.
   */
  let tuiAgentRecords: TerminalAgentsSlice = EMPTY_TERMINAL_AGENTS_SLICE;
  const tuiAgentRecordRows = new Map<string, TuiAgentRecordSummaryV11>();
  /** See `OpenEpicState.tuiAgentRetractions` - absorbing for the session. */
  const tuiAgentRetractions = new Map<string, ChatRecordRemovalReason>();
  /**
   * Local ingest order for the terminal-agent rows, and the watermark the last
   * `epic.listTuiAgents` answer left behind.
   *
   * `revision` orders two versions of ONE row; it says nothing about a row the
   * snapshot simply does not contain. That omission is the ambiguous case: a
   * list read issued before an agent was committed cannot carry it, and the
   * `tuiUpsert` that announced it can land while that read is still in flight.
   * Applying such a snapshot as clear-and-replace deletes the row it never had
   * a chance to see - precisely the A2A-created agent this whole channel exists
   * to surface - until the next 20s poll.
   *
   * So an omission is only allowed to retract a row that was already held
   * when the answer was issued. `tuiAgentRowSeq` stamps every accepted write
   * with a monotonic counter; the list hook reads that counter at dispatch
   * (`peekTuiAgentIngestSeq`) and hands it back with the answer as the fence,
   * so a row ingested past it survives that answer and an answer issued after
   * the row landed retracts it at once - a deletion missed while the stream
   * was down is collected by the very next read, not one read later.
   * `tuiAgentSnapshotFence` (where the counter stood after the previous
   * answer) is the fallback for an answer dispatched with no session to read;
   * it holds an omitted row for one extra pass. Retractions are unaffected:
   * `tuiRemove` is the explicit signal and stays absorbing.
   */
  const tuiAgentRowSeq = new Map<string, number>();
  let tuiAgentIngestSeq = 0;
  let tuiAgentSnapshotFence = 0;

  // The projector hides chats owned by a different signed-in user. The owner
  // id is the canonical `profile.userId`, read LIVE rather than off the
  // store's `userId` option: that option is the same canonical id today (it
  // used to be the email), but it is fixed at construction, and a session
  // constructed before the auth profile hydrates must pick up the id on its
  // next projection.
  /**
   * Metadata mutations stamped by this client and not yet answered, keyed by
   * client request id (Phase 1.1's optimistic overlay).
   *
   * Held here rather than in store state for the same reason
   * {@link pendingChatCreations} is: it is the projector's INPUT, folded into
   * the published slices at projection time, and putting it in state would
   * make every mutation two setStates - one for the pending map and one for
   * the projection it forces - with a frame between them where the row is
   * neither old nor new.
   *
   * A `Map` because order is semantic: two renames of one row must apply in
   * the order the user made them.
   */
  const pendingMetadataMutations = new Map<string, PendingMetadataMutation>();

  /**
   * The last-stamped rename request per node, SURVIVING the chain: the dead
   * sweep deletes a chain whose row moved off-anchor, and a successful
   * rename's own echo arriving before its RPC settles is exactly such a
   * move. The persisted-tab snapshot guard has to tell "an older rename of
   * ours acked after a newer one" (skip the write) from "our only rename's
   * echo beat its ack" (write) - chain membership cannot, because the chain
   * is gone in both. Entries are overwritten per node and cleared at
   * dispose; request ids are never reused, so a stale tombstone can only
   * ever refuse a write, never misattribute one.
   */
  const latestRenameStampByNode = new Map<string, string>();

  /**
   * Mutations OBSERVED to target a record-plane row, by client request id.
   *
   * Membership is decided by {@link markRegistryBackedMutations} while the
   * evidence exists - a record row for the node that the OWNER SELECTION
   * would actually serve to this viewer - and is STICKY: a registry row
   * disappearing is itself a record-plane judgment (that plane keeps moving
   * through a root reconnect), so it must not downgrade the chain back to
   * doc authority at exactly the moment the dead sweep needs to honor the
   * disappearance.
   *
   * The fact is CHAIN-WIDE and stored chain-wide: one marked member marks
   * every current sibling AND every sibling stamped later (the marking pass
   * propagates), so a mutation begun after the record row disappeared -
   * against the doc fallback the union still serves - carries its chain's
   * provenance itself rather than borrowing it from an older sibling that a
   * partially-processed dead batch might already have deleted. Request ids
   * are never reused, so an id left behind by a deleted entry can never
   * mislabel a future chain - the deletes at the map's removal sites are
   * hygiene, not correctness.
   */
  const registryBackedRequestIds = new Set<string>();

  /**
   * Whether the record plane CURRENTLY serves `nodeId` to this viewer, using
   * the same owner selection the publish seams use. The raw tables
   * deliberately retain every identity's rows - a collaborator may hold the
   * SAME `chatId` (a record identity is `(epicId, ownerUserId, chatId)`, see
   * {@link chatRecordRows}) - and a row the projector never served cannot be
   * provenance for a mutation the user made against the visible one. Testing
   * bare-id membership here shipped once and misclassified a doc-only legacy
   * chat as registry-backed off a collaborator's invisible same-id row.
   */
  const hasVisibleRecordRowForNode = (nodeId: string): boolean => {
    const currentUserId = getCurrentChatProjectionUserId();
    const tuiRow = tuiAgentRecordRows.get(nodeId);
    if (
      tuiRow !== undefined &&
      isTerminalAgentVisibleToUser(tuiRow.ownerUserId, currentUserId)
    ) {
      return true;
    }
    for (const row of chatRecordRows.values()) {
      if (row.chatId !== nodeId) continue;
      if (isChatVisibleToUser(row.ownerUserId, currentUserId)) return true;
    }
    return false;
  };

  /**
   * Capture record-plane provenance for every retained mutation whose CHAIN
   * the record plane serves to this viewer. Runs at stamp time and from both
   * record publish seams - the ONE writer each raw table has - so a row
   * already present at begin and a row arriving mid-flight both mark the
   * chain while the row is still there to prove it.
   *
   * Two passes because the fact is chain-wide: a chain counts as
   * registry-backed if ANY member is already marked (stickiness surviving
   * the row's disappearance) or the node currently has a visible record row,
   * and then EVERY member is marked - including one stamped after the row
   * disappeared, which inherits the chain's provenance here at its own
   * stamp.
   */
  const markRegistryBackedMutations = (): void => {
    if (pendingMetadataMutations.size === 0) return;
    const chainKeyOf = (kind: string, nodeId: string): string =>
      `${kind}\u001f${nodeId}`;
    const markedChains = new Set<string>();
    for (const mutation of pendingMetadataMutations.values()) {
      if (mutation.kind === "epic-title") continue;
      const key = chainKeyOf(mutation.kind, mutation.nodeId);
      if (markedChains.has(key)) continue;
      if (
        registryBackedRequestIds.has(mutation.requestId) ||
        hasVisibleRecordRowForNode(mutation.nodeId)
      ) {
        markedChains.add(key);
      }
    }
    if (markedChains.size === 0) return;
    for (const mutation of pendingMetadataMutations.values()) {
      if (mutation.kind === "epic-title") continue;
      if (markedChains.has(chainKeyOf(mutation.kind, mutation.nodeId))) {
        registryBackedRequestIds.add(mutation.requestId);
      }
    }
  };

  /**
   * Whether a mutation's CHAIN is served by the RECORD plane. Registry rows
   * live in {@link chatRecordRows} / {@link tuiAgentRecordRows} - closure
   * state fed by the poll and delta channels, never cleared by a root
   * reconnect - so their authority does not ride the root doc snapshot the
   * way artifact rows and the epic title do. The dead sweep's snapshot gate
   * reads this to decide which plane's judgment it may trust while the
   * replacement doc is still unseeded.
   *
   * Chain-level, not entry-level: the sweep reports whole chains, and one
   * member observed against a record row is provenance for all of them - a
   * split verdict would delete half a chain and hand `resolvePendingChain`
   * a remainder whose baseline no longer means anything.
   */
  const isRegistryBackedMutation = (
    mutation: PendingMetadataMutation,
  ): boolean => {
    if (mutation.kind === "epic-title") return false;
    for (const other of pendingMetadataMutations.values()) {
      if (other.kind !== mutation.kind) continue;
      if (other.nodeId !== mutation.nodeId) continue;
      if (registryBackedRequestIds.has(other.requestId)) return true;
    }
    return hasVisibleRecordRowForNode(mutation.nodeId);
  };

  const projector: EpicProjector = createEpicProjector({
    getCurrentUserId: getCurrentChatProjectionUserId,
    getChatRecords: () => chatRecords,
    getTuiAgentRecords: () => tuiAgentRecords,
    getPendingOverlay: () => pendingMetadataMutations,
    // The dead sweep: a full projection proved these chains finished (row
    // caught up to the acked value, or a peer overwrote it). Deletion only -
    // NO republish - a dead chain already displays the authoritative value,
    // and a republish here would recurse into the projection that reported it.
    //
    // Gated on the open cycle's root snapshot, because a projection can run
    // against a replica that holds no authority yet: `requestFreshSnapshotImpl`
    // swaps in a brand-new EMPTY `Y.Doc` and `projector.attach` full-projects
    // it before the replacement snapshot lands, and record ingests can force
    // full projections inside that same window. Against that state every
    // doc-backed row reads as deleted and the epic title as "", so honoring
    // the report would terminally retire chains whose RPCs are alive and
    // retryable. While the flag is down the report is ignored; the snapshot's
    // own full projection re-runs the sweep against real state the moment it
    // lands, and the landed-entry TTL bounds the map meanwhile.
    //
    // The gate is PLANE-AWARE: it protects only chains whose authority rides
    // the doc (artifact rows, the epic title, a doc-only legacy chat). A
    // registry-backed chat or terminal agent is judged against record rows
    // the reconnect never touched, and its record plane keeps moving through
    // the window - suppressing ITS death lets a supersession verdict
    // (row moved off-anchor) sit retained until a later record revisits the
    // chain's baseline value, where the stale intent would resurrect. A
    // deadness computed entirely from live registry state is honored
    // regardless of the flag. Which plane a chain rides is the STICKY,
    // owner-selected provenance above (`registryBackedRequestIds`), not a
    // bare-id scan of the raw tables - see `hasVisibleRecordRowForNode`.
    //
    // Classification runs to completion BEFORE any deletion: the plane
    // lookup is chain-level, so deleting one member (and its provenance
    // mark) mid-batch would change a later sibling's verdict - honoring
    // half a chain and suppressing the rest, leaving a remainder whose
    // baseline no longer means anything.
    onDeadMutations: (requestIds) => {
      const honored: string[] = [];
      for (const requestId of requestIds) {
        const mutation = pendingMetadataMutations.get(requestId);
        if (mutation === undefined) continue;
        if (
          !hasFreshRootSnapshotForOpenCycle &&
          !isRegistryBackedMutation(mutation)
        ) {
          continue;
        }
        honored.push(requestId);
      }
      for (const requestId of honored) {
        pendingMetadataMutations.delete(requestId);
        registryBackedRequestIds.delete(requestId);
      }
    },
  });

  const handleDocUpdate = (updateBytes: Uint8Array, origin: unknown) => {
    if (origin === STREAM_ORIGIN) return;
    markDirtyFromLocalDocUpdate?.();
    if (routeLocalUpdate === null) return;
    routeLocalUpdate(updateBytes);
  };
  const handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote") return;
    if (routeOutboundAwareness === null) return;
    const touched = changes.added
      .concat(changes.updated)
      .concat(changes.removed);
    if (touched.length === 0) return;
    routeOutboundAwareness(encodeAwarenessUpdate(awareness, touched));
  };
  const bindCurrentReplica = (): void => {
    doc.on("update", handleDocUpdate);
    awareness.on("update", handleAwarenessUpdate);
    // Re-point pending attachment reads at the freshly-bound doc so a wait
    // started before a snapshot rebind still observes the live map.
    for (const waiter of attachmentReadWaiters) bindAttachmentWaiter(waiter);
  };

  const destroyReplica = (
    replicaDoc: Y.Doc,
    replicaAwareness: Awareness,
  ): void => {
    replicaAwareness.off("update", handleAwarenessUpdate);
    replicaDoc.off("update", handleDocUpdate);
    replicaAwareness.destroy();
    replicaDoc.destroy();
  };

  const replaceReplica = (storeApi: StoreApi<OpenEpicState>): void => {
    const localAwarenessState = awareness.getLocalState();
    const previousDoc = doc;
    const previousAwareness = awareness;
    projector.detach();
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    bindCurrentReplica();
    if (localAwarenessState !== null) {
      awareness.setLocalState(localAwarenessState);
    }
    destroyReplica(previousDoc, previousAwareness);
    projector.attach(doc, storeApi);
  };

  const replaceHostCoverageDoc = (snapshotBytes: Uint8Array | null): void => {
    const previous = hostCoverageDoc;
    hostCoverageDoc = new Y.Doc();
    if (snapshotBytes !== null) {
      Y.applyUpdate(hostCoverageDoc, snapshotBytes);
    }
    // Whatever room the discarded doc represented, the replacement does not
    // represent it: callers either reset coverage to empty or rebase it onto a
    // full snapshot whose room only `applyRootSeedToHostCoverage` knows. Left
    // stale, this would offer a new room's state under the old room's name.
    hostCoverageRoomId = null;
    // The doc any outstanding offer was taken from no longer exists, so a
    // delta computed against it can no longer be applied anywhere.
    hostCoverageGeneration += 1;
    previous.destroy();
  };

  /**
   * Folds this cycle's root payload into {@link hostCoverageDoc} and records
   * the room it came from.
   *
   * THE SEAM THE `seededFromOffer` FLAG EXISTS FOR. A full snapshot is
   * self-sufficient, so coverage is rebuilt from it — that is what
   * {@link replaceHostCoverageDoc} does and what every pre-`@1.3` cycle did. A
   * DELTA is not self-sufficient: it deliberately omits everything the host
   * knew this client already had, so rebuilding a fresh doc from it would
   * discard exactly the state the delta was computed to leave out, silently
   * collapsing coverage to the handful of bytes that changed. It must be
   * merged into the existing doc instead.
   *
   * WHY THE REBUILD ARM STILL EXISTS — and it is NOT to bound growth.
   *
   * Merging deltas forever does not make this doc grow. Yjs integrates
   * operations into a struct store keyed by client and clock; it does not
   * append the update messages that delivered them. So the encoded size is a
   * function of the document's operation set, not of how many merges built it.
   * Measured: 50 reattach cycles merging deltas produce a byte-IDENTICAL doc
   * to rebuilding from a full snapshot each cycle (ratio 1.000000), and with
   * deletions, in-place edits and redundant full-snapshot re-delivery mixed in,
   * 1.000108 — 78 bytes on 722 KB of fragmentation noise, with identical
   * content and identical state vectors. A client that reattaches fifty times
   * on a flaky link therefore needs no periodic re-baseline, and none is
   * armed.
   *
   * The rebuild arm earns its place on CORRECTNESS instead: a full snapshot
   * may come from a DIFFERENT ROOM. A major migration mints a new room for the
   * same `epicId`, and merging its snapshot into coverage built from the old
   * room would union two logically different documents. Discarding the old doc
   * is the only correct handling, and the arms line up with that by
   * construction — a room change makes the host reject the offer
   * (`offer.roomId !== storage.getRoomId()`), so it answers with a full
   * snapshot and no `seededFromOffer`, which lands here on exactly the rebuild
   * arm that drops the stale room.
   */
  const applyRootSeedToHostCoverage = (
    meta: SnapshotMetaEpic,
    snapshotBytes: Uint8Array,
  ): void => {
    if (meta.seededFromOffer !== true) {
      replaceHostCoverageDoc(snapshotBytes);
      hostCoverageRoomId = meta.roomId ?? null;
      offeredCoverageGeneration = null;
      return;
    }
    // A delta, so it is only meaningful against the doc whose state vector was
    // offered. If that doc has been replaced since (permission loss clears
    // coverage without ending the stream cycle), merging here would fold a
    // diff into a doc it was never computed against, and the result would
    // silently hold only the bytes that changed.
    //
    // Leave coverage untouched in that case, and take no room id — so no
    // further offer is made until a full snapshot re-establishes a basis. The
    // replica still receives these bytes at the call site, so the user's view
    // is unaffected; only host-coverage precision degrades, and it degrades by
    // UNDER-stating what the host has. That is the safe direction: coverage is
    // read to decide whether local work is durable, and over-reporting dirty
    // work costs a redundant reconcile, while under-reporting it would claim
    // unsynced edits are safe.
    if (offeredCoverageGeneration !== hostCoverageGeneration) {
      offeredCoverageGeneration = null;
      return;
    }
    Y.applyUpdate(hostCoverageDoc, snapshotBytes);
    hostCoverageRoomId = meta.roomId ?? null;
    offeredCoverageGeneration = null;
  };

  /**
   * The reattach offer: what this client has already received from the host,
   * so the host can answer a resubscribe with only what changed.
   *
   * Read live at every wire subscribe, including reconnects — never cached.
   *
   * Offers {@link hostCoverageDoc}'s state vector rather than the local
   * replica's, and the distinction is load-bearing rather than stylistic.
   * `doc` additionally holds local edits the host may not have accepted yet;
   * naming those in the offer would tell the host "I already have this", and
   * the delta it computed would omit the host's own copy of anything it had
   * in fact accepted and not echoed back. The replica would still converge —
   * it holds those bytes locally — but `hostCoverageDoc` would not, leaving
   * host coverage understated and the sync pill claiming unsynced work that
   * is actually durable. Coverage is precisely "what the host has sent me",
   * which is exactly the question a seed offer asks.
   *
   * `doc ⊇ hostCoverageDoc` always (both receive every snapshot and update;
   * only `doc` also receives local edits), so a delta computed against
   * coverage is a superset of what the replica needs and applying it to both
   * converges.
   */
  const readSeedOffer = (): EpicSubscribeClientSeedOffer | null => {
    if (hostCoverageRoomId === null) {
      offeredCoverageGeneration = null;
      return null;
    }
    // Record WHICH doc this vector describes, so the reply can be checked
    // against it rather than against whatever `hostCoverageDoc` names by then.
    offeredCoverageGeneration = hostCoverageGeneration;
    return {
      stateVectorBase64: encodeDocStateVectorBase64(hostCoverageDoc),
      roomId: hostCoverageRoomId,
    };
  };

  bindCurrentReplica();

  const closeStreamClient = (): void => {
    if (streamClient === null) return;
    const active = streamClient;
    streamClient = null;
    active.close();
  };

  const store = create<OpenEpicState>()(
    persist(
      (set, get, api) => {
        /**
         * Re-derives `chatRecords` from `chatRecordRows` and publishes it.
         *
         * The ONE writer of the record slice, shared by the poll
         * (`applyChatRecords`) and the push (`applyChatRecordDelta`) so the two
         * halves of one table cannot drift in how they publish it.
         *
         * Change-gated on {@link chatSlicesEq}: an answer that says the same
         * thing as the last one writes nothing, so the 20s poll behind this
         * costs no renders while an epic is quiet. `extra` (the retraction map)
         * bypasses that gate, because a removal that leaves the slice unchanged
         * - a chat this session never held a record for, opened cross-host from
         * the sidebar - still has to reach the open tab that is rendering it.
         *
         * A FULL re-projection rather than a hand-rolled patch: `chats` feeds
         * the tree and the role-claim slices, and re-deriving those here would
         * be a second implementation of the projector's own composition, free
         * to drift from it. Records change rarely (this is gated on an actual
         * difference), so the cost is a snapshot-shaped re-project on a real
         * change and nothing at all otherwise.
         */
        const publishChatRecords = (
          extra: Pick<OpenEpicState, "chatRetractions"> | null,
        ): void => {
          // The slice is keyed on `chatId` alone, so it can only be built from
          // rows for which that id is unambiguous - i.e. ONE owner's. Selecting
          // that owner here (rather than letting `unionChatsSlice`'s filter do
          // it downstream) is what stops a collaborator's same-id row from
          // taking the `byId` slot the viewer's own chat needs.
          //
          // The objection this used to carry - that filtering at ingest freezes
          // the answer at the moment the rows ARRIVED - is answered by
          // `chatRecordRows`, which retains EVERY row regardless of owner. A
          // user switch re-runs this from the retained rows (see the auth
          // subscription below), so nothing is frozen and nothing is lost.
          // `unionChatsSlice` still applies the same predicate at projection
          // time; two boundaries, one shared rule, so they cannot disagree.
          const currentUserId = getCurrentChatProjectionUserId();
          // Record provenance for any pending metadata mutation this table
          // now backs, BEFORE the change gate below can early-return: the
          // marks must be captured while the row exists, and this is the one
          // seam every chat-record write flows through.
          markRegistryBackedMutations();
          const visible: ChatRecordSummary[] = [];
          for (const row of chatRecordRows.values()) {
            if (!isChatVisibleToUser(row.ownerUserId, currentUserId)) continue;
            visible.push(row);
          }
          // Creations this client has asked for but has no record back for,
          // folded in HERE - the one seam both the poll and the push path
          // publish through, so neither can see a table the other cannot. A
          // real row always wins over its pending stand-in.
          const next = unionPendingChatCreations(
            chatRecordsSlice(visible),
            pendingChatCreations.values(),
            currentUserId,
          );
          const nextSlice = next.allIds.length === 0 ? EMPTY_CHATS_SLICE : next;
          if (extra === null && chatSlicesEq(chatRecords, nextSlice)) return;
          chatRecords = nextSlice;
          set(
            projector.isAttached()
              ? { chatRecords: nextSlice, ...extra, ...projector.projectFull() }
              : // Nothing attached yet: the records are held, and the
                // attach-time projection folds them in through the same
                // getter. Writing EMPTY slices here would erase the store.
                { chatRecords: nextSlice, ...extra },
          );
        };

        /**
         * The terminal-agent twin of {@link publishChatRecords}: the ONE
         * writer of the terminal-agent record slice, shared by the poll
         * (`applyTuiAgentRecords`) and the push (`applyTuiAgentRecordDelta`),
         * with the same ingest-time owner selection (retained rows make a user
         * switch lossless), the same {@link terminalAgentSlicesEq} change gate,
         * the same retraction-driven gate bypass, and the same full
         * re-projection - `tuiAgents` feeds the tree and role-claim slices
         * exactly as `chats` does.
         */
        const publishTuiAgentRecords = (
          extra: Pick<OpenEpicState, "tuiAgentRetractions"> | null,
        ): void => {
          const currentUserId = getCurrentChatProjectionUserId();
          // See publishChatRecords: provenance marks are captured at the one
          // seam every terminal-agent record write flows through.
          markRegistryBackedMutations();
          const visible: TuiAgentRecordSummaryV11[] = [];
          for (const row of tuiAgentRecordRows.values()) {
            if (!isTerminalAgentVisibleToUser(row.ownerUserId, currentUserId)) {
              continue;
            }
            visible.push(row);
          }
          const next = tuiAgentRecordsSlice(visible);
          const nextSlice =
            next.allIds.length === 0 ? EMPTY_TERMINAL_AGENTS_SLICE : next;
          if (
            extra === null &&
            terminalAgentSlicesEq(tuiAgentRecords, nextSlice)
          ) {
            return;
          }
          tuiAgentRecords = nextSlice;
          set(
            projector.isAttached()
              ? {
                  tuiAgentRecords: nextSlice,
                  ...extra,
                  ...projector.projectFull(),
                }
              : { tuiAgentRecords: nextSlice, ...extra },
          );
        };

        const syncCurrentConnectionStatus = (): StreamConnectionStatus => {
          currentStatus = deriveConnectionStatus(
            transportStatus,
            cloudSyncStatus,
            hasConnectedOnce,
          );
          return currentStatus;
        };

        // Publishes the blended status together with the raw legs it was
        // blended from, so a reader that needs to know WHERE unsynced work is
        // sitting can never observe the two out of step. Every site that
        // moves `transportStatus` / `cloudSyncStatus` /
        // `hasFreshCloudSyncStatus` / `hasConnectedOnce`
        // must set through this.
        const connectionStateSlice = (): Pick<
          OpenEpicState,
          | "connectionStatus"
          | "hostTransportStatus"
          | "cloudSyncStatus"
          | "hasFreshCloudSyncStatus"
          | "hasConnectedOnce"
        > => ({
          connectionStatus: currentStatus,
          hostTransportStatus: transportStatus,
          cloudSyncStatus,
          hasFreshCloudSyncStatus,
          hasConnectedOnce,
        });

        /**
         * Returns the state patch that puts host dirtiness back to UNKNOWN for
         * a new subscription cycle, and — as a side effect the return type
         * cannot express — also clears the closure-local
         * `hasFreshCloudSyncStatus`.
         *
         * Both halves have to move together. Cloud freshness lives outside the
         * store because only the pill reads it, but a retained `true` from the
         * previous cycle would let the pill claim `synced` off a stale cloud
         * status the moment this cycle's snapshot arrives. Callers must apply
         * the returned patch AND accept that reset; do not lift one out.
         */
        const resetDurabilityProofForOpenCycle = (): Pick<
          OpenEpicState,
          | "artifactRoomDirtyByArtifactRoomId"
          | "rootDirty"
          | "hasDirtySnapshotForOpenCycle"
        > => {
          hasFreshCloudSyncStatus = false;
          return {
            artifactRoomDirtyByArtifactRoomId: EMPTY_ARTIFACT_ROOM_DIRTY,
            rootDirty: null,
            hasDirtySnapshotForOpenCycle: false,
          };
        };

        const flushPendingRootUpdates = (): void => {
          if (unsyncedQueue.length === 0) return;
          const role = currentRole ?? get().permissionRole;
          if (!isWritablePermissionRole(role)) {
            clearUnsyncedQueue();
            set({ unsyncedQueueSize: 0 });
            return;
          }
          const pending = takeUnsyncedQueue();
          set({ unsyncedQueueSize: 0 });
          for (const updateBytes of pending) {
            streamClient?.applyUpdate(updateBytes);
          }
        };

        const flushPendingWritesAfterReconnect = (
          client: OpenEpicStreamClient | null,
        ): void => {
          if (transportStatus !== "open") return;
          if (!hasFreshRootSnapshotForOpenCycle) return;
          flushPendingRootUpdates();
          flushAllPendingArtifactRoomUpdates();
          if (client !== null) {
            emitCurrentAwareness(awareness, doc, client);
          }
        };

        const openStreamClient = (): void => {
          const generation = streamGeneration + 1;
          streamGeneration = generation;
          hasFreshRootSnapshotForOpenCycle = false;

          let client: OpenEpicStreamClient | null = null;
          client = options.streamClientFactory(
            epicId,
            {
              onSnapshot: (meta, snapshotBytes) => {
                if (disposed || generation !== streamGeneration) return;
                // Suspend projector so the per-event observeDeep storm
                // triggered by `Y.applyUpdate` does not race with the
                // deterministic full re-project below.
                projector.suspend();
                try {
                  // The replica merges either way: a delta and a full snapshot
                  // are both just updates to apply here, and `doc` is never
                  // rebuilt on this path. It is host COVERAGE that has a
                  // rebuild-vs-merge decision, and it is the one that would lose
                  // state if a delta reached the rebuild arm.
                  Y.applyUpdate(doc, snapshotBytes, STREAM_ORIGIN);
                  applyRootSeedToHostCoverage(meta, snapshotBytes);
                } finally {
                  projector.resume();
                }
                const reconcileUpdate = Y.encodeStateAsUpdate(
                  doc,
                  decodeBase64(meta.hostStateVectorBase64),
                );
                const dirtyState = resolvePublicDirtyState(
                  get().dirtyWatermarkStateVectorBase64,
                  meta.hostStateVectorBase64,
                );
                // Only writable roles may push the reconcile delta back. A
                // viewer's local doc carries no legitimate offline edits, and the
                // delta vs `hostStateVectorBase64` can be non-trivial purely
                // because the host re-encoded its snapshot and state vector at
                // different instants on an actively-syncing room. Sending it as a
                // viewer hits the host's guarded `applyCollabUpdate`, which
                // refuses the mutate AND evicts the warm slot - tearing the room
                // down mid-open. Mirror the same gate as `applyLocalUpdate`.
                if (
                  isNonTrivialYUpdate(reconcileUpdate) &&
                  isWritablePermissionRole(meta.permissionRole)
                ) {
                  client?.applyUpdate(reconcileUpdate);
                }
                clearUnsyncedQueue();
                currentRole = meta.permissionRole;
                hasFreshRootSnapshotForOpenCycle = true;
                const slices = projector.projectFull();
                set((state) => ({
                  snapshotMeta: meta,
                  permissionRole: meta.permissionRole,
                  accessLost:
                    meta.permissionRole === null ? state.accessLost : false,
                  snapshotLoaded: true,
                  snapshotFetchError: null,
                  // The snapshot landing is the unambiguous "migration
                  // succeeded" signal - there is nothing further to render.
                  migration:
                    state.migration.status === "idle"
                      ? state.migration
                      : IDLE_MIGRATION_SLICE,
                  ...dirtyState,
                  ...slices,
                  unsyncedQueueSize: 0,
                }));
                if (!isWritablePermissionRole(currentRole)) {
                  const hadArtifactRoomState =
                    Object.keys(get().artifactRooms.stateByArtifactRoomId)
                      .length > 0;
                  clearAllPendingArtifactRoomUpdates();
                  destroyAllArtifactRoomReplicas();
                  set((state) => {
                    const publicDirtyState = resolvePublicDirtyState(
                      state.dirtyWatermarkStateVectorBase64,
                      state.latestHostStateVectorBase64,
                    );
                    if (!hadArtifactRoomState) return publicDirtyState;
                    return {
                      bindingVersion: state.bindingVersion + 1,
                      artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
                      ...publicDirtyState,
                    };
                  });
                  return;
                }
                if (transportStatus === "open") {
                  flushAllPendingArtifactRoomUpdates();
                }
              },
              onUpdate: (updateBytes) => {
                if (disposed || generation !== streamGeneration) return;
                Y.applyUpdate(doc, updateBytes, STREAM_ORIGIN);
                Y.applyUpdate(hostCoverageDoc, updateBytes);
                // Skip the expensive state-vector encode on the steady-stream
                // clean-to-clean case: with no dirty watermark, coverage check
                // is trivially satisfied and `latestHostStateVectorBase64`
                // would only be consulted after the next local edit, at which
                // point the next onUpdate path below will recompute it.
                if (get().dirtyWatermarkStateVectorBase64 === null) return;
                const latestHostStateVectorBase64 =
                  encodeDocStateVectorBase64(hostCoverageDoc);
                set((state) =>
                  resolvePublicDirtyState(
                    state.dirtyWatermarkStateVectorBase64,
                    latestHostStateVectorBase64,
                  ),
                );
              },
              onEarlyMeta: (earlyMeta) => {
                if (disposed || generation !== streamGeneration) return;
                // Metadata-only frame from the host - populate snapshotMeta
                // so workspace-derived UI (git status, file tree, sidebar
                // repo chip, permission display) starts working before the
                // full Y.Doc snapshot lands. Intentionally does NOT flip
                // `snapshotLoaded` - canvas content still gates on the real
                // `onSnapshot` callback.
                //
                // We do NOT update the closure-scoped `currentRole` here:
                // that variable gates local writes (`applyLocalUpdate`,
                // artifact-room `docUpdateHandler`). The early
                // `permissionRole` is the host's projection of cloud
                // `epic.permission.role`, which can disagree with the
                // snapshot-derived role (which factors in team memberships
                // via `derivePermissionRole`). Allowing early-meta to flip
                // `currentRole` would fail-closed for a team-derived owner
                // (writes silently dropped for ~8s) or fail-open for a
                // stale-cached editor (writes go out but host rejects).
                // Snapshot is authoritative - leave `currentRole` alone.
                //
                // The merged `snapshotMeta` uses placeholders for
                // `schemaVersion` and `hostStateVectorBase64` since
                // earlyMeta doesn't know them. Consumers must not read
                // those two fields before `snapshotLoaded === true`.
                const meta: SnapshotMetaEpic = {
                  ...earlyMeta,
                  schemaVersion: "",
                  hostStateVectorBase64: "",
                };
                set((state) => ({
                  snapshotMeta: meta,
                  permissionRole: earlyMeta.permissionRole,
                  // Mirror the snapshot's accessLost-clear semantics so a
                  // role-restored reconnect doesn't leave the renderer in a
                  // self-contradicting state (sidebar shows editor while the
                  // session is still flagged access-lost for the access
                  // coordinator).
                  accessLost:
                    earlyMeta.permissionRole === null
                      ? state.accessLost
                      : false,
                }));
              },
              onAwareness: (awarenessBytes) => {
                if (disposed || generation !== streamGeneration) return;
                applyAwarenessUpdate(awareness, awarenessBytes, "remote");
              },
              onArtifactRoomSnapshot: (
                artifactRoomId,
                snapshotBytes,
                hostArtifactRoomStateVectorBase64,
              ) => {
                if (disposed || generation !== streamGeneration) return;
                // A room nobody is editing never materializes: keep the bytes
                // and flip availability so the tile can render its state, and
                // let the first lease pay for the `Y.Doc`. There is nothing to
                // reconcile on this path - a cold room has no local edits by
                // construction - so the whole reconcile/queue dance below is
                // reachable only for rooms an editor is (or was) bound to.
                if (
                  !artifactRoomReplicas.has(artifactRoomId) &&
                  !isArtifactRoomLeased(artifactRoomId)
                ) {
                  recordColdArtifactRoomBytes(
                    artifactRoomId,
                    snapshotBytes,
                    hostArtifactRoomStateVectorBase64,
                  );
                  set((state) => ({
                    artifactRooms: {
                      stateByArtifactRoomId: {
                        ...state.artifactRooms.stateByArtifactRoomId,
                        [artifactRoomId]: "ready",
                      },
                    },
                  }));
                  return;
                }
                // Reuse any prior replica for this artifactRoom so a snapshot during
                // reconnect/recovery does NOT destroy local in-flight
                // edits. The host is now the merge source - its bytes
                // get applied on top of the existing local replica, and
                // dirty tracking drives a reconcile fan-out for any local
                // edits the host has not yet seen.
                const hadPrior = artifactRoomReplicas.has(artifactRoomId);
                const entry = getOrCreateArtifactRoomReplica(artifactRoomId);
                Y.applyUpdate(entry.doc, snapshotBytes, BIN_STREAM_ORIGIN);
                entry.latestHostStateVectorBase64 =
                  hostArtifactRoomStateVectorBase64;
                // If the local replica is ahead of the host's snapshot,
                // ship a reconcile update so offline edits round-trip.
                const reconcileUpdate = Y.encodeStateAsUpdate(
                  entry.doc,
                  decodeBase64(hostArtifactRoomStateVectorBase64),
                );
                const reconcileNeeded = isNonTrivialYUpdate(reconcileUpdate);
                const canSendNow = canSendArtifactRoomBodyWritesNow();
                if (reconcileNeeded && canSendNow) {
                  streamClient?.applyArtifactRoomUpdate(
                    artifactRoomId,
                    reconcileUpdate,
                  );
                  // Reconcile shipped: every local update is already
                  // represented in the merged replica, so the single
                  // reconcile subsumes both the queue and any prior
                  // pending reconcile. Convergence is proven by the next
                  // coverage check, not by replaying each queued frame.
                  clearPendingRoomUpdates(entry);
                  entry.pendingReconcileUpdate = null;
                } else if (
                  reconcileNeeded &&
                  isWritablePermissionRole(currentRole)
                ) {
                  // Stream is reconnecting/closed, or raw-open before the
                  // fresh root snapshot. Stash the reconcile so the root
                  // snapshot permission gate can flush it later. Without this,
                  // clearing `pendingUpdates` here would silently drop the only
                  // outbound propagation path for local edits made during the
                  // reconnect window. The merged-replica reconcile subsumes
                  // those queued frames.
                  entry.pendingReconcileUpdate = reconcileUpdate;
                  clearPendingRoomUpdates(entry);
                } else {
                  // Either no divergence (reconcile is trivial) or the
                  // role is viewer/null (fail-closed). In both cases
                  // there is nothing safe to send and nothing to retain.
                  clearPendingRoomUpdates(entry);
                  entry.pendingReconcileUpdate = null;
                }
                if (
                  latestHostCoversDirtyWatermark(
                    hostArtifactRoomStateVectorBase64,
                    entry.dirtyWatermarkStateVectorBase64,
                  )
                ) {
                  entry.dirtyWatermarkStateVectorBase64 = null;
                }
                set((state) => {
                  const stateByArtifactRoomId = {
                    ...state.artifactRooms.stateByArtifactRoomId,
                    [artifactRoomId]: "ready" as EpicArtifactRoomAvailability,
                  };
                  const dirtyState = resolvePublicDirtyState(
                    state.dirtyWatermarkStateVectorBase64,
                    state.latestHostStateVectorBase64,
                  );
                  return {
                    // Bumping bindingVersion only when the artifactRoom replica is
                    // a fresh one - for an already-bound replica we keep
                    // the editor mounted so user typing is uninterrupted.
                    bindingVersion: hadPrior
                      ? state.bindingVersion
                      : state.bindingVersion + 1,
                    artifactRooms: { stateByArtifactRoomId },
                    ...dirtyState,
                  };
                });
                // The snapshot may have been what cleared this replica's last
                // local divergence, so re-test the linger arm here: without it a
                // room whose editor closed while it was still dirty would stay
                // materialized for the rest of the session.
                scheduleArtifactRoomCooldown(artifactRoomId);
              },
              onArtifactRoomUpdate: (
                artifactRoomId,
                updateBytes,
                hostArtifactRoomStateVectorBase64,
              ) => {
                if (disposed || generation !== streamGeneration) return;
                const entry = artifactRoomReplicas.get(artifactRoomId);
                if (entry === undefined) {
                  // Cold room: accumulate the bytes rather than materializing a
                  // doc for a body nothing is displaying. An unknown room is
                  // still skipped - `recordColdArtifactRoomBytes` only extends
                  // rooms the host has already snapshotted.
                  const cold = coldArtifactRooms.get(artifactRoomId);
                  if (cold === undefined) return;
                  pushColdArtifactRoomUpdate(cold, updateBytes);
                  cold.latestHostStateVectorBase64 =
                    hostArtifactRoomStateVectorBase64;
                  return;
                }
                Y.applyUpdate(entry.doc, updateBytes, BIN_STREAM_ORIGIN);
                entry.latestHostStateVectorBase64 =
                  hostArtifactRoomStateVectorBase64;
                if (
                  latestHostCoversDirtyWatermark(
                    hostArtifactRoomStateVectorBase64,
                    entry.dirtyWatermarkStateVectorBase64,
                  )
                ) {
                  entry.dirtyWatermarkStateVectorBase64 = null;
                }
                refreshPublicDirtyState?.();
                scheduleArtifactRoomCooldown(artifactRoomId);
              },
              onArtifactRoomAwareness: (artifactRoomId, awarenessBytes) => {
                if (disposed || generation !== streamGeneration) return;
                // Apply inbound awareness to the artifact-room-scoped Awareness
                // instance, NOT the root Epic awareness. CollaborationCaret
                // bindings on artifact-room-doc fragments listen on this instance, so
                // routing them through the root awareness would mis-attribute
                // cursors and lose the per-artifact-room presence channel.
                const entry = artifactRoomReplicas.get(artifactRoomId);
                if (entry === undefined) {
                  // Cold room: retain the frame rather than dropping it. Without
                  // this a collaborator already present in a room this client
                  // has never opened stays invisible until their next renewal.
                  recordColdArtifactRoomAwareness(
                    artifactRoomId,
                    awarenessBytes,
                  );
                  return;
                }
                applyAwarenessUpdate(
                  entry.awareness,
                  awarenessBytes,
                  BIN_AWARENESS_REMOTE_ORIGIN,
                );
                // A peer leaving can drop the presence pin that was holding this
                // room hot, so re-test it here rather than waiting for a doc
                // frame that may never come.
                scheduleArtifactRoomCooldown(artifactRoomId);
              },
              onArtifactRoomState: (artifactRoomId, nextState) => {
                if (disposed || generation !== streamGeneration) return;
                if (nextState !== "ready") {
                  // A artifactRoom transitioning out of `ready` invalidates the
                  // local replica - the next `artifactRoomSnapshot` will rebuild.
                  // The cold copy is invalidated with it; leases survive, so a
                  // mounted editor re-materializes from that next snapshot.
                  cancelArtifactRoomCooldown(artifactRoomId);
                  coldArtifactRooms.delete(artifactRoomId);
                  artifactRoomTouchSeq.delete(artifactRoomId);
                  destroyArtifactRoomReplica(artifactRoomId);
                }
                set((prev) => {
                  const current =
                    prev.artifactRooms.stateByArtifactRoomId[artifactRoomId];
                  if (current === nextState) return prev;
                  const stateByArtifactRoomId = {
                    ...prev.artifactRooms.stateByArtifactRoomId,
                    [artifactRoomId]: nextState,
                  };
                  const dirtyState = resolvePublicDirtyState(
                    prev.dirtyWatermarkStateVectorBase64,
                    prev.latestHostStateVectorBase64,
                  );
                  return {
                    bindingVersion:
                      nextState !== "ready"
                        ? prev.bindingVersion + 1
                        : prev.bindingVersion,
                    artifactRooms: { stateByArtifactRoomId },
                    ...dirtyState,
                  };
                });
              },
              onArtifactRoomDirty: (artifactRoomId, dirty) => {
                if (disposed || generation !== streamGeneration) return;
                set((prev) => {
                  const current =
                    prev.artifactRoomDirtyByArtifactRoomId[artifactRoomId] ??
                    false;
                  if (current === dirty) return prev;
                  return {
                    artifactRoomDirtyByArtifactRoomId: {
                      ...prev.artifactRoomDirtyByArtifactRoomId,
                      [artifactRoomId]: dirty,
                    },
                  };
                });
              },
              onRootDirty: (dirty) => {
                if (disposed || generation !== streamGeneration) return;
                set((prev) => {
                  if (prev.rootDirty === dirty) return prev;
                  // A delta does not establish that this subscription has seen
                  // every room. Only the atomic dirtySnapshot can make
                  // dirtiness known for sync-pill purposes.
                  return { rootDirty: dirty };
                });
              },
              onDirtySnapshot: (rootDirty, rooms) => {
                if (disposed || generation !== streamGeneration) return;
                const artifactRoomDirtyByArtifactRoomId: Record<
                  string,
                  boolean
                > = {};
                for (const room of rooms) {
                  artifactRoomDirtyByArtifactRoomId[room.artifactRoomId] =
                    room.dirty;
                }
                set({
                  rootDirty,
                  hasDirtySnapshotForOpenCycle: true,
                  artifactRoomDirtyByArtifactRoomId,
                });
              },
              onPermissionChanged: (permissionRole) => {
                if (disposed || generation !== streamGeneration) return;
                if (permissionRole === null) {
                  clearUnsyncedQueue();
                  clearAllPendingArtifactRoomUpdates();
                  replaceHostCoverageDoc(null);
                  currentRole = null;
                  set({
                    permissionRole: null,
                    accessLost: true,
                    unsyncedQueueSize: 0,
                    ...knownCleanDirtyState(),
                  });
                  return;
                }

                const previous = get().permissionRole;
                if (
                  previous !== null &&
                  previous !== "viewer" &&
                  permissionRole === "viewer"
                ) {
                  clearUnsyncedQueue();
                  clearAllPendingArtifactRoomUpdates();
                  currentRole = permissionRole;
                  set({
                    permissionRole,
                    unsyncedQueueSize: 0,
                  });
                  requestFreshSnapshotImpl?.();
                  return;
                }

                currentRole = permissionRole;
                set({ permissionRole });
              },
              onEpicDeleted: (attribution) => {
                if (disposed || generation !== streamGeneration) return;
                // Record the remote-delete signal + attribution. The app-level
                // access coordinator observes this and force-closes the tab
                // (redirecting an active tab to landing); no further local work
                // is needed here.
                set({ epicDeleted: attribution });
              },
              onMigrationStarted: () => {
                if (disposed || generation !== streamGeneration) return;
                // First tick of a migration. Snap the slice into the running
                // shape with placeholder counts so the modal can render the
                // Prepare row immediately - the host will follow up with a
                // `migrationProgress(prepare, 0, 1)` frame right away.
                set({
                  migration: {
                    status: "running",
                    phase: "prepare",
                    chunksDone: 0,
                    chunksTotal: 1,
                  },
                });
              },
              onMigrationProgress: (phase, chunksDone, chunksTotal) => {
                if (disposed || generation !== streamGeneration) return;
                set({
                  migration: {
                    status: "running",
                    phase,
                    chunksDone,
                    chunksTotal: chunksTotal > 0 ? chunksTotal : 1,
                  },
                });
              },
              onMigrationFailed: (reason) => {
                if (disposed || generation !== streamGeneration) return;
                // Host kept the WS alive so the modal's Retry button can fire
                // `retryMigration` in-stream. Log the `reason` so support can
                // diagnose failed migrations from a renderer console dump even
                // when the host log is unavailable; the modal copy itself is
                // fixed and never displays this string.
                appLogger.warn(
                  "[epic-migration] host reported migrationFailed",
                  {
                    epicId,
                    reason,
                  },
                );
                set({
                  migration: ERROR_MIGRATION_SLICE,
                });
              },
              onMigrationNotAllowed: () => {
                if (disposed || generation !== streamGeneration) return;
                // The epic needs a major migration this caller may not perform
                // (viewer / sub-editor). The host did not start one and there is
                // nothing to retry, so this is a distinct terminal state from
                // `error`: the modal shows a fixed "ask an owner/editor" message.
                set({
                  migration: NOT_ALLOWED_MIGRATION_SLICE,
                });
              },
              onCloudSyncStatus: (status) => {
                if (disposed || generation !== streamGeneration) return;
                const previousCloudSyncStatus = cloudSyncStatus;
                cloudSyncStatus = status;
                hasFreshCloudSyncStatus = true;
                if (
                  hasConnectedOnce &&
                  previousCloudSyncStatus !== "connected" &&
                  status === "connected"
                ) {
                  // Wake-recovery latency marker: the host<->cloud link is back
                  // online. Paired with the `[stream] reconnectAll` log, the gap
                  // between them is the measured time-to-online after wake (the
                  // gate the plan tracks on a real device). `warn` is the only
                  // info-ish console level this workspace's lint permits.
                  // `hasConnectedOnce` keeps this to genuine RE-connections (wake)
                  // - not the first connect or a `requestFreshSnapshot` re-open,
                  // which would pollute the trace.
                  appLogger.debug("[epic-stream] cloud sync connected", {
                    epicId,
                  });
                }
                // A genuine cloud "connected" frame is the ONLY thing that latches
                // "connected once" - never the optimistic default - so a new
                // room's pre-connect catch-up reads as the bootstrap "connecting"
                // while a drop AFTER a real connect reads as "reconnecting".
                if (status === "connected") hasConnectedOnce = true;
                syncCurrentConnectionStatus();
                set(connectionStateSlice());
                flushPendingWritesAfterReconnect(client);
              },
              onConnectionStatus: (status, reason) => {
                if (disposed || generation !== streamGeneration) return;
                const previousTransportStatus = transportStatus;
                transportStatus = status;
                const startedSubscriptionCycle =
                  previousTransportStatus !== "open" && status === "open";
                if (
                  hasConnectedOnce &&
                  previousTransportStatus !== "open" &&
                  status === "open"
                ) {
                  // Wake-recovery sub-marker: the renderer<->host stream
                  // re-subscribed, so the host has the live request context
                  // again. The gap from here to `[epic-stream] cloud sync
                  // connected` isolates the host<->cloud recovery latency.
                  // `warn` is the only info-ish console level lint permits here.
                  // Gated on `hasConnectedOnce` so it marks only RE-connections
                  // (wake), not the initial connect or a fresh-snapshot re-open.
                  appLogger.debug("[epic-stream] transport open", {
                    epicId,
                    contextRegistered: true,
                  });
                }
                const cycleDurabilityState = startedSubscriptionCycle
                  ? resetDurabilityProofForOpenCycle()
                  : null;
                const nextStatus = syncCurrentConnectionStatus();
                hasFreshRootSnapshotForOpenCycle = false;
                set(
                  cycleDurabilityState === null
                    ? connectionStateSlice()
                    : {
                        ...cycleDurabilityState,
                        ...connectionStateSlice(),
                      },
                );
                // Convert a fatal close into the modal's error state, but only
                // when a migration had actually started - a fatal close before
                // any `migrationStarted` is a normal connection error owned by
                // `snapshotFetchError`, not the migration modal. UNAUTHORIZED
                // also bypasses the modal so the auth/unavailable handlers
                // below can still recover the session; leaving the user pinned
                // on a migration-error modal after a token expiry would block
                // re-auth entirely.
                if (
                  isFatalMigrationClose(status, reason, get().migration.status)
                ) {
                  // Convert the fatal close into the modal's error state and
                  // return - letting control fall through would ALSO populate
                  // `snapshotFetchError` from the same fatalError, surfacing
                  // two redundant failure UIs (migration modal AND the snapshot
                  // empty-state) for one underlying cause. The migration
                  // modal's Retry/Close already covers recovery; Close routes
                  // the user away cleanly.
                  set({
                    migration: ERROR_MIGRATION_SLICE,
                  });
                  return;
                }
                if (isFatalClose(status, reason)) {
                  const { details } = reason;
                  if (isUnavailableFatal(details)) {
                    set({
                      snapshotFetchError: snapshotFetchErrorFrom(details),
                    });
                    return;
                  }
                  if (details.code === "UNAUTHORIZED") {
                    // The stream owns UNAUTHORIZED recovery now: it stays
                    // "reconnecting" and self-revalidates, so a terminal
                    // closed/UNAUTHORIZED means it GAVE UP - the credential was
                    // rejected (the stream's revalidator already signed out) or
                    // the host kept rejecting a still-valid bearer (reload
                    // required). Surface the error so the user isn't stranded on a
                    // silent "closed"; keep the revalidate as the sign-out
                    // cascade's net (single-flight, a no-op once already settled).
                    set({
                      snapshotFetchError: snapshotFetchErrorFrom(details),
                    });
                    options.onAuthError?.();
                    return;
                  }
                  set({ snapshotFetchError: snapshotFetchErrorFrom(details) });
                  return;
                }
                if (nextStatus !== "open") return;
                emitCurrentAwareness(awareness, doc, client);
              },
            },
            readSeedOffer,
          );
          streamClient = client;
        };

        requestFreshSnapshotImpl = () => {
          if (disposed) return;
          clearUnsyncedQueue();
          transportStatus = "connecting";
          cloudSyncStatus = "connected";
          const cycleDurabilityState = resetDurabilityProofForOpenCycle();
          // A fresh re-subscribe bootstraps from scratch, so the next connect is
          // "connecting", not "reconnecting": clear the latch and let only a
          // genuine cloud "connected" frame re-arm it.
          hasConnectedOnce = false;
          currentStatus = deriveConnectionStatus(
            transportStatus,
            cloudSyncStatus,
            hasConnectedOnce,
          );
          hasFreshRootSnapshotForOpenCycle = false;
          closeStreamClient();
          replaceReplica(api);
          replaceHostCoverageDoc(null);
          destroyAllArtifactRoomReplicas();
          set((state) => ({
            doc,
            awareness,
            bindingVersion: state.bindingVersion + 1,
            ...connectionStateSlice(),
            snapshotLoaded: false,
            snapshotFetchError: null,
            unsyncedQueueSize: 0,
            artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
            // Reset eagerly for an explicit rebuild. Automatic reconnects
            // repeat this reset at their next `open` transition.
            ...cycleDurabilityState,
            // Re-subscribing is the moment the migration story restarts -
            // the host will re-emit `migrationStarted` if the new
            // subscription still hits the migration path.
            migration: IDLE_MIGRATION_SLICE,
            ...knownCleanDirtyState(),
          }));
          openStreamClient();
        };

        openStreamClient();

        // ── Mutation actions: delegate to local helpers, all wrapped in
        //    `doc.transact(..., LOCAL_ORIGIN)` so the projector observeDeep
        //    fires once per logical mutation and `handleDocUpdate` routes
        //    the resulting update bytes through `applyLocalUpdate`.

        /**
         * Republish the projection so a change to the pending overlay is
         * visible. The doc has not moved, so this is a pure re-projection -
         * the same call the chat-record channel makes when new rows land.
         */
        const republishForOverlay = (): void => {
          if (!projector.isAttached()) return;
          set(projector.projectFull());
        };

        /**
         * Arm (or re-arm) the bounded landed-entry expiry. See the landed arm
         * of {@link retirePendingMutation} for why landed entries expire at
         * all; the CHAIN-SCOPED half lives here, in two rules.
         *
         * While any member of the entry's chain is still un-settled, the
         * timer re-arms: an INTERIOR landed entry is a causal anchor for
         * every later pending member (`resolvePendingChain` anchors a
         * pending chain on baseline plus every landed target), so expiring
         * it would strip the anchor set and the next projection would read
         * the landed value's own echo as off-anchor supersession -
         * terminally killing a chain whose RPC is alive and retryable.
         *
         * Once the whole chain is landed, expiry is owned by the chain's
         * TAIL - the last-STAMPED member, whose target is what the
         * all-landed chain displays - and the tail deletes the ENTIRE chain
         * atomically. Per-entry deletion is wrong here: ACKs settle out of
         * order, so a later-stamped member's timer can fire before an
         * earlier one's, and deleting just that member would re-expose the
         * previous landed target - the display walking BACKWARD through the
         * chain's history as timers fire. A non-tail timer re-arms instead;
         * if the tail is ever retired away (a failed RPC), the next re-armed
         * timer to find itself the tail takes over, at most one TTL later.
         * A sibling's failure or landing never needs to reschedule anything
         * for the same reason.
         */
        const scheduleLandedExpiry = (requestId: string): void => {
          window.setTimeout(() => {
            if (disposed) return;
            const entry = pendingMetadataMutations.get(requestId);
            if (entry === undefined) return;
            const nodeId = entry.kind === "epic-title" ? null : entry.nodeId;
            const chainRequestIds: string[] = [];
            let chainHasUnsettled = false;
            for (const [id, other] of pendingMetadataMutations) {
              if (other.kind !== entry.kind) continue;
              const otherId = other.kind === "epic-title" ? null : other.nodeId;
              if (otherId !== nodeId) continue;
              chainRequestIds.push(id);
              if (!other.landed) chainHasUnsettled = true;
            }
            const isTail =
              chainRequestIds[chainRequestIds.length - 1] === requestId;
            if (chainHasUnsettled || !isTail) {
              scheduleLandedExpiry(requestId);
              return;
            }
            for (const id of chainRequestIds) {
              pendingMetadataMutations.delete(id);
              registryBackedRequestIds.delete(id);
            }
            republishForOverlay();
          }, LANDED_MUTATION_TTL_MS);
        };

        /**
         * Report a mutation's RPC outcome.
         *
         * `"failed"` is the simple half: the patch is layered over the
         * authoritative value, so deleting the entry reveals whatever the
         * host actually has. Nothing is written back - see the module doc on
         * `pending-metadata-overlay.ts`, and do not reintroduce a restore
         * path. Only TERMINAL failures; a retryable transport error must
         * leave the row pending, or the title flaps for the length of the
         * retry.
         *
         * `"landed"` does NOT delete: the ack is causal proof the host holds
         * this value, which the row-wins rule needs to tell our own echo from
         * a peer's write, and which keeps the display honest while the record
         * slice is still stale (deleting here would snap a successful rename
         * back to the old title until the refetch landed). The projection's
         * dead sweep (`collectDeadPendingMutations`) forgets the entry once
         * the row catches up or a peer overwrites it.
         */
        const retirePendingMutation = (
          requestId: string,
          outcome: "landed" | "failed",
        ): boolean => {
          const entry = pendingMetadataMutations.get(requestId);
          if (entry === undefined) return false;
          // A landed outcome is only worth KEEPING while the projector can
          // still observe the echo that sweeps it. Detached (a retained
          // buffer), the display is frozen and no projection will ever run
          // again - a kept entry would just sit in the map for the handle's
          // life, so delete on both outcomes there.
          if (outcome === "failed" || !projector.isAttached()) {
            pendingMetadataMutations.delete(requestId);
            registryBackedRequestIds.delete(requestId);
          } else {
            pendingMetadataMutations.set(requestId, {
              ...entry,
              landed: true,
            });
            // The bounded half of the landed contract. The ack proves the host
            // HELD this value, but value equality is the only reconciliation
            // the sweep has, and it cannot tell "the slice has not caught up
            // to our write yet" from "a peer moved the row BACK to the
            // baseline value after our write" - both read as authoritative ===
            // baseline. Unbounded, the wrong guess hides the peer's write for
            // the rest of the session. So a landed entry outranks a
            // baseline-valued row only while our own echo could still
            // plausibly be in flight - one full record-poll interval (20s)
            // plus refetch slack - and past that the row wins. If the slice
            // was merely stale (a run of failed polls), the brief regression
            // is honest and the next successful poll re-serves our value
            // anyway. Expiry is CHAIN-SCOPED (see `scheduleLandedExpiry`):
            // while a later sibling is still in flight this entry is that
            // sibling's causal anchor, not just a display bridge, and the
            // timer re-arms instead of deleting; an all-landed chain is
            // expired atomically by its TAIL, so out-of-order ACKs cannot
            // walk the display backward through the chain's history.
            scheduleLandedExpiry(requestId);
          }
          republishForOverlay();
          return true;
        };

        const stampPendingMutation = (
          mutation: PendingMetadataMutation,
        ): string => {
          pendingMetadataMutations.set(mutation.requestId, mutation);
          // Provenance is captured while the record row exists - a node the
          // record plane serves right now marks its chain registry-backed
          // for the dead sweep's plane-aware gate, stickily.
          markRegistryBackedMutations();
          republishForOverlay();
          return mutation.requestId;
        };

        const renameArtifactAction = (
          artifactId: string,
          nextTitle: string,
        ): boolean => {
          const trimmed = nextTitle.trim();
          if (trimmed.length === 0) return false;
          if (disposed) return false;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return false;
          let mutated = false;
          doc.transact(() => {
            const artifact = getArtifactEntry(doc, artifactId);
            if (artifact !== null) {
              if (artifact.get("title") === trimmed) return;
              artifact.set("title", trimmed);
              artifact.set("updatedAt", Date.now());
              mutated = true;
              return;
            }
            const chat = getChatEntry(doc, artifactId);
            if (chat !== null) {
              if (chat.get("title") === trimmed) return;
              chat.set("title", trimmed);
              chat.set("updatedAt", Date.now());
              mutated = true;
              return;
            }
            const agent = getTerminalAgentEntry(doc, artifactId);
            if (agent !== null) {
              if (agent.get("title") === trimmed) return;
              agent.set("title", trimmed);
              agent.set("updatedAt", Date.now());
              mutated = true;
            }
          }, LOCAL_ORIGIN);
          return mutated;
        };

        const pickParentId = (
          results: ReadonlyArray<{
            readonly removed: boolean;
            readonly parentId: string | null;
          }>,
        ): string | null => {
          for (const r of results) {
            if (r.removed) return r.parentId;
          }
          return null;
        };

        const deleteFromMap = (
          map: Y.Map<unknown> | null,
          id: string,
        ): { readonly removed: boolean; readonly parentId: string | null } => {
          if (map === null) return { removed: false, parentId: null };
          const entry = map.get(id);
          if (!(entry instanceof Y.Map))
            return { removed: false, parentId: null };
          const pid = (entry as Y.Map<unknown>).get("parentId");
          map.delete(id);
          return {
            removed: true,
            parentId: typeof pid === "string" ? pid : null,
          };
        };

        const readTicketStatus = (entry: Y.Map<unknown>): 0 | 1 | 2 => {
          const value = entry.get("status");
          if (value === 1) return 1;
          if (value === 2) return 2;
          return 0;
        };

        // Record a `deletedArtifacts` tombstone for an artifact we're about to
        // remove optimistically. The host's `epic.deleteArtifact` RPC usually
        // runs AFTER this optimistic delete has already synced in and removed
        // the live entry - taking its `kind` with it - so without the tombstone
        // the host can no longer drive cloud-delete sync and the
        // spec/ticket/review row orphans in the cloud DB. Mirrors the tombstone
        // the host writes in EpicArtifactStorage.delete(); recovered there by
        // id. No-op for ids that aren't artifacts (chats/terminal agents).
        const writeDeletedArtifactTombstone = (
          artifactsMap: Y.Map<unknown>,
          artifactId: string,
        ): void => {
          const entry = artifactsMap.get(artifactId);
          if (!(entry instanceof Y.Map)) return;
          const kind = readArtifactKind(entry);
          if (kind === null) return;
          const deletedArtifactsMap = getDeletedArtifactsMap(doc);
          if (deletedArtifactsMap === null) return;
          const title = readMaybeString(entry, "title");
          const artifactRoomId = readMaybeString(entry, "artifactRoomId");
          const deletedAt = new Date().toISOString();
          const base = {
            id: artifactId,
            title,
            artifactRoomId: artifactRoomId.length > 0 ? artifactRoomId : null,
            deletedAt,
          };
          const tombstone: DeletedEpicArtifact =
            kind === "ticket" || kind === "story"
              ? {
                  kind,
                  ...base,
                  status: readTicketStatus(entry),
                }
              : { kind, ...base };
          deletedArtifactsMap.set(artifactId, createTypedMap(tombstone));
        };

        const deleteArtifactAction = (artifactId: string): boolean => {
          if (disposed) return false;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return false;
          let mutated = false;
          doc.transact(() => {
            const artifactsMap = getArtifactsMap(doc);
            const chatsMap = getChatsMap(doc);
            const terminalAgentsMap = getTerminalAgentsMap(doc);
            // Capture the tombstone before the removal below takes the entry's
            // `kind` with it, so the host can still cloud-delete the row.
            if (artifactsMap !== null) {
              writeDeletedArtifactTombstone(artifactsMap, artifactId);
            }
            const fromArtifacts = deleteFromMap(artifactsMap, artifactId);
            const fromChats = fromArtifacts.removed
              ? { removed: false, parentId: null }
              : deleteFromMap(chatsMap, artifactId);
            const fromAgents =
              fromArtifacts.removed || fromChats.removed
                ? { removed: false, parentId: null }
                : deleteFromMap(terminalAgentsMap, artifactId);
            const removed =
              fromArtifacts.removed || fromChats.removed || fromAgents.removed;
            if (!removed) return;
            mutated = true;
            const targetParentId = pickParentId([
              fromArtifacts,
              fromChats,
              fromAgents,
            ]);
            // Re-parent direct children onto the deleted node's parent so the
            // subtree doesn't get orphaned.
            const reparent = (map: Y.Map<unknown>) => {
              for (const [, entry] of map.entries()) {
                if (!(entry instanceof Y.Map)) continue;
                const child = entry as Y.Map<unknown>;
                if (child.get("parentId") !== artifactId) continue;
                child.set("parentId", targetParentId);
              }
            };
            // Artifact descendants must keep their parent links during the
            // optimistic window. If the host receives this local removal
            // before the `epic.deleteArtifact` RPC runs, subtree deletion still
            // discovers descendants by scanning `parentId`.
            if (!fromArtifacts.removed && artifactsMap !== null) {
              reparent(artifactsMap);
            }
            if (chatsMap !== null) reparent(chatsMap);
            if (terminalAgentsMap !== null) reparent(terminalAgentsMap);
          }, LOCAL_ORIGIN);
          return mutated;
        };

        const reparentArtifactAction = (
          artifactId: string,
          newParentId: string | null,
        ): boolean => {
          if (disposed) return false;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return false;
          // VALIDATE AGAINST THE PROJECTION, WRITE TO THE DOC. The two are no
          // longer the same surface and have not been since chats-off-YJS: a
          // registry-backed chat or terminal agent has NO doc entry, so the
          // doc evaluator answers `missing-node` for a row the user is plainly
          // dragging. That is not a hypothetical - it rejected every drop onto
          // a record-backed parent, and the rejection THREW, which is how one
          // ordinary drag came to wedge the whole DnD session (4.3a).
          //
          // The projected tree is the union the sidebar renders, so it is the
          // only surface that can judge a drop for every node the user can
          // grab. Cycle detection improves for free: the walk now crosses the
          // doc and record arms, which the doc-only walk could not see.
          //
          // Read before the transaction, deliberately. `get().tree` is
          // projector output, and the projector runs on the doc observer -
          // reading it INSIDE `doc.transact` would still return the pre-write
          // projection, but only by accident of when observers fire. Reading
          // it here says what we mean, and nothing can mutate between these
          // two synchronous statements.
          const evaluation = evaluateProjectedReparent(
            get().tree,
            artifactId,
            newParentId,
          );
          if (!evaluation.ok) {
            if (evaluation.reason === "same-parent") return false; // no-op
            throw projectedReparentRejectionError(
              get().tree,
              evaluation.reason,
              artifactId,
              newParentId,
            );
          }
          // The projection said yes; now find something to write to. A node
          // with no doc entry is registry-backed, and its parent pointer lives
          // on the host record - `epic.reparentChat` owns that move, and the
          // caller routes it there instead. Returning false rather than
          // throwing is the honest answer: nothing is wrong, there is simply
          // no local write to make.
          const target = resolveReparentNode(doc, artifactId);
          if (target === null) return false;
          let mutated = false;
          doc.transact(() => {
            target.entry.set("parentId", newParentId);
            target.entry.set("updatedAt", Date.now());
            mutated = true;
          }, LOCAL_ORIGIN);
          return mutated;
        };

        const setEpicTitleAction = (nextTitle: string): boolean => {
          if (disposed) return false;
          const trimmed = nextTitle.trim();
          if (trimmed.length === 0) return false;
          let mutated = false;
          doc.transact(() => {
            const epic = getEpicMap(doc);
            if (epic.get("title") === trimmed) return;
            epic.set("title", trimmed);
            mutated = true;
          }, LOCAL_ORIGIN);
          return mutated;
        };

        /**
         * The AUTHORITATIVE value a new mutation should record as its
         * baseline.
         *
         * `get()` returns the OVERLAID projection - the projector folds the
         * overlay in - so the currently displayed value is not authoritative
         * whenever something is already in flight for this node. When a chain
         * exists, its first element already captured the authoritative value
         * and the host has not moved (if it had, that chain would have been
         * dropped at projection time), so reusing that baseline is both
         * correct and the only reading available here. With no chain, nothing
         * is overlaid and the projected value IS authoritative.
         */
        const baselineFor = (
          kind: PendingMetadataMutation["kind"],
          nodeId: string | null,
          projected: string | null,
        ): string | null => {
          for (const mutation of pendingMetadataMutations.values()) {
            if (mutation.kind !== kind) continue;
            const id = mutation.kind === "epic-title" ? null : mutation.nodeId;
            if (id !== nodeId) continue;
            return mutation.baseline;
          }
          return projected;
        };

        /**
         * Stamp an optimistic rename and return its request id. The caller
         * fires the RPC and retires the id when it settles or terminally
         * fails.
         *
         * Covers every plane: an artifact, a doc-backed chat, and a
         * REGISTRY-backed chat or terminal agent, which is the case desktop
         * silently lost when chats moved off YJS - `renameArtifact`'s doc
         * write no-ops for those rows, so until now they had no optimistic
         * feedback on any viewport.
         */
        const beginRenameMutation = (
          nodeId: string,
          nextTitle: string,
        ): string | null => {
          if (disposed) return null;
          const trimmed = nextTitle.trim();
          if (trimmed.length === 0) return null;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return null;
          // The RAW union row, never the tree node: tree titles already
          // carry the "Untitled ..." display fallback, so a baseline read
          // there lives in a different value space than the row title the
          // applier compares against - an untitled row's rename would anchor
          // on the fallback string and never apply. Same lookup rule as
          // `beginReparentMutation` and the dead sweep.
          const slices = get();
          let displayed: string | null = null;
          for (const byId of [
            slices.artifacts.byId,
            slices.chats.byId,
            slices.tuiAgents.byId,
          ]) {
            if (!Object.hasOwn(byId, nodeId)) continue;
            displayed = byId[nodeId].title;
            break;
          }
          if (displayed === null) return null;
          // No-op against what the user SEES (the overlaid title), never the
          // chain baseline. With a landed rename awaiting its echo, "rename
          // back to the original" differs from the display and must become a
          // real chain entry - a baseline compare would return null here
          // while the caller's RPC fires anyway, leaving the UI stuck on the
          // landed value until a full row round-trip.
          if (displayed === trimmed) return null;
          const baseline = baselineFor("rename", nodeId, displayed);
          if (baseline === null) return null;
          const requestId = stampPendingMutation({
            kind: "rename",
            requestId: crypto.randomUUID(),
            nodeId,
            title: trimmed,
            baseline,
            landed: false,
          });
          // The stamp TOMBSTONE outlives the chain - see
          // {@link OpenEpicState.isLatestRenameStamp} for why the snapshot
          // guard cannot read chain membership.
          latestRenameStampByNode.set(nodeId, requestId);
          return requestId;
        };

        /** Stamp an optimistic epic-title change. See {@link beginRenameMutation}. */
        const beginEpicTitleMutation = (nextTitle: string): string | null => {
          if (disposed) return null;
          const trimmed = nextTitle.trim();
          if (trimmed.length === 0) return null;
          // `epic.title` is the OVERLAID (displayed) value; the no-op check
          // runs against it for the same rename-back-to-baseline reason as
          // `beginRenameMutation`. `baselineFor` then anchors a chained entry
          // on the original authoritative value.
          const displayed = get().epic.title;
          if (displayed === trimmed) return null;
          const baseline = baselineFor("epic-title", null, displayed);
          if (baseline === null) return null;
          return stampPendingMutation({
            kind: "epic-title",
            requestId: crypto.randomUUID(),
            title: trimmed,
            baseline,
            landed: false,
          });
        };

        /**
         * Stamp an optimistic reparent. Validated against the projected tree,
         * exactly as the write path is (4.3) - one evaluator, one tree, so the
         * overlay can never accept a move the commit would refuse.
         */
        const beginReparentMutation = (
          nodeId: string,
          newParentId: string | null,
        ): string | null => {
          if (disposed) return null;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return null;
          const evaluation = evaluateProjectedReparent(
            get().tree,
            nodeId,
            newParentId,
          );
          if (!evaluation.ok) return null;
          // Baseline from the union ROW's raw `parentId`, NOT the tree
          // node's. The tree promotes a dangling raw parent to root, so the
          // effective parent can be `null` while the row still carries the
          // deleted id - and the applier compares the ROW. A baseline read
          // from the tree would then look like "the authoritative value
          // moved" and refuse the very patch that was just validated. Same
          // lookup rule as `collectDeadPendingMutations`' authoritative read.
          const slices = get();
          let rawParent: { found: boolean; value: string | null } = {
            found: false,
            value: null,
          };
          for (const byId of [
            slices.artifacts.byId,
            slices.chats.byId,
            slices.tuiAgents.byId,
          ]) {
            if (!Object.hasOwn(byId, nodeId)) continue;
            rawParent = { found: true, value: byId[nodeId].parentId };
            break;
          }
          if (!rawParent.found) return null;
          return stampPendingMutation({
            kind: "reparent",
            requestId: crypto.randomUUID(),
            nodeId,
            parentId: newParentId,
            baseline: baselineFor("reparent", nodeId, rawParent.value),
            landed: false,
          });
        };

        /**
         * See the {@link OpenEpicState.isLatestRenameStamp} contract - a
         * tombstone read, NOT a chain walk. The chain answer shipped first
         * and was wrong: the fast-echo race (authoritative row catches up
         * before the RPC settles) sweeps the chain, and the success arm then
         * found "not latest" for a rename that succeeded, skipping its only
         * persisted-tab write.
         */
        const isLatestRenameStamp = (
          nodeId: string,
          requestId: string,
        ): boolean => latestRenameStampByNode.get(nodeId) === requestId;

        return {
          epicId,
          doc,
          awareness,
          bindingVersion: 0,
          ...EMPTY_PROJECTED_SLICES,
          chatRecords: EMPTY_CHATS_SLICE,
          chatRecordListAuthoritative: false,
          chatRetractions: EMPTY_CHAT_RETRACTIONS,
          tuiAgentRecords: EMPTY_TERMINAL_AGENTS_SLICE,
          // The same shared "nothing retracted" identity as the chats': one
          // frozen empty object serves both, so neither table's quiet state
          // ever hands subscribers a fresh reference.
          tuiAgentRetractions: EMPTY_CHAT_RETRACTIONS,
          artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
          artifactRoomDirtyByArtifactRoomId: EMPTY_ARTIFACT_ROOM_DIRTY,
          rootDirty: null,
          hasDirtySnapshotForOpenCycle: false,
          snapshotMeta: null,
          permissionRole: null,
          // Through the helper like every other site, per the invariant above.
          // Restating the five fields by hand agreed with the bootstrap locals
          // only by coincidence, and this is the one place that could drift
          // from them silently - the initial value of `cloudSyncStatus` in
          // particular is load-bearing, since `deriveConnectionStatus` blends
          // it into the `connectionStatus` that gates the chat handoff.
          ...connectionStateSlice(),
          accessLost: false,
          epicDeleted: null,
          snapshotLoaded: false,
          snapshotFetchError: null,
          migration: IDLE_MIGRATION_SLICE,
          ...knownCleanDirtyState(),
          unsyncedQueueSize: 0,
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

          applyLocalUpdate: (updateBytes) => {
            if (disposed) return;
            const role = currentRole ?? get().permissionRole;
            if (role === "viewer" || role === null) return;
            // Gate on the renderer↔host transport, NOT the combined visible
            // status. When the host's cloud link drops the pill shows
            // "reconnecting" but the LOCAL transport stays open, and edits must
            // keep flowing to the host: it durably persists them (SQLite
            // pending-update store) while offline and replays them on restart.
            // Queuing here instead strands them in memory and loses them on
            // restart - the pending-update-replay regression this guards.
            if (transportStatus === "open") {
              streamClient?.applyUpdate(updateBytes);
              return;
            }
            pushUnsyncedUpdate(updateBytes);
            set({ unsyncedQueueSize: unsyncedOps });
          },

          sendAwareness: (awarenessBytes) => {
            if (disposed) return;
            if (transportStatus !== "open") return;
            streamClient?.awareness(awarenessBytes);
          },

          discardUnsyncedEdits: () => {
            if (unsyncedQueue.length === 0 && !get().isDirty) return;
            clearUnsyncedQueue();
            clearAllPendingArtifactRoomUpdates();
            set({
              unsyncedQueueSize: 0,
              ...resolvePublicDirtyState(
                null,
                get().latestHostStateVectorBase64,
              ),
            });
          },

          requestFreshSnapshot: () => {
            requestFreshSnapshotImpl?.();
          },

          retryMigration: () => {
            if (disposed) return;
            // Nothing to retry until at least one migration has surfaced on
            // this session. Modal-only paths gate the button on
            // `migration.status === "error"`, but this guard keeps the
            // store contract honest if a stray call slips through.
            if (get().migration.status !== "error") return;
            // If the underlying WS session is no longer open (e.g., the
            // migration error came from a `onConnectionStatus(closed,
            // fatalError)` transition rather than a `migrationFailed` server
            // frame), an in-stream `retryMigration` would be sent to a dead
            // session and silently dropped by `ws-stream-client` -
            // permanently trapping the user on the Prepare step with no
            // recovery. Fall back to a full session reopen instead;
            // `requestFreshSnapshotImpl` resets migration to idle then opens
            // a fresh client, and the host re-runs migration if needed,
            // emitting a fresh `migrationStarted` that snaps the slice back
            // to running. Re-apply the optimistic running flip AFTER the
            // reopen so the modal doesn't briefly flash to idle (which
            // would unmount it) before the host's first progress frame.
            const reopen = transportStatus !== "open";
            if (reopen) {
              requestFreshSnapshotImpl?.();
            }
            set({
              migration: {
                status: "running",
                phase: "prepare",
                chunksDone: 0,
                chunksTotal: 1,
              },
            });
            if (!reopen) {
              streamClient?.retryMigration();
            }
          },

          applyChatRecords: (records, issuedAtSeq) => {
            if (disposed) return;
            const served = new Map<string, ChatRecordSummary>();
            for (const row of records) {
              // A retracted chat never comes back through the poll. The list
              // read is a SNAPSHOT of the host's SQLite and the host applies a
              // removal before it emits one, so a response that still carries
              // the row was necessarily issued before the retraction - letting
              // it through would resurrect a chat seconds after its tab said it
              // was gone. See `OpenEpicState.chatRetractions`.
              if (chatRetractions.has(row.chatId)) continue;
              served.set(recordKey(row.ownerUserId, row.chatId), row);
            }
            // Omissions first, against the fence - see `chatRowSeq`. A row
            // this answer does not carry is dropped only if it was already
            // held when the answer was ISSUED; anything ingested since then (a
            // push delta, a faster later answer) is newer than this snapshot
            // by construction and survives it.
            const fence = issuedAtSeq ?? chatSnapshotFence;
            for (const key of [...chatRecordRows.keys()]) {
              if (served.has(key)) continue;
              if ((chatRowSeq.get(key) ?? 0) > fence) continue;
              chatRecordRows.delete(key);
              chatRowSeq.delete(key);
            }
            for (const [key, row] of served) {
              // The record for a creation this client is holding open has
              // arrived: the stand-in has served its purpose and the served
              // row takes over. Runs for EVERY served row - stale-rejected
              // ones included, since even an old version proves the record
              // exists - which is what lets a later answer retire a stand-in
              // registered while the row was already held.
              expirePendingChatCreationForRecord(row.ownerUserId, row.chatId);
              const held = chatRecordRows.get(key);
              // The same monotonic-`revision` test the delta path applies, in
              // the same direction: a snapshot row that does not strictly
              // exceed what is held is an older version of that row, and
              // overwriting with it would regress a push the client has
              // already shown - and, through the optimistic overlay's
              // supersession rule, terminally kill a healthy pending chain
              // over a read that was merely slow. (No doc-resident carve-out
              // here, unlike the terminal-agent twin: chat records are
              // registry-only, so every row carries a real revision.)
              if (held !== undefined && row.revision <= held.revision) continue;
              chatRecordRows.set(key, row);
              chatIngestSeq += 1;
              chatRowSeq.set(key, chatIngestSeq);
            }
            chatSnapshotFence = chatIngestSeq;
            publishChatRecords(null);
          },

          peekChatIngestSeq: () => chatIngestSeq,

          ingestFenceIdentity: mintedIngestFenceIdentity,

          markChatRecordListAuthoritative: () => {
            if (disposed || get().chatRecordListAuthoritative) return;
            set({ chatRecordListAuthoritative: true });
          },

          applyChatRecordDelta: (delta) => {
            if (disposed) return;
            if (delta.kind === "remove") {
              // Every retained row with this id, because the frame carries no
              // owner to narrow by - see `chatRetractions` for why that is
              // bounded rather than wrong.
              const doomed = Array.from(chatRecordRows.entries())
                .filter(([, row]) => row.chatId === delta.chatId)
                .map(([key]) => key);
              // A retraction outranks a creation this client is still holding
              // open: removal is terminal and absorbing, and an optimistic row
              // is the weakest claim there is. Id-coarse like the frame itself
              // and like `chatRetractions`, since a `remove` names no owner.
              // Dropped BEFORE the idempotence test so a redelivered removal
              // that is the first one to race a registration still retires it.
              const hadPending = dropPendingChatCreationsForChat(delta.chatId);
              // Idempotent: a redelivered removal for the same reason is not a
              // state change, and re-publishing on it would re-project the epic
              // for nothing.
              if (
                chatRetractions.get(delta.chatId) === delta.reason &&
                doomed.length === 0 &&
                !hadPending
              ) {
                return;
              }
              chatRetractions.set(delta.chatId, delta.reason);
              for (const key of doomed) {
                chatRecordRows.delete(key);
                chatRowSeq.delete(key);
              }
              publishChatRecords({
                chatRetractions: Object.fromEntries(chatRetractions),
              });
              return;
            }
            const { record } = delta;
            // Removal is TERMINAL AND ABSORBING - the one lifecycle rule in
            // this design - so no later upsert resurrects the row here.
            if (chatRetractions.has(record.chatId)) return;
            const key = recordKey(record.ownerUserId, record.chatId);
            const held = chatRecordRows.get(key);
            // The staleness test, and the only ordering fact on a row:
            // `revision` is per-chat monotonic, so a delta that does not
            // strictly exceed what is held is a replay, a reorder or a
            // duplicate. Dropping it is what makes those harmless with no merge
            // logic anywhere. NOT a timestamp comparison - host clocks skew and
            // `updatedAt` is display metadata no ordering decision may read.
            if (held !== undefined && record.revision <= held.revision) return;
            chatRecordRows.set(key, record);
            // Past the fence the last snapshot left: an `epic.listChatRecords`
            // answer already in flight cannot carry this row's new version, so
            // its omission - or its stale copy, via the revision test above -
            // must not defeat it. See `chatRowSeq`.
            chatIngestSeq += 1;
            chatRowSeq.set(key, chatIngestSeq);
            // Same handover as the poll's, on the same full identity: whichever
            // path delivers the real row first retires the stand-in, so the row
            // never blinks out between the two.
            expirePendingChatCreationForRecord(
              record.ownerUserId,
              record.chatId,
            );
            publishChatRecords(null);
          },

          peekTuiAgentIngestSeq: () => tuiAgentIngestSeq,

          applyTuiAgentRecords: (records, issuedAtSeq) => {
            if (disposed) return;
            const served = new Map<string, TuiAgentRecordSummaryV11>();
            for (const row of records) {
              // A retracted agent never comes back through the poll: the list
              // read is a snapshot of the host's registry and the host applies
              // a removal before it emits one, so a response still carrying
              // the row was issued before the retraction. See
              // `OpenEpicState.tuiAgentRetractions`.
              if (tuiAgentRetractions.has(row.tuiAgentId)) continue;
              served.set(row.tuiAgentId, row);
            }
            // Omissions first, against the fence - see `tuiAgentRowSeq`. A
            // row this answer does not carry is dropped only if it was already
            // held when the answer was ISSUED; anything ingested since then is
            // newer than the snapshot by construction and survives it. The
            // request-time counter is the exact fence; the previous answer's
            // watermark is the fallback when none was captured.
            const fence = issuedAtSeq ?? tuiAgentSnapshotFence;
            for (const id of [...tuiAgentRecordRows.keys()]) {
              if (served.has(id)) continue;
              if ((tuiAgentRowSeq.get(id) ?? 0) > fence) continue;
              tuiAgentRecordRows.delete(id);
              tuiAgentRowSeq.delete(id);
            }
            for (const [id, row] of served) {
              const held = tuiAgentRecordRows.get(id);
              // The same monotonic-`revision` test the delta path applies, for
              // the same reason and in the same direction: a snapshot row that
              // does not strictly exceed what is held is an older version of
              // that row, and overwriting with it would regress a push the
              // client has already shown.
              //
              // EXCEPT doc-resident over doc-resident, which the test cannot
              // judge. A doc row has no registry seq to carry, so it ships at
              // `revision: 0` on EVERY answer - `0 <= 0` would reject each
              // refresh and freeze that agent at whatever the first answer of
              // the session said, for the life of the session. Under `@2` that
              // row is its only source, so the freeze hides a peer-host rename,
              // reparent and archive alike.
              //
              // Narrow, and in one direction only. The guard still applies the
              // moment either side is registry-backed: a doc row at 0 can never
              // clobber an adopted registry row (`0 <= n`), and an adopted row
              // still replaces the frozen copy (`n <= 0` is false). What is
              // waived is only the comparison between two rows that both carry
              // a placeholder, where the later answer is newer by construction
              // because it is a fresher read of the same map.
              if (held !== undefined) {
                const bothDocResident = held.docResident && row.docResident;
                if (!bothDocResident && row.revision <= held.revision) continue;
              }
              tuiAgentRecordRows.set(id, row);
              tuiAgentIngestSeq += 1;
              tuiAgentRowSeq.set(id, tuiAgentIngestSeq);
            }
            tuiAgentSnapshotFence = tuiAgentIngestSeq;
            publishTuiAgentRecords(null);
          },

          applyTuiAgentRecordDelta: (delta) => {
            if (disposed) return;
            if (delta.kind === "tuiRemove") {
              const hadRow = tuiAgentRecordRows.delete(delta.tuiAgentId);
              tuiAgentRowSeq.delete(delta.tuiAgentId);
              // Idempotent: a redelivered removal for the same reason is not a
              // state change, and re-publishing on it would re-project the
              // epic for nothing.
              if (
                tuiAgentRetractions.get(delta.tuiAgentId) === delta.reason &&
                !hadRow
              ) {
                return;
              }
              tuiAgentRetractions.set(delta.tuiAgentId, delta.reason);
              // The retraction map bypasses the change gate for the same
              // reason the chats' does: a removal that changes no slice (a row
              // this session never held) still has to reach an open tab that
              // is rendering the agent.
              publishTuiAgentRecords({
                tuiAgentRetractions: Object.fromEntries(tuiAgentRetractions),
              });
              return;
            }
            const { record } = delta;
            // Removal is TERMINAL AND ABSORBING - no later upsert resurrects
            // the row here.
            if (tuiAgentRetractions.has(record.tuiAgentId)) return;
            const held = tuiAgentRecordRows.get(record.tuiAgentId);
            // The staleness test: `revision` is per-record monotonic and the
            // only ordering fact on a row, so a delta that does not strictly
            // exceed what is held is a replay, a reorder or a duplicate.
            if (held !== undefined && record.revision <= held.revision) return;
            // The delta plane is REGISTRY-ONLY by construction - a doc-resident
            // agent has no registry row, so it can never produce a delta. So
            // `false` here is a fact about the source, not a filled-in default.
            //
            // It is also what makes ADOPTION converge through the staleness
            // test above: `epic.listTuiAgents@1.1` serves a frozen doc row at
            // `revision: 0`, so the first real delta after that agent's binding
            // host upgrades and the sweep imports it strictly exceeds 0 and
            // replaces the frozen copy in place.
            tuiAgentRecordRows.set(record.tuiAgentId, {
              ...record,
              docResident: false,
            });
            // Past the fence the last snapshot left: an `epic.listTuiAgents`
            // answer already in flight cannot carry this row, so its omission
            // must not delete it. See `tuiAgentRowSeq`.
            tuiAgentIngestSeq += 1;
            tuiAgentRowSeq.set(record.tuiAgentId, tuiAgentIngestSeq);
            publishTuiAgentRecords(null);
          },

          republishChatRecordsForCurrentUser: () => {
            if (disposed) return;
            publishChatRecords(null);
            publishTuiAgentRecords(null);
          },

          beginPendingChatCreation: (pending) => {
            if (disposed) return;
            // A chat this session has already seen retracted cannot be created
            // back into view - the same absorbing rule the record paths apply.
            if (chatRetractions.has(pending.chatId)) return;
            // No signed-in user means no identity to retain this under, and an
            // unattributed stand-in is worse than none: it could be retired by a
            // stranger's same-id row, or rendered to whoever signs in next. The
            // chat still surfaces when its own record arrives - i.e. exactly the
            // behavior that existed before this registry.
            //
            // Taken from the CALLER, who captured it when the request left,
            // rather than read live here. This runs when the host answers, and a
            // profile change while the create was in flight would otherwise file
            // a chat authorized as user A under user B - visible to B, and
            // unretirable by A's real record when it arrives under its actual
            // owner. See `CreateChatMutationContext.ownerUserId`.
            const ownerUserId = pending.ownerUserId;
            if (ownerUserId === null) return;
            // NOT gated on whether a served row for this chat is already held.
            // It can be - the owning host pushes its record the moment it
            // commits, so a delta can beat the create's own answer - and
            // retaining anyway is deliberate: the union shadows the stand-in for
            // as long as the real row is there, and a stale list answer that
            // clear-and-replaces that row (one issued before the chat existed,
            // landing after) would otherwise leave NEITHER, which is the exact
            // disappearance this registry exists to prevent. The redundant entry
            // costs one map slot and is retired by the next answer carrying the
            // row.
            const key = recordKey(ownerUserId, pending.chatId);
            if (pendingChatCreations.has(key)) return;
            pendingChatCreations.set(key, {
              pending,
              ownerUserId,
              createdAt: Date.now(),
            });
            publishChatRecords(null);
          },

          clearPendingChatCreation: (chatId) => {
            if (disposed) return;
            if (!dropPendingChatCreationsForChat(chatId)) return;
            publishChatRecords(null);
          },

          detachTransport: () => {
            if (disposed) return;
            if (transportDetached) return;
            transportDetached = true;
            // Order mirrors `dispose`'s first two teardown steps and stops
            // there: the projector unbinds so no late stream frame can write
            // into a doc nobody is watching, the socket closes so this handle
            // stops producing dial evidence for a host the window has left -
            // and the doc, its replica and the unsynced queue are left intact,
            // because they are the thing being retained.
            //
            // Landed overlay entries are dropped here: their sweep runs
            // inside full projections, and a detached projector never
            // projects again, so a landed stamp would sit in the map for the
            // life of the retained handle waiting for an echo the closed
            // stream cannot deliver. Un-landed entries stay - their RPC
            // promise still owns a terminal retire.
            for (const [requestId, entry] of pendingMetadataMutations) {
              if (entry.landed) {
                pendingMetadataMutations.delete(requestId);
                registryBackedRequestIds.delete(requestId);
              }
            }
            projector.detach();
            closeStreamClient();
            // Say so rather than leaving the last live reading in place. The
            // handle is unreachable from the transport now, and `isClean()`
            // reads this field.
            set({ hostTransportStatus: "closed" });
          },

          dispose: () => {
            if (disposed) return;
            disposed = true;
            // Settle any in-flight attachment reads (resolve null) so their
            // observers unbind from the live doc and their promises don't
            // dangle forever - the caller's abort signal isn't guaranteed to
            // fire when a session is disposed by the registry's MRU prune.
            // Must run before destroyReplica so the unobserve targets a live
            // doc.
            [...attachmentReadWaiters].forEach((waiter) => waiter.settle(null));
            // Backstop for retires that never arrive (a caller torn down
            // before its RPC settled). The store is dead, so nothing reads
            // the map again; clearing just guarantees no stamp outlives it.
            pendingMetadataMutations.clear();
            registryBackedRequestIds.clear();
            latestRenameStampByNode.clear();
            unsubscribeAuthUserId?.();
            unsubscribeAuthUserId = null;
            projector.detach();
            closeStreamClient();
            destroyReplica(doc, awareness);
            hostCoverageDoc.destroy();
            destroyAllArtifactRoomReplicas();
          },

          renameArtifact: renameArtifactAction,
          beginRenameMutation,
          beginEpicTitleMutation,
          beginReparentMutation,
          retirePendingMutation,
          isLatestRenameStamp,
          deleteArtifact: deleteArtifactAction,
          reparentArtifact: reparentArtifactAction,
          setEpicTitle: setEpicTitleAction,

          readAttachmentBytes: (hash, signal) => {
            if (signal.aborted) return Promise.resolve(null);
            const existing = doc.getMap("attachments").get(hash);
            if (existing instanceof Uint8Array)
              return Promise.resolve(existing);
            // Wait for the bytes to sync in. The waiter is registered so a
            // replica swap re-points it at the live doc; the caller's signal
            // (fired on unmount / when nothing still needs the image) tears it
            // down. No fixed give-up, so a slow cross-device sync still renders.
            return new Promise<Uint8Array | null>((resolve) => {
              const waiter: AttachmentReadWaiter = {
                hash,
                observedMap: null,
                onChange: () => {
                  const bytes = waiter.observedMap?.get(hash);
                  if (bytes instanceof Uint8Array) waiter.settle(bytes);
                },
                settle: (bytes: Uint8Array | null): void => {
                  if (!attachmentReadWaiters.has(waiter)) return;
                  attachmentReadWaiters.delete(waiter);
                  waiter.observedMap?.unobserve(waiter.onChange);
                  signal.removeEventListener("abort", onAbort);
                  resolve(bytes);
                },
              };
              const onAbort = (): void => waiter.settle(null);
              signal.addEventListener("abort", onAbort);
              attachmentReadWaiters.add(waiter);
              bindAttachmentWaiter(waiter);
            });
          },

          hasAttachmentBytes: (hash) =>
            doc.getMap("attachments").get(hash) instanceof Uint8Array,

          getArtifactFragment: (artifactId) => {
            // Resolve the artifact's artifactRoom via root metadata, then look up
            // the live `artifact-body:{id}` fragment in that artifactRoom's local
            // replica. Returns `null` until the artifactRoom transitions to
            // `ready` and a `artifactRoomSnapshot` has seeded the replica.
            //
            // PURE. This runs inside Zustand selectors, so it must not
            // materialize, touch the LRU, reset a cooldown, or evict: an
            // earlier attempt did all four and made an unrelated store update
            // able to extend a room's lifetime, and made cap enforcement able
            // to destroy an unpinned `Y.Doc` while a component rendered
            // earlier in the same pass was still holding its fragment.
            // Materialization belongs to `acquireArtifactBodyLease`, which
            // `useEpicArtifactFragment` takes for the caller.
            const artifactRoomId = readArtifactArtifactRoomId(artifactId);
            if (artifactRoomId === null) return null;
            const availability =
              get().artifactRooms.stateByArtifactRoomId[artifactRoomId] ??
              "unavailable";
            if (availability !== "ready") return null;
            const entry = artifactRoomReplicas.get(artifactRoomId);
            if (entry === undefined) return null;
            return entry.doc.getXmlFragment(
              artifactBodyFragmentName(artifactId),
            );
          },

          getArtifactBodyAwareness: (artifactId) => {
            const artifactRoomId = readArtifactArtifactRoomId(artifactId);
            if (artifactRoomId === null) return null;
            const availability =
              get().artifactRooms.stateByArtifactRoomId[artifactRoomId] ??
              "unavailable";
            if (availability !== "ready") return null;
            // Pure, for the same reason as `getArtifactFragment`.
            const entry = artifactRoomReplicas.get(artifactRoomId);
            if (entry === undefined) return null;
            return entry.awareness;
          },

          getArtifactBodyAvailability: (artifactId) => {
            const artifactRoomId = readArtifactArtifactRoomId(artifactId);
            if (artifactRoomId === null) return "unavailable";
            return (
              get().artifactRooms.stateByArtifactRoomId[artifactRoomId] ??
              "unavailable"
            );
          },

          getArtifactRoomId: (artifactId) =>
            readArtifactArtifactRoomId(artifactId),

          acquireArtifactBodyLease: (artifactId) => {
            const artifactRoomId = readArtifactArtifactRoomId(artifactId);
            if (artifactRoomId === null || disposed) return () => {};
            artifactRoomLeases.set(
              artifactRoomId,
              (artifactRoomLeases.get(artifactRoomId) ?? 0) + 1,
            );
            const hadReplica = artifactRoomReplicas.has(artifactRoomId);
            materializeArtifactRoomReplica(artifactRoomId);
            if (!hadReplica && artifactRoomReplicas.has(artifactRoomId)) {
              // A newly materialized doc is a new fragment identity, so the
              // editor has to rebind. Availability is unchanged here - the
              // room was already `ready` - which is exactly why this needs its
              // own invalidation signal. Coalesced because opening a canvas
              // takes one lease per tile: a `set` per tile would re-run every
              // mounted selector once per artifact.
              scheduleBindingVersionBump();
            }
            let released = false;
            return () => {
              if (released) return;
              released = true;
              const remaining =
                (artifactRoomLeases.get(artifactRoomId) ?? 1) - 1;
              if (remaining > 0) {
                artifactRoomLeases.set(artifactRoomId, remaining);
                return;
              }
              artifactRoomLeases.delete(artifactRoomId);
              scheduleArtifactRoomCooldown(artifactRoomId);
            };
          },

          readArtifactTitle: (artifactId) => {
            const artifact = getArtifactEntry(doc, artifactId);
            if (artifact !== null) {
              const title = artifact.get("title");
              if (typeof title === "string") return title;
            }
            const chat = getChatEntry(doc, artifactId);
            if (chat !== null) {
              const title = chat.get("title");
              if (typeof title === "string") return title;
            }
            const agent = getTerminalAgentEntry(doc, artifactId);
            if (agent !== null) {
              const title = agent.get("title");
              if (typeof title === "string") return title;
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

  routeLocalUpdate = (bytes) => {
    store.getState().applyLocalUpdate(bytes);
  };
  bumpBindingVersionImpl = () => {
    store.setState((state) => ({ bindingVersion: state.bindingVersion + 1 }));
  };
  markDirtyFromLocalDocUpdate = () => {
    store.setState({
      isDirty: true,
      dirtyWatermarkStateVectorBase64: encodeDocStateVectorBase64(doc),
    });
  };
  refreshPublicDirtyState = () => {
    const state = store.getState();
    const dirtyState = resolvePublicDirtyState(
      state.dirtyWatermarkStateVectorBase64,
      state.latestHostStateVectorBase64,
    );
    if (
      state.isDirty === dirtyState.isDirty &&
      state.dirtyWatermarkStateVectorBase64 ===
        dirtyState.dirtyWatermarkStateVectorBase64 &&
      state.latestHostStateVectorBase64 ===
        dirtyState.latestHostStateVectorBase64
    ) {
      return;
    }
    store.setState(dirtyState);
  };
  routeOutboundAwareness = (bytes) => {
    store.getState().sendAwareness(bytes);
  };

  unsubscribeAuthUserId = useAuthStore.subscribe((state, prevState) => {
    const nextUserId = state.profile?.userId ?? null;
    const prevUserId = prevState.profile?.userId ?? null;
    if (nextUserId === prevUserId || disposed) return;
    // An answer scoped to the previous viewer cannot authorize absence for the
    // next one. The viewer-keyed query will set this again when its own result
    // is applied.
    store.setState({ chatRecordListAuthoritative: false });
    // Re-derive the record slice from the RETAINED raw rows first. It is built
    // for one owner (a `byId` keyed on `chatId` can hold no more), so a user
    // switch has to rebuild it rather than merely re-filter downstream - a
    // re-projection alone would keep serving the previous identity's selection.
    // This is what makes the ingest-time owner selection safe.
    store.getState().republishChatRecordsForCurrentUser();
    store.setState(projector.projectFull());
  });

  // Wire projector last so the initial full projection runs after the
  // store is fully constructed (otherwise the `setState` from `attach`
  // would race with the persist middleware's hydration setState).
  projector.attach(doc, store);

  return {
    epicId,
    userId,
    get doc() {
      return doc;
    },
    get awareness() {
      return awareness;
    },
    store,
    dispose: () => {
      store.getState().dispose();
    },
    detachTransport: () => {
      store.getState().detachTransport();
    },
    hotArtifactRoomIdsForTests: () => Array.from(artifactRoomReplicas.keys()),
    requestFreshSnapshot: () => {
      store.getState().requestFreshSnapshot();
    },
    isClean: () => {
      const state = store.getState();
      return (
        state.snapshotLoaded &&
        !state.isDirty &&
        state.hostTransportStatus === "open"
      );
    },
  };
}
