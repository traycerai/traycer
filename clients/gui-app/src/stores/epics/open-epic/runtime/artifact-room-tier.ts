/**
 * The artifact-body hot/cold tier: which rooms are live `Y.Doc`s, which are
 * encoded bytes, and what pins one against being demoted.
 *
 * Re-homed from the open-epic closure - two maps, three side tables, a counter,
 * eight constants and twenty-two closures, `store.ts:1204-1917`. **Moved, not
 * rewritten.** The tuning here is load-bearing and has history: the hot cap was
 * 8 and evicted on ordinary scrolling, the collapse triggers latch on
 * bytes-since-collapse rather than total bytes for a reason that is written
 * down at each of them, and the pin predicate has three arms that each cost
 * correctness rather than memory if dropped. Every one of those comments came
 * with the code.
 *
 * What DID change: `window.setTimeout` became the injected scheduler, and the
 * LRU counter became the shared `MonotonicSequence`. Both are worker-portability
 * requirements, and the second is the same counter with the same reason - a
 * counter rather than a clock so eviction order is deterministic under fake
 * timers.
 *
 * ## The lease surface, and the one signature that is still local
 *
 * This IS the shared `LeaseRegistry`, and its demand book is the only one -
 * `leaseCount` is what the seeding path below asks to decide whether an
 * arriving snapshot materialises hot or is filed cold, rather than any counter
 * of its own.
 *
 * The `"awaiting-seed"` grant is the arm that matters here and it carries a
 * lease. A room reports `ready` on first observation independently of any
 * snapshot, so an editor can mount on a room with no bytes anywhere; the demand
 * it registers is what makes the NEXT `artifactRoomSnapshot` materialise the
 * room instead of filing it cold. A grant that withheld the lease until bytes
 * existed would strand that editor.
 *
 * `acquireSync` exists beside the contract's async `acquire` for exactly one
 * reason: today's call site - the store's `acquireArtifactBodyLease` - is
 * synchronous, and the shared interface is async because materialising will
 * mean transferring bytes across a thread boundary once the cold tier moves
 * into a worker. There is still ONE implementation; `acquire` awaits nothing
 * and only wraps it, so the two cannot drift. The worker relocation deletes the
 * sync one and makes its caller async.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type {
  LeaseGrant,
  LeaseHandle,
  LeasePolicy,
  MonotonicSequence,
  RuntimeEnvironment,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
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

/**
 * Per-artifact-room Y.Doc replicas mirroring the host-side artifact-rooms. The
 * runtime treats these as the GUI-side authority for artifact body fragments;
 * editors bind to `artifactRoom.doc.getXmlFragment(artifact-body:{id})` rather
 * than to anything inside the root Epic doc (per Decision 7 in the artifact-room
 * approach spec). Kept outside any projection because `Y.Doc` mutates in place
 * and cannot cross a structured clone - the rooms plane publishes its own
 * availability slice and binding epoch for reactivity instead, and callers reach
 * the live fragment through the runtime's escape hatches.
 */
export interface ArtifactRoomReplicaEntry {
  doc: Y.Doc;
  awareness: Awareness;
  docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  /**
   * Local artifact-room-body updates produced while the stream is not ready to
   * send are queued here and replayed once the fresh root snapshot confirms
   * write permission. This mirrors the root-doc unsynced queue so reconnect
   * windows do not silently discard user edits - see ticket
   * 4a598302-ac79-47a5-a686-cc9e35bde18b "GUI artifact-room-doc awareness and
   * reconnect-safe body edits".
   *
   * On viewer downgrade the queue is cleared (fail-closed). When a
   * `artifactRoomSnapshot` arrives, the queue is collapsed into a single
   * merged-replica reconcile - sent immediately only after the current open
   * cycle has received a fresh root snapshot/permission role, or stashed in
   * `pendingReconcileUpdate` until that root snapshot confirms owner/editor
   * permission.
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
   * not ready to send (the stream is not `open`, or the current open cycle has
   * not received a fresh root snapshot/permission role). The next owner/editor
   * root snapshot flushes this single update before draining `pendingUpdates`.
   * The reconcile is derived from the merged local replica's state-as-update
   * against the host's state vector at snapshot time, so it subsumes every local
   * artifact-room-body edit produced during the reconnect window.
   *
   * Cleared on viewer/null downgrade (fail-closed), on a successful send, and
   * on artifactRoom destruction.
   */
  pendingReconcileUpdate: Uint8Array | null;
  /**
   * Local dirty watermark for the artifactRoom replica (base64 state vector at
   * the time of the most recent local edit). `null` when there is no
   * outstanding local divergence.
   */
  dirtyWatermarkStateVectorBase64: string | null;
  /**
   * Latest host-side artifactRoom state vector observed via `artifactRoomSnapshot`
   * or `artifactRoomUpdate` - base64. Compared against the watermark to clear
   * dirty state once the host catches up.
   */
  latestHostStateVectorBase64: string | null;
}

/**
 * A room the host has sent us, held as encoded update bytes with no live
 * `Y.Doc` behind it.
 *
 * This is the memory-shaped half of the artifact-room cache. Yjs retains one
 * `Item` struct per edit for the lifetime of a doc - garbage collection only
 * collapses deleted *content*, never the structs - so a room an agent has
 * rewritten a few hundred times costs O(edits) live objects while it is
 * materialized, but only O(body) bytes once it is encoded back down. A renderer
 * that materialized every room the host opened was paying the former for rooms
 * nothing was looking at.
 *
 * Cold rooms are read-only by construction: the only writer of a room doc is a
 * bound editor, and a bound editor holds a lease that keeps its room hot.
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
  /**
   * Recent remote awareness frames, replayed when the room materializes.
   *
   * A cold room has no `Awareness` instance, so inbound presence frames would
   * otherwise be dropped and a collaborator already sitting in the body would
   * be invisible when the local user finally opens it. Bounded because these
   * arrive continuously: y-protocols renews each client's state every
   * `outdatedTimeout / 2` (15s), so the newest few frames always cover every
   * currently-present peer, and anything staler than `outdatedTimeout` is culled
   * by Awareness itself after replay.
   */
  awarenessFrames: Uint8Array[];
}

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
 * The tier's lease policy, in the shared vocabulary.
 *
 * `cooldownMs` - how long a room stays materialized after its last editor
 * unmounts. Tile remounts (tab switches, canvas virtualization, a re-render that
 * swaps the editor) are common and re-materializing costs a full
 * `Y.applyUpdate` of the body, so an immediate demote would trade memory for
 * visible latency.
 *
 * `maxMaterialized` - a backstop ceiling, NOT the reclaim mechanism; the linger
 * timer is. The cap only exists so a pathological epic cannot hold an unbounded
 * number of rooms hot inside the linger window. It is set well above a realistic
 * canvas viewport on purpose: at 8 it evicted on ordinary scrolling of a large
 * epic, so every scroll-in paid a full `Y.encodeStateAsUpdate` of the evicted
 * body and every scroll-back paid a compaction plus `Y.applyUpdate` of its own -
 * churn that cost more than the memory it reclaimed. A pinned room is never
 * evicted, so the cap can still be exceeded by editors genuinely in use. Treat a
 * lower value here as a regression, not a tightening.
 */
export const ARTIFACT_ROOM_LEASE_POLICY: LeasePolicy = {
  cooldownMs: 60_000,
  maxMaterialized: 32,
};

/**
 * What a room snapshot did, and therefore what the plane above owes.
 *
 * Three outcomes rather than a boolean, because the three differ in more than
 * degree and the differences are exactly the ones a boolean loses:
 *
 * - `"filed-cold"` — nothing is watching this room, so the bytes were cached
 *   and no `Y.Doc` was built. Availability still flips to `ready` so the tile
 *   can render, but there is no binding to invalidate, no divergence to
 *   recompute (a cold room has no local edits by construction) and no linger to
 *   re-arm.
 * - `"merged"` — a live replica already existed and the host's bytes were
 *   merged onto it. Bindings are UNCHANGED and must stay so: the editor stays
 *   mounted and the user's typing is uninterrupted.
 * - `"seeded"` — a lease was waiting and this snapshot built the room. A newly
 *   materialised doc is a new fragment identity, so anything bound by reference
 *   has to rebind even though availability did not move.
 */
export type RoomSnapshotOutcome = "filed-cold" | "merged" | "seeded";

export interface ArtifactRoomTierSources {
  readonly environment: RuntimeEnvironment;
  readonly session: EpicSessionFacts;
  /**
   * The outbound half. Returns what the transport did with the frame; the tier
   * has already decided the frame may go, so the outcome is diagnostic here and
   * the queueing decision stays above it.
   */
  readonly send: (request: EpicOutboundRequest) => void;
  /**
   * A room's local divergence moved. The records plane folds room dirtiness
   * into the renderer-local `isDirty` it publishes, so it has to be told.
   */
  readonly onDivergenceChanged: () => void;
  readonly isDisposed: () => boolean;
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
  /**
   * Read an ALREADY materialised room without taking a lease or affecting
   * recency. `null` covers both "cold" and "unknown" and callers must not
   * distinguish them - a reader that materialised on peek is how a passive
   * projection ends up pinning the whole working set.
   */
  peek(artifactRoomId: string): ArtifactRoomReplicaEntry | null;
  leaseCount(artifactRoomId: string): number;
  /** Ids currently materialised as live `Y.Doc`s. */
  materializedIds(): readonly string[];
  /** Demote everything demotable right now, ignoring cooldowns. */
  demoteIdle(): void;

  /** Whether the tier holds any unsent or unacknowledged local body state. */
  hasDivergence(): boolean;

  // ── Inbound frames ──────────────────────────────────────────────────────
  applySnapshot(
    artifactRoomId: string,
    snapshotBytes: Uint8Array,
    hostStateVectorBase64: string,
  ): RoomSnapshotOutcome;
  applyUpdate(
    artifactRoomId: string,
    updateBytes: Uint8Array,
    hostStateVectorBase64: string,
  ): void;
  applyAwareness(artifactRoomId: string, awarenessBytes: Uint8Array): void;
  /** A room leaving `ready` invalidates both its hot and cold copies. */
  invalidate(artifactRoomId: string): void;
  /**
   * Re-test the linger arm for one room.
   *
   * The pin predicate is re-evaluated on every inbound frame, so a room that
   * finishes syncing after its editor closed still cools rather than staying
   * hot forever. Exposed because the snapshot path's last pin can be cleared by
   * the plane above (the reconcile it just shipped), and nothing else would
   * re-arm the timer for that room.
   */
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
   * Tear every live replica down, keeping the LEASES.
   *
   * Leases are owned by mounted editors, which survive a replica swap /
   * resubscribe and will re-materialize their room from the next snapshot.
   * Clearing them here would leave a mounted editor holding a release closure
   * for a lease nobody is counting.
   */
  destroyAll(): void;
  /** Terminal. `destroyAll` plus refusing every later acquisition. */
  dispose(): void;
}

export function createArtifactRoomTier(
  sources: ArtifactRoomTierSources,
): ArtifactRoomTier {
  const { environment, session, send, onDivergenceChanged, isDisposed } =
    sources;

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
   * through a long disconnect costs O(body) rather than O(keystrokes). Nothing
   * is discarded - these bytes are the only outbound path for edits made during
   * the window.
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

  /**
   * The registry's demand book, and the only one.
   *
   * Counts DEMAND, not materialisation: a room nobody has bytes for yet can
   * legitimately have leases, and that is exactly the question the seeding path
   * asks - "did anyone ask for this while it was absent?" - to decide whether
   * an arriving snapshot materialises hot or is filed cold. Answering that from
   * a second counter is the divergence this single map exists to prevent.
   */
  function leaseCountOf(artifactRoomId: string): number {
    return leases.get(artifactRoomId) ?? 0;
  }

  /** Any awareness client other than our own local one. */
  function hasRemotePeers(entry: ArtifactRoomReplicaEntry): boolean {
    const states = entry.awareness.getStates();
    if (states.size === 0) return false;
    if (states.size > 1) return true;
    return !states.has(entry.awareness.clientID);
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
  function isPinned(artifactRoomId: string): boolean {
    if (leaseCountOf(artifactRoomId) > 0) return true;
    const entry = replicas.get(artifactRoomId);
    if (entry === undefined) return false;
    if (hasRemotePeers(entry)) return true;
    return (
      entry.dirtyWatermarkStateVectorBase64 !== null ||
      entry.pendingReconcileUpdate !== null ||
      entry.pendingUpdates.length > 0
    );
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
      if (session.canSendBodyWrites()) {
        send({ kind: "room-update", artifactRoomId, update });
        return;
      }
      // Queue while reconnecting/closed, or while a raw-open stream is still
      // waiting on its fresh root snapshot/permission role. Snapshots collapse
      // the queue into a single merged-replica reconcile (stashed as
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
      docUpdateHandler,
      awarenessUpdateHandler,
      pendingUpdates: [],
      pendingBytes: 0,
      pendingBytesSinceCollapse: 0,
      pendingReconcileUpdate: null,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64: null,
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
   * Encode the room's currently-known REMOTE peers as a single awareness
   * update, for replay after a demote. The local client is excluded: the editor
   * sets its own state when it rebinds, and replaying a stale copy of it would
   * fight that.
   */
  function encodePeerAwareness(entry: ArtifactRoomReplicaEntry): Uint8Array[] {
    const remote = Array.from(entry.awareness.getStates().keys()).filter(
      (clientId) => clientId !== entry.awareness.clientID,
    );
    if (remote.length === 0) return [];
    return [encodeAwarenessUpdate(entry.awareness, remote)];
  }

  /**
   * Compact a cold room's buffered frames into a single garbage-collected
   * update.
   *
   * `Y.mergeUpdates` alone concatenates history losslessly, keeping the CONTENT
   * of every deleted item. Replaying into a throwaway doc and re-encoding runs
   * Yjs's GC, which drops that deleted content. Measured against this repo's
   * yjs on the workload this targets (an agent rewriting a body repeatedly):
   * 85.9 KB -> 7.5 KB at 40 rewrites, 657 KB -> 48.8 KB at 300 - a 6-13x
   * reduction that widens with edit count.
   *
   * What it does NOT do, and must not be described as doing: it does not reset
   * client clocks or discard the struct skeleton. Struct COUNT is unchanged by
   * compaction (measured identical either way), so the encoding still grows with
   * edit history, just far more slowly, and re-materializing a long-rewritten
   * room rebuilds the same number of structs. The win here is that a cold room
   * holds bytes instead of a live doc full of `Item` objects; bounding the
   * struct skeleton itself would need a document rewrite, which would break
   * synchronization with the host.
   *
   * The temporary doc is destroyed immediately; only the bytes are retained.
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
    // Measured against bytes appended SINCE the last collapse, never against
    // the total: a compacted buffer can exceed the threshold by itself, and a
    // total-size trigger would then re-compact on every single inbound frame.
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
      return;
    }
    pushColdUpdate(existing, update);
    if (hostStateVectorBase64 !== null) {
      existing.latestHostStateVectorBase64 = hostStateVectorBase64;
    }
  }

  function recordColdAwareness(
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ): void {
    const entry = cold.get(artifactRoomId);
    // Only rooms the host has actually snapshotted are worth holding presence
    // for - a room awaiting its seed cannot be materialized, so there is
    // nothing to replay into.
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
    // Encode the whole replica, not just the frames we happened to receive:
    // the doc is the merge of the host snapshot plus every update since, and
    // its state-as-update is the smallest lossless representation of that.
    const encoded = Y.encodeStateAsUpdate(entry.doc);
    const latestHostStateVectorBase64 = entry.latestHostStateVectorBase64;
    // Peers read BEFORE the teardown. Equivalent to reading them after it -
    // `Awareness.destroy()` clears only the LOCAL client's state, and the local
    // client is filtered out here anyway - but the equivalence rests on a
    // detail of y-protocols rather than on anything this file states, so the
    // order that does not need the argument is the one to keep.
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
    return true;
  }

  /**
   * Arm the linger timer for a room nothing is holding. No-op while a lease or
   * local divergence pins the room, and re-armable: the pinned case is re-tested
   * when the next frame lands, so a room that finishes syncing after its editor
   * closed still cools rather than staying hot forever.
   */
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

  /**
   * Re-arm the linger after materializing, in case nothing pinned the room.
   *
   * `scheduleCooldown` no-ops while the room is pinned, and `acquire`
   * increments its count BEFORE materializing, so this is inert on the lease
   * path - which is the only caller today. It stays as the guarantee for any
   * future one: a materialization cancels the pending cooldown, so a caller
   * that does not pin the room would otherwise strand a live `Y.Doc` for the
   * rest of the session.
   */
  function armCooldownForUnleasedMaterialization(artifactRoomId: string): void {
    scheduleCooldown(artifactRoomId);
  }

  /**
   * Bring a room back up to a live `Y.Doc`, or return `null` when the room has
   * no content to bring up.
   *
   * Returning `null` is load-bearing, and is what produces an
   * `"awaiting-seed"` grant rather than a failure. `artifactRoomState`
   * reports `ready` on first observation and on every recovery transition,
   * independently of `artifactRoomSnapshot`, so there is a window where the room
   * is `ready` with no bytes anywhere. Fabricating an empty `Y.Doc` there would
   * make `getArtifactFragment` hand back a live-but-EMPTY fragment where it used
   * to return `null` - which reads as a real, empty body: export would skip its
   * "still loading" guard and write an empty file, and an editor would bind to a
   * blank document. An empty room and an unseeded room must stay
   * distinguishable.
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
    // Replay presence that arrived while the room was cold, so a peer already
    // in the body is visible immediately rather than after their next renewal.
    // `BIN_AWARENESS_REMOTE_ORIGIN` keeps these from echoing back to the host.
    for (const frame of coldEntry.awarenessFrames) {
      applyAwarenessUpdate(entry.awareness, frame, BIN_AWARENESS_REMOTE_ORIGIN);
    }
    enforceHotCap();
    armCooldownForUnleasedMaterialization(artifactRoomId);
    return entry;
  }

  function grantLease(artifactRoomId: string): LeaseHandle {
    let released = false;
    return {
      resourceId: artifactRoomId,
      /**
       * Released individually, OR by the registry going terminal.
       *
       * Consulting `tierDisposed` rather than having `dispose()` walk a list of
       * live handles: the contract is that every held lease reads as released
       * the moment the registry is disposed, and a handle that answers from the
       * registry's own terminal state cannot be missed by bookkeeping. There is
       * no set of outstanding handles to keep in step, so there is nothing to
       * forget to add to it.
       */
      isReleased: () => released || tierDisposed,
      release(): void {
        // A release after dispose is a no-op, not a decrement. The demand map
        // was cleared wholesale, so decrementing would re-enter a key for a
        // dead registry and arm a cooldown against timers that are gone.
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
    // Demand BEFORE materialisation, so a concurrent release cannot cool the
    // room while it is being brought up - and so a snapshot arriving for a room
    // with no bytes yet sees the demand and materialises it hot.
    leases.set(artifactRoomId, (leases.get(artifactRoomId) ?? 0) + 1);
    const resource = materialize(artifactRoomId);
    const lease = grantLease(artifactRoomId);
    if (resource === null) {
      // Ready, but nothing to bring up yet. The holder releases this exactly as
      // it would a granted one, and the next snapshot materialises the room
      // under the demand already counted here.
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
      // Nothing else will re-arm the timer for it, so an unleased room would
      // otherwise stay materialized for the rest of the session.
      scheduleCooldown(artifactRoomId);
      return;
    }
    // Flush the snapshot-derived reconcile first (if any). It already subsumes
    // every queued local edit captured before the snapshot merge, so a
    // successful send lets us drop the queue without double-shipping bytes. The
    // queue still drains afterwards to cover edits produced AFTER the snapshot
    // but before reopen.
    const reconcile = entry.pendingReconcileUpdate;
    if (reconcile !== null) {
      entry.pendingReconcileUpdate = null;
      send({ kind: "room-update", artifactRoomId, update: reconcile });
    }
    if (entry.pendingUpdates.length === 0) {
      // The reconcile above may have been the last pin.
      scheduleCooldown(artifactRoomId);
      return;
    }
    const pending = takePendingRoomUpdates(entry);
    for (const update of pending) {
      send({ kind: "room-update", artifactRoomId, update });
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

    hasDivergence(): boolean {
      for (const entry of replicas.values()) {
        if (entry.dirtyWatermarkStateVectorBase64 !== null) return true;
        if (entry.pendingReconcileUpdate !== null) return true;
        if (entry.pendingUpdates.length > 0) return true;
      }
      return false;
    },

    applySnapshot(artifactRoomId, snapshotBytes, hostStateVectorBase64) {
      // A room nobody is editing never materializes: keep the bytes and let the
      // caller flip availability so the tile can render its state, and let the
      // first lease pay for the `Y.Doc`. There is nothing to reconcile on this
      // path - a cold room has no local edits by construction - so the whole
      // reconcile/queue dance below is reachable only for rooms an editor is
      // (or was) bound to.
      // `leaseCount`, not the materialised set: an `"awaiting-seed"` holder is
      // absent from `materializedIds()` by contract, and it is precisely that
      // holder this branch must not file cold.
      if (!replicas.has(artifactRoomId) && leaseCountOf(artifactRoomId) === 0) {
        recordColdBytes(artifactRoomId, snapshotBytes, hostStateVectorBase64);
        return "filed-cold";
      }
      // Reuse any prior replica for this artifactRoom so a snapshot during
      // reconnect/recovery does NOT destroy local in-flight edits. The host is
      // now the merge source - its bytes get applied on top of the existing
      // local replica, and dirty tracking drives a reconcile fan-out for any
      // local edits the host has not yet seen.
      const hadPrior = replicas.has(artifactRoomId);
      const entry = getOrCreateReplica(artifactRoomId);
      Y.applyUpdate(entry.doc, snapshotBytes, BIN_STREAM_ORIGIN);
      entry.latestHostStateVectorBase64 = hostStateVectorBase64;
      // If the local replica is ahead of the host's snapshot, ship a reconcile
      // update so offline edits round-trip.
      const reconcileUpdate = Y.encodeStateAsUpdate(
        entry.doc,
        decodeBase64(hostStateVectorBase64),
      );
      const reconcileNeeded = isNonTrivialYUpdate(reconcileUpdate);
      const canSendNow = session.canSendBodyWrites();
      if (reconcileNeeded && canSendNow) {
        send({
          kind: "room-update",
          artifactRoomId,
          update: reconcileUpdate,
        });
        // Reconcile shipped: every local update is already represented in the
        // merged replica, so the single reconcile subsumes both the queue and
        // any prior pending reconcile. Convergence is proven by the next
        // coverage check, not by replaying each queued frame.
        clearPendingRoomUpdates(entry);
        entry.pendingReconcileUpdate = null;
      } else if (
        reconcileNeeded &&
        isWritablePermissionRole(session.permissionRole())
      ) {
        // Stream is reconnecting/closed, or raw-open before the fresh root
        // snapshot. Stash the reconcile so the root snapshot permission gate can
        // flush it later. Without this, clearing `pendingUpdates` here would
        // silently drop the only outbound propagation path for local edits made
        // during the reconnect window. The merged-replica reconcile subsumes
        // those queued frames.
        entry.pendingReconcileUpdate = reconcileUpdate;
        clearPendingRoomUpdates(entry);
      } else {
        // Either no divergence (reconcile is trivial) or the role is
        // viewer/null (fail-closed). In both cases there is nothing safe to
        // send and nothing to retain.
        clearPendingRoomUpdates(entry);
        entry.pendingReconcileUpdate = null;
      }
      if (
        latestHostCoversDirtyWatermark(
          hostStateVectorBase64,
          entry.dirtyWatermarkStateVectorBase64,
        )
      ) {
        entry.dirtyWatermarkStateVectorBase64 = null;
      }
      return hadPrior ? "merged" : "seeded";
    },

    applyUpdate(artifactRoomId, updateBytes, hostStateVectorBase64) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) {
        // Cold room: accumulate the bytes rather than materializing a doc for a
        // body nothing is displaying. An unknown room is still skipped -
        // `recordColdBytes` only extends rooms the host has already
        // snapshotted.
        const coldEntry = cold.get(artifactRoomId);
        if (coldEntry === undefined) return;
        pushColdUpdate(coldEntry, updateBytes);
        coldEntry.latestHostStateVectorBase64 = hostStateVectorBase64;
        return;
      }
      Y.applyUpdate(entry.doc, updateBytes, BIN_STREAM_ORIGIN);
      entry.latestHostStateVectorBase64 = hostStateVectorBase64;
      if (
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

    applyAwareness(artifactRoomId, awarenessBytes) {
      // Apply inbound awareness to the artifact-room-scoped Awareness instance,
      // NOT the root Epic awareness. CollaborationCaret bindings on
      // artifact-room-doc fragments listen on this instance, so routing them
      // through the root awareness would mis-attribute cursors and lose the
      // per-artifact-room presence channel.
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) {
        // Cold room: retain the frame rather than dropping it. Without this a
        // collaborator already present in a room this client has never opened
        // stays invisible until their next renewal.
        recordColdAwareness(artifactRoomId, awarenessBytes);
        return;
      }
      applyAwarenessUpdate(
        entry.awareness,
        awarenessBytes,
        BIN_AWARENESS_REMOTE_ORIGIN,
      );
      // A peer leaving can drop the presence pin that was holding this room
      // hot, so re-test it here rather than waiting for a doc frame that may
      // never come.
      scheduleCooldown(artifactRoomId);
    },

    invalidate(artifactRoomId) {
      // A artifactRoom transitioning out of `ready` invalidates the local
      // replica - the next `artifactRoomSnapshot` will rebuild. The cold copy is
      // invalidated with it; leases survive, so a mounted editor
      // re-materializes from that next snapshot.
      cancelCooldown(artifactRoomId);
      cold.delete(artifactRoomId);
      touchSeq.delete(artifactRoomId);
      destroyReplica(artifactRoomId);
    },

    scheduleCooldownCheck: scheduleCooldown,

    flushPending,

    flushAllPending(): void {
      for (const id of Array.from(replicas.keys())) {
        flushPending(id);
      }
    },

    /**
     * Each clear removes the divergence that was pinning that room, so each one
     * has to re-arm the linger timer: `scheduleCooldown` is otherwise only
     * reachable from a lease release or an inbound frame for that specific room,
     * and neither follows a discard. Without this the rooms a user actually
     * edited - precisely the ones that accumulated the most Yjs structs - would
     * stay materialized for the rest of the session.
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
      for (const id of Array.from(replicas.keys())) {
        destroyReplica(id);
      }
      for (const timer of cooldownTimers.values()) {
        timer.cancel();
      }
      cooldownTimers.clear();
      cold.clear();
      touchSeq.clear();
      // Leases are deliberately NOT cleared: they are owned by mounted editors,
      // which survive a replica swap / resubscribe and will re-materialize their
      // room from the next snapshot. Clearing them here would leave a mounted
      // editor holding a release closure for a lease nobody is counting.
    },

    /**
     * Terminal, in the registry's full sense: every cooldown cancelled, every
     * resource dropped INCLUDING leased ones, every later acquisition refused,
     * and every outstanding handle reading as released from this moment.
     *
     * `tierDisposed` is set FIRST so the last three of those hold for anything
     * that runs during the teardown below, and the demand map is cleared
     * because a disposed registry reporting demand is what a memory accountant
     * and a worker lifecycle would both read as a live holder.
     *
     * Deliberately unlike {@link ArtifactRoomTier.destroyAll}, which leaves
     * leases alone on purpose: that one runs on a replica swap, where mounted
     * editors survive and re-materialise from the next snapshot. This one is
     * the end of the registry.
     */
    dispose(): void {
      tierDisposed = true;
      for (const id of Array.from(replicas.keys())) {
        destroyReplica(id);
      }
      for (const timer of cooldownTimers.values()) {
        timer.cancel();
      }
      cooldownTimers.clear();
      cold.clear();
      touchSeq.clear();
      leases.clear();
    },
  };
}
