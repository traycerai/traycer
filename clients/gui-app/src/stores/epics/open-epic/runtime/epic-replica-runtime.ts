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
  AdapterDetachReason,
  CommandIdFactory,
  CommandQueue,
  CommandRecord,
  ReplicaReplacementReason,
  ReplicaResetCause,
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
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
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
  /**
   * No `hostId`. 4e moved holder-id composition into the accounting port, and
   * that was this option's only remaining reader - the write path takes the
   * host it actually attempted from `writeCommandSender.currentHostId()`,
   * which is a live read rather than a construction-time capture.
   */
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: EpicStreamClientFactory;
  /**
   * Where the planes publish. Supplied by the consumer because delivery is a
   * consumer concern - a zustand `setState` today, a `postMessage` once the
   * runtime is in a worker.
   */
  readonly delivery: EpicRuntimeDelivery;
  /**
   * Where this runtime's bytes are reported.
   *
   * Supplied, never reached for. T5's accountant is a module-scoped singleton
   * whose app-wideness comes from MODULE IDENTITY, so a worker that imported
   * it would silently keep a second copy of the books — invisible in-process,
   * where there is only ever one. Taking the port as an option is what moves
   * that import onto main's graph and off this file's; the worker-graph
   * ratchet is what keeps it there.
   */
  readonly accounting: EpicRuntimeAccountingPort;
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
  /**
   * Everything the lane arm needs, or `null` when this caller cannot serve
   * lanes at all.
   *
   * ONE field rather than three, and nullable rather than three nullable
   * members, because the three are only ever meaningful together: a support
   * reader with no stream clients cannot open anything, and stream clients with
   * no support reader could never be selected. `null` is a fact about the
   * CALLER - a consumer that never built the clients - and it pins the arm to
   * legacy without the support reader ever being consulted.
   */
  readonly laneSelection: EpicLaneSelectionSources | null;
}

/** What a lane-capable composition supplies. All of it, or none. */
export interface EpicLaneSelectionSources {
  /**
   * This connection's negotiated support for the three lane methods, read LIVE.
   *
   * Selection is per CONNECTION: a host that upgrades under an open tab
   * reconnects advertising the lanes, and the tab moves to them. See
   * `epic-adapter-selection.ts` for why `"unknown"` is not a selection.
   */
  readonly support: EpicMethodSupportReader;
  /** Notified whenever any method's support changes. Returns an unsubscribe. */
  readonly subscribeSupport: (listener: () => void) => () => void;
  readonly stateStreamClientFactory: EpicStateStreamClientFactory;
  readonly statusStreamClientFactory: EpicStatusStreamClientFactory;
  /**
   * One body lane per artifact whose body is being shown. Over the SAME
   * session transport as the other two - the session owns one durable socket
   * and every lane is a method on it, so a per-tile body does not dial.
   */
  readonly artifactStreamClientFactory: ArtifactStreamClientFactory;
}

export interface EpicReplicaRuntime {
  /**
   * The live root `Y.Doc`. A getter: a replica replacement mints a new one, and
   * a captured reference would observe a destroyed doc.
   */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * The root replica's whole state, encoded for transfer into another session.
   *
   * A PORT over what two call sites do today as `Y.encodeStateAsUpdate(handle.doc)`
   * against a doc they reach directly. Introduced while the replica is still
   * in-process - "seams before relocation" - so the flip changes this port's
   * IMPLEMENTATION and not one call site.
   *
   * Async from the start for the same reason. A `Uint8Array` return would have
   * to become a `Promise` at the flip, and that is the signature change that
   * would then ripple through both callers' lifecycles at the worst moment.
   * Paying it here makes the flip a one-file change.
   */
  encodeRootState(): Promise<Uint8Array>;
  /**
   * Apply another session's encoded root state into this one.
   *
   * `asLocalEdit` is not a convenience: the two merge sites differ, and the
   * difference is load-bearing. The provider's replacement merge applies with
   * `LOCAL_ORIGIN` so the union routes through the replacement's normal
   * local-update path and unacknowledged edits survive for recovery; the
   * registry's retention merge applies with no origin, because a retained
   * buffer is not re-sending anything. Collapsing them would either strand
   * edits or re-send a whole document.
   *
   * Answers whether the update LANDED. `false` means the caller must treat the
   * edits as still living only in the source - see the merge sites.
   */
  applyRootUpdate(update: Uint8Array, asLocalEdit: boolean): Promise<boolean>;
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
  /**
   * The key the artifact-body tier holds this artifact's live `Y.Doc` under, or
   * `null` when there is none.
   *
   * Deliberately NOT "the room id" any more, though that is what it returns on
   * the `@1` arm. The two arms disagree about what a body's doc IS: `@1` serves
   * an artifact ROOM whose doc carries one
   * `artifactBodyFragmentName(artifactId)` fragment per artifact assigned to it,
   * while `artifact.subscribe` serves ONE artifact's body as its own doc and has
   * no rooms at all. The tier does not care - its keys are opaque strings - so
   * the only thing that differs is what to key by, and this is that one fact.
   *
   * Callers use it for exactly one thing: re-taking a body lease when the doc
   * behind an artifact changes identity. An artifact reassigned between two
   * already-`ready` rooms produces no availability transition, so keying that on
   * availability alone would strand the lease on the stale doc.
   */
  getArtifactBodyDocKey(artifactId: string): string | null;
  /**
   * The cold bytes for a body doc, or `null` when the tier does not hold it.
   *
   * The runtime's face on the tier's own arithmetic. `null` is NOT empty
   * bytes: a zero-length update applies cleanly and yields an empty document.
   */
  encodeArtifactBodyColdState(docKey: string): ArtifactRoomColdState | null;
  /**
   * The live body doc's bytes for a room that states NO identity.
   *
   * The `@1` arm's rooms are exactly that: its adapter sets `docGuid: null` by
   * design, so `encodeArtifactBodyColdState` refuses them - "bytes whose
   * document cannot be identified cannot be safely settled back" - and before
   * the relocation nothing needed them, because `getArtifactFragment` returned
   * the tier's live doc BY REFERENCE.
   *
   * After the relocation the main thread must build its own doc, so the bytes
   * have to cross. This is that read, and it claims nothing: no guid is
   * invented (`artifact-room-tier.ts:325` forbids it), and the caller marks
   * the result forward-only so it is never settled back.
   *
   * `null` when the room is not materialized - there is no live doc to encode.
   */
  encodeArtifactBodyForwardOnly(docKey: string): Uint8Array | null;
  /**
   * Observe a materialized body doc; returns the detach.
   *
   * The tier has no per-room change callback (only `onDivergenceChanged`), so
   * this is a direct observation of the replica's doc. A no-op detach when the
   * room is not materialized - there is nothing to watch, and answering with a
   * detach anyway keeps the caller's lifetime bookkeeping total.
   */
  observeArtifactBodyDoc(
    docKey: string,
    onUpdate: (update: Uint8Array) => void,
  ): () => void;
  /**
   * A local presence frame from the main-thread editor, on its way out.
   *
   * Not `applyArtifactRoomAwareness`, and the difference is invisible at a
   * call site: that one is the INBOUND path and stamps the room's remote
   * origin, which is exactly the origin the room's own update handler skips.
   * A local frame sent through it would be applied, would notify local
   * observers, and would never reach the wire - with no error anywhere,
   * because the guard doing the dropping is working as designed.
   *
   * `localClientId` is the main-side `Awareness.clientID`; the room needs it
   * to keep telling its own presence apart from a collaborator's, which is a
   * materialisation pin rather than a cosmetic distinction.
   */
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
  /**
   * Observe a materialized body's presence; returns the detach.
   *
   * The inbound counterpart: remote peers land in the room's `Awareness`, and
   * the editor rendering them is on the other thread. No-op detach when the
   * room is not materialized, matching {@link observeArtifactBodyDoc}.
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
  /**
   * The authority reason this replica was last rebuilt for, while that rebuild
   * is still untouched by any inbound frame.
   *
   * This is what makes {@link replaceForAuthority} idempotent per event rather
   * than per call. One epoch change is legitimately reported more than once -
   * the state and status lanes both see it, and a body lane reports a stale
   * epoch through both its translated `doc-unavailable` and the adapter's own
   * `requestReplacement` - and every one of those is a true statement about
   * the SAME event.
   *
   * Cleared by the first frame applied afterwards, which is what keeps this a
   * coalescer and not a latch: once the fresh cycle has delivered anything, a
   * later report of the same reason is a NEW event and must rebuild again.
   */
  let replacementSettledForReason: ReplicaReplacementReason | null = null;
  const isDisposed = (): boolean => disposed;
  /**
   * Last snapshot's wire bytes, not a live encode of the resident doc.
   * Honest while `@1` is the wire: the floor is measured-not-evicted, and
   * the snapshot is the figure we actually received.
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

  /**
   * One outbound request, routed to the arm that is actually installed.
   *
   * Only the two BODY kinds are rerouted, and they are addressed by the tier's
   * doc key - the artifact id on the lane arm (see `artifactBodyDocKey`) - so
   * choosing the destination is the whole translation.
   *
   * The remaining three keep going to the `@1` adapter, which is where they
   * belong and where they can still be sent from: `retry-migration` serves a
   * modal that is a `@1` concept, and the root doc is not a write path on the
   * lane arm at all - that arm's records are typed rows and its writes go
   * through the command queue. If a root frame were ever produced there it
   * would reach a detached adapter and be dropped rather than misrouted, which
   * is the safe direction but not a guarantee this function makes.
   */
  function sendOutbound(request: EpicOutboundRequest): void {
    if (installedArm !== "lanes" || laneArm === null) {
      adapter.send(request);
      return;
    }
    switch (request.kind) {
      case "room-update":
        laneArm.bodies.sendUpdate(request.artifactRoomId, request.update);
        return;
      case "room-awareness":
        laneArm.bodies.sendAwareness(request.artifactRoomId, request.frame);
        return;
      case "root-update":
      case "root-awareness":
      case "retry-migration":
        adapter.send(request);
        return;
    }
  }

  const tier = createArtifactRoomTier({
    environment,
    session: control.facts,
    // Body writes go out on the arm that is installed. On `@1` they ride the
    // one epic stream; on the lane arm each body has its own subscription and
    // its own `docGuid` write guard, so sending them down the legacy adapter
    // would post them to a socket that arm never opened.
    send: (request) => {
      sendOutbound(request);
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
    // Which artifacts a body-doc key covers, per arm.
    //
    // On the LANE arm the key IS the artifact - `artifact.subscribe` serves one
    // body per doc - so the fan-out is the identity. It must not fall through
    // to the mapping below: that arm's artifacts carry `artifactRoomId: null`
    // (the wire omits the field), so the filter would match nothing, and since
    // `deriveAvailability` fans out through here for EVERY key, an empty answer
    // would publish an empty availability map - every body reading as never
    // ready, on the arm that is meant to be indistinguishable from `@1`.
    //
    // Answering before the artifact appears in the slice is deliberate and is
    // the same retention `@1` gets: the value is published, and a consumer
    // looking up its own id finds it the moment that id exists.
    //
    // On the `@1` arm a room hosts MANY bodies, so the mapping is real. Read
    // off the records plane's PUBLISHED artifacts slice rather than the root
    // doc: it is the runtime's own projection, so this stays
    // worker-relocatable, and it is the value every consumer already agrees on.
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
    accounting.settleRootBytes(update.byteLength);
    control.adoptSnapshotRole(meta.permissionRole);
    records.publishSnapshotLanded(meta, divergence);
    // The mapping half of the availability fan-out. A `@1` room reports `ready`
    // independently of any snapshot, so a room frame can arrive BEFORE the
    // artifacts that live in it exist - the room-keyed value was retained and
    // becomes visible only now, when the artifacts naming that room appear.
    // Gated inside, so a snapshot that moved no artifact costs no publish.
    rooms.republishAvailability();
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

  // ── Adapter selection ─────────────────────────────────────────────────────
  //
  // Which arm serves this connection, and what happens when that changes. The
  // DECISION is `epic-adapter-selection.ts`, the ORDERED STEPS are
  // `epic-adapter-lifecycle.ts`, and this is the only place that executes them -
  // so the mid-session upgrade every long-lived tab hits exactly once has one
  // implementation rather than one per caller.

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
            noteInboundFrameApplied();
            delivery.batch(() => {
              records.applyLaneState(slices);
            });
          },
          onControlEvent: (event) => {
            noteInboundFrameApplied();
            delivery.batch(() => {
              control.apply(event);
            });
          },
          onReplacementRequested: (reason) => {
            replaceForAuthority(reason);
          },
          artifactStreamClientFactory:
            laneSelection.artifactStreamClientFactory,
          // The tier IS the seed authority: a body it does not hold offers
          // nothing, so the host answers with a full seed rather than a delta
          // against state this client threw away.
          readDocSeed: (artifactId) => tier.readDocSeedOffer(artifactId),
          onRoomEvent: (event) => {
            noteInboundFrameApplied();
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
      // Retire an outstanding capability probe first. On this path the probe
      // has just answered method-unsupported, so its status stream is a socket
      // held open for a question already settled; the arm's per-lane attach
      // state makes this a no-op when no probe ran.
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

  /**
   * Close whatever this runtime has open, installed arm or not.
   *
   * The `installedArm === null` branch is the one worth naming: a connection
   * still being probed holds a status stream under NO arm, and a teardown that
   * only ever detached the installed arm would leave that socket open for the
   * lifetime of the client.
   */
  function detachWhateverIsOpen(reason: AdapterDetachReason): void {
    if (installedArm !== null) {
      detachArm(installedArm, reason);
      return;
    }
    laneArm?.detach(reason);
  }

  /**
   * Empty every plane, carrying the cause.
   *
   * The same sequence `requestFreshSnapshot` runs, minus the transport dance:
   * the caller owns the sockets, because a replacement closes BEFORE it
   * discards and opens AFTER, while a targeted authority reset does not close
   * at all.
   */
  function resetAllPlanes(cause: ReplicaResetCause): void {
    records.clearUnsyncedQueue();
    control.beginFreshCycle();
    records.replaceReplica();
    records.resetCoverage();
    laneArm?.reset(cause);
    rooms.reset(cause);
    records.publishFreshCycle();
  }

  /**
   * An adapter asking for the replica to be rebuilt.
   *
   * COALESCED by construction: both lanes route here, and one epoch change
   * reported by both produces one rebuild, because the second call finds the
   * planes already emptied for that cause. That is the design the seam names -
   * two lanes each asking once for one real epoch change is two true
   * statements, not two replacements.
   */
  function replaceForAuthority(reason: ReplicaReplacementReason): void {
    if (disposed) return;
    // The coalescing this function's contract promises, made real. It used to
    // be asserted and not implemented: `resetAllPlanes` is idempotent, but
    // `replicaGenerationCounter += 1` is not, so two reports of ONE epoch
    // change bumped the generation twice and asked every consumer to rebuild
    // twice.
    //
    // Reachable from more than one place by design - the state and status
    // lanes both report an epoch change, and a body lane reports a stale epoch
    // through BOTH its translated `doc-unavailable` and the adapter's own
    // `requestReplacement`. All of those are true statements about the same
    // event, which is exactly what has to collapse to one rebuild.
    if (replacementSettledForReason === reason) return;
    delivery.batch(() => {
      resetAllPlanes({ origin: "authority", reason });
      replicaGenerationCounter += 1;
    });
    // Stamped AFTER the batch, not before, and that ordering is the whole
    // trick: emptying the planes republishes them, and a republication runs
    // the same `noteInboundFrameApplied` hook a real frame does. Stamping
    // first therefore let the replacement clear its OWN guard, and the second
    // report of one epoch change rebuilt again - which is the exact double
    // bump this coalescer exists to stop.
    replacementSettledForReason = reason;
  }

  /**
   * Re-read the manifest and move the arm if it says to.
   *
   * Idempotent and cheap: an unchanged verdict plans no steps, and an
   * `"undecided"` one holds whatever is installed - which is what makes this
   * safe to call from a support-change listener that also fires on every
   * reconnect's support reset.
   *
   * ## Undecided with nothing installed is the PROBE case, not a hold
   *
   * The hold rule ("an undecided verdict never displaces an installed arm")
   * describes a reconnect, where support was wiped but an arm is already
   * serving. With NO arm installed there is nothing to hold and, worse,
   * nothing that would ever make the verdict decide: the client learns a
   * method's support from a subscribe completing, so a runtime that installs
   * nothing while it waits opens no subscribe, receives no answer, and stalls
   * on that connection permanently. So this case probes rather than waits -
   * see {@link EpicLaneArm.probe}.
   */
  /**
   * The key the body tier holds one artifact's live doc under, per arm.
   *
   * `@1` addresses a body by the ROOM that hosts it - one room, many bodies -
   * and reads the mapping off the records plane. `artifact.subscribe` has no
   * rooms at all: it serves one body per doc, addressed by artifact id under an
   * authority epoch, so on that arm the artifact IS the key.
   *
   * Both arms answer `null` for a body this client cannot address yet, which is
   * what every caller already branches on.
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
    if (installedArm === null && verdict === "undecided") {
      // Idempotent: the arm opens one status stream however often this is
      // called, and every reconnect's support reset lands here again.
      laneArm?.probe();
      return;
    }
    executeTransition(verdict);
  }

  /**
   * The probe answered. Install on THAT, without consulting the manifest.
   *
   * This is the half that makes the probe a probe rather than a hopeful open.
   * Reading support here would reintroduce the stall it exists to prevent: a
   * remote peer's `getMethodSupport` stays `"unknown"` forever, because the mux
   * resolves an incompatible method as a fatal on the subscribe attempt and
   * never as a queryable pre-check. The subscribe's own outcome is the only
   * evidence both transports produce, so it is the only thing that can decide.
   *
   * Ignored once an arm is installed: a manifest that resolved first has
   * already settled this, and the probe's stream was adopted by that install.
   */
  /**
   * A lane the installed arm requires is not served. Fall back to legacy.
   *
   * The arm is installed on ALL its required lanes being served, not on the
   * first one that answers. A host can serve `epic.status.subscribe` and
   * refuse `epic.state.subscribe` - a rolling upgrade, a lane behind a flag -
   * and on that host the probe succeeds, the arm installs, and the records
   * lane then dies with a typed refusal that no manifest will ever repeat. The
   * result is an epic that renders nothing, on the arm whose whole contract is
   * to be indistinguishable from `@1`.
   *
   * So this is a full replacement rather than a degraded mode: detach the lane
   * arm, reset the planes, open `@1`. Idempotent - the arm reports once, and
   * an arm already replaced is not replaced again.
   */
  function applyRequiredLaneUnsupported(): void {
    if (disposed) return;
    if (installedArm !== "lanes") return;
    executeTransition("legacy");
  }

  function applyProbeOutcome(outcome: EpicLaneProbeOutcome): void {
    if (disposed) return;
    if (installedArm !== null) return;
    executeTransition(outcome === "succeeded" ? "lanes" : "legacy");
  }

  /**
   * A frame reached the replicas, so any rebuild that was standing is spent.
   *
   * Called from every inbound path - the `@1` router and each of the lane
   * arm's three callbacks - because a coalescer that is never cleared is a
   * latch, and a latch here would swallow the SECOND genuine epoch change of a
   * session.
   */
  function noteInboundFrameApplied(): void {
    replacementSettledForReason = null;
  }

  function routeEvent(runtimeEvent: EpicRuntimeEvent): void {
    noteInboundFrameApplied();
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
          // A later root update can create an artifact naming a room already
          // reported `ready`, which is the same "mapping arrived second" case
          // as the snapshot above.
          rooms.republishAvailability();
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
      // Close BEFORE discarding and open AFTER: the re-subscribe reads the
      // resume offer (a `@1` seed offer, or the lane's applied cursor), and an
      // offer taken before the discard would name state this client has just
      // thrown away.
      if (installedArm === "lanes") {
        laneArm?.closeTransport();
      } else {
        adapter.closeTransport();
      }
      records.replaceReplica();
      laneArm?.reset({ origin: "client", intent: "fresh-snapshot-requested" });
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
      // Reported, not thrown. A merge that cannot land is a fact the caller
      // must act on - it decides whether the source's edits have been
      // transferred - and a throw at this seam would reach a synchronous
      // lifecycle callback that has no way to answer it.
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
      // Selection FIRST, then the listener. On a connection whose manifest has
      // not resolved this installs nothing at all - it does not open
      // `epic.subscribe@1` speculatively - and the status lane's own open is
      // the probe that settles it. The listener is what carries a host that
      // upgrades under this tab onto the lanes without a reopen.
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
      if (rooms.availabilityOfArtifact(artifactId) !== "ready") return null;
      // The ROOM is still how the `@1` arm finds the bytes - a room id is a
      // legacy-arm-private fact now, and this is one of the two places it is
      // still read. The lane arm replaces this lookup rather than translating
      // it: `artifact.subscribe` serves a body addressed by artifact id.
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

    // On the `@1` arm the body doc is the artifact's ROOM. The lane arm keys the
    // tier by artifact id instead, because `artifact.subscribe` serves one body
    // per doc - that arm returns the artifact id here unchanged.
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
    sendArtifactBodyAwareness: (docKey, frame, localClientId) => {
      tier.relayLocalAwareness(docKey, frame, localClientId);
    },
    observeArtifactBodyAwareness: (docKey, onFrame) =>
      tier.observeAwareness(docKey, onFrame),
    encodeArtifactBodyForwardOnly: (docKey) => {
      // IDENTITY-ABSENT only, checked explicitly rather than inferred from a
      // cold refusal. `encodeColdState` refuses for two reasons, and only one
      // of them belongs here: a room that STATED an identity and merely has no
      // replica must answer not-held, because serving it forward-only would
      // retire its settle path without anything saying so.
      if (tier.statedDocGuid(docKey) !== null) return null;
      const entry = tier.peek(docKey);
      return entry === null ? null : Y.encodeStateAsUpdate(entry.doc);
    },
    settleArtifactBodyColdState: (docKey, update, expectedDocGuid) =>
      tier.settleColdState(docKey, update, expectedDocGuid),
    sendArtifactBodyUpdate: (docKey, update) => {
      // The lane arm is the only one that serves bodies per-doc; on `@1` the
      // body rides the room and there is no lane to send to. `dropped` rather
      // than a silent no-op, because the caller's edit went nowhere and the
      // reason is what makes that legible.
      if (installedArm !== "lanes" || laneArm === null) {
        // On `@1` the body rides the ROOM. There is no lane, but there IS an
        // outbound path: the room's own update handler emits
        // `room-apply-update` for a locally-originated edit, which before the
        // relocation is exactly how this arm's edits reached the host - the
        // tier held the live doc and the editor wrote to it directly.
        //
        // Returning `dropped` here (which this did) was that path going
        // missing: every `@1` body edit compiled, applied to main's doc, and
        // never left the tab.
        return tier.relayLocalUpdate(docKey, update)
          ? { kind: "sent" }
          : { kind: "dropped", reason: "artifact room is not materialized" };
      }
      return laneArm.bodies.sendUpdate(docKey, update);
    },

    acquireArtifactBodyLease(artifactId): () => void {
      const docKey = artifactBodyDocKey(artifactId);
      if (docKey === null || disposed) return () => {};
      // Demand on the BODY LANE, taken before the tier lease. On the lane arm
      // a body is not served until something asks for it - unlike `@1`, where
      // every room arrives whether or not a tile is open - so the lease is
      // also the subscribe. Idempotent, and a no-op on the legacy arm.
      const bodyDemanded = installedArm === "lanes" && laneArm !== null;
      if (bodyDemanded) laneArm.bodies.ensureAttached(artifactId);
      const hadReplica = tier.peek(docKey) !== null;
      const grant = rooms.acquireLease(docKey);
      if (grant.kind === "unavailable") {
        // No tier lease was registered, so there is nothing to release there -
        // but the body demand above WAS taken, and must come back off or this
        // artifact stays subscribed for the session. Reached only for a
        // disposed tier.
        if (bodyDemanded) laneArm.bodies.release(artifactId, "superseded");
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
      //
      // BOTH halves come off, and this closure is the only place that pairing
      // exists. Releasing the tier lease alone would leave the body lane
      // subscribed for the rest of the session and rebuilt on every later
      // epoch change - a leak that grows with every tile ever opened, and one
      // that is invisible because the tier, the projection and the tile all
      // look correct throughout.
      // IDEMPOTENT, and it has to be explicitly rather than by luck. The tier
      // lease guards itself internally, so double-invoking this closure used
      // to be harmless on that half - but `bodies.release` decrements a
      // ref-count, and a second call would take the count past this holder's
      // own demand and close a body stream another live lease is using. A
      // `finally` backstop firing after an early release is exactly that
      // shape, and it is a pattern this codebase already guards against
      // elsewhere.
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
      // Order mirrors `dispose`'s first two teardown steps and stops there: the
      // projector unbinds so no late stream frame can write into a doc nobody
      // is watching, the socket closes so this handle stops producing dial
      // evidence for a host the window has left - and the doc, its replica and
      // the unsynced queue are left intact, because they are the thing being
      // retained.
      delivery.batch(() => {
        records.detach();
        detachWhateverIsOpen("transport-only");
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
