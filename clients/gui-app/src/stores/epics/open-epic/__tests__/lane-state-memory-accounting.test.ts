import { afterEach, describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicLaneSelectionSources } from "../runtime/epic-replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";
import {
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";

const EPIC_ID = "epic-lane-memory-accounting";
const AUTHORITY_EPOCH = "authority-epoch-1";
const ARTIFACT_ID = "artifact-retained-by-lane";

afterEach(() => {
  resetProcessMemoryRuntimeForTests();
});

function laneStateSnapshot() {
  const parsed = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: AUTHORITY_EPOCH,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords: [
      {
        kind: "spec",
        id: ARTIFACT_ID,
        folderName: "Retained lane artifact",
        title: "Retained lane artifact",
        createdAt: 1000,
        updatedAt: 1000,
        createdManually: false,
        parentId: null,
        revision: 1,
      },
    ],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title: "Lane memory accounting", updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function laneStatusSnapshot() {
  const parsed = epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: AUTHORITY_EPOCH,
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

function openLaneStore(): {
  readonly handle: OpenedStoreForTest;
  readonly openSnapshot: () => void;
} {
  let stateCallbacks: EpicStateStreamCallbacks | null = null;
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    stateCallbacks = callbacks;
    return { close: () => undefined };
  };
  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    statusCallbacks = callbacks;
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
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open in this lane test");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  return {
    handle,
    openSnapshot(): void {
      if (stateCallbacks === null || statusCallbacks === null) {
        throw new Error("the lane factories were not invoked");
      }
      statusCallbacks.onConnectionStatus("open", null);
      stateCallbacks.onConnectionStatus("open", null);
      statusCallbacks.onSnapshot(laneStatusSnapshot(), true);
      stateCallbacks.onSnapshot(laneStateSnapshot());
    },
  };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

function epicReplicaUsage(): {
  readonly settledBytes: number;
  readonly holderCount: number;
} {
  const plane = getProcessMemoryRuntime()
    .accountant.snapshot()
    .planes.find((item) => item.planeId === BUDGET_PLANE_IDS.epicReplicas);
  if (plane === undefined) {
    throw new Error("epic-replicas plane was not registered");
  }
  return { settledBytes: plane.settledBytes, holderCount: plane.holderCount };
}

describe("lane state replica memory accounting", () => {
  it("accounts retained state-lane data through the in-process worker bridge", async () => {
    const rig = openLaneStore();
    try {
      const baseline = epicReplicaUsage();
      rig.openSnapshot();
      await settle(rig.handle);

      expect(rig.handle.store.getState().artifacts.allIds).toContain(
        ARTIFACT_ID,
      );
      expect(
        getProcessMemoryRuntime().epicReplicas.projectionRowCounts().artifacts,
      ).toBeGreaterThan(0);

      const retained = epicReplicaUsage();
      // A populated lane snapshot must have an accounted main-thread holder.
      // On the broken path only the unrelated empty root Y.Doc is reported,
      // leaving the plane's bytes and holder count unchanged.
      expect(retained.settledBytes).toBeGreaterThan(baseline.settledBytes);
      expect(retained.holderCount).toBeGreaterThan(baseline.holderCount);
    } finally {
      rig.handle.dispose();
    }
  });
});
