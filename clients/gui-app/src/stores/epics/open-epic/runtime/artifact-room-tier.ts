/**
 * The artifact-body hot/cold tier: which rooms are live `Y.Doc`s, which are encoded bytes, and
 * what pins one against being demoted.
 */
import type { ArtifactBodySeedMode } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type {
  DocSeedMode,
  LeaseGrant,
  LeaseHandle,
  LeasePolicy,
  MonotonicSequence,
  RuntimeEnvironment,
  RuntimeTimer,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import type { HotDocBudgetSink } from "@/stores/replica-memory/hot-doc-budget";
import { HOT_DOCS_MAX_MATERIALIZED } from "@/stores/replica-memory/budget-limits";
import { createMonotonicSequence } from "@traycer-clients/shared/replica-runtime";
import type { EpicOutboundRequest } from "./epic-runtime-events";
import type { EpicSessionFacts } from "./session-facts";
import { isWritablePermissionRole } from "./session-facts";
import {
  decodeBase64,
  encodeDocStateVectorBase64,
  isNonTrivialYUpdate,
  latestHostCoversDirtyWatermark,
} from "./dirty-watermark";
import type { HotDocEvictionOutcome } from "./epic-runtime-accounting-port";

/** Per-artifact-room Y.Doc replicas mirroring the host-side artifact-rooms. */
export interface ArtifactRoomReplicaEntry {
  doc: Y.Doc;
  awareness: Awareness;
  /**
   * The `clientID` of the main-thread `Awareness` whose presence is RELAYED into this room, or
   * `null` before any local presence has been relayed.
   */
  relayedLocalClientId: number | null;
  docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  /**
   * Local artifact-room-body updates produced while the stream is not ready to send are queued here
   * and replayed once the fresh root snapshot confirms write permission.
   */
  pendingUpdates: Uint8Array[];
  /**
   * Byte size of `pendingUpdates`, so the queue can be collapsed with `Y.mergeUpdates` before a long
   * offline stretch turns it into O(edits) of retained buffers.
   */
  pendingBytes: number;
  /** Bytes appended since the last collapse - the collapse trigger. */
  pendingBytesSinceCollapse: number;
  /**
   * Reconcile bytes computed at `artifactRoomSnapshot` time when the stream was not ready to send
   * (the stream is not `open`, or the current open cycle has not received a fresh root
   */
  pendingReconcileUpdate: Uint8Array | null;
  /**
   * Local dirty watermark for the artifactRoom replica (base64 state vector at the time of the most
   * recent local edit). `null` when there is no outstanding local divergence.
   */
  dirtyWatermarkStateVectorBase64: string | null;
  /**
   * Latest host-side artifactRoom state vector observed via `artifactRoomSnapshot` or
   * `artifactRoomUpdate` - base64.
   */
  latestHostStateVectorBase64: string | null;
  /** Inbound/local update bytes since the last `notifyHot` encode. */
  hotBytesSinceSettle: number;
}

/**
 * A room the host has sent us, held as encoded update bytes with no live `Y.Doc` behind it. This
 * is the memory-shaped half of the artifact-room cache.
 */
interface ColdArtifactRoomEntry {
  /** Host update bytes, collapsed with `Y.mergeUpdates` past the thresholds
   * below so a chatty room does not accumulate one buffer per frame. */
  updates: Uint8Array[];
  bytes: number;
  /** Bytes appended since the last compaction - the compaction trigger.
   * See `pushColdArtifactRoomUpdate` for why the total must not be used. */
  bytesSinceCollapse: number;
  latestHostStateVectorBase64: string | null;
  /** Recent remote awareness frames, replayed when the room materializes. */
  awarenessFrames: Uint8Array[];
}

const BIN_STREAM_ORIGIN = Symbol("open-epic/artifact-room-stream");
const BIN_AWARENESS_REMOTE_ORIGIN = "artifact-room-stream-remote";
/** Origin for presence relayed IN from the main-thread editor. */
const BIN_AWARENESS_RELAYED_LOCAL_ORIGIN = "artifact-room-relayed-local";
const ROOM_PENDING_COLLAPSE_BYTES = 2 * 1024 * 1024;
/** Re-encode a hot room for the byte budget after this much unmeasured growth. */
const HOT_DOC_RESETTLE_BYTES = 256 * 1024;
const ROOM_PENDING_COLLAPSE_ENTRIES = 32;
/** Frames retained per cold room; see `ColdArtifactRoomEntry.awarenessFrames`.
 * One renewal cycle across a realistic number of collaborators. */
const COLD_ROOM_AWARENESS_FRAMES = 32;
const COLD_ROOM_COLLAPSE_BYTES = 1024 * 1024;
const COLD_ROOM_COLLAPSE_ENTRIES = 32;

/**
 * The tier's lease policy, in the shared vocabulary. `cooldownMs` - how long a room stays
 * materialized after its last editor unmounts.
 */
export const ARTIFACT_ROOM_LEASE_POLICY: LeasePolicy = {
  cooldownMs: 60_000,
  maxMaterialized: HOT_DOCS_MAX_MATERIALIZED,
};

/** What a room snapshot did, and therefore what the plane above owes. */
export type RoomSnapshotOutcome = "filed-cold" | "merged" | "seeded";

/** One inbound body snapshot, with the authority's own account of what it is. */
/** This client's position on one body, in the shape `artifact.subscribe`'s open request takes. */
export interface ArtifactRoomDocSeed {
  readonly knownDocGuid: string;
  /** Base64 `Y.encodeStateVector` of the replica this client still holds. */
  readonly stateVectorBase64: string;
}

/** A body's cold state, encoded for transfer. NOT `ArtifactRoomDocSeed`. */
export interface ArtifactRoomColdState {
  readonly update: Uint8Array;
  readonly seedMode: ArtifactBodySeedMode;
  readonly hostStateVector: string | null;
  readonly docGuid: string;
}

/** What a settle answers. */
export type ArtifactRoomColdSettlement =
  | { readonly accepted: true; readonly settledBytes: number }
  | {
      readonly accepted: false;
      readonly reason: "not-held" | "newer-generation" | "pinned";
    };

export interface ArtifactRoomSnapshotInput {
  readonly artifactRoomId: string;
  readonly snapshotBytes: Uint8Array;
  /** The authority's state vector at snapshot time, driving the reconcile diff. */
  readonly hostStateVectorBase64: string | null;
  /**
   * Whether these bytes stand alone or complete an offer this replica made. `"delta-against-offer"`
   * must be merged onto the replica that made the offer and can never install a room from cold.
   */
  readonly seed: DocSeedMode;
  /**
   * The authority's identity for this doc instance, or `null` on an arm that states none. `null`
   * rather than a synthesized id for the `@1` arm on purpose.
   */
  readonly docGuid: string | null;
}

export interface ArtifactRoomTierSources {
  readonly environment: RuntimeEnvironment;
  readonly session: EpicSessionFacts;
  /** The outbound half. Returns what the transport did with the frame. */
  readonly send: (request: EpicOutboundRequest) => SendOutcome;
  /**
   * A room's local divergence moved. The records plane folds room dirtiness
   * into the renderer-local `isDirty` it publishes, so it has to be told.
   */
  readonly onDivergenceChanged: () => void;
  readonly isDisposed: () => boolean;
  /**
   * Process-wide budget sink, or `null` in tests that do not exercise it.
   * Never optional: a missing field and "no accountant" must stay distinct.
   */
  readonly budget: HotDocBudgetSink | null;
}

export interface ArtifactRoomTier {
  /**
   * Take demand on a room, materialising it if there is anything to
   * materialise. The contract's shape; awaits nothing today.
   */
  acquire(
    artifactRoomId: string,
  ): Promise<LeaseGrant<ArtifactRoomReplicaEntry>>;
  /**
   * {@link acquire}, synchronously. The only caller is the store action that
   * has not been made async yet; see the module doc.
   */
  acquireSync(artifactRoomId: string): LeaseGrant<ArtifactRoomReplicaEntry>;
  /** Read an ALREADY materialised room without taking a lease or affecting recency. */
  peek(artifactRoomId: string): ArtifactRoomReplicaEntry | null;
  /** The identity this room's snapshots STATED, or `null` when none did. */
  statedDocGuid(artifactRoomId: string): string | null;
  leaseCount(artifactRoomId: string): number;
  /** Ids currently materialised as live `Y.Doc`s. */
  materializedIds(): readonly string[];
  /** Demote everything demotable right now, ignoring cooldowns. */
  demoteIdle(): void;
  /**
   * The existing LRU walk, parameterized by bytes rather than count. Pinned
   * rooms are never victims and are reported as protected `"leased"`.
   */
  demoteColdestUnpinned(overBytes: number): HotDocEvictionOutcome;

  /** Whether the tier holds any unsent or unacknowledged local body state. */
  hasDivergence(): boolean;

  // ── Inbound frames ──────────────────────────────────────────────────────
  /** What this client can offer the authority for one body, or `null` when it can offer nothing. */
  readDocSeedOffer(artifactRoomId: string): ArtifactRoomDocSeed | null;
  /** The whole encoded document for a held body, or `null` when the tier does not hold it. */
  encodeColdState(artifactRoomId: string): ArtifactRoomColdState | null;
  /**
   * Take an encoded document back and store it. `expectedDocGuid` is what the caller encoded
   * against.
   */
  settleColdState(
    artifactRoomId: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ): ArtifactRoomColdSettlement;
  applySnapshot(input: ArtifactRoomSnapshotInput): RoomSnapshotOutcome;
  /** Remote bytes for one body. */
  applyUpdate(
    artifactRoomId: string,
    updateBytes: Uint8Array,
    hostStateVectorBase64: string | null,
    docGuid: string | null,
  ): void;
  /**
   * The authority's coverage of updates this client pushed - the event that retires local divergence
   * on the body lane.
   */
  applyCoverage(
    artifactRoomId: string,
    coverageStateVectorBase64: string,
    docGuid: string | null,
  ): void;
  /** INBOUND presence, from the wire. */
  applyAwareness(artifactRoomId: string, awarenessBytes: Uint8Array): void;
  /** OUTBOUND presence, from the main-thread editor. */
  relayLocalAwareness(
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
    localClientId: number,
  ): void;
  /** A local body EDIT from the main-thread editor, on its way out. */
  relayLocalUpdate(artifactRoomId: string, update: Uint8Array): boolean;
  /** Is this room pinned by TIER state - local divergence or remote presence? */
  isRoomPinnedByTierState(artifactRoomId: string): boolean;
  /** This room's currently-known REMOTE peers, encoded for a fresh observer. */
  encodeRoomPeerAwareness(artifactRoomId: string): readonly Uint8Array[];
  /**
   * Observe this room's presence; returns the detach. The return leg of the relocation: remote peers
   * land in this room's `Awareness`, and the editor that has to render them is on the main thread.
   */
  observeAwareness(
    artifactRoomId: string,
    onFrame: (frame: Uint8Array) => void,
  ): () => void;
  /** A room leaving `ready` invalidates both its hot and cold copies. */
  invalidate(artifactRoomId: string): void;
  /** Re-test the linger arm for one room. */
  scheduleCooldownCheck(artifactRoomId: string): void;

  // ── Outbound drains ─────────────────────────────────────────────────────
  flushPending(artifactRoomId: string): void;
  flushAllPending(): void;
  /**
   * Drop every room's unsent local state (discard-changes, viewer downgrade,
   * access loss).
   */
  clearAllPending(): void;

  /**
   * Tear every live replica down, keeping the LEASES. Leases are owned by mounted editors, which
   * survive a replica swap / resubscribe and will re-materialize their room from the next snapshot.
   */
  destroyAll(): void;
  /** Terminal. `destroyAll` plus refusing every later acquisition. */
  dispose(): void;
}

export function createArtifactRoomTier(
  sources: ArtifactRoomTierSources,
): ArtifactRoomTier {
  const {
    environment,
    session,
    send,
    onDivergenceChanged,
    isDisposed,
    budget,
  } = sources;

  const replicas = new Map<string, ArtifactRoomReplicaEntry>();
  const cold = new Map<string, ColdArtifactRoomEntry>();
  /** Outstanding materialization leases per room id. A room with a live lease
   * is never cooled - see `isPinned`. */
  const leases = new Map<string, number>();
  const cooldownTimers = new Map<string, RuntimeTimer>();
  /** Monotonic touch stamps driving the hot-room LRU. A counter rather than a
   * clock so eviction order is deterministic under fake timers. */
  const touchSeq = new Map<string, number>();
  const touchCounter: MonotonicSequence = createMonotonicSequence();
  let tierDisposed = false;
  /** Last encoded size settled as hot, for `"leased"` protection reporting. */
  const lastHotBytes = new Map<string, number>();

  function notifyHot(artifactRoomId: string, bytes: number): void {
    lastHotBytes.set(artifactRoomId, bytes);
    const entry = replicas.get(artifactRoomId);
    if (entry !== undefined) entry.hotBytesSinceSettle = 0;
    if (budget === null) return;
    budget.settle(artifactRoomId, bytes);
  }

  function noteHotGrowth(artifactRoomId: string, deltaBytes: number): void {
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return;
    entry.hotBytesSinceSettle += deltaBytes;
    if (entry.hotBytesSinceSettle > HOT_DOC_RESETTLE_BYTES) {
      notifyHot(artifactRoomId, Y.encodeStateAsUpdate(entry.doc).byteLength);
      return;
    }
    if (budget === null) return;
    budget.chargeProvisional(artifactRoomId, deltaBytes);
  }

  function notifyCold(artifactRoomId: string, bytes: number): void {
    if (budget === null) return;
    budget.settleCold(artifactRoomId, bytes);
  }

  function hotHolderBytes(artifactRoomId: string): number {
    const settled = lastHotBytes.get(artifactRoomId) ?? 0;
    const entry = replicas.get(artifactRoomId);
    const provisional = entry === undefined ? 0 : entry.hotBytesSinceSettle;
    return settled + provisional;
  }

  function unchargeHot(artifactRoomId: string): void {
    lastHotBytes.delete(artifactRoomId);
    if (budget !== null) budget.release(artifactRoomId);
  }

  /**
   * Drop everything held for one room - hot replica, cold bytes, recency and both budget charges -
   * keeping its LEASES.
   */
  function discardEverythingFor(artifactRoomId: string): void {
    cancelCooldown(artifactRoomId);
    cold.delete(artifactRoomId);
    touchSeq.delete(artifactRoomId);
    destroyReplica(artifactRoomId);
    unchargeHot(artifactRoomId);
    notifyCold(artifactRoomId, 0);
  }

  /** The authority's doc identity per room, for as long as the room is held. */
  const docGuidByRoom = new Map<string, string>();

  /**
   * Whether an incoming snapshot's identity supersedes what this room holds. Stated-to-stated
   * difference only.
   */
  function seedReplacesHeldDoc(
    artifactRoomId: string,
    incomingGuid: string | null,
  ): boolean {
    if (incomingGuid === null) return false;
    const held = docGuidByRoom.get(artifactRoomId);
    if (held === undefined) return false;
    return held !== incomingGuid;
  }

  /**
   * Whether an INCREMENTAL frame describes a document this room no longer is. The same comparison
   * {@link seedReplacesHeldDoc} makes, named separately because the consequence is the opposite.
   */
  function namesASupersededDoc(
    artifactRoomId: string,
    incomingGuid: string | null,
  ): boolean {
    return seedReplacesHeldDoc(artifactRoomId, incomingGuid);
  }

  function clearPendingRoomUpdates(entry: ArtifactRoomReplicaEntry): void {
    entry.pendingUpdates.length = 0;
    entry.pendingBytes = 0;
    entry.pendingBytesSinceCollapse = 0;
  }

  /**
   * Ship the local replica's divergence from a just-applied host snapshot, or retain it for a later
   * flush.
   */
  function reconcileAfterSnapshot(
    entry: ArtifactRoomReplicaEntry,
    artifactRoomId: string,
    hostStateVectorBase64: string | null,
  ): void {
    // If the local replica is ahead of the host's snapshot, ship a reconcile update so offline edits
    // round-trip. With no watermark there is no diff to take, so the reconcile is the WHOLE replica.
    const reconcileUpdate =
      hostStateVectorBase64 === null
        ? Y.encodeStateAsUpdate(entry.doc)
        : Y.encodeStateAsUpdate(entry.doc, decodeBase64(hostStateVectorBase64));
    const reconcileNeeded = isNonTrivialYUpdate(reconcileUpdate);
    const canSendNow = session.canSendBodyWrites();
    // The OUTCOME, not the attempt. The branch below clears the queue on the strength of "the
    // reconcile subsumes it", and that is only true once the reconcile has actually gone out.
    const reconcileSent =
      reconcileNeeded &&
      canSendNow &&
      send({ kind: "room-update", artifactRoomId, update: reconcileUpdate })
        .kind === "sent";
    if (reconcileSent) {
      // Reconcile shipped: every local update is already represented in the merged replica, so the
      // single reconcile subsumes both the queue and any prior pending reconcile.
      clearPendingRoomUpdates(entry);
      entry.pendingReconcileUpdate = null;
      return;
    }
    if (reconcileNeeded && isWritablePermissionRole(session.permissionRole())) {
      // Stream is reconnecting/closed, raw-open before the fresh root snapshot, or - since the outcome
      // is read above - the body's own lane refused.
      entry.pendingReconcileUpdate = reconcileUpdate;
      clearPendingRoomUpdates(entry);
      return;
    }
    // Either no divergence (reconcile is trivial) or the role is viewer/null (fail-closed). In both
    // cases there is nothing safe to send and nothing to retain.
    clearPendingRoomUpdates(entry);
    entry.pendingReconcileUpdate = null;
  }

  function takePendingRoomUpdates(
    entry: ArtifactRoomReplicaEntry,
  ): Uint8Array[] {
    const pending = entry.pendingUpdates.slice();
    clearPendingRoomUpdates(entry);
    return pending;
  }

  /**
   * Queue a local room edit the stream cannot carry yet, collapsing the queue once it outgrows
   * either threshold.
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

  /** The registry's demand book, and the only one. */
  function leaseCountOf(artifactRoomId: string): number {
    return leases.get(artifactRoomId) ?? 0;
  }

  /** Is this client one of OUR OWN presence identities in this room? */
  function isOwnAwarenessClient(
    entry: ArtifactRoomReplicaEntry,
    clientId: number,
  ): boolean {
    return (
      clientId === entry.awareness.clientID ||
      clientId === entry.relayedLocalClientId
    );
  }

  /** Any awareness client other than our own local ones. */
  function hasRemotePeers(entry: ArtifactRoomReplicaEntry): boolean {
    for (const clientId of entry.awareness.getStates().keys()) {
      if (!isOwnAwarenessClient(entry, clientId)) return true;
    }
    return false;
  }

  /** True when the room must stay materialized; ignoring any arm costs correctness rather than memory. */
  /** Pin arms that survive a released lease: local divergence and remote presence. Settle must not consult the lease arm. */
  function isPinnedByTierState(entry: ArtifactRoomReplicaEntry): boolean {
    if (hasRemotePeers(entry)) return true;
    return (
      entry.dirtyWatermarkStateVectorBase64 !== null ||
      entry.pendingReconcileUpdate !== null ||
      entry.pendingUpdates.length > 0
    );
  }

  function isPinned(artifactRoomId: string): boolean {
    if (leaseCountOf(artifactRoomId) > 0) return true;
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return false;
    return isPinnedByTierState(entry);
  }

  function getOrCreateReplica(
    artifactRoomId: string,
  ): ArtifactRoomReplicaEntry {
    const existing = replicas.get(artifactRoomId);
    if (existing !== undefined) return existing;
    const replicaDoc = new Y.Doc();
    const replicaAwareness = new Awareness(replicaDoc);
    const docUpdateHandler = (update: Uint8Array, origin: unknown): void => {
      // Host-originated applies must not be echoed; locally-originated
      // edits become outbound `artifactRoomApplyUpdate` frames.
      if (origin === BIN_STREAM_ORIGIN) return;
      const role = session.permissionRole();
      if (!isWritablePermissionRole(role)) {
        // Permission downgrade - fail-closed: stop sending and drop any
        // queued writes that have not been confirmed by a snapshot.
        const replica = replicas.get(artifactRoomId);
        if (replica !== undefined) {
          clearPendingRoomUpdates(replica);
          replica.pendingReconcileUpdate = null;
          replica.dirtyWatermarkStateVectorBase64 = null;
        }
        onDivergenceChanged();
        // The clear above removed this room's dirty pin - re-arm the linger so
        // an unleased room is not stranded hot.
        scheduleCooldown(artifactRoomId);
        return;
      }
      // Mark the replica dirty against the host's last-seen view.
      const replica = replicas.get(artifactRoomId);
      if (replica !== undefined) {
        replica.dirtyWatermarkStateVectorBase64 = encodeDocStateVectorBase64(
          replica.doc,
        );
      }
      onDivergenceChanged();
      // MEASURED BEFORE THE SEND, and this is not defensive style.
      const updateBytes = update.byteLength;
      if (session.canSendBodyWrites()) {
        // COPIED, because Yjs owns this update and hands the SAME array to every observer.
        const outboundUpdate = update.slice();
        const outcome = send({
          kind: "room-update",
          artifactRoomId,
          update: outboundUpdate,
        });
        if (outcome.kind === "sent") {
          noteHotGrowth(artifactRoomId, updateBytes);
          return;
        }
        // The session may write and this BODY still could not. Fall through to the queue rather than
        // treating the refusal as delivery.
      }
      // Queue while reconnecting/closed, or while a raw-open stream is still waiting on its fresh root
      // snapshot/permission role.
      if (replica !== undefined) {
        pushPendingRoomUpdate(replica, update);
        noteHotGrowth(artifactRoomId, updateBytes);
      }
    };
    const awarenessUpdateHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === BIN_AWARENESS_REMOTE_ORIGIN) return;
      const role = session.permissionRole();
      if (role === "viewer" || role === null) return;
      if (session.transportStatus() !== "open") return;
      const touched = changes.added
        .concat(changes.updated)
        .concat(changes.removed);
      if (touched.length === 0) return;
      send({
        kind: "room-awareness",
        artifactRoomId,
        frame: encodeAwarenessUpdate(replicaAwareness, touched),
      });
    };
    replicaDoc.on("update", docUpdateHandler);
    replicaAwareness.on("update", awarenessUpdateHandler);
    const entry: ArtifactRoomReplicaEntry = {
      doc: replicaDoc,
      awareness: replicaAwareness,
      relayedLocalClientId: null,
      docUpdateHandler,
      awarenessUpdateHandler,
      pendingUpdates: [],
      pendingBytes: 0,
      pendingBytesSinceCollapse: 0,
      pendingReconcileUpdate: null,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64: null,
      hotBytesSinceSettle: 0,
    };
    replicas.set(artifactRoomId, entry);
    return entry;
  }

  function destroyReplica(artifactRoomId: string): void {
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return;
    entry.doc.off("update", entry.docUpdateHandler);
    entry.awareness.off("update", entry.awarenessUpdateHandler);
    entry.awareness.destroy();
    entry.doc.destroy();
    replicas.delete(artifactRoomId);
  }

  /**
   * Encode the room's currently-known REMOTE peers as a single awareness update, for replay after a
   * demote.
   */
  function encodePeerAwareness(entry: ArtifactRoomReplicaEntry): Uint8Array[] {
    const remote = Array.from(entry.awareness.getStates().keys()).filter(
      (clientId) => !isOwnAwarenessClient(entry, clientId),
    );
    if (remote.length === 0) return [];
    return [encodeAwarenessUpdate(entry.awareness, remote)];
  }

  /**
   * Compact a cold room's buffered frames into a single garbage-collected update. `Y.mergeUpdates`
   * alone concatenates history losslessly, keeping the CONTENT of every deleted item.
   */
  function compactColdBytes(updates: Uint8Array[]): Uint8Array {
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, Y.mergeUpdates(updates));
      return Y.encodeStateAsUpdate(scratch);
    } finally {
      scratch.destroy();
    }
  }

  function pushColdUpdate(
    entry: ColdArtifactRoomEntry,
    update: Uint8Array,
  ): void {
    entry.updates.push(update);
    entry.bytes += update.byteLength;
    entry.bytesSinceCollapse += update.byteLength;
    if (entry.updates.length < 2) return;
    if (
      entry.bytesSinceCollapse <= COLD_ROOM_COLLAPSE_BYTES &&
      entry.updates.length <= COLD_ROOM_COLLAPSE_ENTRIES
    ) {
      return;
    }
    const compacted = compactColdBytes(entry.updates);
    entry.updates.length = 0;
    entry.updates.push(compacted);
    entry.bytes = compacted.byteLength;
    entry.bytesSinceCollapse = 0;
  }

  function recordColdBytes(
    artifactRoomId: string,
    update: Uint8Array,
    hostStateVectorBase64: string | null,
  ): void {
    const existing = cold.get(artifactRoomId);
    if (existing === undefined) {
      cold.set(artifactRoomId, {
        updates: [update],
        bytes: update.byteLength,
        bytesSinceCollapse: 0,
        latestHostStateVectorBase64: hostStateVectorBase64,
        awarenessFrames: [],
      });
      notifyCold(artifactRoomId, update.byteLength);
      return;
    }
    pushColdUpdate(existing, update);
    if (hostStateVectorBase64 !== null) {
      existing.latestHostStateVectorBase64 = hostStateVectorBase64;
    }
    notifyCold(artifactRoomId, existing.bytes);
  }

  function recordColdAwareness(
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ): void {
    const entry = cold.get(artifactRoomId);
    // Only rooms the host has actually snapshotted are worth holding presence for - a room awaiting
    // its seed cannot be materialized, so there is nothing to replay into.
    if (entry === undefined) return;
    entry.awarenessFrames.push(awarenessBytes);
    while (entry.awarenessFrames.length > COLD_ROOM_AWARENESS_FRAMES) {
      entry.awarenessFrames.shift();
    }
  }

  function touch(artifactRoomId: string): void {
    touchSeq.set(artifactRoomId, touchCounter.next());
  }

  function cancelCooldown(artifactRoomId: string): void {
    const timer = cooldownTimers.get(artifactRoomId);
    if (timer === undefined) return;
    timer.cancel();
    cooldownTimers.delete(artifactRoomId);
  }

  /**
   * Encode a materialized room back down to update bytes and drop its doc.
   * Returns false when the room is pinned or was not hot to begin with.
   */
  function coolReplica(artifactRoomId: string): boolean {
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return false;
    if (isPinned(artifactRoomId)) return false;
    // Encode the whole replica, not just the frames we happened to receive: the doc is the merge of
    // the host snapshot plus every update since, and its state-as-update is the smallest lossless
    const encoded = Y.encodeStateAsUpdate(entry.doc);
    const latestHostStateVectorBase64 = entry.latestHostStateVectorBase64;
    // Peers read BEFORE the teardown.
    const awarenessFrames = encodePeerAwareness(entry);
    destroyReplica(artifactRoomId);
    cold.set(artifactRoomId, {
      updates: [encoded],
      bytes: encoded.byteLength,
      bytesSinceCollapse: 0,
      latestHostStateVectorBase64,
      // Carry the peers this replica currently knows about across the demote,
      // so cooling a room does not blank presence when it comes back.
      awarenessFrames,
    });
    unchargeHot(artifactRoomId);
    notifyCold(artifactRoomId, encoded.byteLength);
    return true;
  }

  /** Arm the linger timer for a room nothing is holding. */
  function scheduleCooldown(artifactRoomId: string): void {
    if (isDisposed() || tierDisposed) return;
    if (isPinned(artifactRoomId)) return;
    if (!replicas.has(artifactRoomId)) return;
    if (cooldownTimers.has(artifactRoomId)) return;
    const timer = environment.scheduler.schedule(
      ARTIFACT_ROOM_LEASE_POLICY.cooldownMs,
      () => {
        cooldownTimers.delete(artifactRoomId);
        if (isDisposed() || tierDisposed) return;
        coolReplica(artifactRoomId);
      },
    );
    cooldownTimers.set(artifactRoomId, timer);
  }

  function enforceHotCap(): void {
    while (replicas.size > ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized) {
      let victim: string | null = null;
      let victimSeq = Number.POSITIVE_INFINITY;
      for (const id of replicas.keys()) {
        if (isPinned(id)) continue;
        const seq = touchSeq.get(id) ?? 0;
        if (seq < victimSeq) {
          victimSeq = seq;
          victim = id;
        }
      }
      if (victim === null) return;
      cancelCooldown(victim);
      if (!coolReplica(victim)) return;
    }
  }

  /** Re-arm the linger after materializing, in case nothing pinned the room. */
  function armCooldownForUnleasedMaterialization(artifactRoomId: string): void {
    scheduleCooldown(artifactRoomId);
  }

  /**
   * Bring a room back up to a live `Y.Doc`, or return `null` when the room has no content to bring
   * up.
   */
  function materialize(
    artifactRoomId: string,
  ): ArtifactRoomReplicaEntry | null {
    touch(artifactRoomId);
    cancelCooldown(artifactRoomId);
    const hot = replicas.get(artifactRoomId);
    if (hot !== undefined) {
      armCooldownForUnleasedMaterialization(artifactRoomId);
      return hot;
    }
    const coldEntry = cold.get(artifactRoomId);
    if (coldEntry === undefined) return null;
    const entry = getOrCreateReplica(artifactRoomId);
    cold.delete(artifactRoomId);
    // `BIN_STREAM_ORIGIN` so the replay does not read as a local edit and get
    // echoed back to the host as an outbound update.
    Y.applyUpdate(
      entry.doc,
      Y.mergeUpdates(coldEntry.updates),
      BIN_STREAM_ORIGIN,
    );
    entry.latestHostStateVectorBase64 = coldEntry.latestHostStateVectorBase64;
    // Replay presence that arrived while the room was cold, so a peer already in the body is visible
    // immediately rather than after their next renewal.
    for (const frame of coldEntry.awarenessFrames) {
      applyAwarenessUpdate(entry.awareness, frame, BIN_AWARENESS_REMOTE_ORIGIN);
    }
    notifyHot(artifactRoomId, Y.encodeStateAsUpdate(entry.doc).byteLength);
    notifyCold(artifactRoomId, 0);
    enforceHotCap();
    armCooldownForUnleasedMaterialization(artifactRoomId);
    return entry;
  }

  function grantLease(artifactRoomId: string): LeaseHandle {
    let released = false;
    return {
      resourceId: artifactRoomId,
      /** Released individually, OR by the registry going terminal. */
      isReleased: () => released || tierDisposed,
      release(): void {
        // A release after dispose is a no-op, not a decrement.
        if (released || tierDisposed) return;
        released = true;
        const remaining = (leases.get(artifactRoomId) ?? 1) - 1;
        if (remaining > 0) {
          leases.set(artifactRoomId, remaining);
          return;
        }
        leases.delete(artifactRoomId);
        scheduleCooldown(artifactRoomId);
      },
    };
  }

  function acquireSync(
    artifactRoomId: string,
  ): LeaseGrant<ArtifactRoomReplicaEntry> {
    if (tierDisposed || isDisposed()) {
      // The only arm with no lease, because it is the only one that registered
      // no demand.
      return { kind: "unavailable", reason: "tier-disposed" };
    }
    leases.set(artifactRoomId, (leases.get(artifactRoomId) ?? 0) + 1);
    const resource = materialize(artifactRoomId);
    const lease = grantLease(artifactRoomId);
    if (resource === null) {
      // Ready, but nothing to bring up yet. The holder releases this exactly as it would a granted one,
      // and the next snapshot materialises the room under the demand already counted here.
      return { kind: "awaiting-seed", lease };
    }
    return { kind: "granted", lease, resource };
  }

  function flushPending(artifactRoomId: string): void {
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return;
    if (session.transportStatus() !== "open") return;
    if (!session.hasFreshRootSnapshotForOpenCycle()) return;
    const role = session.permissionRole();
    if (!isWritablePermissionRole(role)) {
      clearPendingRoomUpdates(entry);
      entry.pendingReconcileUpdate = null;
      entry.dirtyWatermarkStateVectorBase64 = null;
      onDivergenceChanged();
      // Dropping the dirty state just removed this room's last non-lease pin.
      scheduleCooldown(artifactRoomId);
      return;
    }
    // Flush the snapshot-derived reconcile first (if any).
    const reconcile = entry.pendingReconcileUpdate;
    if (reconcile !== null) {
      entry.pendingReconcileUpdate = null;
      const outcome = send({
        kind: "room-update",
        artifactRoomId,
        update: reconcile,
      });
      // Put it back. The gates above are EPIC-level - transport open, fresh root snapshot, writable role
      // - and on the lane arm they can all hold while this body's own lane is still unseeded.
      if (outcome.kind !== "sent") {
        entry.pendingReconcileUpdate = reconcile;
        scheduleCooldown(artifactRoomId);
        return;
      }
    }
    if (entry.pendingUpdates.length === 0) {
      // The reconcile above may have been the last pin.
      scheduleCooldown(artifactRoomId);
      return;
    }
    const pending = takePendingRoomUpdates(entry);
    for (let index = 0; index < pending.length; index += 1) {
      const update = pending[index];
      const outcome = send({ kind: "room-update", artifactRoomId, update });
      if (outcome.kind === "sent") continue;
      // Re-queue this one AND everything after it, in order, then stop.
      for (let rest = index; rest < pending.length; rest += 1) {
        pushPendingRoomUpdate(entry, pending[rest]);
      }
      scheduleCooldown(artifactRoomId);
      return;
    }
    // Everything queued is now in flight; if no lease holds this room it is
    // free to cool again.
    scheduleCooldown(artifactRoomId);
  }

  return {
    acquire(
      artifactRoomId: string,
    ): Promise<LeaseGrant<ArtifactRoomReplicaEntry>> {
      return Promise.resolve(acquireSync(artifactRoomId));
    },

    acquireSync,

    peek: (artifactRoomId) => replicas.get(artifactRoomId) ?? null,
    leaseCount: leaseCountOf,
    materializedIds: () => Array.from(replicas.keys()),

    demoteIdle(): void {
      for (const id of Array.from(replicas.keys())) {
        cancelCooldown(id);
        coolReplica(id);
      }
    },

    demoteColdestUnpinned(overBytes: number): HotDocEvictionOutcome {
      let remaining = overBytes;
      let reclaimed = 0;
      while (remaining > 0) {
        let victim: string | null = null;
        let victimSeq = Number.POSITIVE_INFINITY;
        for (const id of replicas.keys()) {
          if (isPinned(id)) continue;
          const seq = touchSeq.get(id) ?? 0;
          if (seq < victimSeq) {
            victimSeq = seq;
            victim = id;
          }
        }
        if (victim === null) break;
        // Settled + provisional: `accountant.release` drops the whole HolderCharge, and
        // `hotBytesSinceSettle` is lockstep with `chargeProvisional`.
        const charged = hotHolderBytes(victim);
        cancelCooldown(victim);
        if (!coolReplica(victim)) break;
        reclaimed += charged;
        remaining -= charged;
      }
      let leasedBytes = 0;
      for (const id of replicas.keys()) {
        if (!isPinned(id)) continue;
        leasedBytes += hotHolderBytes(id);
      }
      return {
        reclaimedBytes: reclaimed,
        // ZERO, and it must stay zero: this tier does the demotion before it returns, so everything it
        // accepted is already in `reclaimedBytes`. Deferral exists only across the worker boundary.
        deferredBytes: 0,
        protectedBytesByKind:
          leasedBytes > 0 ? [{ kind: "leased", bytes: leasedBytes }] : [],
      };
    },

    hasDivergence(): boolean {
      for (const entry of replicas.values()) {
        if (entry.dirtyWatermarkStateVectorBase64 !== null) return true;
        if (entry.pendingReconcileUpdate !== null) return true;
        if (entry.pendingUpdates.length > 0) return true;
      }
      return false;
    },

    statedDocGuid(artifactRoomId) {
      return docGuidByRoom.get(artifactRoomId) ?? null;
    },

    encodeColdState(artifactRoomId) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return null;
      const docGuid = docGuidByRoom.get(artifactRoomId);
      // No stated identity means no transferable state, for the same reason a seed offer needs one:
      // bytes whose document cannot be identified cannot be safely settled back.
      if (docGuid === undefined) return null;
      return {
        update: Y.encodeStateAsUpdate(entry.doc),
        // Always `"full"` here.
        seedMode: "full",
        hostStateVector: entry.latestHostStateVectorBase64,
        docGuid,
      };
    },

    settleColdState(artifactRoomId, update, expectedDocGuid) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return { accepted: false, reason: "not-held" };
      const docGuid = docGuidByRoom.get(artifactRoomId);
      if (docGuid === undefined || docGuid !== expectedDocGuid) {
        // The body was replaced while these bytes were in flight.
        return { accepted: false, reason: "newer-generation" };
      }
      // PINNED: this room must stay materialized, and settling would cool it.
      if (isPinnedByTierState(entry)) {
        return { accepted: false, reason: "pinned" };
      }
      Y.applyUpdate(entry.doc, update);
      // Measured from what is STORED, never from the input.
      return {
        accepted: true,
        settledBytes: Y.encodeStateAsUpdate(entry.doc).byteLength,
      };
    },

    readDocSeedOffer(artifactRoomId) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return null;
      const knownDocGuid = docGuidByRoom.get(artifactRoomId);
      // No stated identity means no offer.
      if (knownDocGuid === undefined) return null;
      return {
        knownDocGuid,
        stateVectorBase64: encodeDocStateVectorBase64(entry.doc),
      };
    },

    applySnapshot(input) {
      const {
        artifactRoomId,
        snapshotBytes,
        hostStateVectorBase64,
        seed,
        docGuid,
      } = input;
      // ── Doc identity, before anything is applied ────────────────────────── A deleted-and-recreated
      // artifact arrives under the SAME id with a new guid, and its history shares no ancestor with what
      if (seedReplacesHeldDoc(artifactRoomId, docGuid)) {
        discardEverythingFor(artifactRoomId);
      }
      if (docGuid !== null) docGuidByRoom.set(artifactRoomId, docGuid);
      // A room nobody is editing never materializes: keep the bytes and let the caller flip availability
      // so the tile can render its state, and let the first lease pay for the `Y.Doc`.
      if (!replicas.has(artifactRoomId) && leaseCountOf(artifactRoomId) === 0) {
        // A delta is only meaningful against the replica that made the offer, and there is no replica
        // here.
        if (seed === "delta-against-offer") return "filed-cold";
        recordColdBytes(artifactRoomId, snapshotBytes, hostStateVectorBase64);
        return "filed-cold";
      }
      // Reuse any prior replica for this artifactRoom so a snapshot during reconnect/recovery does NOT
      // destroy local in-flight edits.
      const hadPrior = replicas.has(artifactRoomId);
      const entry = getOrCreateReplica(artifactRoomId);
      Y.applyUpdate(entry.doc, snapshotBytes, BIN_STREAM_ORIGIN);
      if (hostStateVectorBase64 !== null) {
        entry.latestHostStateVectorBase64 = hostStateVectorBase64;
      }
      reconcileAfterSnapshot(entry, artifactRoomId, hostStateVectorBase64);
      // A snapshot with no watermark proves nothing about what the host has durably seen, so it cannot
      // clear the dirty mark: the room stays dirty until one carrying a vector covers it.
      if (
        hostStateVectorBase64 !== null &&
        latestHostCoversDirtyWatermark(
          hostStateVectorBase64,
          entry.dirtyWatermarkStateVectorBase64,
        )
      ) {
        entry.dirtyWatermarkStateVectorBase64 = null;
      }
      if (!hadPrior) {
        notifyHot(artifactRoomId, Y.encodeStateAsUpdate(entry.doc).byteLength);
        notifyCold(artifactRoomId, 0);
      } else {
        // Merge arm: a leased room surviving reconnect absorbs the host's whole re-snapshot - the largest
        // single growth event a room sees.
        noteHotGrowth(artifactRoomId, snapshotBytes.byteLength);
      }
      return hadPrior ? "merged" : "seeded";
    },

    applyUpdate(artifactRoomId, updateBytes, hostStateVectorBase64, docGuid) {
      // BEFORE the hot path and before the cold one, because both are ways of
      // keeping the bytes. See {@link namesASupersededDoc}.
      if (namesASupersededDoc(artifactRoomId, docGuid)) return;
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) {
        // Cold room: accumulate the bytes rather than materializing a doc for a body nothing is
        // displaying.
        const coldEntry = cold.get(artifactRoomId);
        if (coldEntry === undefined) return;
        pushColdUpdate(coldEntry, updateBytes);
        if (hostStateVectorBase64 !== null) {
          coldEntry.latestHostStateVectorBase64 = hostStateVectorBase64;
        }
        notifyCold(artifactRoomId, coldEntry.bytes);
        return;
      }
      Y.applyUpdate(entry.doc, updateBytes, BIN_STREAM_ORIGIN);
      if (hostStateVectorBase64 !== null) {
        entry.latestHostStateVectorBase64 = hostStateVectorBase64;
      }
      noteHotGrowth(artifactRoomId, updateBytes.byteLength);
      // Same fail-closed reading as the snapshot path, and redundant for the same reason - stated here
      // because this is where getting it wrong loses a user's edit.
      if (
        hostStateVectorBase64 !== null &&
        latestHostCoversDirtyWatermark(
          hostStateVectorBase64,
          entry.dirtyWatermarkStateVectorBase64,
        )
      ) {
        entry.dirtyWatermarkStateVectorBase64 = null;
      }
      onDivergenceChanged();
      scheduleCooldown(artifactRoomId);
    },

    applyCoverage(artifactRoomId, coverageStateVectorBase64, docGuid) {
      if (namesASupersededDoc(artifactRoomId, docGuid)) return;
      // The authority stating how much of what THIS client pushed it now has.
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return;
      entry.latestHostStateVectorBase64 = coverageStateVectorBase64;
      if (
        latestHostCoversDirtyWatermark(
          coverageStateVectorBase64,
          entry.dirtyWatermarkStateVectorBase64,
        )
      ) {
        entry.dirtyWatermarkStateVectorBase64 = null;
      }
      onDivergenceChanged();
      scheduleCooldown(artifactRoomId);
    },

    applyAwareness(artifactRoomId, awarenessBytes) {
      // Apply inbound awareness to the artifact-room-scoped Awareness instance, NOT the root Epic
      // awareness.
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) {
        // Cold room: retain the frame rather than dropping it. Without this a collaborator already present
        // in a room this client has never opened stays invisible until their next renewal.
        recordColdAwareness(artifactRoomId, awarenessBytes);
        return;
      }
      applyAwarenessUpdate(
        entry.awareness,
        awarenessBytes,
        BIN_AWARENESS_REMOTE_ORIGIN,
      );
      // A peer leaving can drop the presence pin that was holding this room hot, so re-test it here
      // rather than waiting for a doc frame that may never come.
      scheduleCooldown(artifactRoomId);
    },
    encodeRoomPeerAwareness(artifactRoomId): readonly Uint8Array[] {
      const entry = replicas.get(artifactRoomId);
      return entry === undefined ? [] : encodePeerAwareness(entry);
    },
    isRoomPinnedByTierState(artifactRoomId): boolean {
      const entry = replicas.get(artifactRoomId);
      // Not materialized: nothing to pin. A room with no replica cannot be
      // divergent and holds no presence.
      return entry === undefined ? false : isPinnedByTierState(entry);
    },
    relayLocalUpdate(artifactRoomId, update): boolean {
      const entry = replicas.get(artifactRoomId);
      // Cold room: DROP.
      if (entry === undefined) return false;
      // A LOCAL origin, which here means "anything but `BIN_STREAM_ORIGIN`".
      Y.applyUpdate(entry.doc, update, BIN_AWARENESS_RELAYED_LOCAL_ORIGIN);
      return true;
    },
    relayLocalAwareness(artifactRoomId, awarenessBytes, localClientId) {
      const entry = replicas.get(artifactRoomId);
      // Cold room: DROP, deliberately, where `applyAwareness` retains.
      if (entry === undefined) return;
      if (
        entry.relayedLocalClientId !== null &&
        entry.relayedLocalClientId !== localClientId
      ) {
        // The main-side identity CHANGED - a rematerialize builds a fresh `Y.Doc`, and `Awareness` takes
        // its `clientID` from the doc.
        removeAwarenessStates(
          entry.awareness,
          [entry.relayedLocalClientId],
          BIN_AWARENESS_RELAYED_LOCAL_ORIGIN,
        );
      }
      entry.relayedLocalClientId = localClientId;
      // LOCAL origin - see `BIN_AWARENESS_RELAYED_LOCAL_ORIGIN`.
      applyAwarenessUpdate(
        entry.awareness,
        awarenessBytes,
        BIN_AWARENESS_RELAYED_LOCAL_ORIGIN,
      );
    },
    observeAwareness(artifactRoomId, onFrame) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return () => {};
      const handler = (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ): void => {
        // Do not hand the main thread back the presence it just relayed IN.
        if (origin === BIN_AWARENESS_RELAYED_LOCAL_ORIGIN) return;
        const touched = changes.added
          .concat(changes.updated)
          .concat(changes.removed);
        if (touched.length === 0) return;
        onFrame(encodeAwarenessUpdate(entry.awareness, touched));
      };
      entry.awareness.on("update", handler);
      // NO initial push from here. It belongs with the materialize RESPONSE instead - see
      // `encodeRoomPeerAwareness`.
      return () => {
        entry.awareness.off("update", handler);
      };
    },

    invalidate(artifactRoomId) {
      // A artifactRoom transitioning out of `ready` invalidates the local replica - the next
      // `artifactRoomSnapshot` will rebuild.
      discardEverythingFor(artifactRoomId);
    },

    scheduleCooldownCheck: scheduleCooldown,

    flushPending,

    flushAllPending(): void {
      for (const id of Array.from(replicas.keys())) {
        flushPending(id);
      }
    },

    /**
     * Each clear removes the divergence that was pinning that room, so each one has to re-arm the
     * linger timer: `scheduleCooldown` is otherwise only reachable from a lease release or an inbound
     */
    clearAllPending(): void {
      for (const [artifactRoomId, entry] of replicas) {
        clearPendingRoomUpdates(entry);
        entry.pendingReconcileUpdate = null;
        entry.dirtyWatermarkStateVectorBase64 = null;
        scheduleCooldown(artifactRoomId);
      }
    },

    destroyAll(): void {
      const hotIds = Array.from(replicas.keys());
      const coldIds = Array.from(cold.keys());
      for (const id of hotIds) {
        destroyReplica(id);
      }
      for (const timer of cooldownTimers.values()) {
        timer.cancel();
      }
      cooldownTimers.clear();
      cold.clear();
      touchSeq.clear();
      lastHotBytes.clear();
      // Unlike `invalidate`, this IS the end of what the tier knows: the plane above runs it on
      // replacement, reseed and teardown, where the next snapshot rebuilds from nothing and has no held
      docGuidByRoom.clear();
      for (const id of hotIds) {
        unchargeHot(id);
      }
      for (const id of coldIds) {
        notifyCold(id, 0);
      }
      // Leases are deliberately NOT cleared: they are owned by mounted editors, which survive a replica
      // swap / resubscribe and will re-materialize their room from the next snapshot.
    },

    dispose(): void {
      tierDisposed = true;
      const hotIds = Array.from(replicas.keys());
      const coldIds = Array.from(cold.keys());
      for (const id of hotIds) {
        destroyReplica(id);
      }
      for (const timer of cooldownTimers.values()) {
        timer.cancel();
      }
      cooldownTimers.clear();
      cold.clear();
      touchSeq.clear();
      leases.clear();
      lastHotBytes.clear();
      for (const id of hotIds) {
        unchargeHot(id);
      }
      for (const id of coldIds) {
        notifyCold(id, 0);
      }
    },
  };
}
