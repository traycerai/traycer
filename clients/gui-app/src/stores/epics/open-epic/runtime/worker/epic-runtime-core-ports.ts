/**
 * {@link EpicRuntimeCorePorts} over a composed {@link EpicReplicaRuntime}.
 *
 * Its own module rather than a closure inside `install-epic-runtime-core.ts`
 * for one reason: the attachments port has a property that must be pinned -
 * it never waits - and pinning it through the whole install would need a host,
 * a bridge and a bootstrap to observe one promise settling.
 *
 * Named members rather than the runtime itself: the runtime has 42 members and
 * these ports need eight. A parameter typed as the whole runtime would let a
 * future member reach across this seam without anyone noticing the seam had
 * moved.
 *
 * This paragraph used to cite `in-process-runtime-port.ts` as the discipline's
 * other practitioner. That module is retired, and the sentence was corrected in
 * the SAME commit that deleted it rather than left to be found later - a
 * deletion that leaves a name behind mints a stale-prose instance instead of
 * merely inheriting one. `epicRuntimeCorePortSourceOf` in
 * `install-epic-runtime-core.ts` is the mapping that fills these members now,
 * and it is exported so the arm-equality pin uses production's rather than a
 * copy.
 */
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
  /** Live bytes for a room that states no identity. See the runtime member. */
  encodeForwardOnly(docKey: string): Uint8Array | null;
  /**
   * Observe a materialized room's doc. Returns the detach.
   *
   * Every update is forwarded, with NO origin filter on this side, and that is
   * deliberate rather than an omission. Main runs the only filter: an update
   * main itself sent comes back as the arm's echo and re-applies as a Yjs
   * no-op, while a collaborator's edit is stamped with main's private origin
   * on arrival so main's observer does not send it back out. A second filter
   * here would be a second thing to keep in step with that one, and the two
   * would drift.
   */
  observeBodyDoc(
    docKey: string,
    onUpdate: (update: Uint8Array) => void,
  ): () => void;
  /**
   * Relay a local presence frame for one body to the arm.
   *
   * `localClientId` is the main-side `Awareness.clientID` the frame speaks
   * for; the room excludes it from its remote-peer pin. See the runtime
   * member and `ArtifactRoomReplicaEntry.relayedLocalClientId`.
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
  /**
   * Observe a materialized room's presence. Returns the detach.
   *
   * The mirror of {@link observeBodyDoc}, with ONE difference that is not
   * cosmetic: the source DOES filter here, dropping frames it relayed in
   * itself. Presence has no equivalent of a Yjs no-op re-apply - handing main
   * back its own state would resurrect a cursor it had just removed - so that
   * cut is made where the origin is still known, not left to main.
   */
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
  /**
   * Narrow the wire form of an intent, or `null` if it is not one.
   *
   * The intent crosses as `unknown` exactly as `main/write-command`'s does -
   * it is the caller's clonable wire form and the worker carries it opaquely -
   * but the QUEUE is typed, so something has to narrow it. Refusing an
   * unrecognised payload is the fail-closed answer: enqueuing a malformed
   * intent would mint an id for a command that can never be dispatched.
   */
  readWriteCommandIntent(intent: unknown): EpicWriteCommandIntent | null;
  applyChatRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): void;
  applyChatRecordDelta(delta: ChatRecordDelta): void;
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

/**
 * Where a resident body's return traffic goes: `body/doc-in` to main's live
 * doc, `body/awareness-in` to main's `Awareness`.
 *
 * A NAMED pair rather than two positional callbacks, because the two have the
 * identical shape `(docKey, Uint8Array) => void` - passing them in the wrong
 * order compiles clean and silently feeds document updates into a presence
 * channel, where they decode as garbage or as nothing at all. There is no
 * type that catches that; a field name is.
 */
export interface EpicRuntimeBodyReturnLeg {
  readonly onDocUpdate: (docKey: string, update: Uint8Array) => void;
  readonly onAwareness: (docKey: string, frame: Uint8Array) => void;
}

export function buildEpicRuntimeCorePorts(
  source: EpicRuntimeCorePortSource,
  returnLeg: EpicRuntimeBodyReturnLeg,
): EpicRuntimeCorePorts {
  /**
   * One retained release per resident `docKey`.
   *
   * Closure state, not module state - one map per composed runtime, which is
   * also what keeps this module off the worker-graph ratchet's process-scoped
   * list.
   */
  const heldLeases = new Map<string, () => void>();

  /**
   * The return-leg observers per resident docKey - doc AND presence, behind
   * ONE composite detach.
   *
   * Kept as a single entry rather than two maps so the two can never be
   * detached at different corners: they are attached together and released
   * together, and a room whose doc stopped being watched while its presence
   * was not is a half-live room no assertion is looking for.
   *
   * Detached at THREE corners: an accepted demote, a drop, and core dispose.
   * The third is the one that gets forgotten - a worker tearing down with
   * observers attached is the same shape as the pending-await park, and this
   * leak is worse to find because the tier, the projection and the tile all
   * look correct throughout it.
   */
  const bodyObservers = new Map<string, () => void>();

  /**
   * Demand retained for a body that has no bytes YET - one release per docKey,
   * held rather than called.
   *
   * The defect it closes: on the lane arm the lease taken at the top of
   * `materialize` IS the `artifact.subscribe` open, so a cold open runs
   * lease → no bytes → release, and the release closes the subscription that
   * was about to deliver those bytes. Nothing retried, because the tile's
   * effect keys on a docKey that never moves. Every artifact body on that arm
   * was unreachable.
   *
   * Disjoint from {@link heldLeases} BY CONSTRUCTION, and the disjointness is
   * what makes "already held" answerable in one question: a docKey is resident
   * (bytes handed over, demote owed) or awaiting (demand held, nothing handed
   * over), never both. Every transition below moves the entry rather than
   * copying it.
   */
  const awaitingDemand = new Map<string, () => void>();

  /**
   * Whether this docKey already has demand on it from either map.
   *
   * The guard a second `materialize` for the same body needs, and it must ask
   * about BOTH: `bodies.release` is ref-counted, so a retry that recorded its
   * own release on top of a retained one would leave demand permanently one
   * too high and keep the subscription open for the session.
   */
  function hasBodyDemand(docKey: string): boolean {
    return heldLeases.has(docKey) || awaitingDemand.has(docKey);
  }

  function attachBodyObserver(docKey: string): void {
    if (bodyObservers.has(docKey)) return;
    const detachDoc = source.observeBodyDoc(docKey, (update) => {
      // COPIED, because we do not own these bytes.
      //
      // Yjs delivers ONE freshly-encoded array to every `update` listener, and
      // on the `@1` arm two listen: the tier's outbound observer, which turns
      // it into an `artifactRoomApplyUpdate` frame, and this one. BOTH
      // downstream legs can transfer full-span arrays in place, so both copy:
      // the tier before its stream send, and this return leg before its worker
      // post. Neither may rely on observer order; transferring the shared Yjs
      // array in either observer detaches it before every later observer can
      // even make its own copy.
      //
      // The copy belongs HERE and not inside `takeBytesForTransfer`: this is
      // the point where non-ownership is known, and teaching the helper to
      // copy always would tax every legitimate transfer to pay for this one.
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
   * Record demand for a body whose bytes have not arrived, and answer nothing.
   *
   * NO OBSERVER IS ATTACHED HERE, and that is not an omission to tidy up later.
   * `observeArtifactBodyDoc` on an unmaterialized key is a documented no-op
   * that watches nothing and hands back a no-op detach - but
   * {@link attachBodyObserver} would still record an entry for the docKey, and
   * its `bodyObservers.has(docKey)` early-out would then make the REAL attach
   * on the retry a silent no-op. The body would materialise on main and never
   * receive another update.
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

  /**
   * Record demand for a body whose bytes ARE being handed over.
   *
   * The awaiting → resident transition MOVES the retained release rather than
   * dropping it and keeping this call's: the retained one has held the
   * subscription open continuously since the awaiting answer, so promoting it
   * takes demand from two to one with no instant at zero. Dropping it instead
   * would be correct on a ref-count and wrong on a socket, if the two releases
   * ever stop being interchangeable.
   */
  function holdResidentLease(docKey: string, release: () => void): void {
    const awaited = awaitingDemand.get(docKey);
    if (awaited !== undefined) {
      awaitingDemand.delete(docKey);
      heldLeases.set(docKey, awaited);
      release();
      return;
    }
    // Already resident for this doc. Drop the SECOND lease rather than stacking
    // it: the main side has one doc per `docKey` and will send one demote, so a
    // second retained release would never be called - and `bodies.release`
    // decrements a ref-count, so an unreleased extra demand keeps the body
    // stream open for the session.
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
      /**
       * The WAITING read, keyed by the caller's id so it can be cancelled.
       *
       * Built on the runtime's own signal-shaped read rather than beside it:
       * that machinery already holds in-flight waits outside the doc and
       * re-points them across a replica swap, which is the hard part and is
       * already tested. What the bridge adds is a NAME for the wait, because
       * an `AbortSignal` cannot cross a `postMessage` and a call in flight has
       * no other handle.
       */
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
        // `false` for an id that was never pending or has already settled.
        // Bytes can land while a cancel is in flight, so that race is
        // inherent - a no-op, not a fault.
        if (controller === undefined) return false;
        pendingAwaits.delete(awaitId);
        controller.abort();
        return true;
      },
      cancelAll: () => {
        const pending = [...pendingAwaits.values()];
        // Cleared BEFORE aborting: each abort settles a promise whose `.then`
        // deletes its own entry, and mutating the map mid-iteration is how a
        // wait gets skipped and left parked.
        pendingAwaits.clear();
        for (const controller of pending) controller.abort();
      },
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
        if (cold === null) {
          // No COLD state, but the room may still be materialized with no
          // stated identity - the `@1` arm, whose snapshots claim none by
          // design. Serve those FORWARD-ONLY: real bytes, `docGuid: null`, and
          // the lease bridge never posts a demote for them. Refusing here
          // instead would take the whole `@1` arm dark, since its bodies
          // reached editors by reference before the relocation and have no
          // other way across now.
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
        // No bytes on either path. This is AWAITING SEED, not not-held, and the
        // difference is the whole defect: on the lane arm the lease taken above
        // IS the `artifact.subscribe` open, so releasing here closes the
        // subscription that was about to deliver these bytes - and nothing ever
        // retries, because the tile's effect keys on a docKey that does not
        // move. Every body on that arm was unreachable.
        //
        // The demand is RETAINED instead, and main re-calls when the
        // projection says this artifact is ready
        // (`retryAwaitingBodies`). `null` is still not empty bytes: a
        // zero-length update applies cleanly and yields an empty document, so
        // the answer states no bytes rather than handing over none.
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
        // The refusal REASON now CROSSES. It stopped here while every refusal
        // meant the same thing to main; `pinned` does not - it says the room
        // is still in use and will settle later, where `newer-generation` says
        // these bytes belong to a body that has been replaced. Main's
        // behaviour is still identical for all three, so nothing branches on
        // it; it crosses so the seam is readable when one arrives where
        // another was expected.
        if (settlement.accepted) {
          detachBodyObserver(input.docKey);
          // Released ONLY on acceptance, and that asymmetry is the contract: a
          // refusal means the main thread KEEPS its live doc, so the demand and
          // the tier lease that doc stands on are still in use. Releasing on a
          // refusal would unsubscribe a body the user still has open.
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
        // REFUSED while the tier still pins this room. A forward-only body has
        // no settle to be refused, so this is the only channel its pins have -
        // and without it main releases a room the tier considers occupied.
        if (source.isBodyPinned(docKey)) {
          return { released: false, reason: "pinned" as const };
        }
        // The FORWARD-ONLY lifecycle's terminator, and the twin of the
        // `settlement.accepted` branch above rather than a second way into it.
        //
        // It deliberately touches NOTHING that path touches beyond these two
        // maps: no settlement is recorded, no bytes are read, no generation is
        // compared. A body has exactly one of the two lifecycles - identity-
        // named bodies settle their bytes back, forward-only bodies release
        // their hold - decided by whether its seed stated an identity, and the
        // two must not learn about each other.
        //
        // IDEMPOTENT: `Map.get` on an absent key is `undefined` and both
        // deletes are no-ops, so a release that races a re-acquire or arrives
        // twice after a reconnect costs nothing. That is load-bearing rather
        // than defensive - this is a fire-and-forget event, so the sender has
        // no answer to deduplicate on.
        detachBodyObserver(docKey);
        heldLeases.get(docKey)?.();
        heldLeases.delete(docKey);
        // The AWAITING half of the same terminator. A consumer that unmounts
        // while its body is still waiting for a seed sends this release like
        // any other, and the demand retained for it is the only thing holding
        // that subscription open - so it comes off here or it never does, and
        // the tab stays subscribed to a body nobody is looking at for the rest
        // of the session. Disjoint from `heldLeases` by construction, so at
        // most one of these two lines does anything.
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
      enqueueWrite: (intent) => {
        const narrowed = source.readWriteCommandIntent(intent);
        if (narrowed === null) return { outcome: "refused" };
        const commandId = source.enqueueWriteCommand(narrowed);
        return commandId === null
          ? { outcome: "refused" }
          : { outcome: "enqueued", commandId };
      },
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
    releaseAllBodyHolds: () => {
      const detachers = [...bodyObservers.values()];
      // Cleared BEFORE detaching, so a detach that re-enters cannot see a
      // half-emptied map - the same ordering `cancelAll` uses.
      bodyObservers.clear();
      for (const detach of detachers) detach();
      // Retained demand is the OTHER thing a teardown leaves behind, and it is
      // invisible to the loop above: an awaiting body has no observer to
      // detach, by design, so a corner that only walked `bodyObservers` would
      // skip exactly the entries this map exists to hold. Same order, same
      // reason.
      const awaited = [...awaitingDemand.values()];
      awaitingDemand.clear();
      for (const release of awaited) release();
    },
    root: {
      encode: () => source.encodeRootState(),
      apply: (update, asLocalEdit) =>
        source.applyRootUpdate(update, asLocalEdit),
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
    case "detach-transport":
      // Ends the transport while the replica lives on. The member is
      // idempotent (`transportDetached` latches worker-side), which is what
      // makes a duplicated command harmless rather than something this
      // dispatch has to guard.
      source.detachTransport();
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
