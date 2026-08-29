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
import type { ArtifactBodySeedMode } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type {
  DocSeedMode,
  EvictionOutcome,
  LeaseGrant,
  LeaseHandle,
  LeasePolicy,
  MonotonicSequence,
  RuntimeEnvironment,
  RuntimeTimer,
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
  /**
   * Inbound/local update bytes since the last `notifyHot` encode. The
   * collapse-latching pattern: a total-size trigger would re-encode on every
   * keystroke once the body itself exceeded the threshold.
   */
  hotBytesSinceSettle: number;
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
/** Re-encode a hot room for the byte budget after this much unmeasured growth. */
const HOT_DOC_RESETTLE_BYTES = 256 * 1024;
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
  maxMaterialized: HOT_DOCS_MAX_MATERIALIZED,
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

/**
 * One inbound body snapshot, with the authority's own account of what it is.
 *
 * The tier used to decide merge-vs-seed by itself - "is there already a replica
 * for this room" - which is the only thing it COULD do on a wire that states
 * nothing. `artifact.subscribe` states both halves, and this is the shape that
 * carries them, so the decision moves to the authority that owns it.
 */
/**
 * This client's position on one body, in the shape `artifact.subscribe`'s open
 * request takes.
 *
 * Both fields are non-empty by the wire's schema, which is why this is `null`
 * rather than a record with empty strings when there is nothing to offer.
 */
export interface ArtifactRoomDocSeed {
  /**
   * Taken off the snapshot that seeded the replica, never derived from the
   * artifact id - an id cannot answer "is my replica the same document as
   * yours" once a body has been deleted and recreated under it.
   */
  readonly knownDocGuid: string;
  /** Base64 `Y.encodeStateVector` of the replica this client still holds. */
  readonly stateVectorBase64: string;
}

/**
 * A body's cold state, encoded for transfer.
 *
 * NOT `ArtifactRoomDocSeed`. A seed offer is a state VECTOR - what this client
 * already has, offered so the host can answer with a delta. This is the
 * encoded DOCUMENT. Reusing the seed here would hand a negotiation artefact to
 * a consumer that needs bytes it can rebuild a doc from.
 *
 * `docGuid` rides along so a later settle can tell it is talking about the
 * same document: a body deleted and recreated under one artifact id arrives
 * with a new guid and a history sharing no ancestor, and merging the two is
 * unrecoverable rather than lossy.
 */
export interface ArtifactRoomColdState {
  readonly update: Uint8Array;
  readonly seedMode: ArtifactBodySeedMode;
  readonly hostStateVector: string | null;
  readonly docGuid: string;
}

/**
 * What a settle answers. A typed ARM, never a throw: the caller is a demote
 * whose whole purpose is to decide whether the main thread may drop a live
 * document, and a throw at that seam either drops bytes nothing stored or
 * strands a doc forever.
 */
export type ArtifactRoomColdSettlement =
  | { readonly accepted: true; readonly settledBytes: number }
  | {
      readonly accepted: false;
      readonly reason: "not-held" | "newer-generation";
    };

export interface ArtifactRoomSnapshotInput {
  readonly artifactRoomId: string;
  readonly snapshotBytes: Uint8Array;
  /**
   * The authority's state vector at snapshot time, driving the reconcile diff.
   *
   * `null` is a REPRESENTED state, not a missing field: the lane may deliver a
   * body without a watermark, and the honest reading is "this snapshot proves
   * nothing about what the host has seen". Two things follow, both fail-closed
   * (see `applySnapshot`): the reconcile is computed against the whole doc
   * rather than a diff, and the dirty watermark is NOT cleared.
   */
  readonly hostStateVectorBase64: string | null;
  /**
   * Whether these bytes stand alone or complete an offer this replica made.
   * `"delta-against-offer"` must be merged onto the replica that made the
   * offer and can never install a room from cold.
   */
  readonly seed: DocSeedMode;
  /**
   * The authority's identity for this doc instance, or `null` on an arm that
   * states none.
   *
   * `null` rather than a synthesized id for the `@1` arm on purpose. A
   * fabricated guid would be indistinguishable from a stated one, and the
   * replace rule below would then be deciding on a value this client invented;
   * `null` says "no identity was stated", which is the truth, and reduces the
   * rule to "never replace" on that arm by construction rather than by a
   * stability argument about the value chosen.
   */
  readonly docGuid: string | null;
}

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
  /**
   * The existing LRU walk, parameterized by bytes rather than count. Pinned
   * rooms are never victims and are reported as protected `"leased"`.
   */
  demoteColdestUnpinned(overBytes: number): EvictionOutcome;

  /** Whether the tier holds any unsent or unacknowledged local body state. */
  hasDivergence(): boolean;

  // ── Inbound frames ──────────────────────────────────────────────────────
  /**
   * What this client can offer the authority for one body, or `null` when it
   * can offer nothing.
   *
   * This is the other half of {@link ArtifactRoomSnapshotInput.seed}: the body
   * lane's `readDocSeed` is wired here, so "the tier holds a replica" and "the
   * host may answer with a delta" are the SAME fact rather than two that have
   * to be kept in step. A room that has cooled answers `null` - its update
   * buffers are not a document and cannot produce a state vector - so the host
   * sends a full body and the tier files it cold again. That costs bandwidth
   * and cannot corrupt anything, which is the right side to err on.
   */
  readDocSeedOffer(artifactRoomId: string): ArtifactRoomDocSeed | null;
  /**
   * The whole encoded document for a held body, or `null` when the tier does
   * not hold it.
   *
   * `null` is NOT "empty bytes" and a consumer that conflates them is the
   * defect: a zero-length update applies cleanly and produces an empty
   * document, so a caller that treated not-held as empty would silently
   * replace a body with nothing.
   */
  encodeColdState(artifactRoomId: string): ArtifactRoomColdState | null;
  /**
   * Take an encoded document back and store it.
   *
   * `expectedDocGuid` is what the caller encoded against. A tier whose guid has
   * moved refuses with `newer-generation` rather than merging two histories.
   */
  settleColdState(
    artifactRoomId: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ): ArtifactRoomColdSettlement;
  applySnapshot(input: ArtifactRoomSnapshotInput): RoomSnapshotOutcome;
  /**
   * Remote bytes for one body.
   *
   * `hostStateVectorBase64` is nullable for the same reason it is on a
   * snapshot, and on the body lane it is always `null`: `doc-update` carries
   * no vector, because it describes what OTHERS wrote. What this client has
   * pushed is answered separately by {@link applyCoverage}.
   */
  applyUpdate(
    artifactRoomId: string,
    updateBytes: Uint8Array,
    hostStateVectorBase64: string | null,
  ): void;
  /**
   * The authority's coverage of updates this client pushed - the event that
   * retires local divergence on the body lane.
   *
   * Split from {@link applyUpdate} rather than folded into it because the two
   * answer different questions, and folding them would mean either inventing a
   * coverage claim on every remote update or never retiring divergence at all.
   * A room with no live replica has no watermark to retire, so this is a no-op
   * there rather than something to buffer.
   */
  applyCoverage(
    artifactRoomId: string,
    coverageStateVectorBase64: string,
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
   * Drop everything held for one room - hot replica, cold bytes, recency and
   * both budget charges - keeping its LEASES.
   *
   * Two callers with the same requirement: a room leaving `ready`, and a
   * snapshot that states a different doc identity. Both mean "what is held is
   * no longer a valid basis for the next frame", and both rely on a mounted
   * editor's lease surviving so the next snapshot re-materialises under it.
   *
   * Accounting is settled here rather than by the callers, which is what makes
   * the replace path cost-neutral: `unchargeHot` releases the hot
   * `HolderCharge` (settled plus provisional) and `notifyCold(id, 0)` settles
   * the cold charge to zero, so a replaced room is charged for exactly the
   * bytes the new doc goes on to hold.
   */
  function discardEverythingFor(artifactRoomId: string): void {
    cancelCooldown(artifactRoomId);
    cold.delete(artifactRoomId);
    touchSeq.delete(artifactRoomId);
    destroyReplica(artifactRoomId);
    unchargeHot(artifactRoomId);
    notifyCold(artifactRoomId, 0);
  }

  /**
   * The authority's doc identity per room, for as long as the room is held.
   *
   * Kept beside the hot/cold maps rather than inside either, because identity
   * spans them: a room that cools and is later re-materialised is the same
   * document, and a guid stored on the entry would be forgotten exactly when
   * the replace rule still has to be able to fire.
   */
  const docGuidByRoom = new Map<string, string>();

  /**
   * Whether an incoming snapshot's identity supersedes what this room holds.
   *
   * Stated-to-stated difference only. A `null` on either side means no
   * identity was claimed - by the incoming frame, or by everything held so far
   * - and an unclaimed identity cannot be observed to change.
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
        noteHotGrowth(artifactRoomId, update.byteLength);
        return;
      }
      // Queue while reconnecting/closed, or while a raw-open stream is still
      // waiting on its fresh root snapshot/permission role. Snapshots collapse
      // the queue into a single merged-replica reconcile (stashed as
      // `pendingReconcileUpdate`) - they never clear the queue without
      // preserving an outbound propagation path.
      if (replica !== undefined) {
        pushPendingRoomUpdate(replica, update);
        noteHotGrowth(artifactRoomId, update.byteLength);
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
    unchargeHot(artifactRoomId);
    notifyCold(artifactRoomId, encoded.byteLength);
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

    demoteColdestUnpinned(overBytes: number): EvictionOutcome {
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
        // Settled + provisional: `accountant.release` drops the whole
        // HolderCharge, and `hotBytesSinceSettle` is lockstep with
        // `chargeProvisional`. Read BEFORE `coolReplica` destroys the entry.
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

    encodeColdState(artifactRoomId) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return null;
      const docGuid = docGuidByRoom.get(artifactRoomId);
      // No stated identity means no transferable state, for the same reason a
      // seed offer needs one: bytes whose document cannot be identified cannot
      // be safely settled back.
      if (docGuid === undefined) return null;
      return {
        update: Y.encodeStateAsUpdate(entry.doc),
        // Always `"full"` here. `"delta-against-offer"` describes bytes encoded
        // AGAINST an offer, and this path encodes the whole document - naming
        // it delta would tell the receiver to merge into a replica it may not
        // have.
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
        // The body was replaced while these bytes were in flight. Their
        // history shares no ancestor with what is held now, so applying them
        // would splice two documents into one that no later frame can undo.
        return { accepted: false, reason: "newer-generation" };
      }
      Y.applyUpdate(entry.doc, update);
      // Measured from what is STORED, never from the input. A demote's caller
      // uses this to decide it may drop a live document, and the input's length
      // says nothing about what survived the merge - an update carrying only
      // operations the replica already had stores nothing new.
      return {
        accepted: true,
        settledBytes: Y.encodeStateAsUpdate(entry.doc).byteLength,
      };
    },

    readDocSeedOffer(artifactRoomId) {
      const entry = replicas.get(artifactRoomId);
      if (entry === undefined) return null;
      const knownDocGuid = docGuidByRoom.get(artifactRoomId);
      // No stated identity means no offer. Offering a vector without a guid
      // would ask the host for a delta while leaving it unable to check the
      // two replicas are the same document - which is the one question the
      // offer exists to let it answer.
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
      // ── Doc identity, before anything is applied ──────────────────────────
      //
      // A deleted-and-recreated artifact arrives under the SAME id with a new
      // guid, and its history shares no ancestor with what this client holds.
      // Merging the two is not a lossy merge, it is an unrecoverable one: Yjs
      // would splice both histories into one document and no later frame can
      // separate them again. So a stated change in identity replaces
      // everything held for this room - hot replica, cold bytes and watermark
      // alike - and the snapshot then installs as if the room were new.
      //
      // Only a stated-to-stated change counts. `null` on either side means no
      // identity was claimed (the `@1` arm never claims one), and an unclaimed
      // identity cannot have changed.
      if (seedReplacesHeldDoc(artifactRoomId, docGuid)) {
        discardEverythingFor(artifactRoomId);
      }
      if (docGuid !== null) docGuidByRoom.set(artifactRoomId, docGuid);
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
        // A delta is only meaningful against the replica that made the offer,
        // and there is no replica here. Filing it cold would leave the room
        // holding bytes that decode against a state this client no longer has,
        // and the first lease would materialise a torn doc out of them.
        //
        // This is a fail-safe, not a path: the artifact lane's `readDocSeed`
        // is wired to this tier, so a room the tier does not hold offers
        // nothing and the host has nothing to send a delta against. The branch
        // exists because the alternative to a cheap guard is an unrecoverable
        // document, and because that wiring is an invariant maintained by a
        // caller rather than one this module can enforce.
        if (seed === "delta-against-offer") return "filed-cold";
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
      if (hostStateVectorBase64 !== null) {
        entry.latestHostStateVectorBase64 = hostStateVectorBase64;
      }
      // If the local replica is ahead of the host's snapshot, ship a reconcile
      // update so offline edits round-trip.
      //
      // With no watermark there is no diff to take, so the reconcile is the
      // WHOLE replica. That is the fail-closed direction: re-sending state the
      // host already has is idempotent in Yjs and costs bytes, while sending a
      // diff against a vector we do not have would mean sending nothing and
      // silently stranding local edits.
      const reconcileUpdate =
        hostStateVectorBase64 === null
          ? Y.encodeStateAsUpdate(entry.doc)
          : Y.encodeStateAsUpdate(
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
      // A snapshot with no watermark proves nothing about what the host has
      // durably seen, so it cannot clear the dirty mark: the room stays dirty
      // until one carrying a vector covers it. Clearing here would report a
      // body as saved on the strength of a frame that never said so.
      //
      // `latestHostCoversDirtyWatermark` already answers `false` for a null
      // host vector, so this guard changes nothing today. It is here because
      // that helper's null arm is the kind that gets "simplified" to `true`
      // ("no vector, nothing to compare") by someone reading it on its own -
      // and the cost of that edit is silent data loss on this line, not a
      // failing assertion. The requirement belongs where the consequence is.
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
        // Merge arm: a leased room surviving reconnect absorbs the host's
        // whole re-snapshot — the largest single growth event a room sees.
        // Without this, `hotBytesSinceSettle` never moves and the 256 KiB
        // threshold cannot trip.
        noteHotGrowth(artifactRoomId, snapshotBytes.byteLength);
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
      // Same fail-closed reading as the snapshot path, and redundant for the
      // same reason - stated here because this is where getting it wrong loses
      // a user's edit. On the lane arm the null is the NORMAL case, not an
      // edge one: `doc-update` carries no vector at all, and coverage arrives
      // on its own event (see `applyCoverage`).
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

    applyCoverage(artifactRoomId, coverageStateVectorBase64) {
      // The authority stating how much of what THIS client pushed it now has.
      // On `@1` the same fact rides every `room-update`'s post-apply vector;
      // the body lane separates them, because an update is other people's
      // bytes and coverage is an answer about ours. Both retire the same
      // watermark, which is why this is not a second notion of divergence.
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
      //
      // The doc identity is deliberately KEPT: this room is unreachable, not a
      // different document, and forgetting the guid here would disarm the
      // replace rule for exactly the window a recreate is most likely to
      // happen in - the next snapshot would merge two histories and read as a
      // successful rebuild.
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
      // Unlike `invalidate`, this IS the end of what the tier knows: the plane
      // above runs it on replacement, reseed and teardown, where the next
      // snapshot rebuilds from nothing and has no held history to splice into.
      docGuidByRoom.clear();
      for (const id of hotIds) {
        unchargeHot(id);
      }
      for (const id of coldIds) {
        notifyCold(id, 0);
      }
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
