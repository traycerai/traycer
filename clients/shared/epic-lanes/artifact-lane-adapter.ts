/**
 * One artifact body, bidirectional. `terminal` is its own boolean, not derived from code. `doc-ready` fires on the transition into ready, even with no bytes.
 * Stale epoch is an epic-wide void, not a body-unavailable. An adapter is bound to one authorityEpoch for life; recovery is a new adapter.
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

export interface ArtifactLaneStreamClient {
  applyUpdate(docGuid: string, updateBytes: Uint8Array): void;
  awareness(awarenessBytes: Uint8Array): void;
  close(): void;
}

export interface ArtifactStreamClientRequest {
  readonly epicId: string;
  readonly artifactId: string;
  readonly authorityEpoch: string;
  readonly callbacks: ArtifactStreamCallbacks;
  /** Body state already held; re-read before every subscribe. Pure and synchronous. */
  readonly seedOfferProvider: () => ArtifactSubscribeSeedOffer | null;
}

export type ArtifactStreamClientFactory = (
  request: ArtifactStreamClientRequest,
) => ArtifactLaneStreamClient;

export interface ArtifactLaneAdapterSources {
  readonly epicId: string;
  readonly artifactId: string;
  /** Fixed for the adapter's life. */
  readonly authorityEpoch: string;
  readonly streamClientFactory: ArtifactStreamClientFactory;
  /** Guid comes from the seeding doc event, never from the artifact id; delete+recreate gets a new guid. */
  readonly readDocSeed: () => ArtifactSubscribeSeedOffer | null;
  readonly isDisposed: () => boolean;
}

export interface ArtifactLaneAdapter
  extends LaneAdapter<DocReplicaEvent>, LaneRequester<ArtifactLaneRequest> {
  /** Close the socket and keep the host binding. Close before discard and open after so readDocSeed does not name discarded state. */
  closeTransport(): void;
  /** Reopen under the epoch this adapter was built with, never a re-read one. */
  openTransport(): void;
}

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
  /** Tracks served-ness so doc-ready marks a transition rather than repeating. */
  let ready = false;
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
          // seededFromOffer means merge these bytes; absence is a full seed and is always safe to install.
          seed: frame.seededFromOffer === true ? "delta-against-offer" : "full",
        });
      },
      onDocUpdate: (frame: ArtifactDocUpdateFrame, bytes: Uint8Array) => {
        // Guid rides the event; the replica owns the drop.
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
        // Epoch addressing only; no guid. A caret is not document state.
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
          // Epoch the host is serving; fold with state/status so a body does not request a second rebuild.
          host?.requestReplacement(
            "authority-epoch-changed",
            authorityEpochTransition(frame.authorityEpoch),
          );
        }
      },
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        if (status !== "open") {
          // Not connected is not served; the next doc frame must re-announce readiness.
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
      epicId,
      artifactId,
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

    /** Bodies resume by document identity and held bytes, not by a cursor position. */
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
      // Clear ready on close so the next doc frame is a recovery transition.
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
        // No socket. Awareness loss is absorbed by CRDT convergence; do not queue here.
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
