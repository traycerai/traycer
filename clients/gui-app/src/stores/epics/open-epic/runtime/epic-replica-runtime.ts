/**
 * The composition root: the object the 3,600-line closure was cut into.
 *
 * It holds the three planes, the adapter that feeds them, and the ORDER they
 * run in. That last part is the whole point. The closure's ordering invariants
 * were recorded in prose - "read the dirty state before clearing the queue",
 * "adopt the role before re-projecting so the dead sweep's gate is up", "clear
 * the queues before publishing the new role" - and every one of them is now a
 * sequence of method calls in a named function, where a reader can see what
 * happens between two steps.
 *
 * It is deliberately thin everywhere else. It does not project, decode, or
 * evict; it owns the pieces that do. Anything richer here would recreate the
 * closure with a different indentation.
 *
 * ## The batch window, and where it is deliberately absent
 *
 * A wire frame can move more than one plane - a root snapshot settles records
 * AND control AND, on a viewer downgrade, the doc plane - and the closure wrote
 * each of those as ONE `set`. Zustand notifies every subscriber on every write
 * and each notification re-runs the selector of every mounted consumer in the
 * epic, so collapsing a multi-plane frame back to one write is a behaviour
 * requirement, not tidiness. `routeEvent` and the two multi-plane commands
 * (`requestFreshSnapshot`, `discardUnsyncedEdits`) open that window.
 *
 * Everything else does NOT, and that is equally deliberate. A doc mutation, a
 * record ingest and an overlay stamp each cost exactly one store write today,
 * and wrapping them would collapse writes the closure spent separately -
 * changing how often subscribers are woken in the other direction. The rule is
 * to match the closure's write count, not to minimise it.
 */
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type {
  CommandIdFactory,
  CommandQueue,
  CommandRecord,
  FreshnessReport,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createCommandQueue,
  createTransactionalProjectionSink,
} from "@traycer-clients/shared/replica-runtime";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { jsonByteLength } from "@/stores/replica-memory/json-bytes";
import {
  hotDocHolderId,
  type HotDocBudgetSink,
} from "@/stores/replica-memory/hot-doc-budget";
import {
  epicColdRoomHolderId,
  epicCommandOverlayHolderId,
  epicReplicaBookKey,
  epicRootHolderId,
} from "@/stores/replica-memory/epic-replica-budget";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import type { EpicDocRecordArms } from "../projection-helpers";
import type { EpicArtifactRoomAvailability } from "../types";
import type { PendingChatCreation } from "../pending-chat-creations";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicRuntimeEvent } from "./epic-runtime-events";
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
import { createArtifactRoomTier } from "./artifact-room-tier";
import { createEpicRecordsReplica } from "./epic-records-replica";
import { createEpicRoomsReplica } from "./epic-rooms-replica";
import { createEpicControlReplica } from "./epic-control-replica";
import {
  createLegacyEpicStreamAdapter,
  type EpicStreamClientFactory,
} from "./legacy-epic-stream-adapter";
import {
  classifyEpicWriteCommandFailure,
  EpicWriteCommandTransportUnavailableError,
  type EpicWriteCommandIntent,
  type EpicWriteCommandSender,
} from "./epic-write-command";

export interface EpicReplicaRuntimeOptions {
  readonly epicId: string;
  readonly hostId: string;
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: EpicStreamClientFactory;
  /**
   * Where the planes publish. Supplied by the consumer because delivery is a
   * consumer concern - a zustand `setState` today, a `postMessage` once the
   * runtime is in a worker.
   */
  readonly delivery: EpicRuntimeDelivery;
  /**
   * The signed-in user's id, read live. The runtime never imports the auth
   * store; identity arrives from the UI side of the seam.
   */
  readonly getCurrentUserId: () => string | null;
  /**
   * Whether the epic doc is still a record SOURCE, per population - read live,
   * because it is settled by what this host negotiated for
   * `epic.listChatRecords` / `epic.listTuiAgents` and that arrives on its own
   * schedule. Supplied by the composition root: the negotiated-manifest
   * registry is ambient main-thread state and must not be reached from inside
   * `runtime/`. See `EpicDocRecordArms`.
   */
  readonly getDocArm: () => EpicDocRecordArms;
  /**
   * Invoked when the host closes the epic stream with an `UNAUTHORIZED` fatal
   * error. Production wires this to `AuthService.revalidateCurrentContext()`.
   * May be `null` in tests that do not exercise the auth-recovery path.
   */
  readonly onAuthError: (() => void) | null;
  readonly commandIdFactory: CommandIdFactory;
  readonly writeCommandSender: EpicWriteCommandSender;
}

export interface EpicReplicaRuntime {
  /**
   * The live root `Y.Doc`. A getter: a replica replacement mints a new one, and
   * a captured reference would observe a destroyed doc.
   */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * Bumped every time the root replica is REPLACED. The consumer compares it to
   * decide whether the doc/awareness handles it publishes are still current -
   * those are live objects, not projections, so they cannot cross a sink.
   */
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
  applyTuiAgentRecords(
    records: readonly TuiAgentRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  peekTuiAgentIngestSeq(): number;
  applyTuiAgentRecordDelta(delta: TuiAgentRecordDelta): void;
  republishRecordsForCurrentUser(): void;
  /**
   * Re-run the projection because the VIEWER changed, not because the doc did.
   *
   * The projector's owner-visibility filter reads the signed-in id at
   * projection time, so a user switch changes the projection even when neither
   * the doc nor the record tables moved - and the record tables' own change
   * gates would correctly report "nothing new" and publish nothing.
   *
   * A no-op while the projector is detached. That is a deliberate difference
   * from the closure, which wrote `projectFull()`'s return value into the store
   * unconditionally at this one call site while guarding it everywhere else -
   * so a user switch on a RETAINED handle would have blanked every projected
   * slice, contradicting the retention contract that its display freezes.
   */
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
  getArtifactRoomId(artifactId: string): string | null;
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
  /** Per-class freshness, never collapsed into one verdict. */
  freshness(): FreshnessReport;
  /** Ids of the artifact rooms currently materialized as live `Y.Doc`s. */
  materializedArtifactRoomIds(): readonly string[];
}

export function createEpicReplicaRuntime(
  options: EpicReplicaRuntimeOptions,
): EpicReplicaRuntime {
  const {
    epicId,
    hostId,
    environment,
    streamClientFactory,
    delivery,
    getCurrentUserId,
    getDocArm,
    onAuthError,
    commandIdFactory,
    writeCommandSender,
  } = options;

  let disposed = false;
  /**
   * Set by `detachTransport`. Deliberately NOT `disposed`: a detached handle
   * must keep serving local-state actions (`discardUnsyncedEdits` above all),
   * which every dispose guard would turn into silent no-ops - leaving the user
   * a retained buffer they can see and cannot drain.
   */
  let transportDetached = false;
  /**
   * Named apart from the accessor it backs, so a reader is never asking whether
   * the method shadows the binding inside its own body.
   */
  let replicaGenerationCounter = 0;
  const isDisposed = (): boolean => disposed;
  const memory = ensureProcessMemoryRuntime(environment);
  const runtimeToken = memory.nextRuntimeToken();
  const bookKey = epicReplicaBookKey(hostId, epicId, runtimeToken);
  /**
   * Last snapshot's wire bytes, not a live encode of the resident doc.
   * Honest while `@1` is the wire: the floor is measured-not-evicted, and
   * the snapshot is the figure we actually received.
   */
  let rootSettledBytes = 0;
  const budgetSink: HotDocBudgetSink = {
    settle(artifactRoomId, bytes) {
      memory.hotDocs.settle(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);
    },
    settleCold(artifactRoomId, bytes) {
      memory.epicReplicas.settleColdRoom(
        memory.accountant,
        bookKey,
        epicColdRoomHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.epicReplicas);
    },
    chargeProvisional(artifactRoomId, bytes) {
      memory.hotDocs.chargeProvisional(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
    },
    release(artifactRoomId) {
      memory.hotDocs.release(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
      );
    },
  };

  // Explicit type arguments on every sink, and typed constants rather than
  // object literals for the seeds: the shared factory infers its projection
  // from the initial value, and a literal seed would lock the parameter to the
  // literal's own shape.
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

  // ── Planes ────────────────────────────────────────────────────────────────
  //
  // Constructed in dependency order, with the two genuine cycles broken by
  // lazy reads rather than by a mediator object: the control plane's facts are
  // what the other two gate on, and the records plane's divergence is what the
  // doc plane's frames move.

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

  const tier = createArtifactRoomTier({
    environment,
    session: control.facts,
    send: (request) => {
      adapter.send(request);
    },
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
  });

  const records = createEpicRecordsReplica({
    environment,
    session: control.facts,
    sink: recordsSink,
    getCurrentUserId,
    getDocArm,
    send: (request) => {
      adapter.send(request);
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
    memory.epicReplicas.settleCommandOverlay(
      memory.accountant,
      epicCommandOverlayHolderId(hostId, epicId, runtimeToken),
      jsonByteLength(commandQueue.pending()),
    );
  }

  const unsubscribeCommandQueue = commandQueue.subscribe(publishWriteCommands);

  memory.hotDocs.attach({
    key: bookKey,
    materializedIds: () => tier.materializedIds(),
    demoteColdestUnpinned: (overBytes) => tier.demoteColdestUnpinned(overBytes),
  });
  memory.epicReplicas.attach({
    key: bookKey,
    measure: () => rootSettledBytes,
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
   * A landed root snapshot, in the exact order the closure ran it.
   *
   * Two orderings here are load-bearing and neither is expressible as a
   * dependency between the planes:
   *
   *  1. The divergence is read INSIDE `ingestSnapshot`, before the unsynced
   *     queue is cleared, because it is the state the landing settles ON.
   *  2. The role is adopted BEFORE the re-projection, because the projection
   *     runs the overlay's dead sweep and that sweep's gate reads this cycle's
   *     snapshot freshness. Re-projecting first would judge every pending chain
   *     against a replica whose authority had not been declared yet.
   */
  function applyRootSnapshot(meta: SnapshotMetaEpic, update: Uint8Array): void {
    const divergence = records.ingestSnapshot(meta, update);
    rootSettledBytes = update.byteLength;
    memory.epicReplicas.settleRoot(
      memory.accountant,
      epicRootHolderId(hostId, epicId, runtimeToken),
      update.byteLength,
    );
    memory.accountant.reconcile(BUDGET_PLANE_IDS.epicReplicas);
    control.adoptSnapshotRole(meta.permissionRole);
    records.publishSnapshotLanded(meta, divergence);
    control.noteSnapshotLanded(meta.permissionRole);
    if (!control.facts.isWritableRole()) {
      // Fail closed: a viewer (or a client whose role the snapshot revoked)
      // keeps no body state at all. The divergence republish is unconditional
      // because the closure's write here was.
      rooms.dropAllOnViewerDowngrade();
      records.publishDivergence();
      return;
    }
    if (control.facts.transportStatus() === "open") {
      tier.flushAllPending();
      commandQueue.retryPending();
    }
  }

  /**
   * Drain both write paths after a reconnect settles.
   *
   * Gated on the transport being open AND this cycle having its root snapshot:
   * a drain before the snapshot would ship bytes against a role the host has
   * not confirmed, which is the fail-open half of the permission gate.
   */
  function drainWritePathsAfterReconnect(): void {
    if (control.facts.transportStatus() !== "open") return;
    if (!control.facts.hasFreshRootSnapshotForOpenCycle()) return;
    records.flushPendingRootUpdates();
    tier.flushAllPending();
    commandQueue.retryPending();
    records.emitCurrentAwareness();
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
          return;
        case "rooms":
          rooms.apply(runtimeEvent.event);
          return;
        case "control":
          // The metadata-only frame settles a field on each of two planes:
          // `snapshotMeta` here, the displayed role there. One frame, two
          // decoded halves, one store write.
          if (runtimeEvent.event.kind === "early-meta") {
            records.applyEarlyMeta(runtimeEvent.event.meta);
          }
          control.apply(runtimeEvent.event);
          return;
      }
    });
  }

  /**
   * Discard the replica and re-subscribe from scratch.
   *
   * The close/open split around the middle is deliberate: the re-subscribe
   * reads the seed offer, so the socket must be gone before coverage is
   * cleared and must not reopen until after - otherwise the host is handed an
   * offer naming state this client has just thrown away.
   */
  function requestFreshSnapshot(): void {
    if (disposed) return;
    delivery.batch(() => {
      records.clearUnsyncedQueue();
      control.beginFreshCycle();
      adapter.closeTransport();
      records.replaceReplica();
      records.resetCoverage();
      // The rooms plane's reset, carrying its PROVENANCE: nothing is wrong
      // upstream, the client asked. Naming an authority reason here (
      // `"resume-too-old"` is the tempting one) would put a fabricated
      // authority-side event into logs, telemetry and the replay harness, where
      // nothing downstream could tell it from a real one.
      rooms.reset({ origin: "client", intent: "fresh-snapshot-requested" });
      records.publishFreshCycle();
      replicaGenerationCounter += 1;
    });
    adapter.openTransport();
  }

  return {
    get doc() {
      return records.doc;
    },
    get awareness() {
      return records.awareness;
    },
    replicaGeneration: () => replicaGenerationCounter,

    start(): void {
      records.start();
      adapter.attach({
        environment,
        emit: routeEvent,
        // `@1` cannot report a resume outcome - see the adapter's module doc.
        reportResume: () => {},
        // The transport's own status reaches the control plane as an event,
        // because what follows a close is a policy decision. Nothing else in
        // this runtime observes the adapter's status directly today.
        reportStatus: () => {},
        // Replacement on this line is client-initiated only: `@1` carries no
        // epoch, so there is no authority-side signal that could ask for one.
        requestReplacement: () => {},
      });
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
      // Nothing to retry until at least one migration has surfaced on this
      // session. Modal-only paths gate the button on `migration.status ===
      // "error"`, but this guard keeps the contract honest if a stray call
      // slips through.
      if (control.migrationStatus() !== "error") return;
      // If the underlying WS session is no longer open (e.g. the migration
      // error came from a fatal close transition rather than a
      // `migrationFailed` server frame), an in-stream `retryMigration` would be
      // sent to a dead session and silently dropped by `ws-stream-client` -
      // permanently trapping the user on the Prepare step with no recovery.
      // Fall back to a full session reopen instead; `requestFreshSnapshot`
      // resets migration to idle then opens a fresh client, and the host
      // re-runs migration if needed, emitting a fresh `migrationStarted` that
      // snaps the slice back to running. Re-apply the optimistic running flip
      // AFTER the reopen so the modal doesn't briefly flash to idle (which
      // would unmount it) before the host's first progress frame.
      const reopen = control.facts.transportStatus() !== "open";
      if (reopen) requestFreshSnapshot();
      control.markMigrationRetrying();
      if (!reopen) adapter.send({ kind: "retry-migration" });
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
      // TWO publishes, deliberately un-batched: the closure republished the two
      // record tables through their own seams and then re-projected, and the
      // auth bridge that drives this is the one caller that observes both.
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

    /**
     * PURE. This runs inside store selectors, so it must not materialize, touch
     * the LRU, reset a cooldown, or evict: an earlier attempt did all four and
     * made an unrelated store update able to extend a room's lifetime, and made
     * cap enforcement able to destroy an unpinned `Y.Doc` while a component
     * rendered earlier in the same pass was still holding its fragment.
     * Materialization belongs to `acquireArtifactBodyLease`.
     */
    getArtifactFragment(artifactId): Y.XmlFragment | null {
      const artifactRoomId = records.readArtifactRoomId(artifactId);
      if (artifactRoomId === null) return null;
      if (rooms.availabilityOf(artifactRoomId) !== "ready") return null;
      const entry = tier.peek(artifactRoomId);
      if (entry === null) return null;
      return entry.doc.getXmlFragment(artifactBodyFragmentName(artifactId));
    },

    getArtifactBodyAwareness(artifactId): Awareness | null {
      const artifactRoomId = records.readArtifactRoomId(artifactId);
      if (artifactRoomId === null) return null;
      if (rooms.availabilityOf(artifactRoomId) !== "ready") return null;
      // Pure, for the same reason as `getArtifactFragment`.
      const entry = tier.peek(artifactRoomId);
      if (entry === null) return null;
      return entry.awareness;
    },

    getArtifactBodyAvailability(artifactId): EpicArtifactRoomAvailability {
      const artifactRoomId = records.readArtifactRoomId(artifactId);
      if (artifactRoomId === null) return "unavailable";
      return rooms.availabilityOf(artifactRoomId);
    },

    getArtifactRoomId: (artifactId) => records.readArtifactRoomId(artifactId),

    acquireArtifactBodyLease(artifactId): () => void {
      const artifactRoomId = records.readArtifactRoomId(artifactId);
      if (artifactRoomId === null || disposed) return () => {};
      const hadReplica = tier.peek(artifactRoomId) !== null;
      const grant = rooms.acquireLease(artifactRoomId);
      if (grant.kind === "unavailable") {
        // The one arm that registered no demand, so there is nothing to
        // release. Reached only for a disposed tier.
        return () => {};
      }
      if (!hadReplica && grant.kind === "granted") {
        // A newly materialized doc is a new fragment identity, so the editor
        // has to rebind. Availability is unchanged here - the room was already
        // `ready` - which is exactly why this needs its own invalidation
        // signal. Coalesced because opening a canvas takes one lease per tile.
        //
        // NOT on `"awaiting-seed"`: nothing came up, so nothing is bound and
        // there is no identity to invalidate. The snapshot that eventually
        // seeds this room bumps the epoch itself, through the rooms plane's
        // `"seeded"` outcome.
        rooms.scheduleBindingInvalidation();
      }
      // Released the same way from either lease-bearing arm - "if you got a
      // lease, you release it" - so a holder never has to know whether its
      // room had bytes when it asked.
      return () => grant.lease.release();
    },

    hasAttachmentBytes: (hash) => records.hasAttachmentBytes(hash),
    readAttachmentBytes: (hash, signal) =>
      records.readAttachmentBytes(hash, signal),

    detachTransport(): void {
      if (disposed) return;
      if (transportDetached) return;
      transportDetached = true;
      // Order mirrors `dispose`'s first two teardown steps and stops there: the
      // projector unbinds so no late stream frame can write into a doc nobody
      // is watching, the socket closes so this handle stops producing dial
      // evidence for a host the window has left - and the doc, its replica and
      // the unsynced queue are left intact, because they are the thing being
      // retained.
      delivery.batch(() => {
        records.detach();
        adapter.detach("transport-only");
        control.noteTransportDetached();
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Transport first, replica second - the closure's order. Nothing may be
      // decoded into a doc that is about to be destroyed, and while the guards
      // above would already refuse it, "already refused" is a weaker property
      // than "the socket was gone first".
      adapter.detach("disposed");
      unsubscribeCommandQueue();
      commandQueue.dispose();
      attemptedHostByCommandId.clear();
      memory.epicReplicas.settleCommandOverlay(
        memory.accountant,
        epicCommandOverlayHolderId(hostId, epicId, runtimeToken),
        0,
      );
      records.dispose();
      control.dispose();
      rooms.dispose();
      memory.hotDocs.detach(bookKey);
      memory.epicReplicas.detach(bookKey);
      memory.epicReplicas.release(memory.accountant, bookKey);
    },

    isDisposed,

    freshness: () => [
      records.freshness(),
      rooms.freshness(),
      control.freshness(),
    ],

    materializedArtifactRoomIds: () => tier.materializedIds(),
  };
}
