import { describe, expect, it } from "vitest";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import {
  EpicStatusStreamClient,
  type EpicStatusSnapshotFrame,
  type EpicStatusTransitionFrame,
} from "../epic-status-stream-client";

describe("EpicStatusStreamClient artifact sync", () => {
  it("preserves artifact sync when decoding snapshot and status frames", () => {
    const transport = new FakeStreamClient(true);
    const snapshots: EpicStatusSnapshotFrame[] = [];
    const transitions: EpicStatusTransitionFrame[] = [];
    new EpicStatusStreamClient({
      wsStreamClient: transport,
      epicId: "epic-1",
      callbacks: {
        onSnapshot: (frame) => snapshots.push(frame),
        onTransition: (frame) => transitions.push(frame),
        onConnectionStatus: () => {},
      },
    });
    const session = transport.sessions[0];
    if (session === undefined) throw new Error("nothing subscribed");
    const artifactSync = { rooms: "retrying", waitingNewArtifacts: 1 } as const;
    session.emit(
      {
        kind: "snapshot",
        authorityEpoch: "epoch",
        securityEpoch: 0,
        permissionRole: null,
        cloudSyncStatus: "connected",
        dirty: false,
        migration: null,
        deletion: { state: "none" },
        artifactSync,
        hasBinaryPayload: false,
      },
      null,
    );
    session.emit(
      {
        kind: "cloudSyncStatus",
        authorityEpoch: "epoch",
        status: "connected",
        artifactSync,
        hasBinaryPayload: false,
      },
      null,
    );
    expect(snapshots[0]?.artifactSync).toEqual(artifactSync);
    const transition = transitions[0];
    if (transition?.kind !== "cloudSyncStatus")
      throw new Error("missing status transition");
    expect(transition.artifactSync).toEqual(artifactSync);
  });
});
