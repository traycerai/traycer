import type { ConfirmedChatMutation } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
/** {@link EpicRuntimeCorePorts} over a composed {@link EpicReplicaRuntime}. */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { ArtifactRoomColdState } from "../artifact-room-tier";
import type { PendingChatCreation } from "../../pending-chat-creations";
import type { RuntimeCommand } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { EpicWriteCommandIntent } from "../epic-write-command";
import type { EpicRuntimeCorePorts } from "./epic-runtime-core";

export interface EpicRuntimeCorePortSource {
  /** Synchronous and local: whether the root replica holds these bytes now. */
  hasAttachmentBytes(hash: string): boolean;
  /**
   * WAITS for a hash that has not synced yet, resolving `null` only when the
   * signal aborts. That is the contract, not a defect - see the guard below.
   */
  readAttachmentBytes(
    hash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  /** Take the runtime's body lease and return its release. This is what MATERIALIZES. */
  acquireBodyLease(artifactId: string): () => void;
  bodyDocKey(artifactId: string): string | null;
  encodeColdState(docKey: string): ArtifactRoomColdState | null;
  /** Live bytes for a room that states no identity. See the runtime member. */
  encodeForwardOnly(docKey: string): Uint8Array | null;
  /** Observe a materialized room's doc. Returns the detach. */
  observeBodyDoc(
    docKey: string,
    onUpdate: (update: Uint8Array) => void,
  ): () => void;
  /**
   * Relay a local presence frame for one body to the arm. `localClientId` is the main-side
   * `Awareness.clientID` the frame speaks for; the room excludes it from its remote-peer pin.
   */
  applyBodyAwareness(
    docKey: string,
    frame: Uint8Array,
    localClientId: number,
  ): void;
  /** Tier-state pins for one body - divergence or presence, never the lease. */
  isBodyPinned(docKey: string): boolean;
  /** This body's known remote peers, to ride the materialize response. */
  encodeBodyPeerAwareness(docKey: string): readonly Uint8Array[];
  /** Observe a materialized room's presence. Returns the detach. */
  observeBodyAwareness(
    docKey: string,
    onFrame: (frame: Uint8Array) => void,
  ): () => void;
  settleColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ):
    | { readonly accepted: true; readonly settledBytes: number }
    | {
        readonly accepted: false;
        /** WHY. Crosses the bridge so the seam stays readable - see the call. */
        readonly reason: "not-held" | "newer-generation" | "pinned";
      };
  sendBodyUpdate(docKey: string, update: Uint8Array): SendOutcome;
  renameArtifact(artifactId: string, nextTitle: string): boolean;
  deleteArtifact(artifactId: string): boolean;
  /** MAY THROW for an illegal move - the caller turns that into an error result. */
  reparentArtifact(artifactId: string, newParentId: string | null): boolean;
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
  /**
   * Enqueue a write command. `null` is the queue's own REFUSAL - it minted no
   * id and recorded nothing - and is not an error.
   */
  enqueueWriteCommand(intent: EpicWriteCommandIntent): string | null;
  /** Narrow the wire form of an intent, or `null` if it is not one. */
  readWriteCommandIntent(intent: unknown): EpicWriteCommandIntent | null;
  applyChatRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  applyChatRecordDelta(delta: ChatRecordDelta): void;
  applyConfirmedChatMutation(mutation: ConfirmedChatMutation): void;
  applyTuiAgentRecords(
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ): void;
  applyTuiAgentRecordDelta(delta: TuiAgentRecordDelta): void;
  markChatRecordListAuthoritative(): void;
  markChatRecordListNotAuthoritative(): void;
  beginPendingChatCreation(pending: PendingChatCreation): void;
  clearPendingChatCreation(chatId: string): void;
  republishRecordsForCurrentUser(): void;
  reprojectForViewerChange(): void;
  discardUnsyncedEdits(): void;
  requestFreshSnapshot(): void;
  retryMigration(): void;
  retryWriteCommand(commandId: string): void;
  discardWriteCommand(commandId: string): void;
  encodeRootState(): Promise<Uint8Array>;
  applyRootUpdate(update: Uint8Array, asLocalEdit: boolean): Promise<boolean>;
  detachTransport(): void;
  dispose(): void;
}

/**
 * The narrowing for `begin-pending-chat-creation`'s payload. It crosses as `unknown` because
 * `PendingChatCreation` belongs to gui-app and a copy in the protocol would rot against it.
 */
function readPendingChatCreation(value: unknown): PendingChatCreation | null {
  if (typeof value !== "object" || value === null) return null;
  const chatId: unknown = Reflect.get(value, "chatId");
  const hostId: unknown = Reflect.get(value, "hostId");
  const title: unknown = Reflect.get(value, "title");
  const parentChatId: unknown = Reflect.get(value, "parentChatId");
  const ownerUserId: unknown = Reflect.get(value, "ownerUserId");
  if (typeof chatId !== "string" || typeof hostId !== "string") return null;
  if (typeof title !== "string") return null;
  if (parentChatId !== null && typeof parentChatId !== "string") return null;
  // `null` is a REPRESENTED state here - the caller had no signed-in user, and the registry drops
  // that registration itself. Anything else is a foreign payload rather than an absent one.
  if (ownerUserId !== null && typeof ownerUserId !== "string") return null;
  return { chatId, hostId, parentChatId, title, ownerUserId };
}

/**
 * Where a resident body's return traffic goes: `body/doc-in` to main's live doc,
 * `body/awareness-in` to main's `Awareness`.
 */
export interface EpicRuntimeBodyReturnLeg {
  readonly onDocUpdate: (docKey: string, update: Uint8Array) => void;
  readonly onAwareness: (docKey: string, frame: Uint8Array) => void;
}

export function buildEpicRuntimeCorePorts(
  source: EpicRuntimeCorePortSource,
  returnLeg: EpicRuntimeBodyReturnLeg,
): EpicRuntimeCorePorts {
  /** One retained release per resident `docKey`. */
  const heldLeases = new Map<string, () => void>();

  /** The return-leg observers per resident docKey - doc AND presence, behind ONE composite detach. */
  const bodyObservers = new Map<string, () => void>();

  /**
   * Demand retained for a body that has no bytes YET - one release per docKey, held rather than
   * called.
   */
  const awaitingDemand = new Map<string, () => void>();

  /** Whether this docKey already has demand on it from either map. */
  function hasBodyDemand(docKey: string): boolean {
    return heldLeases.has(docKey) || awaitingDemand.has(docKey);
  }

  function attachBodyObserver(docKey: string): void {
    if (bodyObservers.has(docKey)) return;
    const detachDoc = source.observeBodyDoc(docKey, (update) => {
      // COPIED, because we do not own these bytes.
      returnLeg.onDocUpdate(docKey, update.slice());
    });
    const detachAwareness = source.observeBodyAwareness(docKey, (frame) => {
      returnLeg.onAwareness(docKey, frame);
    });
    bodyObservers.set(docKey, () => {
      detachDoc();
      detachAwareness();
    });
  }

  function detachBodyObserver(docKey: string): void {
    const detach = bodyObservers.get(docKey);
    if (detach === undefined) return;
    bodyObservers.delete(docKey);
    detach();
  }

  /**
   * Record demand for a body whose bytes have not arrived, and answer nothing. NO OBSERVER IS
   * ATTACHED HERE, and that is not an omission to tidy up later.
   */
  function holdAwaitingDemand(docKey: string, release: () => void): void {
    // Demand from either map already covers this body; a second retained
    // release would raise the ref-count with nothing left to lower it.
    if (hasBodyDemand(docKey)) {
      release();
      return;
    }
    awaitingDemand.set(docKey, release);
  }

  /** Record demand for a body whose bytes ARE being handed over. */
  function holdResidentLease(docKey: string, release: () => void): void {
    const awaited = awaitingDemand.get(docKey);
    if (awaited !== undefined) {
      awaitingDemand.delete(docKey);
      heldLeases.set(docKey, awaited);
      release();
      return;
    }
    // Already resident for this doc.
    if (heldLeases.has(docKey)) {
      release();
      return;
    }
    heldLeases.set(docKey, release);
  }

  /** Cancellable waits, by the caller's id. Closure state, not module state. */
  const pendingAwaits = new Map<number, AbortController>();

  return {
    attachments: {
      /** The WAITING read, keyed by the caller's id so it can be cancelled. */
      await: (awaitId, hash) => {
        const controller = new AbortController();
        pendingAwaits.set(awaitId, controller);
        return source
          .readAttachmentBytes(hash, controller.signal)
          .then((bytes) => {
            pendingAwaits.delete(awaitId);
            return bytes;
          });
      },
      cancel: (awaitId) => {
        const controller = pendingAwaits.get(awaitId);
        // `false` for an id that was never pending or has already settled. Bytes can land while a cancel
        // is in flight, so that race is inherent - a no-op, not a fault.
        if (controller === undefined) return false;
        pendingAwaits.delete(awaitId);
        controller.abort();
        return true;
      },
      cancelAll: () => {
        const pending = [...pendingAwaits.values()];
        // Cleared BEFORE aborting: each abort settles a promise whose `.then` deletes its own entry, and
        // mutating the map mid-iteration is how a wait gets skipped and left parked.
        pendingAwaits.clear();
        for (const controller of pending) controller.abort();
      },
      /** NON-WAITING, which is this port's whole contract. */
      read: (hash) =>
        source.hasAttachmentBytes(hash)
          ? source.readAttachmentBytes(hash, new AbortController().signal)
          : Promise.resolve(null),
    },
    bodies: {
      materialize: (artifactId) => {
        // LEASE FIRST. Everything below reads state that only exists because
        // of it - see `acquireBodyLease`.
        const release = source.acquireBodyLease(artifactId);
        const docKey = source.bodyDocKey(artifactId);
        if (docKey === null) {
          release();
          return Promise.resolve(null);
        }
        const cold = source.encodeColdState(docKey);
        if (cold === null) {
          // No COLD state, but the room may still be materialized with no stated identity - the `@1` arm,
          // whose snapshots claim none by design.
          const live = source.encodeForwardOnly(docKey);
          if (live !== null) {
            attachBodyObserver(docKey);
            holdResidentLease(docKey, release);
            return Promise.resolve({
              docKey,
              update: live,
              docGuid: null,
              seedMode: "full" as const,
              hostStateVector: null,
              awarenessFrames: source.encodeBodyPeerAwareness(docKey),
            });
          }
        }
        // No bytes on either path.
        if (cold === null) {
          holdAwaitingDemand(docKey, release);
          return Promise.resolve({
            docKey,
            update: null,
            docGuid: null,
            seedMode: "full" as const,
            hostStateVector: null,
            awarenessFrames: [],
          });
        }
        attachBodyObserver(docKey);
        holdResidentLease(docKey, release);
        return Promise.resolve({
          docKey,
          update: cold.update,
          docGuid: cold.docGuid,
          seedMode: cold.seedMode,
          hostStateVector: cold.hostStateVector,
          // The room's peers ride the response, so main installs the doc and
          // applies presence in one step - see the protocol's field.
          awarenessFrames: source.encodeBodyPeerAwareness(docKey),
        });
      },
      settle: (input) => {
        const settlement = source.settleColdState(
          input.docKey,
          input.update,
          input.docGuid,
        );
        // The refusal REASON now CROSSES.
        if (settlement.accepted) {
          detachBodyObserver(input.docKey);
          // Released ONLY on acceptance, and that asymmetry is the contract: a refusal means the main thread
          // KEEPS its live doc, so the demand and the tier lease that doc stands on are still in use.
          heldLeases.get(input.docKey)?.();
          heldLeases.delete(input.docKey);
        }
        return Promise.resolve(
          settlement.accepted
            ? {
                accepted: true,
                settledBytes: settlement.settledBytes,
                reason: null,
              }
            : {
                accepted: false,
                settledBytes: 0,
                reason: settlement.reason,
              },
        );
      },
      heldDocKeys: () => [...heldLeases.keys()],
      release: (docKey) => {
        // REFUSED while the tier still pins this room.
        if (source.isBodyPinned(docKey)) {
          return { released: false, reason: "pinned" as const };
        }
        // The FORWARD-ONLY lifecycle's terminator, and the twin of the `settlement.accepted` branch above
        // rather than a second way into it.
        detachBodyObserver(docKey);
        heldLeases.get(docKey)?.();
        heldLeases.delete(docKey);
        // The AWAITING half of the same terminator.
        awaitingDemand.get(docKey)?.();
        awaitingDemand.delete(docKey);
        return { released: true, reason: null };
      },
      applyAwareness: (docKey, frame, localClientId) => {
        source.applyBodyAwareness(docKey, frame, localClientId);
      },
      sendUpdate: (input) =>
        Promise.resolve(source.sendBodyUpdate(input.docKey, input.update)),
    },
    mutations: {
      /**
       * One branch per kind rather than a generic dispatch, and the repetition is the safety - the same
       * reasoning `CALL_BUILDERS` states in the protocol.
       */
      apply: (mutation) => {
        switch (mutation.kind) {
          case "rename-artifact":
            return {
              kind: "rename-artifact",
              value: {
                changed: source.renameArtifact(
                  mutation.request.artifactId,
                  mutation.request.title,
                ),
              },
            };
          case "delete-artifact":
            return {
              kind: "delete-artifact",
              value: {
                changed: source.deleteArtifact(mutation.request.artifactId),
              },
            };
          case "reparent-artifact":
            return {
              kind: "reparent-artifact",
              value: {
                changed: source.reparentArtifact(
                  mutation.request.artifactId,
                  mutation.request.newParentId,
                ),
              },
            };
          case "begin-rename":
            return {
              kind: "begin-rename",
              value: {
                requestId: source.beginRenameMutation(
                  mutation.request.nodeId,
                  mutation.request.title,
                ),
              },
            };
          case "begin-epic-title":
            return {
              kind: "begin-epic-title",
              value: {
                requestId: source.beginEpicTitleMutation(
                  mutation.request.title,
                ),
              },
            };
          case "begin-reparent":
            return {
              kind: "begin-reparent",
              value: {
                requestId: source.beginReparentMutation(
                  mutation.request.nodeId,
                  mutation.request.newParentId,
                ),
              },
            };
          case "retire-pending":
            return {
              kind: "retire-pending",
              value: {
                retired: source.retirePendingMutation(
                  mutation.request.requestId,
                  mutation.request.outcome,
                ),
              },
            };
          case "is-latest-rename-stamp":
            return {
              kind: "is-latest-rename-stamp",
              value: {
                latest: source.isLatestRenameStamp(
                  mutation.request.nodeId,
                  mutation.request.requestId,
                ),
              },
            };
        }
      },
    },
    commands: {
      enqueueWrite: (intent) => {
        const narrowed = source.readWriteCommandIntent(intent);
        if (narrowed === null) return { outcome: "refused" };
        const commandId = source.enqueueWriteCommand(narrowed);
        return commandId === null
          ? { outcome: "refused" }
          : { outcome: "enqueued", commandId };
      },
      /**
       * One branch per kind, exhaustive, no default - so a command added to the vocabulary without a
       * branch here fails to compile rather than being silently dropped at runtime.
       */
      apply: (command) => {
        // Dispatched by FAMILY, not one 15-arm switch.
        if (isRecordPlaneCommand(command)) {
          applyRecordPlaneCommand(source, command);
          return;
        }
        if (isControlCommand(command)) {
          applyControlCommand(source, command);
          return;
        }
        applyArgumentCommand(source, command);
      },
    },
    releaseAllBodyHolds: () => {
      const detachers = [...bodyObservers.values()];
      // Cleared BEFORE detaching, so a detach that re-enters cannot see a
      // half-emptied map - the same ordering `cancelAll` uses.
      bodyObservers.clear();
      for (const detach of detachers) detach();
      // Retained demand is the OTHER thing a teardown leaves behind, and it is invisible to the loop
      // above: an awaiting body has no observer to detach, by design, so a corner that only walked
      const awaited = [...awaitingDemand.values()];
      awaitingDemand.clear();
      for (const release of awaited) release();
    },
    root: {
      encode: () => source.encodeRootState(),
      apply: (update, asLocalEdit) =>
        source.applyRootUpdate(update, asLocalEdit),
    },
    // The core's documented shutdown order, mapped onto the runtime's two teardown members: the core
    // stops serving, then the transport closes, then the durable store.
    transport: {
      close: () => {
        source.detachTransport();
      },
    },
    durableStore: {
      close: () => {
        source.dispose();
      },
    },
  };
}

/** Record-plane ingest: rows and their authority, from main's chat registry. */
type RecordPlaneCommand = Extract<
  RuntimeCommand,
  {
    kind:
      | "apply-chat-records"
      | "apply-chat-record-delta"
      | "apply-confirmed-chat-mutation"
      | "apply-tui-agent-records"
      | "apply-tui-agent-record-delta"
      | "mark-chat-records-authoritative"
      | "mark-chat-records-not-authoritative";
  }
>;

/** Payload-free control gestures. */
type ControlCommand = Extract<
  RuntimeCommand,
  {
    kind:
      | "republish-records-for-current-user"
      | "reproject-for-viewer-change"
      | "discard-unsynced-edits"
      | "request-fresh-snapshot"
      | "retry-migration";
  }
>;

/** Whatever the two families above do not claim. */
type ArgumentCommand = Exclude<
  RuntimeCommand,
  RecordPlaneCommand | ControlCommand
>;

/** Switches rather than module-scoped `Set`s, and that is not a style choice. */
function isRecordPlaneCommand(
  command: RuntimeCommand,
): command is RecordPlaneCommand {
  switch (command.kind) {
    case "apply-chat-records":
    case "apply-confirmed-chat-mutation":
    case "apply-chat-record-delta":
    case "apply-tui-agent-records":
    case "apply-tui-agent-record-delta":
    case "mark-chat-records-authoritative":
    case "mark-chat-records-not-authoritative":
      return true;
    default:
      return false;
  }
}

function isControlCommand(command: RuntimeCommand): command is ControlCommand {
  switch (command.kind) {
    case "republish-records-for-current-user":
    case "reproject-for-viewer-change":
    case "discard-unsynced-edits":
    case "request-fresh-snapshot":
    case "retry-migration":
      return true;
    default:
      return false;
  }
}

function applyRecordPlaneCommand(
  source: EpicRuntimeCorePortSource,
  command: RecordPlaneCommand,
): void {
  switch (command.kind) {
    case "apply-chat-records":
      source.applyChatRecords(
        command.payload.records,
        command.payload.issuedAtSeq,
      );
      return;
    case "apply-confirmed-chat-mutation":
      source.applyConfirmedChatMutation(command.payload.mutation);
      return;
    case "apply-chat-record-delta":
      source.applyChatRecordDelta(command.payload.delta);
      return;
    case "apply-tui-agent-records":
      source.applyTuiAgentRecords(
        command.payload.records,
        command.payload.issuedAtSeq,
      );
      return;
    case "apply-tui-agent-record-delta":
      source.applyTuiAgentRecordDelta(command.payload.delta);
      return;
    case "mark-chat-records-authoritative":
      source.markChatRecordListAuthoritative();
      return;
    case "mark-chat-records-not-authoritative":
      source.markChatRecordListNotAuthoritative();
      return;
  }
}

function applyControlCommand(
  source: EpicRuntimeCorePortSource,
  command: ControlCommand,
): void {
  switch (command.kind) {
    case "republish-records-for-current-user":
      source.republishRecordsForCurrentUser();
      return;
    case "reproject-for-viewer-change":
      source.reprojectForViewerChange();
      return;
    case "discard-unsynced-edits":
      source.discardUnsyncedEdits();
      return;
    case "request-fresh-snapshot":
      source.requestFreshSnapshot();
      return;
    case "retry-migration":
      source.retryMigration();
      return;
  }
}

function applyArgumentCommand(
  source: EpicRuntimeCorePortSource,
  command: ArgumentCommand,
): void {
  switch (command.kind) {
    case "begin-pending-chat-creation": {
      const pending = readPendingChatCreation(command.payload.pending);
      // DROPPED rather than defaulted: a pending creation with an invented id
      // puts a row on screen that no create will ever resolve.
      if (pending !== null) source.beginPendingChatCreation(pending);
      return;
    }
    case "clear-pending-chat-creation":
      source.clearPendingChatCreation(command.payload.chatId);
      return;
    case "retry-write-command":
      source.retryWriteCommand(command.payload.commandId);
      return;
    case "discard-write-command":
      source.discardWriteCommand(command.payload.commandId);
      return;
    case "detach-transport":
      // Ends the transport while the replica lives on.
      source.detachTransport();
      return;
    default:
      // The exhaustiveness guarantee for the whole vocabulary: a kind added to `RuntimeCommandMap` and
      // to neither family above lands here, and `command` is then not `never`, which does not compile.
      return assertNever(command);
  }
}

function assertNever(command: never): never {
  throw new Error(`Unhandled runtime command ${JSON.stringify(command)}`);
}
