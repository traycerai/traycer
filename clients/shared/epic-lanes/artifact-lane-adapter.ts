/**
 * The `artifact.subscribe@1.0` adapter - ONE artifact body, bidirectionally
 * synced, attached per open tile and detached with it.
 *
 * The only lane that carries bytes, and the only adapter here that also
 * implements `LaneRequester`: bodies are the one genuinely CRDT-shaped thing in
 * an epic, so writes go back up this lane rather than through a unary.
 *
 * ## Translating the `@1` tri-state into epoch-addressed doc events
 *
 * `epic.subscribe@1` reported a room's availability as ONE value out of three -
 * `ready | unavailable | retrying` - emitted on first observation and on every
 * transition, and the projection stored exactly that value. That was the right
 * shape for `@1`, which has no epoch and no doc identity to address an event
 * with. The lanes do, so the seam models the same fact as two events, and this
 * adapter is where the translation lives:
 *
 * | `@1` value      | Lane event                                     |
 * | --------------- | ---------------------------------------------- |
 * | `"ready"`       | `doc-ready`                                    |
 * | `"retrying"`    | `doc-unavailable` with `terminal: false`       |
 * | `"unavailable"` | `doc-unavailable` with `terminal: true`        |
 *
 * `terminal` is its own boolean rather than derived from the `code`, because
 * `bodyUnavailable` is genuinely both - a room that is retrying and a room that
 * has given up - and folding them would force the host to pick a lie for one of
 * the two. That is exactly the distinction `"retrying"` carried on `@1`.
 *
 * `doc-ready` is emitted on the transition INTO ready, independently of whether
 * any bytes have arrived, so "ready with no snapshot" stays a reachable,
 * distinguishable state. A consumer that treated ready-but-unseeded as an empty
 * document would render a blank editor and export an empty file over real
 * content.
 *
 * ## A stale epoch is not an availability state
 *
 * `unavailable / staleAuthorityEpoch` is the one code that is a statement about
 * the EPIC rather than about this body: the client's whole epic view is void.
 * So the adapter both emits the doc event (the tile has to stop claiming to
 * show a live body) and asks the runtime to replace the replica. Rendering it
 * as a merely-unavailable body would leave the epic silently stale, which is
 * the failure the seam's own doc on that code calls out.
 *
 * The adapter never re-attaches itself under a new epoch. An attach is bound to
 * one `authorityEpoch` for life - that is the open request's contract - so the
 * recovery is a NEW adapter, built by the composition once the records lane has
 * reported the epoch the host is actually serving. An adapter that
 * re-parameterised itself would convert a refusal into a successful attach
 * against a different replica, which is the history splice the epoch exists to
 * prevent.
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
import { createGenerationGuard } from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactAwarenessFrame,
  ArtifactDocAckFrame,
  ArtifactDocFrame,
  ArtifactDocUpdateFrame,
  ArtifactStreamCallbacks,
  ArtifactUnavailableFrame,
} from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  ArtifactSubscribeSeedOffer,
  ArtifactSubscribeUnavailableCode,
} from "@traycer/protocol/host/epic/artifact-subscribe";
import { artifactLaneId, type ArtifactLaneRequest } from "./lane-events";

/** The subset of the body lane's stream client this adapter drives. */
export interface ArtifactLaneStreamClient {
  applyUpdate(docGuid: string, updateBytes: Uint8Array): void;
  awareness(awarenessBytes: Uint8Array): void;
  close(): void;
}

export type ArtifactStreamClientFactory = (
  epicId: string,
  artifactId: string,
  authorityEpoch: string,
  callbacks: ArtifactStreamCallbacks,
  /**
   * The body state this client already holds, re-read before every wire
   * subscribe. Pure and synchronous by contract.
   */
  seedOfferProvider: () => ArtifactSubscribeSeedOffer | null,
) => ArtifactLaneStreamClient;

export interface ArtifactLaneAdapterSources {
  readonly epicId: string;
  readonly artifactId: string;
  /**
   * The epic replica generation this attach is made under. Fixed for the
   * adapter's whole life - see the module doc.
   */
  readonly authorityEpoch: string;
  readonly streamClientFactory: ArtifactStreamClientFactory;
  /**
   * What this client holds for THIS body, or `null` when it holds nothing.
   *
   * The guid must be taken off the `doc` event that seeded the replica and
   * NEVER derived from the artifact id: a body deleted and recreated has a new
   * guid under the same id, so the id cannot answer "is my replica the same
   * document as yours".
   */
  readonly readDocSeed: () => ArtifactSubscribeSeedOffer | null;
  readonly isDisposed: () => boolean;
}

export interface ArtifactLaneAdapter
  extends LaneAdapter<DocReplicaEvent>, LaneRequester<ArtifactLaneRequest> {
  /**
   * Close the socket and retire the current generation, keeping the host
   * binding so a later {@link openTransport} resumes decoding into the same
   * consumer.
   *
   * The same retained-handle pair the state and status lanes carry, and it is
   * needed here for the same reason: a window that detaches its transport
   * (a retained-dirty buffer that must stop dialling a host the window has
   * left) has to stop every lane it holds, and a body lane is one of them. An
   * adapter without this pair can only be torn down by `detach`, which drops
   * the host binding - so every reopen would have to rebuild the adapter, and
   * a body rebuilt that way would attach under a FRESHLY READ epoch rather
   * than the one it was serving.
   *
   * Split from {@link openTransport} rather than offered as one `reconnect`
   * because the reseed path closes BEFORE it discards local state and opens
   * AFTER: the re-subscribe reads `readDocSeed`, and an offer taken before the
   * discard would name a replica this client has just thrown away.
   */
  closeTransport(): void;
  /**
   * Reopen under the epoch this adapter was BUILT with - never a re-read one.
   * `authorityEpoch` is fixed for the adapter's life (it is baked into the
   * open request), so a reopen that picked up a newer epoch would silently
   * change which generation this body belongs to.
   */
  openTransport(): void;
}

/**
 * The wire's closed reason code, in the seam's vocabulary.
 *
 * Both enums are CLOSED and this is a total mapping, so a code added by a
 * future minor is a compile error here rather than a body that silently renders
 * the wrong affordance - which is the reason neither side is free text.
 */
function unavailableCodeOf(
  code: ArtifactSubscribeUnavailableCode,
): DocUnavailableCode {
  switch (code) {
    case "staleAuthorityEpoch":
      return "stale-authority-epoch";
    case "artifactNotFound":
      return "artifact-not-found";
    case "bodyUnavailable":
      return "body-unavailable";
  }
}

export function createArtifactLaneAdapter(
  sources: ArtifactLaneAdapterSources,
): ArtifactLaneAdapter {
  const {
    epicId,
    artifactId,
    authorityEpoch,
    streamClientFactory,
    readDocSeed,
    isDisposed,
  } = sources;

  const descriptor: AdapterDescriptor = {
    laneId: artifactLaneId(artifactId),
    kind: "lane",
    label: `artifact.subscribe@1.0 (body ${artifactId})`,
  };

  const guard = createGenerationGuard();
  let host: AdapterHost<DocReplicaEvent> | null = null;
  let client: ArtifactLaneStreamClient | null = null;
  /**
   * Whether the body is currently being served, so `doc-ready` marks a
   * TRANSITION rather than repeating on every frame. The seam's own wording -
   * "emitted on first observation and on every recovery transition" - is what
   * this boolean encodes.
   */
  let ready = false;
  /**
   * Set by a terminal `unavailable`. No later frame arrives on this
   * subscription and nothing may be sent on it; the consumer reattaches with a
   * new adapter if it still wants the body.
   */
  let finished = false;

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

  function buildCallbacks(generation: number): ArtifactStreamCallbacks {
    const emit = (event: DocReplicaEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onDoc: (frame: ArtifactDocFrame, bytes: Uint8Array) => {
        if (!accepts(generation)) return;
        if (!ready) {
          ready = true;
          emit({
            kind: "doc-ready",
            authorityEpoch: frame.authorityEpoch,
            docId: artifactId,
          });
        }
        emit({
          kind: "doc-snapshot",
          authorityEpoch: frame.authorityEpoch,
          docId: artifactId,
          docGuid: frame.docGuid,
          update: bytes,
          hostStateVectorBase64: frame.stateVectorBase64,
          // LOAD-BEARING. `seededFromOffer` present means these bytes are a
          // DELTA against the offer this client sent, so they must be merged
          // into the very replica that produced it; installing them wholesale
          // would drop every byte the delta legitimately omitted. Absence means
          // a full seed, and every non-delta case - a cold attach, a guid that
          // did not match, an unparseable state vector, any host-side fallback
          // - is deliberately indistinguishable, because a full seed is always
          // safe to install.
          seed: frame.seededFromOffer === true ? "delta-against-offer" : "full",
        });
      },
      onDocUpdate: (frame: ArtifactDocUpdateFrame, bytes: Uint8Array) => {
        // The guid rides the event and the REPLICA owns the drop: bytes naming
        // a guid it does not hold describe a document it does not have.
        // Enforcing that here would push a core replica invariant into every
        // adapter, where it would be enforced three times and eventually twice.
        emit({
          kind: "doc-update",
          authorityEpoch: frame.authorityEpoch,
          docId: artifactId,
          docGuid: frame.docGuid,
          update: bytes,
        });
      },
      onDocAck: (frame: ArtifactDocAckFrame) => {
        emit({
          kind: "doc-coverage-ack",
          authorityEpoch: frame.authorityEpoch,
          docId: artifactId,
          docGuid: frame.docGuid,
          coverageStateVectorBase64: frame.coverageStateVectorBase64,
        });
      },
      onAwareness: (frame: ArtifactAwarenessFrame, bytes: Uint8Array) => {
        // Carries the epoch (addressing - a caret from a superseded replica is
        // dropped) but deliberately no guid: a caret is not document state, and
        // replaying one after a reseed would place a cursor from a document
        // that no longer exists.
        emit({
          kind: "doc-awareness",
          authorityEpoch: frame.authorityEpoch,
          docId: artifactId,
          frame: bytes,
        });
      },
      onUnavailable: (frame: ArtifactUnavailableFrame) => {
        if (!accepts(generation)) return;
        ready = false;
        if (frame.terminal) finished = true;
        emit({
          kind: "doc-unavailable",
          authorityEpoch: frame.authorityEpoch,
          docId: artifactId,
          code: unavailableCodeOf(frame.code),
          terminal: frame.terminal,
          reason: frame.reason,
        });
        if (frame.code === "staleAuthorityEpoch") {
          host?.requestReplacement("authority-epoch-changed");
        }
      },
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        if (status !== "open") {
          // A body that is not connected is not being served, so the next
          // `doc` frame is a recovery transition and must re-announce
          // readiness. Without this the reattach after a reconnect would be
          // silent, and a consumer that tore its editor binding down on the
          // drop would never be told it may rebind.
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
    client = streamClientFactory(
      epicId,
      artifactId,
      authorityEpoch,
      buildCallbacks(generation),
      readDocSeed,
    );
  }

  return {
    descriptor,

    attach(nextHost: AdapterHost<DocReplicaEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    /**
     * The doc class does not resume by position: a body's resume state is
     * "which document, and how much of it do I hold". Answering with a cursor
     * would mean inventing a meaningless position, which is precisely why
     * `ResumeOffer` is a union.
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
      // `ready` is cleared for the same reason `detach` clears it: the body is
      // no longer being served, so the next `doc` frame is a RECOVERY
      // transition and has to re-announce readiness. Leaving it set would make
      // the reattach silent, and a consumer that tore its editor binding down
      // on the close would never be told it may rebind.
      ready = false;
      closeStreamClient();
    },

    openTransport(): void {
      openStreamClient();
    },

    send(request: ArtifactLaneRequest): SendOutcome {
      if (finished) {
        return { kind: "dropped", reason: "lane-terminal" };
      }
      const active = client;
      if (active === null) {
        // No socket. The plane that handed this over has already decided
        // whether the bytes are retained (a body edit) or may be lost
        // (awareness, which is fire-and-forget and whose loss CRDT convergence
        // absorbs), so there is nothing to queue here.
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
