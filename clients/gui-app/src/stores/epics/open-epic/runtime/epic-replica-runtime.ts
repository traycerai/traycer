import type { ConfirmedChatMutation } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
/**
 * The composition root: the object the 3,600-line closure was cut into. It holds the three planes,
 * the adapter that feeds them, and the ORDER they run in.
 */
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type {
  AdapterDetachReason,
  CommandIdFactory,
  CommandQueue,
  CommandRecord,
  ReplicaReplacementReason,
  ReplicaResetCause,
  ReplicaTransitionToken,
  RuntimeEnvironment,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import {
  createCommandQueue,
  createTransactionalProjectionSink,
} from "@traycer-clients/shared/replica-runtime";
import { jsonByteLength } from "@/stores/replica-memory/json-bytes";
import type { HotDocBudgetSink } from "@/stores/replica-memory/hot-doc-budget";
import type { EpicRuntimeAccountingPort } from "./epic-runtime-accounting-port";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import type { EpicDocRecordArms } from "../projection-helpers";
import type { EpicArtifactRoomAvailability } from "../types";
import type { PendingChatCreation } from "../pending-chat-creations";
import type {
  EarlyMetaEpic,
  SnapshotMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  EpicOutboundRequest,
  EpicRuntimeEvent,
} from "./epic-runtime-events";
import type {
  EpicControlProjection,
  EpicRecordsProjection,
  EpicRoomsProjection,
} from "./epic-runtime-projection";
import {
  EMPTY_RECORDS_PROJECTION,
  EMPTY_ROOMS_PROJECTION,
  INITIAL_CONTROL_PROJECTION,
} from "./epic-runtime-projection";
import type { EpicRuntimeDelivery } from "./projection-delivery";
import { deliverInto } from "./projection-delivery";
import {
  createArtifactRoomTier,
  type ArtifactRoomColdSettlement,
  type ArtifactRoomColdState,
} from "./artifact-room-tier";
import { createEpicRecordsReplica, LOCAL_ORIGIN } from "./epic-records-replica";
import { createEpicRoomsReplica } from "./epic-rooms-replica";
import { createEpicControlReplica } from "./epic-control-replica";
import {
  createLegacyEpicStreamAdapter,
  type EpicStreamClientFactory,
} from "./legacy-epic-stream-adapter";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import {
  createEpicLaneArm,
  type EpicLaneArm,
  type EpicLaneProbeOutcome,
} from "./epic-lane-arm";
import {
  readEpicAdapterVerdict,
  type EpicAdapterArm,
  type EpicAdapterVerdict,
  type EpicMethodSupportReader,
} from "./epic-adapter-selection";
import { planEpicAdapterTransition } from "./epic-adapter-lifecycle";
import {
  classifyEpicWriteCommandFailure,
  EpicWriteCommandTransportUnavailableError,
  type EpicWriteCommandIntent,
  type EpicWriteCommandSender,
} from "./epic-write-command";

export interface EpicReplicaRuntimeOptions {
  readonly epicId: string;
  /** No `hostId`. */
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: EpicStreamClientFactory;
  /**
   * Where the planes publish. Supplied by the consumer because delivery is a consumer concern - a
   * zustand `setState` today, a `postMessage` once the runtime is in a worker.
   */
  readonly delivery: EpicRuntimeDelivery;
  /** Where this runtime's bytes are reported. Supplied, never reached for. */
  readonly accounting: EpicRuntimeAccountingPort;
  /**
   * The signed-in user's id, read live. The runtime never imports the auth
   * store; identity arrives from the UI side of the seam.
   */
  readonly getCurrentUserId: () => string | null;
  /**
   * Whether the epic doc is still a record SOURCE, per population - read live, because it is settled
   * by what this host negotiated for `epic.listChatRecords` / `epic.listTuiAgents` and that arrives
   */
  readonly getDocArm: () => EpicDocRecordArms;
  /**
   * Invoked when the host closes the epic stream with an `UNAUTHORIZED` fatal error. Production
   * wires this to `AuthService.revalidateCurrentContext()`.
   */
  readonly onAuthError: (() => void) | null;
  readonly commandIdFactory: CommandIdFactory;
  readonly writeCommandSender: EpicWriteCommandSender;
  /** Everything the lane arm needs, or `null` when this caller cannot serve lanes at all. */
  readonly laneSelection: EpicLaneSelectionSources | null;
}

/** What a lane-capable composition supplies. All of it, or none. */
export interface EpicLaneSelectionSources {
  /** This connection's negotiated support for the three lane methods, read LIVE. */
  readonly support: EpicMethodSupportReader;
  /** Notified whenever any method's support changes. Returns an unsubscribe. */
  readonly subscribeSupport: (listener: () => void) => () => void;
  readonly stateStreamClientFactory: EpicStateStreamClientFactory;
  readonly statusStreamClientFactory: EpicStatusStreamClientFactory;
  /** One body lane per artifact whose body is being shown. */
  readonly artifactStreamClientFactory: ArtifactStreamClientFactory;
  /** The two unaries that complete the lane surface. */
  readonly unaries: EpicLaneUnaries;
}

/** `epic.getWorkspaceContext@1.0` and `epic.retryMigration@1.0`, as this runtime consumes them. */
export interface EpicLaneUnaries {
  /**
   * The workspace context - repos, workspaces, repo mapping, resolved folders, `epicLight`,
   * permission role. Exactly `earlyMeta`'s payload.
   */
  getWorkspaceContext(): Promise<EarlyMetaEpic>;
  /**
   * Re-run a failed major migration. Resolves when the host ACCEPTED the retry; progress arrives on
   * the status lane, not here.
   */
  retryMigration(): Promise<void>;
}

export interface EpicReplicaRuntime {
  /**
   * The live root `Y.Doc`. A getter: a replica replacement mints a new one, and
   * a captured reference would observe a destroyed doc.
   */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * The root replica's whole state, encoded for transfer into another session. A PORT over what two
   * call sites do today as `Y.encodeStateAsUpdate(handle.doc)` against a doc they reach directly.
   */
  encodeRootState(): Promise<Uint8Array>;
  /**
   * Apply another session's encoded root state into this one. `asLocalEdit` is not a convenience:
   * the two merge sites differ, and the difference is load-bearing.
   */
  applyRootUpdate(update: Uint8Array, asLocalEdit: boolean): Promise<boolean>;
  /** Bumped every time the root replica is REPLACED. */
  replicaGeneration(): number;

  /** Attach the projector and open the stream. Called once, after the consumer is live. */
  start(): void;

  // ── Local writes ────────────────────────────────────────────────────────
  applyLocalUpdate(updateBytes: Uint8Array): void;
  sendAwareness(awarenessBytes: Uint8Array): void;
  discardUnsyncedEdits(): void;
  requestFreshSnapshot(): void;
  retryMigration(): void;
  enqueueWriteCommand(
    intent: EpicWriteCommandIntent,
  ): CommandRecord<EpicWriteCommandIntent> | null;
  retryWriteCommand(commandId: string): void;
  discardWriteCommand(commandId: string): void;

  // ── Record channels ─────────────────────────────────────────────────────
  applyChatRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  peekChatIngestSeq(): number;
  markChatRecordListAuthoritative(): void;
  /** Withdraw the record list's authority for a new viewer. */
  markChatRecordListNotAuthoritative(): void;
  applyChatRecordDelta(delta: ChatRecordDelta): void;
  applyConfirmedChatMutation(mutation: ConfirmedChatMutation): void;
  applyTuiAgentRecords(
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ): void;
  peekTuiAgentIngestSeq(): number;
  applyTuiAgentRecordDelta(delta: TuiAgentRecordDelta): void;
  republishRecordsForCurrentUser(): void;
  /** Re-run the projection because the VIEWER changed, not because the doc did. */
  reprojectForViewerChange(): void;
  beginPendingChatCreation(pending: PendingChatCreation): void;
  clearPendingChatCreation(chatId: string): void;

  // ── Doc mutations and the optimistic overlay ────────────────────────────
  renameArtifact(artifactId: string, nextTitle: string): boolean;
  deleteArtifact(artifactId: string): boolean;
  reparentArtifact(artifactId: string, newParentId: string | null): boolean;
  setEpicTitle(nextTitle: string): boolean;
  beginRenameMutation(nodeId: string, nextTitle: string): string | null;
  beginEpicTitleMutation(nextTitle: string): string | null;
  beginReparentMutation(
    nodeId: string,
    newParentId: string | null,
  ): string | null;
  retirePendingMutation(
    requestId: string,
    outcome: "landed" | "failed",
  ): boolean;
  isLatestRenameStamp(nodeId: string, requestId: string): boolean;
  readArtifactTitle(artifactId: string): string | null;

  // ── Live-Y escape hatches ───────────────────────────────────────────────
  getArtifactFragment(artifactId: string): Y.XmlFragment | null;
  getArtifactBodyAwareness(artifactId: string): Awareness | null;
  getArtifactBodyAvailability(artifactId: string): EpicArtifactRoomAvailability;
  /**
   * The key the artifact-body tier holds this artifact's live `Y.Doc` under, or `null` when there is
   * none. Deliberately NOT "the room id" any more, though that is what it returns on the `@1` arm.
   */
  getArtifactBodyDocKey(artifactId: string): string | null;
  /**
   * The cold bytes for a body doc, or `null` when the tier does not hold it. The runtime's face on
   * the tier's own arithmetic.
   */
  encodeArtifactBodyColdState(docKey: string): ArtifactRoomColdState | null;
  /** The live body doc's bytes for a room that states NO identity. */
  encodeArtifactBodyForwardOnly(docKey: string): Uint8Array | null;
  /**
   * Observe a materialized body doc; returns the detach. The tier has no per-room change callback
   * (only `onDivergenceChanged`), so this is a direct observation of the replica's doc.
   */
  observeArtifactBodyDoc(
    docKey: string,
    onUpdate: (update: Uint8Array) => void,
  ): () => void;
  /** A local presence frame from the main-thread editor, on its way out. */
  sendArtifactBodyAwareness(
    docKey: string,
    frame: Uint8Array,
    localClientId: number,
  ): void;
  /**
   * Is this body pinned by tier state? See the tier member - the lease arm is
   * excluded, because the caller asking is the one releasing.
   */
  isArtifactBodyPinned(docKey: string): boolean;
  /** This body's known remote peers, to ride the materialize. See the tier. */
  encodeArtifactBodyPeerAwareness(docKey: string): readonly Uint8Array[];
  /**
   * Observe a materialized body's presence; returns the detach. The inbound counterpart: remote
   * peers land in the room's `Awareness`, and the editor rendering them is on the other thread.
   */
  observeArtifactBodyAwareness(
    docKey: string,
    onFrame: (frame: Uint8Array) => void,
  ): () => void;
  /**
   * Take a body doc's encoded state back. Refuses a moved identity rather than
   * splicing two histories - see `ArtifactRoomColdSettlement`.
   */
  settleArtifactBodyColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ): ArtifactRoomColdSettlement;
  /** A local body edit on its way to the lane. The lane's own verdict. */
  sendArtifactBodyUpdate(docKey: string, update: Uint8Array): SendOutcome;
  acquireArtifactBodyLease(artifactId: string): () => void;
  hasAttachmentBytes(hash: string): boolean;
  readAttachmentBytes(
    hash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;

  // ── Lifecycle ───────────────────────────────────────────────────────────
  /** Stop the socket, keep every replica and every unsynced edit addressable. */
  detachTransport(): void;
  dispose(): void;
  isDisposed(): boolean;
  /** Ids of the artifact rooms currently materialized as live `Y.Doc`s. */
  materializedArtifactRoomIds(): readonly string[];
}

export function createEpicReplicaRuntime(
  options: EpicReplicaRuntimeOptions,
): EpicReplicaRuntime {
  const {
    epicId,
    environment,
    streamClientFactory,
    delivery,
    accounting,
    getCurrentUserId,
    getDocArm,
    onAuthError,
    commandIdFactory,
    writeCommandSender,
    laneSelection,
  } = options;

  let disposed = false;
  /** Set by `detachTransport`. */
  let transportDetached = false;
  /**
   * Named apart from the accessor it backs, so a reader is never asking whether
   * the method shadows the binding inside its own body.
   */
  let replicaGenerationCounter = 0;
  /**
   * The authority TRANSITION this replica was last rebuilt for. This is what makes {@link
   * replaceForAuthority} idempotent per event rather than per call.
   */
  let replacementSettledForTransition: ReplicaTransitionToken | null = null;
  const isDisposed = (): boolean => disposed;
  /**
   * Last snapshot's wire bytes, not a live encode of the resident doc. Honest while `@1` is the
   * wire: the floor is measured-not-evicted, and the snapshot is the figure we actually received.
   */
  let rootSettledBytes = 0;
  const budgetSink: HotDocBudgetSink = {
    settle: (artifactRoomId, bytes) =>
      accounting.settleHotDocBytes(artifactRoomId, bytes),
    settleCold: (artifactRoomId, bytes) =>
      accounting.settleColdRoomBytes(artifactRoomId, bytes),
    chargeProvisional: (artifactRoomId, bytes) =>
      accounting.chargeHotDocProvisional(artifactRoomId, bytes),
    release: (artifactRoomId) => accounting.releaseHotDoc(artifactRoomId),
  };

  // Explicit type arguments on every sink, and typed constants rather than object literals for the
  // seeds: the shared factory infers its projection from the initial value, and a literal seed would
  const recordsSink = createTransactionalProjectionSink<EpicRecordsProjection>(
    EMPTY_RECORDS_PROJECTION,
    deliverInto<EpicRecordsProjection>(delivery),
  );
  const roomsSink = createTransactionalProjectionSink<EpicRoomsProjection>(
    EMPTY_ROOMS_PROJECTION,
    deliverInto<EpicRoomsProjection>(delivery),
  );
  const controlSink = createTransactionalProjectionSink<EpicControlProjection>(
    INITIAL_CONTROL_PROJECTION,
    deliverInto<EpicControlProjection>(delivery),
  );

  // ── Planes ──────────────────────────────────────────────────────────────── Constructed in
  // dependency order, with the two genuine cycles broken by lazy reads rather than by a mediator

  const control = createEpicControlReplica({
    epicId,
    environment,
    sink: controlSink,
    effects: {
      clearLocalWritePathsAndCoverage: () => {
        // Rooms first, then the root: the root's publish recomputes divergence,
        // and it has to see rooms that are already clear.
        tier.clearAllPending();
        records.clearLocalWritePaths({ clearCoverage: true });
      },
      clearLocalWritePaths: () => {
        tier.clearAllPending();
        records.clearLocalWritePaths({ clearCoverage: false });
      },
      requestFreshSnapshot: () => requestFreshSnapshot(),
      drainWritePathsAfterReconnect: () => drainWritePathsAfterReconnect(),
      emitRootAwareness: () => records.emitCurrentAwareness(),
    },
    onAuthError,
    isDisposed,
  });

  /** One outbound request, routed to the arm that is actually installed. */
  function sendOutbound(request: EpicOutboundRequest): SendOutcome {
    if (installedArm !== "lanes" || laneArm === null) {
      return adapter.send(request);
    }
    switch (request.kind) {
      case "room-update":
        return laneArm.bodies.sendUpdate(
          request.artifactRoomId,
          request.update,
        );
      case "room-awareness":
        return laneArm.bodies.sendAwareness(
          request.artifactRoomId,
          request.frame,
        );
      case "root-update":
      case "root-awareness":
      case "retry-migration":
        return adapter.send(request);
    }
  }

  const tier = createArtifactRoomTier({
    environment,
    session: control.facts,
    // Body writes go out on the arm that is installed.
    send: (request) => sendOutbound(request),
    // The GATED form: these fire on every keystroke-level room edit and every
    // inbound room frame, and the closure gated them for that reason.
    onDivergenceChanged: () => records.refreshDivergence(),
    isDisposed,
    budget: budgetSink,
  });

  const rooms = createEpicRoomsReplica({
    environment,
    session: control.facts,
    tier,
    sink: roomsSink,
    publishDivergence: () => records.publishDivergence(),
    isDisposed,
    // Which artifacts a body-doc key covers, per arm. On the LANE arm the key IS the artifact -
    // `artifact.subscribe` serves one body per doc - so the fan-out is the identity.
    artifactIdsForRoom: (artifactBodyDocKeyValue) => {
      if (installedArm === "lanes") return [artifactBodyDocKeyValue];
      const artifacts = records.sink.read().artifacts;
      return artifacts.allIds.filter(
        (id) => artifacts.byId[id].artifactRoomId === artifactBodyDocKeyValue,
      );
    },
  });

  const records = createEpicRecordsReplica({
    // Published from HERE because the control slice is the runtime's; the
    // records replica owns the doc but its sink is typed to the records slice.
    onHeldAttachmentsChanged: (heldAttachmentHashes) => {
      options.delivery.publish({ heldAttachmentHashes });
    },
    environment,
    session: control.facts,
    sink: recordsSink,
    getCurrentUserId,
    getDocArm,
    send: (request) => {
      sendOutbound(request);
    },
    hasRoomDivergence: () => tier.hasDivergence(),
    isDisposed,
    commandIdFactory,
    onCommandReconciled: (commandId, outcome, via) => {
      reconcileWriteCommand(commandId, outcome, via);
    },
  });

  const adapter = createLegacyEpicStreamAdapter({
    epicId,
    streamClientFactory,
    readSeedOffer: () => records.readSeedOffer(),
    isDisposed,
  });

  const attemptedHostByCommandId = new Map<string, string>();
  const commandQueue: CommandQueue<EpicWriteCommandIntent> =
    createCommandQueue<EpicWriteCommandIntent>({
      environment,
      idFactory: commandIdFactory,
      accept: () => !disposed,
      onEnqueued: (command) => records.stampWriteCommand(command),
      onUnknownOutcome: (command) => {
        records.overlay.markUnknownOutcome(command.commandId);
      },
      onResolved: (command) => {
        records.overlay.retire(
          command.commandId,
          command.state === "committed" ? "landed" : "failed",
        );
        attemptedHostByCommandId.delete(command.commandId);
      },
      classifyFailure: classifyEpicWriteCommandFailure,
      send: async (command) => {
        if (
          transportDetached ||
          control.facts.transportStatus() !== "open" ||
          !control.facts.hasFreshRootSnapshotForOpenCycle()
        ) {
          throw new EpicWriteCommandTransportUnavailableError();
        }
        const hostId = writeCommandSender.currentHostId();
        if (hostId === null) {
          throw new EpicWriteCommandTransportUnavailableError();
        }
        attemptedHostByCommandId.set(command.commandId, hostId);
        const result = await writeCommandSender.send(
          command.commandId,
          command.intent,
        );
        return {
          kind: "committed",
          hostId: result.hostId,
          entityVersion: null,
        };
      },
    });

  function reconcileWriteCommand(
    commandId: string,
    outcome: "echo" | "superseded",
    via: "authoritative-projection" | "landed-overlay-ttl",
  ): void {
    const command = commandQueue
      .list()
      .find((candidate) => candidate.commandId === commandId);
    if (command === undefined) return;
    if (outcome === "echo") {
      if (
        command.state !== "pending" ||
        command.delivery !== "unknown-outcome"
      ) {
        return;
      }
      const hostId = attemptedHostByCommandId.get(commandId);
      if (hostId === undefined) return;
      commandQueue.resolve(commandId, {
        kind: "committed",
        hostId,
        entityVersion: null,
      });
      return;
    }
    commandQueue.resolve(commandId, {
      kind: "superseded",
      observedAtMs: environment.clock.now(),
      via,
    });
  }

  function publishWriteCommands(): void {
    const writeCommands = commandQueue.list();
    recordsSink.publish({ ...recordsSink.read(), writeCommands });
    accounting.settleCommandOverlayBytes(
      jsonByteLength(commandQueue.pending()),
    );
  }

  const unsubscribeCommandQueue = commandQueue.subscribe(publishWriteCommands);

  accounting.registerBooks({
    materializedRoomIds: () => tier.materializedIds(),
    demoteColdestUnpinned: (overBytes) => tier.demoteColdestUnpinned(overBytes),
    measureRootBytes: () => rootSettledBytes,
    projectionCounts: () => {
      const projection = records.sink.read();
      return {
        artifacts: projection.artifacts.allIds.length,
        chats: projection.chats.allIds.length,
        tuiAgents: projection.tuiAgents.allIds.length,
        deletedArtifacts: projection.deletedArtifacts.allIds.length,
        roleClaims: Object.keys(projection.agentRoles.byAgentId).length,
        treeNodes: Object.keys(projection.tree.nodeById).length,
      };
    },
  });

  // ── Sequencing ────────────────────────────────────────────────────────────

  /**
   * A landed root snapshot, in the exact order the closure ran it. Two orderings here are
   * load-bearing and neither is expressible as a dependency between the planes:
   */
  function applyRootSnapshot(meta: SnapshotMetaEpic, update: Uint8Array): void {
    const divergence = records.ingestSnapshot(meta, update);
    rootSettledBytes = update.byteLength;
    accounting.settleRootBytes(update.byteLength);
    control.adoptSnapshotRole(meta.permissionRole);
    records.publishSnapshotLanded(meta, divergence);
    // The mapping half of the availability fan-out.
    rooms.republishAvailability();
    control.noteSnapshotLanded(meta.permissionRole);
    if (!control.facts.isWritableRole()) {
      // Fail closed: a viewer (or a client whose role the snapshot revoked) keeps no body state at all.
      // The divergence republish is unconditional because the closure's write here was.
      rooms.dropAllOnViewerDowngrade();
      records.publishDivergence();
      return;
    }
    if (control.facts.transportStatus() === "open") {
      tier.flushAllPending();
      commandQueue.retryPending();
    }
  }

  function drainWritePathsAfterReconnect(): void {
    if (control.facts.transportStatus() !== "open") return;
    if (!control.facts.hasFreshRootSnapshotForOpenCycle()) return;
    records.flushPendingRootUpdates();
    tier.flushAllPending();
    commandQueue.retryPending();
    records.emitCurrentAwareness();
  }

  // ── Adapter selection ───────────────────────────────────────────────────── Which arm serves this
  // connection, and what happens when that changes.

  const laneArm: EpicLaneArm | null =
    laneSelection === null
      ? null
      : createEpicLaneArm({
          epicId,
          environment,
          stateStreamClientFactory: laneSelection.stateStreamClientFactory,
          statusStreamClientFactory: laneSelection.statusStreamClientFactory,
          getCurrentUserId,
          isDisposed,
          onStateSlices: (slices) => {
            delivery.batch(() => {
              records.applyLaneState(slices);
            });
          },
          onStateLeadSnapshot: () => {
            delivery.batch(() => {
              records.publishLaneSnapshotLoaded();
            });
          },
          onControlEvent: (event) => {
            delivery.batch(() => {
              control.apply(event);
            });
          },
          getWorkspaceContext: () =>
            laneSelection.unaries.getWorkspaceContext(),
          // The SAME two writes the `@1` arm performs for its `earlyMeta` frame, in the same one store write
          // - `snapshotMeta` on the records plane, the DISPLAY role on the control plane.
          onWorkspaceContext: (context) => {
            delivery.batch(() => {
              records.applyEarlyMeta(context);
              control.apply({ kind: "early-meta", meta: context });
            });
          },
          onReplacementRequested: (reason, transition) => {
            replaceForAuthority(reason, transition);
          },
          artifactStreamClientFactory:
            laneSelection.artifactStreamClientFactory,
          // The tier IS the seed authority: a body it does not hold offers nothing, so the host answers with
          // a full seed rather than a delta against state this client threw away.
          readDocSeed: (artifactId) => tier.readDocSeedOffer(artifactId),
          onRoomEvent: (event) => {
            delivery.batch(() => {
              rooms.apply(event);
            });
          },
          onProbeOutcome: (outcome) => {
            applyProbeOutcome(outcome);
          },
          onRequiredLaneUnsupported: () => {
            applyRequiredLaneUnsupported();
          },
        });

  let installedArm: EpicAdapterArm | null = null;
  let unsubscribeLaneSupport: (() => void) | null = null;

  function attachArm(arm: EpicAdapterArm): void {
    if (arm === "legacy") {
      // Retire an outstanding capability probe first.
      laneArm?.detach("superseded");
      // The doc head: the projector binds the root `Y.Doc` and the `@1` adapter
      // opens the one multiplexed socket.
      records.start();
      adapter.attach({
        environment,
        emit: routeEvent,
        // `@1` cannot report a resume outcome - see the adapter's module doc.
        reportResume: () => {},
        reportStatus: () => {},
        // Replacement on this line is client-initiated only: `@1` carries no
        // epoch, so there is no authority-side signal that could ask for one.
        requestReplacement: () => {},
      });
      return;
    }
    if (laneArm === null) return;
    records.attachLaneHead();
    laneArm.attach();
  }

  function detachArm(arm: EpicAdapterArm, reason: AdapterDetachReason): void {
    if (arm === "legacy") {
      adapter.detach(reason);
      return;
    }
    laneArm?.detach(reason);
  }

  /** Close whatever this runtime has open, installed arm or not. */
  function detachWhateverIsOpen(reason: AdapterDetachReason): void {
    if (installedArm !== null) {
      detachArm(installedArm, reason);
      return;
    }
    laneArm?.detach(reason);
  }

  /**
   * Whether the sockets serving this runtime are replaced as part of the reset, so the transport
   * legs may honestly go back to `connecting`.
   */
  function replacesTransportUnderReset(cause: ReplicaResetCause): boolean {
    if (cause.origin === "client") return true;
    switch (cause.reason) {
      case "manifest-changed":
      case "host-repointed":
        return true;
      case "authority-epoch-changed":
      case "security-epoch-changed":
      case "migration-completed":
      case "resume-too-old":
        return false;
    }
  }

  /** Empty every plane, carrying the cause. */
  function resetAllPlanes(cause: ReplicaResetCause): void {
    records.clearUnsyncedQueue();
    if (replacesTransportUnderReset(cause)) {
      control.beginFreshCycle();
    } else {
      control.beginAuthorityReplacementCycle();
    }
    records.replaceReplica();
    records.resetCoverage();
    laneArm?.reset(cause);
    rooms.reset(cause);
    // AFTER `rooms.reset`, which is the step that actually discards the bodies.
    laneArm?.rebuildBodiesAfterReset(cause);
    records.publishFreshCycle();
  }

  /** A `resume-too-old` reseed: the records plane only. */
  function resetStateRecordsOnly(cause: ReplicaResetCause): void {
    delivery.batch(() => {
      records.clearUnsyncedQueue();
      records.replaceReplica();
      records.resetCoverage();
      laneArm?.reset(cause);
      records.publishFreshCycle();
    });
  }

  /**
   * An adapter asking for the replica to be rebuilt. COALESCED by construction: every lane routes
   * here, and one transition reported by several produces one rebuild.
   */
  function replaceForAuthority(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void {
    if (disposed) return;
    if (reason === "resume-too-old") {
      resetStateRecordsOnly({ origin: "authority", reason });
      return;
    }
    // Keyed on the TRANSITION, not the reason, and that is what finally makes the coalescing above
    // true. Two earlier attempts were not:
    if (replacementSettledForTransition === transition) return;
    replacementSettledForTransition = transition;
    delivery.batch(() => {
      resetAllPlanes({ origin: "authority", reason });
      replicaGenerationCounter += 1;
    });
  }

  /** Re-read the manifest and move the arm if it says to. */
  /**
   * The key the body tier holds one artifact's live doc under, per arm. `@1` addresses a body by the
   * ROOM that hosts it - one room, many bodies - and reads the mapping off the records plane.
   */
  function artifactBodyDocKey(artifactId: string): string | null {
    if (installedArm === "lanes") return artifactId;
    return records.readArtifactRoomId(artifactId);
  }

  function executeTransition(verdict: EpicAdapterVerdict): void {
    const transition = planEpicAdapterTransition(installedArm, verdict);
    if (transition.steps.length === 0) {
      installedArm = transition.installed;
      options.delivery.publish({ installedArm });
      return;
    }
    for (const step of transition.steps) {
      switch (step.kind) {
        case "detach":
          detachArm(step.arm, "superseded");
          break;
        case "reset":
          delivery.batch(() => {
            resetAllPlanes(step.cause);
          });
          break;
        case "bump-generation":
          replicaGenerationCounter += 1;
          break;
        case "attach":
          attachArm(step.arm);
          break;
      }
    }
    installedArm = transition.installed;
    options.delivery.publish({ installedArm });
  }

  function applySelection(): void {
    if (disposed) return;
    const verdict =
      laneSelection === null
        ? "legacy"
        : readEpicAdapterVerdict(laneSelection.support);
    if (installedArm !== "lanes" && verdict === "undecided") {
      // Idempotent: the arm opens one status stream however often this is called, and every reconnect's
      // support reset lands here again.
      laneArm?.probe();
      return;
    }
    executeTransition(verdict);
  }

  /** The probe answered. Install on THAT, without consulting the manifest. */
  /** A lane the installed arm requires is not served. Fall back to legacy. */
  function applyRequiredLaneUnsupported(): void {
    if (disposed) return;
    if (installedArm !== "lanes") return;
    executeTransition("legacy");
  }

  function applyProbeOutcome(outcome: EpicLaneProbeOutcome): void {
    if (disposed) return;
    if (installedArm === "lanes") return;
    if (outcome === "succeeded") {
      executeTransition("lanes");
      return;
    }
    if (installedArm === "legacy") {
      // A REFUSED re-probe, and it has to retire its own stream.
      laneArm?.detach("superseded");
      return;
    }
    executeTransition("legacy");
  }

  function routeEvent(runtimeEvent: EpicRuntimeEvent): void {
    delivery.batch(() => {
      switch (runtimeEvent.plane) {
        case "root":
          if (runtimeEvent.event.kind === "root-snapshot") {
            applyRootSnapshot(
              runtimeEvent.event.meta,
              runtimeEvent.event.update,
            );
            return;
          }
          records.apply(runtimeEvent.event);
          // A later root update can create an artifact naming a room already reported `ready`, which is the
          // same "mapping arrived second" case as the snapshot above.
          rooms.republishAvailability();
          return;
        case "rooms":
          rooms.apply(runtimeEvent.event);
          return;
        case "control":
          // The metadata-only frame settles a field on each of two planes: `snapshotMeta` here, the
          // displayed role there. One frame, two decoded halves, one store write.
          if (runtimeEvent.event.kind === "early-meta") {
            records.applyEarlyMeta(runtimeEvent.event.meta);
          }
          control.apply(runtimeEvent.event);
          return;
      }
    });
  }

  /** Discard the replica and re-subscribe from scratch. */
  function requestFreshSnapshot(): void {
    if (disposed) return;
    delivery.batch(() => {
      records.clearUnsyncedQueue();
      control.beginFreshCycle();
      // Close BEFORE discarding and open AFTER: the re-subscribe reads the resume offer (a `@1` seed
      // offer, or the lane's applied cursor), and an offer taken before the discard would name state
      if (installedArm === "lanes") {
        laneArm?.closeTransport();
      } else {
        adapter.closeTransport();
      }
      records.replaceReplica();
      laneArm?.reset({ origin: "client", intent: "fresh-snapshot-requested" });
      records.resetCoverage();
      // The rooms plane's reset, carrying its PROVENANCE: nothing is wrong upstream, the client asked.
      rooms.reset({ origin: "client", intent: "fresh-snapshot-requested" });
      records.publishFreshCycle();
      replicaGenerationCounter += 1;
    });
    if (installedArm === "lanes") {
      laneArm?.openTransport();
    } else {
      adapter.openTransport();
    }
  }

  return {
    get doc() {
      return records.doc;
    },
    get awareness() {
      return records.awareness;
    },
    encodeRootState: () => Promise.resolve(Y.encodeStateAsUpdate(records.doc)),
    applyRootUpdate: (update, asLocalEdit) => {
      if (disposed) return Promise.resolve(false);
      // Reported, not thrown.
      try {
        if (asLocalEdit) Y.applyUpdate(records.doc, update, LOCAL_ORIGIN);
        else Y.applyUpdate(records.doc, update);
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    replicaGeneration: () => replicaGenerationCounter,

    start(): void {
      // Selection FIRST, then the listener.
      applySelection();
      unsubscribeLaneSupport =
        laneSelection?.subscribeSupport(() => {
          applySelection();
        }) ?? null;
    },

    applyLocalUpdate: (updateBytes) => {
      records.applyLocalUpdate(updateBytes);
    },

    sendAwareness(awarenessBytes): void {
      records.sendAwareness(awarenessBytes);
    },

    discardUnsyncedEdits(): void {
      delivery.batch(() => {
        records.discardUnsyncedEdits(() => tier.clearAllPending());
      });
    },

    requestFreshSnapshot,

    retryMigration(): void {
      if (disposed) return;
      // Nothing to retry until at least one migration has surfaced on this session.
      if (control.migrationStatus() !== "error") return;
      // If the underlying WS session is no longer open (e.g.
      const reopen = control.facts.transportStatus() !== "open";
      if (reopen) requestFreshSnapshot();
      const retryToken = control.markMigrationRetrying();
      if (reopen) return;
      // WHICH ARM, because the two speak different transports for this one gesture and the legacy
      // spelling is not merely suboptimal on the lane arm - it is inert.
      if (installedArm === "lanes" && laneSelection !== null) {
        void laneSelection.unaries.retryMigration().catch(() => {
          control.markMigrationRetryRefused(retryToken);
          // The CAUSE is still swallowed here, and only the cause: it is reported at the dispatcher, which
          // holds it, and rethrowing from a detached continuation would surface as an unhandled rejection
        });
        return;
      }
      // The `@1` arm answers synchronously, and its refusals are the same class: a detached or
      // reconnecting adapter answers `queued`/`dropped`, and neither produces a migration frame either.
      const outcome = adapter.send({ kind: "retry-migration" });
      if (outcome.kind !== "sent")
        control.markMigrationRetryRefused(retryToken);
    },

    enqueueWriteCommand: (intent) =>
      commandQueue.enqueue({ intent, expectedEntityVersion: null }),
    retryWriteCommand: (commandId) => {
      records.overlay.markUnknownOutcomeRetrying(commandId);
      commandQueue.retry(commandId);
    },
    discardWriteCommand: (commandId) => commandQueue.discard(commandId),

    applyChatRecords: (recordRows, issuedAtSeq) => {
      records.applyChatRecords(recordRows, issuedAtSeq);
    },
    peekChatIngestSeq: () => records.peekChatIngestSeq(),
    markChatRecordListNotAuthoritative: () => {
      records.markChatRecordListNotAuthoritative();
    },
    markChatRecordListAuthoritative: () => {
      records.markChatRecordListAuthoritative();
    },
    applyConfirmedChatMutation: (mutation) => {
      records.applyConfirmedChatMutation(mutation);
    },
    applyChatRecordDelta: (delta) => {
      records.applyChatRecordDelta(delta);
    },
    applyTuiAgentRecords: (recordRows, issuedAtSeq) => {
      records.applyTuiAgentRecords(recordRows, issuedAtSeq);
    },
    peekTuiAgentIngestSeq: () => records.peekTuiAgentIngestSeq(),
    applyTuiAgentRecordDelta: (delta) => {
      records.applyTuiAgentRecordDelta(delta);
    },
    reprojectForViewerChange: () => {
      records.project();
    },
    republishRecordsForCurrentUser: () => {
      // TWO publishes, deliberately un-batched: the closure republished the two record tables through
      // their own seams and then re-projected, and the auth bridge that drives this is the one caller
      records.republishRecordsForCurrentUser();
    },
    beginPendingChatCreation: (pending) => {
      records.beginPendingChatCreation(pending);
    },
    clearPendingChatCreation: (chatId) => {
      records.clearPendingChatCreation(chatId);
    },

    renameArtifact: (artifactId, nextTitle) =>
      records.renameArtifact(artifactId, nextTitle),
    deleteArtifact: (artifactId) => records.deleteArtifact(artifactId),
    reparentArtifact: (artifactId, newParentId) =>
      records.reparentArtifact(artifactId, newParentId),
    setEpicTitle: (nextTitle) => records.setEpicTitle(nextTitle),
    beginRenameMutation: (nodeId, nextTitle) =>
      records.beginRenameMutation(nodeId, nextTitle),
    beginEpicTitleMutation: (nextTitle) =>
      records.beginEpicTitleMutation(nextTitle),
    beginReparentMutation: (nodeId, newParentId) =>
      records.beginReparentMutation(nodeId, newParentId),
    retirePendingMutation: (requestId, outcome) =>
      records.overlay.retire(requestId, outcome),
    isLatestRenameStamp: (nodeId, requestId) =>
      records.overlay.isLatestRenameStamp(nodeId, requestId),
    readArtifactTitle: (artifactId) => records.readArtifactTitle(artifactId),

    /** PURE. */
    getArtifactFragment(artifactId): Y.XmlFragment | null {
      if (rooms.availabilityOfArtifact(artifactId) !== "ready") return null;
      // The ROOM is still how the `@1` arm finds the bytes - a room id is a legacy-arm-private fact now,
      // and this is one of the two places it is still read.
      const docKey = artifactBodyDocKey(artifactId);
      if (docKey === null) return null;
      const entry = tier.peek(docKey);
      if (entry === null) return null;
      return entry.doc.getXmlFragment(artifactBodyFragmentName(artifactId));
    },

    getArtifactBodyAwareness(artifactId): Awareness | null {
      if (rooms.availabilityOfArtifact(artifactId) !== "ready") return null;
      const docKey = artifactBodyDocKey(artifactId);
      if (docKey === null) return null;
      // Pure, for the same reason as `getArtifactFragment`.
      const entry = tier.peek(docKey);
      if (entry === null) return null;
      return entry.awareness;
    },

    getArtifactBodyAvailability(artifactId): EpicArtifactRoomAvailability {
      // No room lookup at all: availability is keyed by artifact on both arms.
      return rooms.availabilityOfArtifact(artifactId);
    },

    // On the `@1` arm the body doc is the artifact's ROOM.
    getArtifactBodyDocKey: (artifactId) => artifactBodyDocKey(artifactId),

    encodeArtifactBodyColdState: (docKey) => tier.encodeColdState(docKey),
    observeArtifactBodyDoc: (docKey, onUpdate) => {
      const entry = tier.peek(docKey);
      if (entry === null) return () => {};
      const handler = (update: Uint8Array): void => {
        onUpdate(update);
      };
      entry.doc.on("update", handler);
      return () => {
        entry.doc.off("update", handler);
      };
    },
    isArtifactBodyPinned: (docKey) => tier.isRoomPinnedByTierState(docKey),
    encodeArtifactBodyPeerAwareness: (docKey) =>
      tier.encodeRoomPeerAwareness(docKey),
    sendArtifactBodyAwareness: (docKey, frame, localClientId) => {
      tier.relayLocalAwareness(docKey, frame, localClientId);
    },
    observeArtifactBodyAwareness: (docKey, onFrame) =>
      tier.observeAwareness(docKey, onFrame),
    encodeArtifactBodyForwardOnly: (docKey) => {
      // IDENTITY-ABSENT only, checked explicitly rather than inferred from a cold refusal.
      if (tier.statedDocGuid(docKey) !== null) return null;
      const entry = tier.peek(docKey);
      return entry === null ? null : Y.encodeStateAsUpdate(entry.doc);
    },
    settleArtifactBodyColdState: (docKey, update, expectedDocGuid) =>
      tier.settleColdState(docKey, update, expectedDocGuid),
    sendArtifactBodyUpdate: (docKey, update) =>
      // THROUGH THE TIER ON BOTH ARMS.
      tier.relayLocalUpdate(docKey, update)
        ? { kind: "sent" }
        : { kind: "dropped", reason: "artifact room is not materialized" },

    acquireArtifactBodyLease(artifactId): () => void {
      const docKey = artifactBodyDocKey(artifactId);
      if (docKey === null || disposed) return () => {};
      // Demand on the BODY LANE, taken before the tier lease.
      const bodyDemanded = installedArm === "lanes" && laneArm !== null;
      if (bodyDemanded) laneArm.bodies.ensureAttached(artifactId);
      const hadReplica = tier.peek(docKey) !== null;
      const grant = rooms.acquireLease(docKey);
      if (grant.kind === "unavailable") {
        // No tier lease was registered, so there is nothing to release there - but the body demand above
        // WAS taken, and must come back off or this artifact stays subscribed for the session.
        if (bodyDemanded) laneArm.bodies.release(artifactId, "superseded");
        return () => {};
      }
      if (!hadReplica && grant.kind === "granted") {
        // A newly materialized doc is a new fragment identity, so the editor has to rebind.
        rooms.scheduleBindingInvalidation();
      }
      // Released the same way from either lease-bearing arm - "if you got a lease, you release it" - so
      // a holder never has to know whether its room had bytes when it asked.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        grant.lease.release();
        if (bodyDemanded) laneArm.bodies.release(artifactId, "superseded");
      };
    },

    hasAttachmentBytes: (hash) => records.hasAttachmentBytes(hash),
    readAttachmentBytes: (hash, signal) =>
      records.readAttachmentBytes(hash, signal),

    detachTransport(): void {
      if (disposed) return;
      if (transportDetached) return;
      transportDetached = true;
      // Order mirrors `dispose`'s first two teardown steps and stops there: the projector unbinds so no
      // late stream frame can write into a doc nobody is watching, the socket closes so this handle
      delivery.batch(() => {
        records.detach();
        detachWhateverIsOpen("transport-only");
        control.noteTransportDetached();
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Transport first, replica second - the closure's order.
      detachWhateverIsOpen("disposed");
      unsubscribeLaneSupport?.();
      unsubscribeLaneSupport = null;
      unsubscribeCommandQueue();
      commandQueue.dispose();
      attemptedHostByCommandId.clear();
      accounting.settleCommandOverlayBytes(0);
      records.dispose();
      control.dispose();
      rooms.dispose();
      accounting.unregisterBooks();
    },

    isDisposed,

    materializedArtifactRoomIds: () => tier.materializedIds(),
  };
}
