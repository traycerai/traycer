import type { ConfirmedChatMutation } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
/**
 * The record plane: the root replica, the projector that reads it, the record tables that union
 * over it, and the local divergence the sync pill reports.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type {
  EarlyMetaEpic,
  SnapshotMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import type {
  ClassFreshness,
  CommandIdFactory,
  CommandRecord,
  ProjectionSink,
  Replica,
  ReplicaApplyOutcome,
  ReplicaResetCause,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { DeletedEpicArtifact } from "@traycer/protocol/persistence/epic/artifacts";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils";
import { resolveReparentNode } from "@/lib/reparent-rules";
import {
  evaluateProjectedReparent,
  projectedReparentRejectionError,
} from "@/lib/reparent-projection-rules";
import {
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
} from "../projection-helpers";
import type { EpicDocRecordArms } from "../projection-helpers";
import type { PendingChatCreation } from "../pending-chat-creations";
import { createEpicProjector, type EpicProjector } from "./epic-projector";
import type { EpicRootEvent, EpicOutboundRequest } from "./epic-runtime-events";
import type { EpicRecordsProjection } from "./epic-runtime-projection";
import { projectedSlicesView } from "./projection-delivery";
import { createHostCoverage, type HostCoverage } from "./host-coverage";
import { createUnsyncedRootQueue } from "./unsynced-root-queue";
import {
  EMPTY_LANE_STATE_SLICES,
  laneRawProjectionSources,
  type EpicLaneStateSlices,
} from "./epic-lane-state-replica";
import { createChatRecordTable } from "./chat-record-table";
import { createTuiAgentRecordTable } from "./tui-agent-record-table";
import {
  createMetadataOverlayStore,
  type MetadataOverlayStore,
} from "./metadata-overlay-store";
import {
  type DivergenceState,
  encodeDocStateVectorBase64,
  decodeBase64,
  isNonTrivialYUpdate,
  knownCleanDirtyState,
  resolveDirtyState,
} from "./dirty-watermark";
import type { EpicSessionFacts } from "./session-facts";
import { isWritablePermissionRole } from "./session-facts";
import { deriveClassFreshness } from "./plane-freshness";
import type { EpicWriteCommandIntent } from "./epic-write-command";

export const EPIC_RECORDS_PLANE_ID = "epic-records";

const STREAM_ORIGIN = "stream";
/**
 * Origin tag for renderer-local Y.Doc mutations. Exported for test seeding helpers that must route
 * through the local-update path exactly like a real user mutation.
 */
export const LOCAL_ORIGIN = "local";

export interface EpicRecordsReplicaSources {
  /** Fires when the set of held attachment hashes changes. */
  readonly onHeldAttachmentsChanged: (hashes: readonly string[]) => void;

  readonly environment: RuntimeEnvironment;
  readonly session: EpicSessionFacts;
  readonly sink: ProjectionSink<EpicRecordsProjection>;
  /** The signed-in user's id. */
  readonly getCurrentUserId: () => string | null;
  /** Whether the doc is still a record SOURCE, per population. */
  readonly getDocArm: () => EpicDocRecordArms;
  readonly send: (request: EpicOutboundRequest) => void;
  /** Whether any artifact room holds unsent or unacknowledged local state. */
  readonly hasRoomDivergence: () => boolean;
  readonly isDisposed: () => boolean;
  readonly commandIdFactory: CommandIdFactory;
  readonly onCommandReconciled: (
    commandId: string,
    outcome: "echo" | "superseded",
    via: "authoritative-projection" | "landed-overlay-ttl",
  ) => void;
}

export interface EpicRecordsReplica extends Replica<
  EpicRootEvent,
  EpicRecordsProjection
> {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly overlay: MetadataOverlayStore;

  // ── Snapshot sequencing (the runtime orders these against the other planes)
  ingestSnapshot(meta: SnapshotMetaEpic, update: Uint8Array): DivergenceState;
  /** Re-project and publish everything a landed snapshot settles here. */
  publishSnapshotLanded(
    meta: SnapshotMetaEpic,
    divergence: DivergenceState,
  ): void;
  /** The metadata-only frame's records half. */
  applyEarlyMeta(meta: EarlyMetaEpic): void;

  // ── Local writes ────────────────────────────────────────────────────────
  applyLocalUpdate(updateBytes: Uint8Array): void;
  sendAwareness(awarenessBytes: Uint8Array): void;
  /** Drop the local dirty signal and every offline-buffered byte. */
  discardUnsyncedEdits(clearRoomState: () => void): void;
  /** Drain the root queue once the transport and the role allow it. */
  flushPendingRootUpdates(): void;
  /** Re-send this client's own awareness state after a (re)connect. */
  emitCurrentAwareness(): void;
  /** Fail-closed teardown of every local root write path. */
  clearLocalWritePaths(options: { readonly clearCoverage: boolean }): void;

  // ── Divergence ──────────────────────────────────────────────────────────
  /** Recompute and publish only if something actually moved. */
  refreshDivergence(): void;
  /** Recompute and publish unconditionally. */
  publishDivergence(): void;
  /** Discard only the unsynced root queue and publish its new size. */
  clearUnsyncedQueue(): void;
  /** Rebuild host coverage empty, so no further seed offer is made. */
  resetCoverage(): void;
  /** What a fresh subscription cycle settles on this plane. */
  publishFreshCycle(): void;

  // ── Replica swap ────────────────────────────────────────────────────────
  /**
   * Throw the replica away and rebuild it empty, keeping the sink and every
   * consumer attached to it.
   */
  replaceReplica(): void;
  /** The reattach offer, read live at every wire subscribe. */
  readSeedOffer(): EpicSubscribeClientSeedOffer | null;

  // ── Record tables ───────────────────────────────────────────────────────
  applyChatRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  applyChatRecordDelta(delta: ChatRecordDelta): void;
  applyConfirmedChatMutation(mutation: ConfirmedChatMutation): void;
  peekChatIngestSeq(): number;
  markChatRecordListAuthoritative(): void;
  /** Withdraw the record list's authority for a NEW viewer. */
  markChatRecordListNotAuthoritative(): void;
  applyTuiAgentRecords(
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ): void;
  applyTuiAgentRecordDelta(delta: TuiAgentRecordDelta): void;
  peekTuiAgentIngestSeq(): number;
  beginPendingChatCreation(pending: PendingChatCreation): void;
  clearPendingChatCreation(chatId: string): void;
  republishRecordsForCurrentUser(): void;

  // ── Doc reads and writes ────────────────────────────────────────────────
  readArtifactRoomId(artifactId: string): string | null;
  readArtifactTitle(artifactId: string): string | null;
  hasAttachmentBytes(hash: string): boolean;
  /** Every hash this replica currently holds bytes for. */
  heldAttachmentHashes(): readonly string[];
  readAttachmentBytes(
    hash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  renameArtifact(artifactId: string, nextTitle: string): boolean;
  deleteArtifact(artifactId: string): boolean;
  reparentArtifact(artifactId: string, newParentId: string | null): boolean;
  setEpicTitle(nextTitle: string): boolean;

  // ── Overlay stamping (reads the published projection) ────────────────────
  beginRenameMutation(nodeId: string, nextTitle: string): string | null;
  beginEpicTitleMutation(nextTitle: string): string | null;
  beginReparentMutation(
    nodeId: string,
    newParentId: string | null,
  ): string | null;
  /** Stamp the optimistic projection using the queue's already-minted id. */
  stampWriteCommand(command: CommandRecord<EpicWriteCommandIntent>): boolean;

  /** Settle in-flight attachment reads and drop the projector. */
  detach(): void;
  /** Bind the LANE head instead of the root `Y.Doc`, and feed it. */
  attachLaneHead(): void;
  /** The records lane's populations, as its replica last recomputed them. */
  applyLaneState(slices: EpicLaneStateSlices): void;
  /**
   * The lane arm's lead state snapshot landed - see the implementation. The `@1` counterpart is
   * {@link EpicRecordsReplica.publishSnapshotLanded}, and both reach one publish site.
   */
  publishLaneSnapshotLoaded(): void;
  /** Publish the first projection. Called once the sink's consumer is live. */
  start(): void;
  /** Logical count of root updates the transport has not carried yet. */
  unsyncedQueueSize(): number;
}

export function createEpicRecordsReplica(
  sources: EpicRecordsReplicaSources,
): EpicRecordsReplica {
  const {
    environment,
    session,
    sink,
    getCurrentUserId,
    getDocArm,
    send,
    hasRoomDivergence,
    isDisposed,
    commandIdFactory,
    onCommandReconciled,
  } = sources;

  let doc = new Y.Doc();
  let awareness = new Awareness(doc);
  /** The records lane's populations on the LANE arm, empty until its first snapshot. */
  let laneSlices: EpicLaneStateSlices = EMPTY_LANE_STATE_SLICES;
  /** Which head the projector is bound to, so a replica replacement can rebind the SAME one. */
  let attachedHead: "doc" | "lane" | null = null;
  const coverage: HostCoverage = createHostCoverage();
  const unsynced = createUnsyncedRootQueue();
  let observedAtMs: number | null = null;

  // In-flight `readAttachmentBytes` waits. Held here (not per call) so a replica swap can re-point
  // each one at the live doc's attachments map instead of leaving it observing a destroyed doc.
  interface AttachmentReadWaiter {
    readonly hash: string;
    readonly onChange: () => void;
    readonly settle: (bytes: Uint8Array | null) => void;
    observedMap: Y.Map<unknown> | null;
  }
  const attachmentReadWaiters = new Set<AttachmentReadWaiter>();

  /** A STANDING observation of the attachments map, distinct from the per-waiter ones above. */
  let heldAttachmentsObservedMap: Y.Map<unknown> | null = null;
  const heldAttachmentHashesNow = (): readonly string[] => {
    const held: string[] = [];
    for (const [hash, value] of doc.getMap("attachments").entries()) {
      if (value instanceof Uint8Array) held.push(hash);
    }
    return held;
  };
  const onHeldAttachmentsChanged = (): void => {
    // The VALUE is pushed, not fetched.
    sources.onHeldAttachmentsChanged(heldAttachmentHashesNow());
  };
  const bindHeldAttachmentsObserver = (): void => {
    if (heldAttachmentsObservedMap !== null) {
      heldAttachmentsObservedMap.unobserve(onHeldAttachmentsChanged);
    }
    const map = doc.getMap("attachments");
    heldAttachmentsObservedMap = map;
    map.observe(onHeldAttachmentsChanged);
  };
  const bindAttachmentWaiter = (waiter: AttachmentReadWaiter): void => {
    if (waiter.observedMap !== null) {
      waiter.observedMap.unobserve(waiter.onChange);
    }
    const map = doc.getMap("attachments");
    waiter.observedMap = map;
    map.observe(waiter.onChange);
    waiter.onChange();
  };

  function publish(patch: Partial<EpicRecordsProjection>): void {
    sink.publish({
      ...sink.read(),
      ...patch,
      // Folded in here, AFTER the patch, so every publish carries the current counters no matter which
      // path produced it.
      chatIngestSeq: chatTable.ingestSeq(),
      tuiAgentIngestSeq: tuiTable.ingestSeq(),
    });
  }

  /**
   * The renderer-local divergence the UI reads: root doc against host coverage,
   * OR any artifact room against its own host state vector.
   */
  function resolvePublicDirtyState(
    dirtyWatermarkStateVectorBase64: string | null,
    latestHostStateVectorBase64: string | null,
  ): DivergenceState {
    const rootDirtyState = resolveDirtyState(
      dirtyWatermarkStateVectorBase64,
      latestHostStateVectorBase64,
    );
    return {
      ...rootDirtyState,
      isDirty: rootDirtyState.isDirty || hasRoomDivergence(),
    };
  }

  function refreshDivergence(): void {
    const state = sink.read();
    const next = resolvePublicDirtyState(
      state.dirtyWatermarkStateVectorBase64,
      state.latestHostStateVectorBase64,
    );
    if (
      state.isDirty === next.isDirty &&
      state.dirtyWatermarkStateVectorBase64 ===
        next.dirtyWatermarkStateVectorBase64 &&
      state.latestHostStateVectorBase64 === next.latestHostStateVectorBase64
    ) {
      return;
    }
    publish(next);
  }

  // ── Record tables ─────────────────────────────────────────────────────────

  const chatTable = createChatRecordTable({
    getCurrentUserId,
    // Record provenance for any pending metadata mutation this table now backs,
    // at the ONE seam every chat-record write flows through.
    onBeforePublish: () => overlay.markRegistryBacked(),
    now: () => environment.clock.now(),
  });

  const tuiTable = createTuiAgentRecordTable({
    getCurrentUserId,
    onBeforePublish: () => overlay.markRegistryBacked(),
  });

  const overlay: MetadataOverlayStore = createMetadataOverlayStore({
    environment,
    republish: () => republishForOverlay(),
    isProjectorAttached: () => projector.isAttached(),
    hasFreshRootSnapshotForOpenCycle: () =>
      session.hasFreshRootSnapshotForOpenCycle(),
    recordPlaneServesNode: (nodeId) => {
      const currentUserId = getCurrentUserId();
      return (
        tuiTable.servesNodeToViewer(nodeId, currentUserId) ||
        chatTable.servesNodeToViewer(nodeId, currentUserId)
      );
    },
    isDisposed,
    onReconciled: onCommandReconciled,
  });

  const projector: EpicProjector = createEpicProjector({
    getCurrentUserId,
    getChatRecords: () => chatTable.current(),
    getTuiAgentRecords: () => tuiTable.current(),
    getDocArm,
    getPendingOverlay: () => overlay.overlay(),
    onDeadMutations: (requestIds) => overlay.collectDead(requestIds),
  });

  const projectorSink = projectedSlicesView(sink);

  /** Republish the projection so a change to the pending overlay is visible. */
  function republishForOverlay(): void {
    if (!projector.isAttached()) return;
    projector.projectFull();
  }

  /** Publish a record table's recomputed slice, folding in the FULL re-projection it forces. */
  function publishRecordSlice(patch: Partial<EpicRecordsProjection>): void {
    if (!projector.isAttached()) {
      publish(patch);
      return;
    }
    // Two publishes, one delivery.
    sink.transact(() => {
      publish(patch);
      projector.projectFull();
    });
  }

  // ── Replica lifecycle ─────────────────────────────────────────────────────

  const handleDocUpdate = (updateBytes: Uint8Array, origin: unknown): void => {
    if (origin === STREAM_ORIGIN) return;
    publish({
      isDirty: true,
      dirtyWatermarkStateVectorBase64: encodeDocStateVectorBase64(doc),
    });
    applyLocalUpdate(updateBytes);
  };

  const handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === "remote") return;
    const touched = changes.added
      .concat(changes.updated)
      .concat(changes.removed);
    if (touched.length === 0) return;
    sendAwareness(encodeAwarenessUpdate(awareness, touched));
  };

  /** Bind the lane head over whatever `laneSlices` currently holds. */
  function attachLaneSources(): void {
    projector.attachLaneSources(
      () => laneRawProjectionSources(laneSlices),
      projectorSink,
    );
  }

  function bindCurrentReplica(): void {
    doc.on("update", handleDocUpdate);
    awareness.on("update", handleAwarenessUpdate);
    // Re-point pending attachment reads at the freshly-bound doc so a wait
    // started before a snapshot rebind still observes the live map.
    for (const waiter of attachmentReadWaiters) bindAttachmentWaiter(waiter);
    // The standing observation moves with them, and then REPUBLISHES: a swap
    // can change which hashes are held, and nothing else would say so.
    bindHeldAttachmentsObserver();
    onHeldAttachmentsChanged();
  }

  function destroyReplica(
    replicaDoc: Y.Doc,
    replicaAwareness: Awareness,
  ): void {
    replicaAwareness.off("update", handleAwarenessUpdate);
    replicaDoc.off("update", handleDocUpdate);
    replicaAwareness.destroy();
    replicaDoc.destroy();
  }

  bindCurrentReplica();

  // ── Local writes ──────────────────────────────────────────────────────────

  function applyLocalUpdate(updateBytes: Uint8Array): void {
    if (isDisposed()) return;
    const role = session.writeGateRole();
    if (role === "viewer" || role === null) return;
    // Gate on the renderer↔host transport, NOT the combined visible status.
    if (session.transportStatus() === "open") {
      send({ kind: "root-update", update: updateBytes });
      return;
    }
    unsynced.push(updateBytes);
    publish({ unsyncedQueueSize: unsynced.size() });
  }

  function sendAwareness(awarenessBytes: Uint8Array): void {
    if (isDisposed()) return;
    if (session.transportStatus() !== "open") return;
    send({ kind: "root-awareness", frame: awarenessBytes });
  }

  function emitCurrentAwareness(): void {
    if (awareness.getLocalState() === null) return;
    send({
      kind: "root-awareness",
      frame: encodeAwarenessUpdate(awareness, [doc.clientID]),
    });
  }

  function flushPendingRootUpdates(): void {
    if (unsynced.isEmpty()) return;
    if (!isWritablePermissionRole(session.writeGateRole())) {
      unsynced.clear();
      publish({ unsyncedQueueSize: 0 });
      return;
    }
    const pending = unsynced.take();
    publish({ unsyncedQueueSize: 0 });
    for (const updateBytes of pending) {
      send({ kind: "root-update", update: updateBytes });
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  function ingestSnapshot(
    meta: SnapshotMetaEpic,
    update: Uint8Array,
  ): DivergenceState {
    projector.ingest(() => {
      // The replica merges either way: a delta and a full snapshot are both just updates to apply here,
      // and `doc` is never rebuilt on this path.
      Y.applyUpdate(doc, update, STREAM_ORIGIN);
      coverage.applyRootSeed(meta, update);
    });
    const reconcileUpdate = Y.encodeStateAsUpdate(
      doc,
      decodeBase64(meta.hostStateVectorBase64),
    );
    const divergence = resolvePublicDirtyState(
      sink.read().dirtyWatermarkStateVectorBase64,
      meta.hostStateVectorBase64,
    );
    // Only writable roles may push the reconcile delta back.
    if (
      isNonTrivialYUpdate(reconcileUpdate) &&
      isWritablePermissionRole(meta.permissionRole)
    ) {
      send({ kind: "root-update", update: reconcileUpdate });
    }
    unsynced.clear();
    return divergence;
  }

  /** The ONE place `snapshotLoaded` becomes true, on either arm. */
  function publishSnapshotLoaded(
    alsoPublish: Partial<EpicRecordsProjection>,
  ): void {
    sink.transact(() => {
      projector.projectFull();
      publish({ ...alsoPublish, snapshotLoaded: true });
    });
  }

  function publishSnapshotLanded(
    meta: SnapshotMetaEpic,
    divergence: DivergenceState,
  ): void {
    publishSnapshotLoaded({
      snapshotMeta: meta,
      ...divergence,
      unsyncedQueueSize: 0,
    });
  }

  /** The lane arm's lead state snapshot. */
  function publishLaneSnapshotLoaded(): void {
    publishSnapshotLoaded({});
  }

  function applyEarlyMeta(meta: EarlyMetaEpic): void {
    // Populate `snapshotMeta` so workspace-derived UI (git status, file tree, sidebar repo chip,
    // permission display) starts working before the full Y.Doc snapshot lands.
    publish({
      snapshotMeta: { ...meta, schemaVersion: "", hostStateVectorBase64: "" },
    });
  }

  // ── Doc mutations ─────────────────────────────────────────────────────────

  function canWriteDoc(): boolean {
    if (isDisposed()) return false;
    const role = session.writeGateRole();
    return role !== "viewer" && role !== null;
  }

  function renameArtifact(artifactId: string, nextTitle: string): boolean {
    const trimmed = nextTitle.trim();
    if (trimmed.length === 0) return false;
    if (!canWriteDoc()) return false;
    let mutated = false;
    doc.transact(() => {
      const artifact = getArtifactEntry(doc, artifactId);
      if (artifact !== null) {
        if (artifact.get("title") === trimmed) return;
        artifact.set("title", trimmed);
        artifact.set("updatedAt", environment.clock.now());
        mutated = true;
        return;
      }
      const chat = getChatEntry(doc, artifactId);
      if (chat !== null) {
        if (chat.get("title") === trimmed) return;
        chat.set("title", trimmed);
        chat.set("updatedAt", environment.clock.now());
        mutated = true;
        return;
      }
      const agent = getTerminalAgentEntry(doc, artifactId);
      if (agent !== null) {
        if (agent.get("title") === trimmed) return;
        agent.set("title", trimmed);
        agent.set("updatedAt", environment.clock.now());
        mutated = true;
      }
    }, LOCAL_ORIGIN);
    return mutated;
  }

  function pickParentId(
    results: ReadonlyArray<{
      readonly removed: boolean;
      readonly parentId: string | null;
    }>,
  ): string | null {
    for (const r of results) {
      if (r.removed) return r.parentId;
    }
    return null;
  }

  function deleteFromMap(
    map: Y.Map<unknown> | null,
    id: string,
  ): { readonly removed: boolean; readonly parentId: string | null } {
    if (map === null) return { removed: false, parentId: null };
    const entry = map.get(id);
    if (!(entry instanceof Y.Map)) return { removed: false, parentId: null };
    const pid = (entry as Y.Map<unknown>).get("parentId");
    map.delete(id);
    return { removed: true, parentId: typeof pid === "string" ? pid : null };
  }

  function readTicketStatus(entry: Y.Map<unknown>): 0 | 1 | 2 {
    const value = entry.get("status");
    if (value === 1) return 1;
    if (value === 2) return 2;
    return 0;
  }

  // Record a `deletedArtifacts` tombstone for an artifact we're about to remove optimistically.
  function writeDeletedArtifactTombstone(
    artifactsMap: Y.Map<unknown>,
    artifactId: string,
  ): void {
    const entry = artifactsMap.get(artifactId);
    if (!(entry instanceof Y.Map)) return;
    const kind = readArtifactKind(entry);
    if (kind === null) return;
    const deletedArtifactsMap = getDeletedArtifactsMap(doc);
    if (deletedArtifactsMap === null) return;
    const title = readMaybeString(entry, "title");
    const artifactRoomId = readMaybeString(entry, "artifactRoomId");
    const deletedAt = new Date(environment.clock.now()).toISOString();
    const base = {
      id: artifactId,
      title,
      artifactRoomId: artifactRoomId.length > 0 ? artifactRoomId : null,
      deletedAt,
    };
    const tombstone: DeletedEpicArtifact =
      kind === "ticket" || kind === "story"
        ? { kind, ...base, status: readTicketStatus(entry) }
        : { kind, ...base };
    deletedArtifactsMap.set(artifactId, createTypedMap(tombstone));
  }

  function deleteArtifact(artifactId: string): boolean {
    if (!canWriteDoc()) return false;
    let mutated = false;
    doc.transact(() => {
      const artifactsMap = getArtifactsMap(doc);
      const chatsMap = getChatsMap(doc);
      const terminalAgentsMap = getTerminalAgentsMap(doc);
      // Capture the tombstone before the removal below takes the entry's `kind`
      // with it, so the host can still cloud-delete the row.
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
      // Re-parent direct children onto the deleted node's parent so the subtree
      // doesn't get orphaned.
      const reparent = (map: Y.Map<unknown>): void => {
        for (const [, entry] of map.entries()) {
          if (!(entry instanceof Y.Map)) continue;
          const child = entry as Y.Map<unknown>;
          if (child.get("parentId") !== artifactId) continue;
          child.set("parentId", targetParentId);
        }
      };
      // Artifact descendants must keep their parent links during the optimistic window.
      if (!fromArtifacts.removed && artifactsMap !== null) {
        reparent(artifactsMap);
      }
      if (chatsMap !== null) reparent(chatsMap);
      if (terminalAgentsMap !== null) reparent(terminalAgentsMap);
    }, LOCAL_ORIGIN);
    return mutated;
  }

  function reparentArtifact(
    artifactId: string,
    newParentId: string | null,
  ): boolean {
    if (!canWriteDoc()) return false;
    // VALIDATE AGAINST THE PROJECTION, WRITE TO THE DOC.
    const tree = sink.read().tree;
    const evaluation = evaluateProjectedReparent(tree, artifactId, newParentId);
    if (!evaluation.ok) {
      if (evaluation.reason === "same-parent") return false; // no-op
      throw projectedReparentRejectionError(
        tree,
        evaluation.reason,
        artifactId,
        newParentId,
      );
    }
    // The projection said yes; now find something to write to.
    const target = resolveReparentNode(doc, artifactId);
    if (target === null) return false;
    let mutated = false;
    doc.transact(() => {
      target.entry.set("parentId", newParentId);
      target.entry.set("updatedAt", environment.clock.now());
      mutated = true;
    }, LOCAL_ORIGIN);
    return mutated;
  }

  function setEpicTitle(nextTitle: string): boolean {
    if (isDisposed()) return false;
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
  }

  // ── Overlay stamping ──────────────────────────────────────────────────────

  /** The RAW union row's field, never the tree node's. */
  function readUnionRow(
    nodeId: string,
  ): { readonly title: string; readonly parentId: string | null } | null {
    const slices = sink.read();
    for (const byId of [
      slices.artifacts.byId,
      slices.chats.byId,
      slices.tuiAgents.byId,
    ]) {
      if (!Object.hasOwn(byId, nodeId)) continue;
      const row = byId[nodeId];
      return { title: row.title, parentId: row.parentId };
    }
    return null;
  }

  function beginRenameMutationWithId(
    requestId: string,
    nodeId: string,
    nextTitle: string,
    artifactOnly: boolean,
  ): string | null {
    if (isDisposed()) return null;
    const trimmed = nextTitle.trim();
    if (trimmed.length === 0) return null;
    if (!isWritablePermissionRole(session.writeGateRole())) return null;
    if (artifactOnly && !Object.hasOwn(sink.read().artifacts.byId, nodeId)) {
      return null;
    }
    const row = readUnionRow(nodeId);
    if (row === null) return null;
    // No-op against what the user SEES (the overlaid title), never the chain baseline.
    if (row.title === trimmed) return null;
    const baseline = overlay.baselineFor("rename", nodeId, row.title);
    overlay.stamp({
      kind: "rename",
      requestId,
      nodeId,
      title: trimmed,
      baseline,
      landed: false,
    });
    // The stamp TOMBSTONE outlives the chain - see `isLatestRenameStamp`.
    overlay.recordRenameStamp(nodeId, requestId);
    return requestId;
  }

  function beginRenameMutation(
    nodeId: string,
    nextTitle: string,
  ): string | null {
    return beginRenameMutationWithId(
      commandIdFactory.next(),
      nodeId,
      nextTitle,
      false,
    );
  }

  function beginEpicTitleMutationWithId(
    requestId: string,
    nextTitle: string,
  ): string | null {
    if (isDisposed()) return null;
    const trimmed = nextTitle.trim();
    if (trimmed.length === 0) return null;
    if (!isWritablePermissionRole(session.writeGateRole())) return null;
    // The OVERLAID (displayed) value; the no-op check runs against it for the same
    // rename-back-to-baseline reason as `beginRenameMutation`.
    const displayed = sink.read().epic.title;
    if (displayed === trimmed) return null;
    const baseline = overlay.baselineFor("epic-title", null, displayed);
    return overlay.stamp({
      kind: "epic-title",
      requestId,
      title: trimmed,
      baseline,
      landed: false,
    });
  }

  function beginEpicTitleMutation(nextTitle: string): string | null {
    return beginEpicTitleMutationWithId(commandIdFactory.next(), nextTitle);
  }

  function beginReparentMutationWithId(
    requestId: string,
    nodeId: string,
    newParentId: string | null,
    artifactOnly: boolean,
  ): string | null {
    if (isDisposed()) return null;
    if (!isWritablePermissionRole(session.writeGateRole())) return null;
    if (artifactOnly && !Object.hasOwn(sink.read().artifacts.byId, nodeId)) {
      return null;
    }
    // Validated against the projected tree, exactly as the write path is (4.3) - one evaluator, one
    // tree, so the overlay can never accept a move the commit would refuse.
    const evaluation = evaluateProjectedReparent(
      sink.read().tree,
      nodeId,
      newParentId,
    );
    if (!evaluation.ok) return null;
    const row = readUnionRow(nodeId);
    if (row === null) return null;
    return overlay.stamp({
      kind: "reparent",
      requestId,
      nodeId,
      parentId: newParentId,
      baseline: overlay.baselineFor("reparent", nodeId, row.parentId),
      landed: false,
    });
  }

  function beginReparentMutation(
    nodeId: string,
    newParentId: string | null,
  ): string | null {
    return beginReparentMutationWithId(
      commandIdFactory.next(),
      nodeId,
      newParentId,
      false,
    );
  }

  function stampArtifactStatus(
    requestId: string,
    intent: Extract<EpicWriteCommandIntent, { kind: "update-artifact-status" }>,
  ): boolean {
    if (isDisposed()) return false;
    if (!isWritablePermissionRole(session.writeGateRole())) return false;
    if (!Number.isInteger(intent.status)) return false;
    const artifacts = sink.read().artifacts;
    if (!Object.hasOwn(artifacts.byId, intent.artifactId)) return false;
    const row = artifacts.byId[intent.artifactId];
    if (row.kind !== intent.artifactType || row.status === intent.status) {
      return false;
    }
    overlay.stamp({
      kind: "status",
      requestId,
      nodeId: intent.artifactId,
      status: intent.status,
      baseline: overlay.baselineFor("status", intent.artifactId, row.status),
      landed: false,
    });
    return true;
  }

  function stampArtifactDelete(requestId: string, artifactId: string): boolean {
    if (isDisposed()) return false;
    if (!isWritablePermissionRole(session.writeGateRole())) return false;
    if (!Object.hasOwn(sink.read().artifacts.byId, artifactId)) return false;
    overlay.stamp({
      kind: "delete",
      requestId,
      nodeId: artifactId,
      baseline: true,
      landed: false,
    });
    return true;
  }

  function stampWriteCommand(
    command: CommandRecord<EpicWriteCommandIntent>,
  ): boolean {
    const { commandId, intent } = command;
    switch (intent.kind) {
      case "rename-artifact":
        return (
          beginRenameMutationWithId(
            commandId,
            intent.artifactId,
            intent.title,
            true,
          ) !== null
        );
      case "delete-artifact":
        return stampArtifactDelete(commandId, intent.artifactId);
      case "reparent-artifact":
        return (
          beginReparentMutationWithId(
            commandId,
            intent.artifactId,
            intent.parentId,
            true,
          ) !== null
        );
      case "update-artifact-status":
        return stampArtifactStatus(commandId, intent);
      case "update-epic-title":
        return beginEpicTitleMutationWithId(commandId, intent.title) !== null;
    }
  }

  // ── Assembly ──────────────────────────────────────────────────────────────

  const replica: EpicRecordsReplica = {
    planeId: EPIC_RECORDS_PLANE_ID,
    dataClass: "records",
    sink,
    overlay,
    get doc() {
      return doc;
    },
    get awareness() {
      return awareness;
    },

    apply(event: EpicRootEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      observedAtMs = environment.clock.now();
      switch (event.kind) {
        case "root-snapshot": {
          // The cross-plane sequencing (role adoption, control's snapshot fields, the viewer-downgrade room
          // teardown) belongs to the runtime; this arm is what the seam's `apply` can honestly do alone.
          const divergence = ingestSnapshot(event.meta, event.update);
          publishSnapshotLanded(event.meta, divergence);
          break;
        }
        case "root-update": {
          Y.applyUpdate(doc, event.update, STREAM_ORIGIN);
          coverage.applyUpdate(event.update);
          // Skip the expensive state-vector encode on the steady-stream clean-to-clean case: with no dirty
          // watermark, the coverage check is trivially satisfied and `latestHostStateVectorBase64` would
          if (sink.read().dirtyWatermarkStateVectorBase64 === null) break;
          const latestHostStateVectorBase64 = coverage.stateVectorBase64();
          publish(
            resolvePublicDirtyState(
              sink.read().dirtyWatermarkStateVectorBase64,
              latestHostStateVectorBase64,
            ),
          );
          break;
        }
        case "root-awareness":
          applyAwarenessUpdate(awareness, event.frame, "remote");
          break;
      }
      // The `@1` root lane carries a Yjs state vector, not a lane position.
      return { kind: "applied", cursor: null };
    },

    project(): void {
      projector.projectFull();
    },

    watermark: () => null,

    freshness(): ClassFreshness {
      return deriveClassFreshness({
        planeId: EPIC_RECORDS_PLANE_ID,
        dataClass: "records",
        session,
        observedAtMs,
      });
    },

    reset(_cause: ReplicaResetCause): void {
      replica.replaceReplica();
    },

    dispose(): void {
      // Settle any in-flight attachment reads (resolve null) so their observers unbind from the live doc
      // and their promises don't dangle forever - the caller's abort signal isn't guaranteed to fire
      [...attachmentReadWaiters].forEach((waiter) => waiter.settle(null));
      // Backstop for retires that never arrive (a caller torn down before its RPC settled). The replica
      // is dead, so nothing reads the map again; clearing just guarantees no stamp outlives it.
      overlay.clear();
      projector.detach();
      destroyReplica(doc, awareness);
      coverage.destroy();
    },

    ingestSnapshot,
    publishSnapshotLanded,
    publishLaneSnapshotLoaded,
    applyEarlyMeta,
    applyLocalUpdate,
    sendAwareness,
    flushPendingRootUpdates,
    emitCurrentAwareness,
    refreshDivergence,

    publishDivergence(): void {
      const state = sink.read();
      publish(
        resolvePublicDirtyState(
          state.dirtyWatermarkStateVectorBase64,
          state.latestHostStateVectorBase64,
        ),
      );
    },

    clearUnsyncedQueue(): void {
      unsynced.clear();
    },

    resetCoverage(): void {
      coverage.replace(null);
    },

    publishFreshCycle(): void {
      publish({
        snapshotLoaded: false,
        unsyncedQueueSize: 0,
        ...knownCleanDirtyState(),
      });
    },

    discardUnsyncedEdits(clearRoomState: () => void): void {
      if (unsynced.isEmpty() && !sink.read().isDirty) return;
      unsynced.clear();
      clearRoomState();
      publish({
        unsyncedQueueSize: 0,
        ...resolvePublicDirtyState(
          null,
          sink.read().latestHostStateVectorBase64,
        ),
      });
    },

    clearLocalWritePaths(options): void {
      unsynced.clear();
      if (!options.clearCoverage) {
        // A viewer downgrade. Coverage is KEPT: the host still holds what it acknowledged, and discarding
        // it would under-report host coverage, which is the direction that claims unsynced edits are safe.
        publish({ unsyncedQueueSize: 0 });
        return;
      }
      // Access revoked.
      coverage.replace(null);
      publish({ unsyncedQueueSize: 0, ...knownCleanDirtyState() });
    },

    replaceReplica(): void {
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
      if (attachedHead === "lane") {
        laneSlices = EMPTY_LANE_STATE_SLICES;
        attachLaneSources();
        return;
      }
      projector.attach(doc, projectorSink);
    },

    readSeedOffer: () => coverage.readSeedOffer(),

    attachLaneHead(): void {
      attachedHead = "lane";
      attachLaneSources();
    },

    applyLaneState(slices): void {
      if (isDisposed()) return;
      laneSlices = slices;
      projector.projectFull();
    },

    applyChatRecords(records, issuedAtSeq): void {
      if (isDisposed()) return;
      const publication = chatTable.applyRecords(records, issuedAtSeq);
      if (publication === null) return;
      publishRecordSlice(
        publication.chatRetractions === null
          ? { chatRecords: publication.chatRecords }
          : {
              chatRecords: publication.chatRecords,
              chatRetractions: publication.chatRetractions,
            },
      );
    },

    applyConfirmedChatMutation(mutation): void {
      if (isDisposed()) return;
      const publication = chatTable.applyConfirmedMutation(mutation);
      if (publication !== null)
        publishRecordSlice({ chatRecords: publication.chatRecords });
    },

    applyChatRecordDelta(delta): void {
      if (isDisposed()) return;
      const publication = chatTable.applyDelta(delta);
      if (publication === null) return;
      publishRecordSlice(
        publication.chatRetractions === null
          ? { chatRecords: publication.chatRecords }
          : {
              chatRecords: publication.chatRecords,
              chatRetractions: publication.chatRetractions,
            },
      );
    },

    peekChatIngestSeq: () => chatTable.ingestSeq(),

    markChatRecordListNotAuthoritative(): void {
      if (isDisposed() || !sink.read().chatRecordListAuthoritative) return;
      publish({ chatRecordListAuthoritative: false });
    },

    markChatRecordListAuthoritative(): void {
      if (isDisposed() || sink.read().chatRecordListAuthoritative) return;
      publish({ chatRecordListAuthoritative: true });
    },

    applyTuiAgentRecords(records, issuedAtSeq): void {
      if (isDisposed()) return;
      const publication = tuiTable.applyRecords(records, issuedAtSeq);
      if (publication === null) return;
      publishRecordSlice(
        publication.tuiAgentRetractions === null
          ? { tuiAgentRecords: publication.tuiAgentRecords }
          : {
              tuiAgentRecords: publication.tuiAgentRecords,
              tuiAgentRetractions: publication.tuiAgentRetractions,
            },
      );
    },

    applyTuiAgentRecordDelta(delta): void {
      if (isDisposed()) return;
      const publication = tuiTable.applyDelta(delta);
      if (publication === null) return;
      publishRecordSlice(
        publication.tuiAgentRetractions === null
          ? { tuiAgentRecords: publication.tuiAgentRecords }
          : {
              tuiAgentRecords: publication.tuiAgentRecords,
              tuiAgentRetractions: publication.tuiAgentRetractions,
            },
      );
    },

    peekTuiAgentIngestSeq: () => tuiTable.ingestSeq(),

    beginPendingChatCreation(pending): void {
      if (isDisposed()) return;
      const publication = chatTable.beginPendingCreation(pending);
      if (publication === null) return;
      publishRecordSlice({ chatRecords: publication.chatRecords });
    },

    clearPendingChatCreation(chatId): void {
      if (isDisposed()) return;
      const publication = chatTable.clearPendingCreation(chatId);
      if (publication === null) return;
      publishRecordSlice({ chatRecords: publication.chatRecords });
    },

    republishRecordsForCurrentUser(): void {
      if (isDisposed()) return;
      const chats = chatTable.republishForCurrentUser();
      if (chats !== null) {
        publishRecordSlice({ chatRecords: chats.chatRecords });
      }
      const agents = tuiTable.republishForCurrentUser();
      if (agents !== null) {
        publishRecordSlice({ tuiAgentRecords: agents.tuiAgentRecords });
      }
    },

    readArtifactRoomId(artifactId): string | null {
      const entry = getArtifactEntry(doc, artifactId);
      if (entry === null) return null;
      const v = entry.get("artifactRoomId");
      return typeof v === "string" && v.length > 0 ? v : null;
    },

    readArtifactTitle(artifactId): string | null {
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

    hasAttachmentBytes: (hash) =>
      doc.getMap("attachments").get(hash) instanceof Uint8Array,

    heldAttachmentHashes: () => heldAttachmentHashesNow(),

    readAttachmentBytes(hash, signal): Promise<Uint8Array | null> {
      if (signal.aborted) return Promise.resolve(null);
      const existing = doc.getMap("attachments").get(hash);
      if (existing instanceof Uint8Array) return Promise.resolve(existing);
      // Wait for the bytes to sync in.
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

    renameArtifact,
    deleteArtifact,
    reparentArtifact,
    setEpicTitle,
    beginRenameMutation,
    beginEpicTitleMutation,
    beginReparentMutation,
    stampWriteCommand,

    detach(): void {
      overlay.dropLandedOnDetach();
      projector.detach();
    },

    start(): void {
      // Wired last so the initial full projection runs after the consumer is fully constructed -
      // otherwise the publication from `attach` would race with the persist middleware's hydration
      attachedHead = "doc";
      projector.attach(doc, projectorSink);
    },

    unsyncedQueueSize: () => unsynced.size(),
  };

  return replica;
}
