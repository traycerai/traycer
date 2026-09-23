/**
 * The `agentIdentity.file.subscribe@1.0` adapter - ONE identity file's body,
 * bidirectionally synced, attached per open file and detached with it.
 *
 * The only identity lane that carries bytes, and the only adapter here that also
 * implements `LaneRequester`: bodies are the one genuinely CRDT-shaped thing an
 * identity holds, so writes go back up this lane rather than through a unary.
 *
 * It decodes into the SAME seam vocabulary the epic body lane decodes into
 * (`DocReplicaEvent`), because the two lanes carry the same class of thing. What
 * they do not share is the wire contract: `agentIdentity.file.subscribe` is its
 * own method with its own version line, so a fix to one lane's behaviour is not
 * a fix to the other's, and this file is a sibling of `artifact-lane-adapter.ts`
 * rather than a call into it.
 *
 * ## A blob is not an empty document
 *
 * Only paths in the identity's `documents` map have a fragment. Asking this lane
 * for a blob is refused with `notAFragment`, which decodes to
 * `"not-a-fragment"` and NOT to a not-found: the consumer's next move is to
 * fetch the bytes through the file plane's signed read URL. The one answer that
 * must never be produced is an empty body, because that is the one a user will
 * save over.
 *
 * ## A stale epoch is not an availability state
 *
 * `unavailable / staleAuthorityEpoch` is the one code that is a statement about
 * the IDENTITY rather than about this body: the client's whole index view is
 * void. So the adapter both emits the doc event (the editor has to stop claiming
 * to show a live body) and asks the runtime to replace the replica. Rendering it
 * as a merely-unavailable body would leave the index silently stale.
 *
 * The adapter never re-attaches itself under a new epoch. An attach is bound to
 * one `authorityEpoch` for life - that is the open request's contract - so the
 * recovery is a NEW adapter, built by the composition once the index lane has
 * reported the epoch the host is actually serving. An adapter that
 * re-parameterised itself would convert a refusal into a successful attach
 * against a different replica, which is the history splice the epoch exists to
 * prevent.
 *
 * ## A shard that is down is NOT reported here
 *
 * `bodyUnavailable` with `terminal: false` is what a retrying shard room looks
 * like on this lane, and it is genuinely per-body. The identity's whole shard
 * SET rides the index lane as `identity-shard-availability`, because that fact
 * is about the host rather than about any one file - and a client that learned
 * it only from body lanes would know nothing about a file it has not opened.
 */
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  DocReplicaEvent,
  DocSeedResumeOffer,
  DocUnavailableCode,
  LaneAdapter,
  LaneRequester,
  ResumeOffer,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import {
  authorityEpochTransition,
  createGenerationGuard,
} from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityFileAwarenessFrame,
  IdentityFileDocAckFrame,
  IdentityFileDocFrame,
  IdentityFileDocUpdateFrame,
  IdentityFileStreamCallbacks,
  IdentityFileUnavailableFrame,
} from "@traycer-clients/shared/host-transport/identity-file-stream-client";
import type {
  AgentIdentityFileSeedOffer,
  AgentIdentityFileSubscribeUnavailableCode,
} from "@traycer/protocol/host/agent-identity/file-subscribe";
import {
  identityFileLaneId,
  type IdentityFileLaneRequest,
} from "./lane-events";

/** The subset of the body lane's stream client this adapter drives. */
export interface IdentityFileLaneStreamClient {
  applyUpdate(docGuid: string, updateBytes: Uint8Array): void;
  awareness(awarenessBytes: Uint8Array): void;
  close(): void;
}

export interface IdentityFileStreamClientRequest {
  readonly identityId: string;
  readonly path: string;
  readonly authorityEpoch: string;
  readonly callbacks: IdentityFileStreamCallbacks;
  /**
   * The body state this client already holds, re-read before every wire
   * subscribe. Pure and synchronous by contract.
   */
  readonly seedOfferProvider: () => AgentIdentityFileSeedOffer | null;
}

export type IdentityFileStreamClientFactory = (
  request: IdentityFileStreamClientRequest,
) => IdentityFileLaneStreamClient;

export interface IdentityFileLaneAdapterSources {
  readonly identityId: string;
  readonly path: string;
  /**
   * The identity replica generation this attach is made under. Fixed for the
   * adapter's whole life - see the module doc.
   */
  readonly authorityEpoch: string;
  readonly streamClientFactory: IdentityFileStreamClientFactory;
  /**
   * What this client holds for THIS body, or `null` when it holds nothing.
   *
   * The guid must be taken off the `doc` event that seeded the replica and NEVER
   * derived from the path: a file deleted and recreated has a new guid under the
   * same path, so the path cannot answer "is my replica the same document as
   * yours".
   */
  readonly readDocSeed: () => AgentIdentityFileSeedOffer | null;
  readonly isDisposed: () => boolean;
}

export interface IdentityFileLaneAdapter
  extends LaneAdapter<DocReplicaEvent>, LaneRequester<IdentityFileLaneRequest> {
  /**
   * Close the socket and retire the current generation, keeping the host binding
   * so a later {@link openTransport} resumes decoding into the same consumer.
   *
   * Split from {@link openTransport} rather than offered as one `reconnect`
   * because the reseed path closes BEFORE it discards local state and opens
   * AFTER: the re-subscribe reads `readDocSeed`, and an offer taken before the
   * discard would name a replica this client has just thrown away.
   */
  closeTransport(): void;
  /**
   * Reopen under the epoch this adapter was BUILT with - never a re-read one.
   * `authorityEpoch` is fixed for the adapter's life (it is baked into the open
   * request), so a reopen that picked up a newer epoch would silently change
   * which generation this body belongs to.
   */
  openTransport(): void;
}

/**
 * The wire's closed reason code, in the seam's vocabulary.
 *
 * Both enums are CLOSED and this is a total mapping, so a code added by a future
 * minor is a compile error here rather than a body that silently renders the
 * wrong affordance - which is the reason neither side is free text.
 */
function unavailableCodeOf(
  code: AgentIdentityFileSubscribeUnavailableCode,
): DocUnavailableCode {
  switch (code) {
    case "staleAuthorityEpoch":
      return "stale-authority-epoch";
    case "fileNotFound":
      return "file-not-found";
    case "notAFragment":
      return "not-a-fragment";
    case "bodyUnavailable":
      return "body-unavailable";
  }
}

export function createIdentityFileLaneAdapter(
  sources: IdentityFileLaneAdapterSources,
): IdentityFileLaneAdapter {
  const {
    identityId,
    path,
    authorityEpoch,
    streamClientFactory,
    readDocSeed,
    isDisposed,
  } = sources;

  const descriptor: AdapterDescriptor = {
    laneId: identityFileLaneId(identityId, path),
    kind: "lane",
    label: `agentIdentity.file.subscribe@1.0 (body ${identityId}/${path})`,
  };

  const guard = createGenerationGuard();
  let host: AdapterHost<DocReplicaEvent> | null = null;
  let client: IdentityFileLaneStreamClient | null = null;
  /**
   * Whether the body is currently being served, so `doc-ready` marks a
   * TRANSITION rather than repeating on every frame. The seam's own wording -
   * "emitted on first observation and on every recovery transition" - is what
   * this boolean encodes.
   */
  let ready = false;
  /**
   * Set by a terminal `unavailable`. No later frame arrives on this subscription
   * and nothing may be sent on it; the consumer reattaches with a new adapter if
   * it still wants the body.
   */
  let finished = false;

  /**
   * The document id the seam's doc events are addressed by: the identity-root
   * relative path, which is this body's identity within its container exactly as
   * an artifact id is within an epic. The IDENTITY is not folded in, because the
   * adapter is already bound to one and a composite id would have to be parsed
   * apart by every consumer that wanted the path back. What distinguishes two
   * identities' files in one runtime is the LANE id, which does carry both.
   */
  const docId = path;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  function buildCallbacks(generation: number): IdentityFileStreamCallbacks {
    const emit = (event: DocReplicaEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onDoc: (frame: IdentityFileDocFrame, bytes: Uint8Array) => {
        if (!accepts(generation)) return;
        if (!ready) {
          ready = true;
          emit({
            kind: "doc-ready",
            authorityEpoch: frame.authorityEpoch,
            docId,
          });
        }
        emit({
          kind: "doc-snapshot",
          authorityEpoch: frame.authorityEpoch,
          docId,
          docGuid: frame.docGuid,
          update: bytes,
          hostStateVectorBase64: frame.stateVectorBase64,
          // LOAD-BEARING. `seededFromOffer` present means these bytes are a
          // DELTA against the offer this client sent, so they must be merged
          // into the very replica that produced it; installing them wholesale
          // would drop every byte the delta legitimately omitted. Absence means
          // a full seed, and every non-delta case - a cold attach, a guid that
          // did not match, an unparseable state vector, any host-side fallback -
          // is deliberately indistinguishable, because a full seed is always
          // safe to install.
          seed: frame.seededFromOffer === true ? "delta-against-offer" : "full",
        });
      },
      onDocUpdate: (frame: IdentityFileDocUpdateFrame, bytes: Uint8Array) => {
        // The guid rides the event and the REPLICA owns the drop: bytes naming a
        // guid it does not hold describe a document it does not have. Enforcing
        // that here would push a core replica invariant into every adapter,
        // where it would be enforced four times and eventually three.
        emit({
          kind: "doc-update",
          authorityEpoch: frame.authorityEpoch,
          docId,
          docGuid: frame.docGuid,
          update: bytes,
        });
      },
      onDocAck: (frame: IdentityFileDocAckFrame) => {
        emit({
          kind: "doc-coverage-ack",
          authorityEpoch: frame.authorityEpoch,
          docId,
          docGuid: frame.docGuid,
          coverageStateVectorBase64: frame.coverageStateVectorBase64,
        });
      },
      onAwareness: (frame: IdentityFileAwarenessFrame, bytes: Uint8Array) => {
        // Carries the epoch (addressing - a caret from a superseded replica is
        // dropped) but deliberately no guid: a caret is not document state, and
        // replaying one after a reseed would place a cursor from a document that
        // no longer exists.
        emit({
          kind: "doc-awareness",
          authorityEpoch: frame.authorityEpoch,
          docId,
          frame: bytes,
        });
      },
      onUnavailable: (frame: IdentityFileUnavailableFrame) => {
        if (!accepts(generation)) return;
        ready = false;
        if (frame.terminal) finished = true;
        emit({
          kind: "doc-unavailable",
          authorityEpoch: frame.authorityEpoch,
          docId,
          code: unavailableCodeOf(frame.code),
          terminal: frame.terminal,
          reason: frame.reason,
        });
        if (frame.code === "staleAuthorityEpoch") {
          // The epoch on the refusal, which is the one the host IS serving - the
          // same string the index lane folds for this transition, so a body
          // discovering it collapses with it instead of asking for a second
          // rebuild of the replica they just rebuilt.
          host?.requestReplacement(
            "authority-epoch-changed",
            authorityEpochTransition(frame.authorityEpoch),
          );
        }
      },
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        if (status !== "open") {
          // A body that is not connected is not being served, so the next `doc`
          // frame is a recovery transition and must re-announce readiness.
          // Without this the reattach after a reconnect would be silent, and a
          // consumer that tore its editor binding down on the drop would never
          // be told it may rebind.
          ready = false;
        }
        host?.reportStatus({
          connection: status,
          closeReason: status === "closed" ? reason : null,
        });
      },
    };
  }

  function openStreamClient(): void {
    const generation = guard.next();
    client = streamClientFactory({
      identityId,
      path,
      authorityEpoch,
      callbacks: buildCallbacks(generation),
      seedOfferProvider: readDocSeed,
    });
  }

  return {
    descriptor,

    attach(nextHost: AdapterHost<DocReplicaEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    /**
     * The doc class does not resume by position: a body's resume state is "which
     * document, and how much of it do I hold". Answering with a cursor would mean
     * inventing a meaningless position, which is precisely why `ResumeOffer` is a
     * union.
     */
    resumeOffer(): ResumeOffer {
      const seed = readDocSeed();
      if (seed === null) return null;
      const offer: DocSeedResumeOffer = {
        kind: "doc-seed",
        authorityEpoch,
        knownDocGuid: seed.knownDocGuid,
        stateVectorBase64: seed.stateVectorBase64,
      };
      return offer;
    },

    detach(_reason: AdapterDetachReason): void {
      guard.next();
      host = null;
      ready = false;
      closeStreamClient();
    },

    closeTransport(): void {
      guard.next();
      // `ready` is cleared for the same reason `detach` clears it: the body is no
      // longer being served, so the next `doc` frame is a RECOVERY transition and
      // has to re-announce readiness. Leaving it set would make the reattach
      // silent, and a consumer that tore its editor binding down on the close
      // would never be told it may rebind.
      ready = false;
      closeStreamClient();
    },

    openTransport(): void {
      openStreamClient();
    },

    send(request: IdentityFileLaneRequest): SendOutcome {
      if (finished) {
        return { kind: "dropped", reason: "lane-terminal" };
      }
      const active = client;
      if (active === null) {
        // No socket. The plane that handed this over has already decided whether
        // the bytes are retained (a body edit) or may be lost (awareness, which
        // is fire-and-forget and whose loss CRDT convergence absorbs), so there
        // is nothing to queue here.
        return { kind: "dropped", reason: "no-transport" };
      }
      switch (request.kind) {
        case "apply-update":
          active.applyUpdate(request.docGuid, request.update);
          break;
        case "awareness":
          active.awareness(request.frame);
          break;
      }
      return { kind: "sent" };
    },
  };
}
