/**
 * A replica REPLACEMENT on the lane arm must keep the projector bound to the
 * lane head, not the fresh (and forever empty) root `Y.Doc`.
 *
 * ## Why this suite exists
 *
 * `epic-records-replica.ts`'s `replaceReplica()` used to end with
 * `projector.attach(doc, projectorSink)` unconditionally. On the LANE arm the
 * projector is bound to the lane head instead (`attachLaneHead()` ->
 * `projector.attachLaneSources`), so every replica replacement -
 * `resetAllPlanes` on an authority-epoch change, `resetStateRecordsOnly` on a
 * `resumeTooOld` lead, `requestFreshSnapshot` - silently rebound the projector
 * onto the brand-new, forever-empty root doc. Every later `applyLaneState`
 * kept updating `laneSlices` correctly, but the projector was no longer
 * reading from it: the store showed ZERO artifacts for the rest of the
 * session (staging, 2026-09-04: a host restart minted a new replica identity
 * for one epic, the tab's next lead was `authorityEpochChanged`, the rows
 * landed in the lane replica, and the projection never read them).
 *
 * The fix tracks `attachedHead` (`"doc" | "lane" | null`) and, in
 * `replaceReplica()`, re-attaches whichever head was attached before the
 * replacement - the lane head via `attachLaneSources()` (with `laneSlices`
 * emptied first, so this replica does not depend on the arm's own reset
 * republishing them empty a step later) rather than always the doc head.
 *
 * This suite pins that the lane arm survives all three replacement paths
 * (authority-epoch change, resume-too-old, and one more that specifically
 * proves the row set is DISCARDED and refilled rather than merged).
 */
import { describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import type { EpicStatusSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStateSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type {
  EpicLaneSelectionSources,
  EpicLaneUnaries,
} from "../runtime/epic-replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

const EPIC_ID = "epic-lane-replacement-records";
const ARTIFACT_A_ID = "artifact-a";
const ARTIFACT_B_ID = "artifact-b";

/**
 * One `spec` artifact row on the records lane, in the shape
 * `epicArtifactRecordSchema` accepts: the persisted spec fields minus
 * `artifactRoomId` (omitted at the wire layer - a lane client has no use for
 * it), plus the wire-only `revision`.
 */
interface SpecArtifactRecordFixture {
  readonly kind: "spec";
  readonly id: string;
  readonly folderName: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdManually: boolean;
  readonly parentId: string | null;
  readonly revision: number;
}

function specArtifactRecord(
  id: string,
  title: string,
): SpecArtifactRecordFixture {
  return {
    kind: "spec",
    id,
    folderName: title,
    title,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId: null,
    revision: 1,
  };
}

interface LaneRigOptions {
  readonly unaries: EpicLaneUnaries;
}

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  readonly openLaneSockets: () => void;
  readonly deliverStatusSnapshot: (authorityEpoch: string) => void;
  readonly deliverStateSnapshot: (
    authorityEpoch: string,
    basis: "cold" | "resumeTooOld" | "authorityEpochChanged",
    position: number,
    artifactRecords: readonly SpecArtifactRecordFixture[],
  ) => void;
}

function statusSnapshot(authorityEpoch: string): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshot(
  authorityEpoch: string,
  basis: "cold" | "resumeTooOld" | "authorityEpochChanged",
  position: number,
  artifactRecords: readonly SpecArtifactRecordFixture[],
): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    basis,
    position,
    reconciledWithCloud: true,
    artifactRecords,
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title: "Lane epic", updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function openLaneRig(options: LaneRigOptions): LaneRig {
  // The LATEST callbacks only, exactly as the sibling authority-replacement
  // suite's rig: a factory call reassigns these, which is what matters for a
  // rig that drives a replacement mid-session.
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let stateCallbacks: EpicStateStreamCallbacks | null = null;

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    statusCallbacks = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    stateCallbacks = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });

  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => {},
    unaries: options.unaries,
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error(
          "the legacy stream must not open: this suite is the LANE arm",
        );
      },
      laneSelection,
    },
    writeCommand: null,
  });

  function openLaneSockets(): void {
    if (statusCallbacks === null || stateCallbacks === null) {
      throw new Error("the lane factories were not invoked");
    }
    statusCallbacks.onConnectionStatus("open", null);
    stateCallbacks.onConnectionStatus("open", null);
  }

  function deliverStatusSnapshot(authorityEpoch: string): void {
    if (statusCallbacks === null) {
      throw new Error("the status lane factory was not invoked");
    }
    statusCallbacks.onSnapshot(statusSnapshot(authorityEpoch));
  }

  function deliverStateSnapshot(
    authorityEpoch: string,
    basis: "cold" | "resumeTooOld" | "authorityEpochChanged",
    position: number,
    artifactRecords: readonly SpecArtifactRecordFixture[],
  ): void {
    if (stateCallbacks === null) {
      throw new Error("the state lane factory was not invoked");
    }
    stateCallbacks.onSnapshot(
      stateSnapshot(authorityEpoch, basis, position, artifactRecords),
    );
  }

  return {
    handle,
    openLaneSockets,
    deliverStatusSnapshot,
    deliverStateSnapshot,
  };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

describe("a lane-arm replica replacement keeps the records projection bound to the lane head", () => {
  it("an authority-epoch replacement keeps the artifact - before the fix the store held zero artifacts", async () => {
    const rig = openLaneRig({ unaries: absentLaneUnaries() });
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1, [
      specArtifactRecord(ARTIFACT_A_ID, "Spec A"),
    ]);
    await settle(rig.handle);

    const opened = rig.handle.store.getState();
    expect(opened.artifacts.allIds).toContain(ARTIFACT_A_ID);
    expect(opened.artifacts.byId[ARTIFACT_A_ID]?.title).toBe("Spec A");

    // The replacement: NO transport event, only the two lanes' next
    // snapshots at the new epoch - exactly as the sibling
    // authority-replacement suite drives it. The status snapshot's
    // `foldAuthorityEpoch` is what actually fires `resetAllPlanes` /
    // `replaceReplica()`; the state snapshot's own replacement request
    // coalesces into the same one because both name the same transition.
    rig.deliverStatusSnapshot("authority-epoch-2");
    rig.deliverStateSnapshot("authority-epoch-2", "authorityEpochChanged", 1, [
      specArtifactRecord(ARTIFACT_A_ID, "Spec A"),
    ]);
    await settle(rig.handle);

    // THE REDDENING ASSERTION. Before the fix, `replaceReplica()` always
    // ended with `projector.attach(doc, projectorSink)`, silently rebinding
    // the projector onto the brand-new, forever-empty root `Y.Doc`. Every
    // later `applyLaneState` kept `laneSlices` correct, but the projector
    // was reading from the empty doc instead - the store held zero
    // artifacts for the rest of the session.
    const replaced = rig.handle.store.getState();
    expect(replaced.snapshotLoaded).toBe(true);
    expect(replaced.artifacts.allIds).toContain(ARTIFACT_A_ID);
    expect(replaced.artifacts.byId[ARTIFACT_A_ID]?.title).toBe("Spec A");
    expect(replaced.tree.nodeById[ARTIFACT_A_ID]).toBeDefined();

    rig.handle.dispose();
  });

  it("a resume-too-old lead keeps the artifact - the other replaceReplica() caller", async () => {
    const rig = openLaneRig({ unaries: absentLaneUnaries() });
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1, [
      specArtifactRecord(ARTIFACT_A_ID, "Spec A"),
    ]);
    await settle(rig.handle);

    expect(rig.handle.store.getState().artifacts.allIds).toContain(
      ARTIFACT_A_ID,
    );

    // `resumeTooOld` routes through `resetStateRecordsOnly`, which calls the
    // SAME `records.replaceReplica()` the authority-epoch path does - this is
    // the second of `replaceReplica()`'s two callers, and the bug lived in
    // the function both share.
    rig.deliverStateSnapshot("authority-epoch-1", "resumeTooOld", 2, [
      specArtifactRecord(ARTIFACT_A_ID, "Spec A"),
    ]);
    await settle(rig.handle);

    const resumed = rig.handle.store.getState();
    expect(resumed.snapshotLoaded).toBe(true);
    expect(resumed.artifacts.allIds).toContain(ARTIFACT_A_ID);
    expect(resumed.artifacts.byId[ARTIFACT_A_ID]?.title).toBe("Spec A");

    rig.handle.dispose();
  });

  it("a replacement DISCARDS the old row set rather than merging it", async () => {
    const rig = openLaneRig({ unaries: absentLaneUnaries() });
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1, [
      specArtifactRecord(ARTIFACT_A_ID, "Spec A"),
    ]);
    await settle(rig.handle);

    expect(rig.handle.store.getState().artifacts.allIds).toContain(
      ARTIFACT_A_ID,
    );

    // The replacement snapshot carries ONLY artifact B - proving both halves
    // of the empty-then-refill path: the old row is gone (the replica really
    // was emptied, not left stale) AND the new row is there (the projector is
    // still bound to whatever `laneSlices` holds, not stuck reading nothing).
    rig.deliverStatusSnapshot("authority-epoch-2");
    rig.deliverStateSnapshot("authority-epoch-2", "authorityEpochChanged", 1, [
      specArtifactRecord(ARTIFACT_B_ID, "Spec B"),
    ]);
    await settle(rig.handle);

    const replaced = rig.handle.store.getState();
    expect(replaced.artifacts.allIds).toContain(ARTIFACT_B_ID);
    expect(replaced.artifacts.byId[ARTIFACT_B_ID]?.title).toBe("Spec B");
    expect(replaced.artifacts.allIds).not.toContain(ARTIFACT_A_ID);
    expect(replaced.artifacts.byId[ARTIFACT_A_ID]).toBeUndefined();

    rig.handle.dispose();
  });
});
