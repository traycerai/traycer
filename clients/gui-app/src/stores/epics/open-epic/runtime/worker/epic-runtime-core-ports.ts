/**
 * {@link EpicRuntimeCorePorts} over a composed {@link EpicReplicaRuntime}.
 *
 * Its own module rather than a closure inside `install-epic-runtime-core.ts`
 * for one reason: the attachments port has a property that must be pinned -
 * it never waits - and pinning it through the whole install would need a host,
 * a bridge and a bootstrap to observe one promise settling.
 *
 * Named members rather than the runtime itself, the same discipline
 * `in-process-runtime-port.ts` uses: the runtime has 42 members and these
 * ports need eight. A parameter typed as the whole runtime would let a future
 * member reach across this seam without anyone noticing the seam had moved.
 */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { ArtifactRoomColdState } from "../artifact-room-tier";
import type { PendingChatCreation } from "../../pending-chat-creations";
import type { RuntimeCommand } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
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
  /**
   * Take the runtime's body lease and return its release.
   *
   * This is what MATERIALIZES. `acquireArtifactBodyLease` takes body-lane
   * demand ("the lease is also the subscribe" on the lane arm), then the tier
   * lease that creates the replica entry, then signals a rebind for a new doc
   * identity. Encoding cold state without it reads a `replicas` entry that
   * does not exist, so it answers "not held" for every body.
   */
  acquireBodyLease(artifactId: string): () => void;
  bodyDocKey(artifactId: string): string | null;
  encodeColdState(docKey: string): ArtifactRoomColdState | null;
  settleColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ):
    | { readonly accepted: true; readonly settledBytes: number }
    | { readonly accepted: false };
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
  applyChatRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  applyChatRecordDelta(delta: ChatRecordDelta): void;
  applyTuiAgentRecords(
    records: readonly TuiAgentRecordSummaryV11[],
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
  detachTransport(): void;
  dispose(): void;
}

/**
 * The narrowing for `begin-pending-chat-creation`'s payload.
 *
 * It crosses as `unknown` because `PendingChatCreation` belongs to gui-app and
 * a copy in the protocol would rot against it. Built as a literal so a field
 * added to that type fails to compile HERE, which a cast would have discarded.
 * A payload that is not a record is DROPPED rather than defaulted: a pending
 * creation with an invented id would put a row on screen that no create will
 * ever resolve.
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
  // `null` is a REPRESENTED state here - the caller had no signed-in user, and
  // the registry drops that registration itself. Anything else is a foreign
  // payload rather than an absent one.
  if (ownerUserId !== null && typeof ownerUserId !== "string") return null;
  return { chatId, hostId, parentChatId, title, ownerUserId };
}

export function buildEpicRuntimeCorePorts(
  source: EpicRuntimeCorePortSource,
): EpicRuntimeCorePorts {
  /**
   * One retained release per resident `docKey`.
   *
   * Closure state, not module state - one map per composed runtime, which is
   * also what keeps this module off the worker-graph ratchet's process-scoped
   * list.
   */
  const heldLeases = new Map<string, () => void>();

  return {
    attachments: {
      /**
       * NON-WAITING, which is this port's whole contract.
       *
       * The runtime's own read waits indefinitely for a hash that has not
       * synced and resolves `null` only when its signal aborts - deliberately,
       * for a main-thread caller that holds one. Across the bridge there is no
       * signal to abort, so an unguarded read parks the call forever and holds
       * a call slot open for the life of the worker.
       *
       * The guard that used to live on main - `hasAttachmentBytes`, which
       * every caller was required to check first and which was documented as
       * "not optional" - lives HERE now, where it is a local synchronous read
       * and cannot be forgotten by a caller.
       */
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
        // `null` is NOT empty bytes: a zero-length update applies cleanly and
        // yields an empty document, so conflating them replaces a body with
        // nothing. The lease comes back off - nothing was handed over, so
        // nothing will come back to release it.
        if (cold === null) {
          release();
          return Promise.resolve(null);
        }
        if (heldLeases.has(docKey)) {
          // Already held for this doc. Drop the SECOND lease rather than
          // stacking it: the main side has one doc per `docKey` and will send
          // one demote, so a second retained release would never be called -
          // and `bodies.release` decrements a ref-count, so an unreleased
          // extra demand keeps the body stream open for the session.
          release();
        } else {
          heldLeases.set(docKey, release);
        }
        return Promise.resolve({
          docKey,
          update: cold.update,
          docGuid: cold.docGuid,
          seedMode: cold.seedMode,
          hostStateVector: cold.hostStateVector,
        });
      },
      settle: (input) => {
        const settlement = source.settleColdState(
          input.docKey,
          input.update,
          input.docGuid,
        );
        // The refusal REASON ("not-held" / "newer-generation") stops here: the
        // response carries the verdict and the bytes, the main thread keeps
        // the live doc on either refusal, and the in-process port drops it at
        // the same seam.
        if (settlement.accepted) {
          // Released ONLY on acceptance, and that asymmetry is the contract: a
          // refusal means the main thread KEEPS its live doc, so the demand and
          // the tier lease that doc stands on are still in use. Releasing on a
          // refusal would unsubscribe a body the user still has open.
          heldLeases.get(input.docKey)?.();
          heldLeases.delete(input.docKey);
        }
        return Promise.resolve(
          settlement.accepted
            ? { accepted: true, settledBytes: settlement.settledBytes }
            : { accepted: false, settledBytes: 0 },
        );
      },
      sendUpdate: (input) =>
        Promise.resolve(source.sendBodyUpdate(input.docKey, input.update)),
    },
    mutations: {
      /**
       * One branch per kind rather than a generic dispatch, and the repetition
       * is the safety - the same reasoning `CALL_BUILDERS` states in the
       * protocol. Inside each branch the kind is a literal, so TypeScript
       * checks the answer against THAT kind's response type; a generic
       * dispatch over the union can only be made to compile with an assertion,
       * at exactly the point where a wrong-shaped answer would be bound to a
       * kind.
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
      /**
       * One branch per kind, exhaustive, no default - so a command added to
       * the vocabulary without a branch here fails to compile rather than
       * being silently dropped at runtime. That is the whole exhaustiveness
       * guarantee for a direction with no responses.
       */
      apply: (command) => {
        // Dispatched by FAMILY, not one 15-arm switch. The families are real
        // groupings - record-plane ingest, payload-free control gestures, and
        // the ones carrying an argument - and splitting on them is also what
        // keeps each function readable. Exhaustiveness survives the split:
        // anything the two predicates do not claim lands in
        // `applyArgumentCommand`, whose `assertNever` makes an unhandled kind
        // a COMPILE error rather than a silent drop.
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
    // The core's documented shutdown order, mapped onto the runtime's two
    // teardown members: the core stops serving, then the transport closes,
    // then the durable store. `dispose()` owns the store, so it goes last.
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

/**
 * Switches rather than module-scoped `Set`s, and that is not a style choice.
 *
 * A `const KINDS = new Set([...])` at module scope is process state, and the
 * worker-graph ratchet reads it as exactly that - correctly, since it cannot
 * know the set is never mutated. This module is on the worker entry's value
 * graph, whose allowlist is empty and stays empty, so the membership test has
 * to be stateless.
 */
function isRecordPlaneCommand(
  command: RuntimeCommand,
): command is RecordPlaneCommand {
  switch (command.kind) {
    case "apply-chat-records":
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
    default:
      // The exhaustiveness guarantee for the whole vocabulary: a kind added to
      // `RuntimeCommandMap` and to neither family above lands here, and
      // `command` is then not `never`, which does not compile.
      return assertNever(command);
  }
}

function assertNever(command: never): never {
  throw new Error(`Unhandled runtime command ${JSON.stringify(command)}`);
}
