/**
 * The rooms replica's `bodyDegradedByArtifactId` slice: `room-body-degraded`
 * marks a READY room's artifacts with the host's reason, and every path that
 * forgets or re-states the served body forgets the mark with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type {
  ProjectionSink,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { createArtifactRoomTier } from "../artifact-room-tier";
import { createEpicRoomsReplica } from "../epic-rooms-replica";
import type { EpicRoomsProjection } from "../epic-runtime-projection";
import { EMPTY_ROOMS_PROJECTION } from "../epic-runtime-projection";
import type { EpicSessionFacts } from "../session-facts";
import type { EpicRoomEvent } from "../epic-runtime-events";
import { encodeDocStateVectorBase64 } from "../dirty-watermark";

const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const ARTIFACT_A = "artifact-a";
const ARTIFACT_B = "artifact-b";

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

function snapshotEvent(roomId: string): EpicRoomEvent {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "hello");
  const update = Y.encodeStateAsUpdate(doc);
  const hostStateVectorBase64 = encodeDocStateVectorBase64(doc);
  doc.destroy();
  return {
    kind: "room-snapshot",
    artifactRoomId: roomId,
    update,
    hostStateVectorBase64,
    seed: "full",
    docGuid: null,
  };
}

function makeReplica() {
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
  const replica = createEpicRoomsReplica({
    environment,
    session,
    tier,
    sink,
    publishDivergence: () => undefined,
    isDisposed: () => false,
    artifactIdsForRoom: (roomId) =>
      roomId === ROOM ? [ARTIFACT_A, ARTIFACT_B] : [],
  });
  return {
    replica,
    degraded: () => ({ ...projection.artifactRooms.bodyDegradedByArtifactId }),
    syncing: () =>
      Object.keys(projection.artifactRooms.bodySyncingByArtifactId).sort(),
    publishes: () => publishes,
    dispose: () => tier.dispose(),
  };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function readyRoom() {
  const harness = makeReplica();
  disposers.push(harness.dispose);
  harness.replica.apply(snapshotEvent(ROOM));
  return harness;
}

function bodyDegraded(
  reason: "room-unavailable" | "baseline-unavailable",
  roomId: string,
): EpicRoomEvent {
  return { kind: "room-body-degraded", artifactRoomId: roomId, reason };
}

function bodySync(state: "syncing" | "synced", roomId: string): EpicRoomEvent {
  return { kind: "room-body-sync", artifactRoomId: roomId, state };
}

describe("rooms replica bodyDegradedByArtifactId", () => {
  it("marks every artifact of a ready room with the reason, and a later reason replaces it", () => {
    const { replica, degraded } = readyRoom();
    replica.apply(bodyDegraded("room-unavailable", ROOM));
    expect(degraded()).toEqual({
      [ARTIFACT_A]: "room-unavailable",
      [ARTIFACT_B]: "room-unavailable",
    });
    replica.apply(bodyDegraded("baseline-unavailable", ROOM));
    expect(degraded()).toEqual({
      [ARTIFACT_A]: "baseline-unavailable",
      [ARTIFACT_B]: "baseline-unavailable",
    });
  });

  it("is ignored for a room that is not ready", () => {
    const { replica, degraded } = readyRoom();
    replica.apply(bodyDegraded("room-unavailable", OTHER_ROOM));
    expect(degraded()).toEqual({});
    replica.apply({
      kind: "room-availability",
      artifactRoomId: ROOM,
      availability: "retrying",
    });
    replica.apply(bodyDegraded("room-unavailable", ROOM));
    expect(degraded()).toEqual({});
  });

  it("a snapshot clears it", () => {
    const { replica, degraded } = readyRoom();
    replica.apply(bodyDegraded("room-unavailable", ROOM));
    replica.apply(snapshotEvent(ROOM));
    expect(degraded()).toEqual({});
  });

  it("a non-ready availability clears it", () => {
    const { replica, degraded } = readyRoom();
    replica.apply(bodyDegraded("baseline-unavailable", ROOM));
    replica.apply({
      kind: "room-availability",
      artifactRoomId: ROOM,
      availability: "retrying",
    });
    expect(degraded()).toEqual({});
  });

  it.each(["syncing", "synced"] as const)(
    "a room-body-sync of %s clears it",
    (state) => {
      const { replica, degraded } = readyRoom();
      replica.apply(bodyDegraded("room-unavailable", ROOM));
      replica.apply(bodySync(state, ROOM));
      expect(degraded()).toEqual({});
    },
  );

  it("reset and viewer downgrade clear it, and a republish does not bring it back", () => {
    const first = readyRoom();
    first.replica.apply(bodyDegraded("room-unavailable", ROOM));
    first.replica.reset({
      origin: "authority",
      reason: "authority-epoch-changed",
    });
    expect(first.degraded()).toEqual({});

    const second = readyRoom();
    second.replica.apply(bodyDegraded("room-unavailable", ROOM));
    expect(second.replica.dropAllOnViewerDowngrade()).toBe(true);
    expect(second.degraded()).toEqual({});
    second.replica.republishAvailability();
    expect(second.degraded()).toEqual({});
  });
});
