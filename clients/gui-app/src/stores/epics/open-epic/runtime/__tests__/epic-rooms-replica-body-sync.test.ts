/**
 * The rooms replica's `bodySyncingByArtifactId` slice (O3): `room-body-sync`
 * marks a READY room's artifacts as syncing, and every path that forgets the
 * served body forgets the mark with it.
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

function bodySync(state: "syncing" | "synced", roomId: string): EpicRoomEvent {
  return { kind: "room-body-sync", artifactRoomId: roomId, state };
}

describe("rooms replica bodySyncingByArtifactId", () => {
  it("syncing on a ready room marks every artifact of the room; synced removes them", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    expect(syncing()).toEqual([ARTIFACT_A, ARTIFACT_B]);
    replica.apply(bodySync("synced", ROOM));
    expect(syncing()).toEqual([]);
  });

  it("a snapshot clears it: the host re-states the state after each seed", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    replica.apply(snapshotEvent(ROOM));
    expect(syncing()).toEqual([]);
  });

  it("a non-ready availability clears it", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    replica.apply({
      kind: "room-availability",
      artifactRoomId: ROOM,
      availability: "retrying",
    });
    expect(syncing()).toEqual([]);
  });

  it("reset clears it", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    replica.reset({ origin: "authority", reason: "authority-epoch-changed" });
    expect(syncing()).toEqual([]);
  });

  it("dropAllOnViewerDowngrade clears it, and a later republish does not bring it back", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    expect(replica.dropAllOnViewerDowngrade()).toBe(true);
    expect(syncing()).toEqual([]);
    replica.republishAvailability();
    expect(syncing()).toEqual([]);
  });

  it("is ignored for a room that is not ready", () => {
    const { replica, syncing } = readyRoom();
    replica.apply(bodySync("syncing", OTHER_ROOM));
    expect(syncing()).toEqual([]);
    replica.apply({
      kind: "room-availability",
      artifactRoomId: ROOM,
      availability: "retrying",
    });
    replica.apply(bodySync("syncing", ROOM));
    expect(syncing()).toEqual([]);
  });

  it("a repeat of the state already shown does not publish", () => {
    const { replica, publishes } = readyRoom();
    replica.apply(bodySync("syncing", ROOM));
    const afterFirst = publishes();
    replica.apply(bodySync("syncing", ROOM));
    expect(publishes()).toBe(afterFirst);
    replica.apply(bodySync("synced", ROOM));
    const afterSynced = publishes();
    expect(afterSynced).toBeGreaterThan(afterFirst);
    replica.apply(bodySync("synced", ROOM));
    expect(publishes()).toBe(afterSynced);
  });
});
