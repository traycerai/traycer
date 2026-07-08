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
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
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
import { evaluateReparent, reparentRejectionError } from "@/lib/reparent-rules";
import { isUnavailableEpicReason } from "@/lib/epics/unavailable-epic";
import { basePersistOptions, openEpicKey } from "@/lib/persist";
import type {
  ArtifactsSlice,
  ArtifactRoomsSlice,
  ChatsSlice,
  DeletedArtifactsSlice,
  EpicArtifactRoomAvailability,
  EpicHeader,
  TerminalAgentsSlice,
  TreeSlice,
} from "./types";
import { EMPTY_ARTIFACT_ROOMS_SLICE, EMPTY_PROJECTED_SLICES } from "./types";
import {
  ensureMap,
  getArtifactEntry,
  getArtifactsMap,
  getChatEntry,
  getChatsMap,
  getDeletedArtifactsMap,
  getEpicMap,
  getTerminalAgentEntry,
  getTerminalAgentsMap,
  NEW_ARTIFACT_TITLES,
  readArtifactKind,
  readMaybeString,
  type AddableArtifactType,
} from "./projection-helpers";
import { v4 as uuidv4 } from "uuid";
import { createEpicProjector, type EpicProjector } from "./epic-projector";
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

function isUnavailableUnauthorized(details: FatalErrorDetails): boolean {
  return (
    details.code === "UNAUTHORIZED" && isUnavailableEpicReason(details.reason)
  );
}

function snapshotFetchErrorFrom(
  details: FatalErrorDetails,
): SnapshotFetchError {
  return {
    code: details.code,
    message: details.reason,
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
   * Identity to namespace persisted state under. When provided, the local
   * `lastFocusedArtifactId` survives the same user signing in again but
   * stays isolated from any other user that signs into this device - a
   * different `userId` (or `null`) yields a disjoint persist key, so prior
   * focus state never leaks across signed-in identities.
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
  readonly chats: ChatsSlice;
  readonly tuiAgents: TerminalAgentsSlice;
  readonly tree: TreeSlice;
  readonly contentRevByArtifactId: Readonly<Record<string, number>>;
  /**
   * Per-artifact-room availability mirrored from `epic.subscribe@1.0` `artifactRoomState`
   * frames. The body of an artifact is renderable only when the artifactRoom
   * referenced by `artifacts.byId[id].artifactRoomId` reports `ready`. ArtifactRooms
   * absent from this slice are implicitly `unavailable`.
   */
  readonly artifactRooms: ArtifactRoomsSlice;

  // ── Connection / permissions / dirty-tracking ────────────────────────
  readonly snapshotMeta: SnapshotMetaEpic | null;
  readonly permissionRole: PermissionRole | null;
  readonly connectionStatus: StreamConnectionStatus;
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
  /** Forcibly closes the underlying stream session. Idempotent. */
  dispose: () => void;

  // ── Actions: artifact + chat mutations (own `doc.transact`) ──────────
  /** Returns the new artifact id; no-op (returns generated id) if viewer/null. */
  createArtifact: (
    type: AddableArtifactType,
    parentId: string | null,
  ) => string;
  /** Returns true when the title actually changed in the Y.Doc. */
  renameArtifact: (artifactId: string, nextTitle: string) => boolean;
  /** Returns true when a delete actually happened. Reparents children. */
  deleteArtifact: (artifactId: string) => boolean;
  /**
   * Move an artifact, chat, or terminal-agent to a new parent within its own
   * family. Throws `MissingNodeError`, `CrossFamilyParentError`, or
   * `ReparentCycleError` on validation failure.
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
  readonly requestFreshSnapshot: () => void;
  /**
   * True when the snapshot meta has landed at least once since construction.
   * Read by the registry when deciding eviction eligibility.
   */
  isClean: () => boolean;
}

const STREAM_ORIGIN = "stream";
const LOCAL_ORIGIN = "local";
const EMPTY_Y_UPDATE_BYTES = 2;

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

// Reparent resolution / validation lives in `@/lib/reparent-rules`
// (`evaluateReparent`), shared verbatim with the DnD pre-flight read in
// `epic-y-mutations.ts` so the rule can never drift between read and write.

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
  const unsyncedQueue: Uint8Array[] = [];
  let transportStatus: StreamConnectionStatus = "connecting";
  // Optimistic until the host's first cloudSyncStatus frame: a freshly-opened
  // transport reads as "open"/synced right away so app-wide gates (the
  // initial-chat handoff's `epicReady`, `isClean`) don't stall on the cloud
  // link. `hasConnectedOnce` is latched ONLY by a genuine cloud "connected"
  // frame (see onCloudSyncStatus), never by this default - so a new room's first
  // real "reconnecting" catch-up still reads as the bootstrap-only "connecting"
  // in the pill, not "reconnecting".
  let cloudSyncStatus: EpicCloudSyncStatus = "connected";
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
    /**
     * Mirror of the host-side artifact-room doc, advanced from every applied
     * `artifactRoomSnapshot`/`artifactRoomUpdate`. Used to compare against the artifactRoom's local
     * dirty watermark so we can clear the dirty flag once the host's
     * view covers the local edits - analogous to root `hostCoverageDoc`.
     */
    hostCoverageDoc: Y.Doc;
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
  const BIN_STREAM_ORIGIN = Symbol("open-epic/artifact-room-stream");
  const BIN_AWARENESS_REMOTE_ORIGIN = "artifact-room-stream-remote";

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
    const replicaHostCoverageDoc = new Y.Doc();
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
          replica.pendingUpdates.length = 0;
          replica.pendingReconcileUpdate = null;
          replica.dirtyWatermarkStateVectorBase64 = null;
        }
        refreshPublicDirtyState?.();
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
        replica.pendingUpdates.push(update);
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
      hostCoverageDoc: replicaHostCoverageDoc,
      docUpdateHandler,
      awarenessUpdateHandler,
      pendingUpdates: [],
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
    entry.hostCoverageDoc.destroy();
    artifactRoomReplicas.delete(artifactRoomId);
  }

  function destroyAllArtifactRoomReplicas(): void {
    for (const id of Array.from(artifactRoomReplicas.keys())) {
      destroyArtifactRoomReplica(id);
    }
  }

  function flushPendingArtifactRoomUpdates(artifactRoomId: string): void {
    const entry = artifactRoomReplicas.get(artifactRoomId);
    if (entry === undefined) return;
    if (transportStatus !== "open") return;
    if (!hasFreshRootSnapshotForOpenCycle) return;
    const role = currentRole;
    if (!isWritablePermissionRole(role)) {
      entry.pendingUpdates.length = 0;
      entry.pendingReconcileUpdate = null;
      entry.dirtyWatermarkStateVectorBase64 = null;
      refreshPublicDirtyState?.();
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
    if (entry.pendingUpdates.length === 0) return;
    const pending = entry.pendingUpdates.slice();
    entry.pendingUpdates.length = 0;
    for (const update of pending) {
      streamClient?.applyArtifactRoomUpdate(artifactRoomId, update);
    }
  }

  function flushAllPendingArtifactRoomUpdates(): void {
    for (const id of Array.from(artifactRoomReplicas.keys())) {
      flushPendingArtifactRoomUpdates(id);
    }
  }

  function clearAllPendingArtifactRoomUpdates(): void {
    for (const entry of artifactRoomReplicas.values()) {
      entry.pendingUpdates.length = 0;
      entry.pendingReconcileUpdate = null;
      entry.dirtyWatermarkStateVectorBase64 = null;
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

  // The projector hides chats owned by a different signed-in user. The owner
  // id is the canonical `profile.userId` (NOT the store's `userId` option,
  // which is the email used for persist namespacing). Read lazily so a session
  // constructed before the auth profile hydrates picks up the id on its next
  // projection.
  const projector: EpicProjector = createEpicProjector(
    getCurrentChatProjectionUserId,
  );

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
    previous.destroy();
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
        const syncCurrentConnectionStatus = (): StreamConnectionStatus => {
          currentStatus = deriveConnectionStatus(
            transportStatus,
            cloudSyncStatus,
            hasConnectedOnce,
          );
          return currentStatus;
        };

        const flushPendingRootUpdates = (): void => {
          if (unsyncedQueue.length === 0) return;
          const role = currentRole ?? get().permissionRole;
          if (!isWritablePermissionRole(role)) {
            unsyncedQueue.length = 0;
            set({ unsyncedQueueSize: 0 });
            return;
          }
          const pending = unsyncedQueue.slice();
          unsyncedQueue.length = 0;
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
          client = options.streamClientFactory(epicId, {
            onSnapshot: (meta, snapshotBytes) => {
              if (disposed || generation !== streamGeneration) return;
              // Suspend projector so the per-event observeDeep storm
              // triggered by `Y.applyUpdate` does not race with the
              // deterministic full re-project below.
              projector.suspend();
              try {
                Y.applyUpdate(doc, snapshotBytes, STREAM_ORIGIN);
                replaceHostCoverageDoc(snapshotBytes);
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
              unsyncedQueue.length = 0;
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
                  earlyMeta.permissionRole === null ? state.accessLost : false,
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
              // Reuse any prior replica for this artifactRoom so a snapshot during
              // reconnect/recovery does NOT destroy local in-flight
              // edits. The host is now the merge source - its bytes
              // get applied on top of the existing local replica, and
              // dirty tracking drives a reconcile fan-out for any local
              // edits the host has not yet seen.
              const hadPrior = artifactRoomReplicas.has(artifactRoomId);
              const entry = getOrCreateArtifactRoomReplica(artifactRoomId);
              Y.applyUpdate(entry.doc, snapshotBytes, BIN_STREAM_ORIGIN);
              // Reset the host coverage replica with the new snapshot
              // so subsequent coverage checks reflect the host's view.
              entry.hostCoverageDoc.destroy();
              const freshCoverage = new Y.Doc();
              Y.applyUpdate(freshCoverage, snapshotBytes);
              entry.hostCoverageDoc = freshCoverage;
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
                entry.pendingUpdates.length = 0;
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
                entry.pendingUpdates.length = 0;
              } else {
                // Either no divergence (reconcile is trivial) or the
                // role is viewer/null (fail-closed). In both cases
                // there is nothing safe to send and nothing to retain.
                entry.pendingUpdates.length = 0;
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
            },
            onArtifactRoomUpdate: (
              artifactRoomId,
              updateBytes,
              hostArtifactRoomStateVectorBase64,
            ) => {
              if (disposed || generation !== streamGeneration) return;
              const entry = artifactRoomReplicas.get(artifactRoomId);
              if (entry === undefined) return;
              Y.applyUpdate(entry.doc, updateBytes, BIN_STREAM_ORIGIN);
              Y.applyUpdate(entry.hostCoverageDoc, updateBytes);
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
            },
            onArtifactRoomAwareness: (artifactRoomId, awarenessBytes) => {
              if (disposed || generation !== streamGeneration) return;
              // Apply inbound awareness to the artifact-room-scoped Awareness
              // instance, NOT the root Epic awareness. CollaborationCaret
              // bindings on artifact-room-doc fragments listen on this instance, so
              // routing them through the root awareness would mis-attribute
              // cursors and lose the per-artifact-room presence channel.
              const entry = artifactRoomReplicas.get(artifactRoomId);
              if (entry === undefined) return;
              applyAwarenessUpdate(
                entry.awareness,
                awarenessBytes,
                BIN_AWARENESS_REMOTE_ORIGIN,
              );
            },
            onArtifactRoomState: (artifactRoomId, nextState) => {
              if (disposed || generation !== streamGeneration) return;
              if (nextState !== "ready") {
                // A artifactRoom transitioning out of `ready` invalidates the
                // local replica - the next `artifactRoomSnapshot` will rebuild.
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
            onPermissionChanged: (permissionRole) => {
              if (disposed || generation !== streamGeneration) return;
              if (permissionRole === null) {
                unsyncedQueue.length = 0;
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
                unsyncedQueue.length = 0;
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
              appLogger.warn("[epic-migration] host reported migrationFailed", {
                epicId,
                reason,
              });
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
              const nextStatus = syncCurrentConnectionStatus();
              set({ connectionStatus: nextStatus });
              flushPendingWritesAfterReconnect(client);
            },
            onConnectionStatus: (status, reason) => {
              if (disposed || generation !== streamGeneration) return;
              const previousTransportStatus = transportStatus;
              transportStatus = status;
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
              const nextStatus = syncCurrentConnectionStatus();
              hasFreshRootSnapshotForOpenCycle = false;
              set({ connectionStatus: nextStatus });
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
                if (isUnavailableUnauthorized(details)) {
                  set({ snapshotFetchError: snapshotFetchErrorFrom(details) });
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
                  set({ snapshotFetchError: snapshotFetchErrorFrom(details) });
                  options.onAuthError?.();
                  return;
                }
                set({ snapshotFetchError: snapshotFetchErrorFrom(details) });
                return;
              }
              if (nextStatus !== "open") return;
              emitCurrentAwareness(awareness, doc, client);
            },
          });
          streamClient = client;
        };

        requestFreshSnapshotImpl = () => {
          if (disposed) return;
          unsyncedQueue.length = 0;
          transportStatus = "connecting";
          cloudSyncStatus = "connected";
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
            connectionStatus: "connecting",
            snapshotLoaded: false,
            snapshotFetchError: null,
            unsyncedQueueSize: 0,
            artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
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

        const createArtifactAction = (
          type: AddableArtifactType,
          parentId: string | null,
        ): string => {
          const id = uuidv4();
          if (disposed) return id;
          const role = currentRole ?? get().permissionRole;
          if (role === "viewer" || role === null) return id;
          const now = Date.now();
          const title = NEW_ARTIFACT_TITLES[type];
          doc.transact(() => {
            const epic = getEpicMap(doc);
            if (type === "chat") {
              const chats = ensureMap(epic, "chats");
              const entry = new Y.Map<unknown>();
              entry.set("id", id);
              entry.set("title", title);
              entry.set("parentId", parentId);
              entry.set("createdAt", now);
              entry.set("updatedAt", now);
              entry.set("messages", new Y.Array());
              chats.set(id, entry);
              return;
            }
            const artifacts = ensureMap(epic, "artifacts");
            const entry = new Y.Map<unknown>();
            entry.set("id", id);
            entry.set("kind", type);
            entry.set("title", title);
            entry.set("parentId", parentId);
            entry.set("createdAt", now);
            entry.set("updatedAt", now);
            artifacts.set(id, entry);
          }, LOCAL_ORIGIN);
          return id;
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
          let mutated = false;
          const pendingErrors: Error[] = [];
          doc.transact(() => {
            const evaluation = evaluateReparent(doc, artifactId, newParentId);
            if (!evaluation.ok) {
              if (evaluation.reason === "same-parent") return; // no-op
              pendingErrors.push(
                reparentRejectionError(
                  doc,
                  evaluation.reason,
                  artifactId,
                  newParentId,
                ),
              );
              return;
            }
            evaluation.node.entry.set("parentId", newParentId);
            evaluation.node.entry.set("updatedAt", Date.now());
            mutated = true;
          }, LOCAL_ORIGIN);
          if (pendingErrors.length > 0) throw pendingErrors[0];
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

        return {
          epicId,
          doc,
          awareness,
          bindingVersion: 0,
          ...EMPTY_PROJECTED_SLICES,
          artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
          snapshotMeta: null,
          permissionRole: null,
          connectionStatus: "connecting",
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
            unsyncedQueue.push(updateBytes);
            set({ unsyncedQueueSize: unsyncedQueue.length });
          },

          sendAwareness: (awarenessBytes) => {
            if (disposed) return;
            if (transportStatus !== "open") return;
            streamClient?.awareness(awarenessBytes);
          },

          discardUnsyncedEdits: () => {
            if (unsyncedQueue.length === 0 && !get().isDirty) return;
            unsyncedQueue.length = 0;
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
            unsubscribeAuthUserId?.();
            unsubscribeAuthUserId = null;
            projector.detach();
            closeStreamClient();
            destroyReplica(doc, awareness);
            hostCoverageDoc.destroy();
            destroyAllArtifactRoomReplicas();
          },

          createArtifact: createArtifactAction,
          renameArtifact: renameArtifactAction,
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

          getArtifactFragment: (artifactId) => {
            // Resolve the artifact's artifactRoom via root metadata, then look up
            // the live `artifact-body:{id}` fragment in that artifactRoom's local
            // replica. Returns `null` until the artifactRoom transitions to
            // `ready` and a `artifactRoomSnapshot` has seeded the replica.
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
    requestFreshSnapshot: () => {
      store.getState().requestFreshSnapshot();
    },
    isClean: () => {
      const state = store.getState();
      return (
        state.snapshotLoaded &&
        !state.isDirty &&
        state.connectionStatus === "open"
      );
    },
  };
}
