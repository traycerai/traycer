/**
 * The wire-to-replica pin for `bodyDegraded`: a frame fired at the socket
 * ends as `bodyDegradedByArtifactId` in the published rooms projection.
 *
 * Every link is real except the socket: `ArtifactStreamClient` (built as the
 * composition builds it), the lane adapter and `createEpicArtifactBodyLanes`
 * inside it, the rooms replica and its room tier. The other degraded tests
 * start mid-chain - the replica test applies `room-body-degraded` itself, the
 * lane tests inject the client's callbacks - so a client that stopped
 * dispatching the frame (or a link that dropped the callback) would pass all
 * of them. This one fails if any link drops it.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ArtifactStreamClient } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ProjectionSink,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { artifactSubscribeServerFrameSchemaV12 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { createArtifactRoomTier } from "../artifact-room-tier";
import { createEpicArtifactBodyLanes } from "../epic-artifact-body-lanes";
import { createEpicRoomsReplica } from "../epic-rooms-replica";
import type { EpicRoomsProjection } from "../epic-runtime-projection";
import { EMPTY_ROOMS_PROJECTION } from "../epic-runtime-projection";
import type { EpicSessionFacts } from "../session-facts";
import { createRendererRuntimeEnvironment } from "../runtime-environment";

const EPOCH = "epoch-1";
const ARTIFACT = "artifact-a";

class StubStreamSession implements IStreamSession {
  private frameHandler: ServerFrameHandler | null = null;
  sendClientFrame(): void {}
  onServerFrame(handler: ServerFrameHandler): void {
    this.frameHandler = handler;
  }
  onStatusChange(_handler: StatusChangeHandler): void {}
  requestReconnect(): void {}
  getNegotiatedSchemaVersion() {
    return null;
  }
  close(): void {}
  fireServerFrame(
    envelope: StreamFrameEnvelope,
    binary: Uint8Array | null,
  ): void {
    this.frameHandler?.(envelope, binary);
  }
}

const environment: RuntimeEnvironment = {
  clock: { now: () => 0 },
  scheduler: {
    schedule: () => ({ cancel: () => {} }),
    scheduleMicrotask: (callback) => callback(),
  },
  logger: { debug: () => {}, warn: () => {}, error: () => {} },
};

const session: EpicSessionFacts = {
  transportStatus: () => "open",
  permissionRole: () => "owner",
  writeGateRole: () => "owner",
  isWritableRole: () => true,
  hasFreshRootSnapshotForOpenCycle: () => true,
  canSendBodyWrites: () => true,
  degradedReason: () => null,
};

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function docUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "hello");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function docFrame(): StreamFrameEnvelope {
  return artifactSubscribeServerFrameSchemaV12.parse({
    kind: "doc",
    authorityEpoch: EPOCH,
    artifactId: ARTIFACT,
    docGuid: "guid-1",
    stateVectorBase64: "AA==",
    hasBinaryPayload: true,
  });
}

function degradedFrame(): StreamFrameEnvelope {
  return artifactSubscribeServerFrameSchemaV12.parse({
    kind: "bodyDegraded",
    authorityEpoch: EPOCH,
    artifactId: ARTIFACT,
    reason: "room-unavailable",
    hasBinaryPayload: false,
  });
}

describe("bodyDegraded from the socket to the published rooms projection", () => {
  it("a bodyDegraded frame marks the artifact, and the next doc frame clears it", () => {
    let projection: EpicRoomsProjection = EMPTY_ROOMS_PROJECTION;
    let publishes = 0;
    const sink: ProjectionSink<EpicRoomsProjection> = {
      read: () => projection,
      publish: (next) => {
        projection = next;
        publishes += 1;
      },
      transact: (body) => body(),
      revision: () => publishes,
    };
    const tier = createArtifactRoomTier({
      environment,
      session,
      send: () => ({ kind: "sent" }),
      onDivergenceChanged: () => undefined,
      isDisposed: () => false,
      budget: null,
    });
    disposers.push(() => tier.dispose());
    // The lanes arm's identity: a body's room key is its artifact id.
    const replica = createEpicRoomsReplica({
      environment,
      session,
      tier,
      sink,
      publishDivergence: () => undefined,
      isDisposed: () => false,
      artifactIdsForRoom: (key) => [key],
    });
    const stub = new StubStreamSession();
    const lanes = createEpicArtifactBodyLanes({
      epicId: "epic-1",
      environment: createRendererRuntimeEnvironment(),
      streamClientFactory: ({
        epicId,
        artifactId,
        authorityEpoch,
        callbacks,
        seedOfferProvider,
      }) =>
        new ArtifactStreamClient({
          wsStreamClient: {
            subscribe: () => stub,
            subscribeWithParamsProvider: () => stub,
            getMethodSchemaVersion: () => null,
          },
          epicId,
          artifactId,
          authorityEpoch,
          callbacks,
          seedOfferProvider,
        }),
      readAuthorityEpoch: () => EPOCH,
      readDocSeed: () => null,
      isDisposed: () => false,
      onRoomEvent: (event) => replica.apply(event),
      onReplacementRequested: () => undefined,
      onLaneUnsupported: () => undefined,
    });
    disposers.push(() => lanes.detachAll("transport-only"));
    const degraded = () => ({
      ...projection.artifactRooms.bodyDegradedByArtifactId,
    });

    lanes.ensureAttached(ARTIFACT);
    stub.fireServerFrame(docFrame(), docUpdate());
    expect(degraded()).toEqual({});

    stub.fireServerFrame(degradedFrame(), null);
    expect(degraded()).toEqual({ [ARTIFACT]: "room-unavailable" });

    stub.fireServerFrame(docFrame(), docUpdate());
    expect(degraded()).toEqual({});
  });
});
