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
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicMigrationStatus } from "@traycer/protocol/host/epic/status-subscribe";
import type {
  EpicLaneSelectionSources,
  EpicLaneUnaries,
} from "../runtime/epic-replica-runtime";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

const EPIC_ID = "epic-lane-open-cycle";
const EPOCH = "authority-epoch-1";
const ANSWERING_HOST = "host-that-answered";

interface LaneRigOptions {
  /** The two lane unaries. */
  readonly unaries: EpicLaneUnaries;
  /** What the status snapshot says about a major migration. */
  readonly migration: EpicMigrationStatus | null;
}

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  readonly received: { commandId: string; intent: EpicWriteCommandIntent }[];
  readonly openLanes: () => void;
  /**
   * A transport drop and return on the CONTROL lane - the policy's named `reconnect` trigger. Only a
   * return to `open` after the transport had left it counts, so both halves are driven.
   */
  readonly reconnectControlLane: () => void;
  /**
   * A transport drop and return on the RECORDS lane ALONE - the `ownsControlCycle: false` half of
   * the same event, never touching the status lane.
   */
  readonly reconnectStateLane: () => void;
  /**
   * A `migrationProgress` transition on the status lane - the host reporting on a migration it has
   * actually taken up.
   */
  readonly emitMigrationProgress: (progress: {
    readonly phase: "prepare" | "upload" | "finalize";
    readonly chunksDone: number;
    readonly chunksTotal: number;
  }) => void;
}

function statusSnapshot(
  migration: EpicMigrationStatus | null,
): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    securityEpoch: 1,
    // EDITOR: the write gate has a permission arm as well as a freshness arm, and this suite is about
    // the freshness arm.
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshot(): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords: [],
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
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let stateCallbacks: EpicStateStreamCallbacks | null = null;
  const received: { commandId: string; intent: EpicWriteCommandIntent }[] = [];

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
    // Declared support rather than the probe's outcome: this suite is about what the lane arm DOES
    // once installed, not about how it gets chosen - `lane-adapter-probe.test.ts` owns that question.
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
    // Recording rather than dispatching, exactly as the legacy delivery suite does: the question is
    // whether the command arrives, not what the dispatcher maps it to.
    writeCommand: (commandId, intent) => {
      received.push({ commandId, intent });
      return Promise.resolve({ hostId: ANSWERING_HOST });
    },
  });

  function openLanes(): void {
    if (statusCallbacks === null || stateCallbacks === null) {
      throw new Error("the lane factories were not invoked");
    }
    // Transport BEFORE the snapshots, for the reason the legacy delivery suite documents: the control
    // replica clears the open-cycle freshness on every transport-status transition, so opening
    statusCallbacks.onConnectionStatus("open", null);
    stateCallbacks.onConnectionStatus("open", null);
    statusCallbacks.onSnapshot(statusSnapshot(options.migration));
    stateCallbacks.onSnapshot(stateSnapshot());
  }

  function reconnectControlLane(): void {
    if (statusCallbacks === null) {
      throw new Error("the status lane factory was not invoked");
    }
    statusCallbacks.onConnectionStatus("reconnecting", null);
    statusCallbacks.onConnectionStatus("open", null);
  }

  function reconnectStateLane(): void {
    if (stateCallbacks === null) {
      throw new Error("the state lane factory was not invoked");
    }
    stateCallbacks.onConnectionStatus("reconnecting", null);
    stateCallbacks.onConnectionStatus("open", null);
  }

  function emitMigrationProgress(progress: {
    readonly phase: "prepare" | "upload" | "finalize";
    readonly chunksDone: number;
    readonly chunksTotal: number;
  }): void {
    if (statusCallbacks === null) {
      throw new Error("the status lane factory was not invoked");
    }
    const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
      kind: "migrationProgress",
      hasBinaryPayload: false,
      authorityEpoch: EPOCH,
      securityEpoch: 1,
      ...progress,
    });
    // Narrowed POSITIVELY. Excluding `snapshot` still leaves `ping`/`pong`,
    // which the parsed union carries and `onTransition` does not accept.
    if (parsed.kind !== "migrationProgress") {
      throw new Error(`expected a migrationProgress frame, got ${parsed.kind}`);
    }
    statusCallbacks.onTransition(parsed);
  }

  return {
    handle,
    received,
    openLanes,
    reconnectControlLane,
    reconnectStateLane,
    emitMigrationProgress,
  };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

describe("a lane-selected session completes an open cycle", () => {
  it("reports the lead snapshot as LOADED, so the UI leaves its skeletons", async () => {
    // ABSENT unaries on purpose.
    const rig = openLaneRig({ unaries: absentLaneUnaries(), migration: null });
    rig.openLanes();
    await settle(rig.handle);

    expect(rig.handle.store.getState().snapshotLoaded).toBe(true);

    rig.handle.dispose();
  });

  it("DELIVERS a write command, rather than refusing it before dispatch", async () => {
    // ABSENT unaries on purpose.
    const rig = openLaneRig({ unaries: absentLaneUnaries(), migration: null });
    rig.openLanes();
    await settle(rig.handle);

    const commandId = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "update-epic-title",
      title: "Renamed on the lane arm",
      updatedAt: 2000,
    });
    expect(commandId).not.toBeNull();
    await settle(rig.handle);

    // The leg the lane arm never proved.
    expect(rig.received).toHaveLength(1);
    expect(rig.received[0].commandId).toBe(commandId);
    expect(rig.received[0].intent).toEqual({
      kind: "update-epic-title",
      title: "Renamed on the lane arm",
      updatedAt: 2000,
    });

    rig.handle.dispose();
  });
});

describe("only the CONTROL lane's own reconnect may close the write gate (ownsControlCycle)", () => {
  it("the records lane's own reconnect leaves freshness intact; the control lane's own reconnect clears it", async () => {
    // ABSENT unaries, as above - neither assertion depends on a workspace
    // context.
    const rig = openLaneRig({ unaries: absentLaneUnaries(), migration: null });
    rig.openLanes();
    await settle(rig.handle);

    // The write gate is open: the control snapshot from openLanes() already
    // established `hasFreshRootSnapshotForOpenCycle`.
    const first = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "update-epic-title",
      title: "before any reconnect",
      updatedAt: 1000,
    });
    expect(first).not.toBeNull();
    await settle(rig.handle);
    expect(rig.received).toHaveLength(1);

    // The RECORDS lane alone drops and returns - `ownsControlCycle: false` on this lane's
    // transport-status event.
    rig.reconnectStateLane();
    await settle(rig.handle);

    const second = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "update-epic-title",
      title: "after the records lane reconnected alone",
      updatedAt: 2000,
    });
    expect(second).not.toBeNull();
    await settle(rig.handle);
    // Freshness SURVIVED the records lane's own reconnect: the write reached the host.
    expect(rig.received).toHaveLength(2);

    // The CONTROL lane's own reconnect DOES own the cycle and clears it - no
    // status snapshot has arrived since, so nothing re-establishes it.
    rig.reconnectControlLane();
    await settle(rig.handle);

    await rig.handle.store.getState().enqueueWriteCommand({
      kind: "update-epic-title",
      title: "after the control lane reconnected",
      updatedAt: 3000,
    });
    await settle(rig.handle);
    // The write gate is now shut: the third command never reached the host.
    expect(rig.received).toHaveLength(2);

    rig.handle.dispose();
  });
});

/** The workspace context every lane session needs and no lane session read. */
const WORKSPACE_CONTEXT: EarlyMetaEpic = {
  epicLight: null,
  permissionRole: "editor",
  repos: [
    {
      task: null,
      repoIdentifier: { owner: "acme", repo: "widgets" },
      createdAt: 10,
      createdBy: "user-1",
    },
  ],
  workspaces: [
    {
      task: null,
      hostId: "test-host",
      workspacePath: "/w/widgets",
      createdAt: 11,
    },
  ],
  repoMapping: [
    {
      repoIdentifier: "github:acme/widgets",
      workspacePath: "/w/widgets",
      lastSyncedAt: 12,
    },
  ],
  workspaceFolders: [
    {
      workspacePath: "/w/widgets",
      hostId: "test-host",
      repoIdentifier: { owner: "acme", repo: "widgets" },
      lastSyncedAt: 12,
    },
  ],
  unresolvedRepos: [],
};

/** Counts reads and answers the fixture. The retry never fires in this block. */
function recordingWorkspaceContext(): {
  readonly unaries: EpicLaneUnaries;
  reads(): number;
} {
  let reads = 0;
  return {
    unaries: {
      getWorkspaceContext: () => {
        reads += 1;
        return Promise.resolve(WORKSPACE_CONTEXT);
      },
      retryMigration: () =>
        Promise.reject(new Error("this test never retries a migration")),
    },
    reads: () => reads,
  };
}

describe("a lane-selected session reads its workspace context", () => {
  it("projects repos, folders and mapping into snapshotMeta at open", async () => {
    const context = recordingWorkspaceContext();
    const rig = openLaneRig({ unaries: context.unaries, migration: null });
    rig.openLanes();
    await settle(rig.handle);

    // TWO, and the number is the coalescer's documented cost rather than a defect.
    expect(context.reads()).toBe(2);
    const meta = rig.handle.store.getState().snapshotMeta;
    // Read off the STORE rather than the runtime: this payload's whole purpose is to reach a renderer
    // before the snapshot does, so the projection is the fact, not the call.
    expect(meta?.repos).toEqual(WORKSPACE_CONTEXT.repos);
    expect(meta?.workspaceFolders).toEqual(WORKSPACE_CONTEXT.workspaceFolders);
    expect(meta?.repoMapping).toEqual(WORKSPACE_CONTEXT.repoMapping);

    rig.handle.dispose();
  });

  it("REFETCHES on reconnect, which is the half a naive unary port drops", async () => {
    const context = recordingWorkspaceContext();
    const rig = openLaneRig({ unaries: context.unaries, migration: null });
    rig.openLanes();
    await settle(rig.handle);
    // The cold open's two - see the previous test for why it is two.
    expect(context.reads()).toBe(2);

    // The monolith RE-EMITTED `earlyMeta`; a unary called once at tab open is a behaviour regression
    // whose symptom is a stale repo chip that nothing ever corrects.
    rig.reconnectControlLane();
    await settle(rig.handle);

    expect(context.reads()).toBe(3);

    rig.handle.dispose();
  });
});

describe("a lane-selected session retries a failed migration", () => {
  it("sends epic.retryMigration on the LANE unary, not the detached @1 adapter", async () => {
    let retries = 0;
    const rig = openLaneRig({
      unaries: {
        getWorkspaceContext: () => Promise.resolve(WORKSPACE_CONTEXT),
        retryMigration: () => {
          retries += 1;
          return Promise.resolve();
        },
      },
      // A lane-serving host reporting a failed migration on a lane that STAYS OPEN - the condition the
      // contract is explicit about, and the one that reaches the in-stream branch rather than the reopen
      migration: { state: "failed", reason: "chunk upload rejected" },
    });
    rig.openLanes();
    await settle(rig.handle);

    rig.handle.store.getState().retryMigration();
    await settle(rig.handle);

    // The TRANSPORT, not the modal.
    expect(retries).toBe(1);

    rig.handle.dispose();
  });

  it("restores the error state when the retry is REFUSED, so Retry comes back", async () => {
    // A refused retry - an absent requester, a host that declines, a bridge failure - produces no
    // migration frame at all.
    const rig = openLaneRig({
      unaries: {
        getWorkspaceContext: () => Promise.resolve(WORKSPACE_CONTEXT),
        retryMigration: () => Promise.reject(new Error("host refused")),
      },
      migration: { state: "failed", reason: "chunk upload rejected" },
    });
    rig.openLanes();
    await settle(rig.handle);
    expect(rig.handle.store.getState().migration.status).toBe("error");

    rig.handle.store.getState().retryMigration();
    await settle(rig.handle);

    // THE REDDENING ASSERTION.
    expect(rig.handle.store.getState().migration.status).toBe("error");

    rig.handle.dispose();
  });

  it("does NOT overwrite host progress with an error when the rejection arrives late", async () => {
    // The control, and the reason the restore is token-guarded rather than unconditional: a host can
    // accept the retry and start reporting while the unary's own answer is still in flight (or fails
    let rejectRetry: () => void = () => {
      throw new Error("the retry never published its rejector");
    };
    const retryAnswer = new Promise<void>((_resolve, reject) => {
      rejectRetry = () => {
        reject(new Error("late failure"));
      };
    });
    const rig = openLaneRig({
      unaries: {
        getWorkspaceContext: () => Promise.resolve(WORKSPACE_CONTEXT),
        retryMigration: () => retryAnswer,
      },
      migration: { state: "failed", reason: "chunk upload rejected" },
    });
    rig.openLanes();
    await settle(rig.handle);

    rig.handle.store.getState().retryMigration();
    await settle(rig.handle);

    // The host accepts and starts reporting BEFORE the unary settles.
    rig.emitMigrationProgress({
      phase: "upload",
      chunksDone: 3,
      chunksTotal: 10,
    });
    await settle(rig.handle);
    expect(rig.handle.store.getState().migration.phase).toBe("upload");

    rejectRetry();
    await settle(rig.handle);

    // Still the host's reading, not a fabricated error.
    expect(rig.handle.store.getState().migration.status).toBe("running");
    expect(rig.handle.store.getState().migration.chunksDone).toBe(3);

    rig.handle.dispose();
  });
});
