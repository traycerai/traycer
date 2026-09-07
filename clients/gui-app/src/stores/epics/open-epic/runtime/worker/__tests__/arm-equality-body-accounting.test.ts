/**
 * Body lifetime charges the same bytes in-process and across the bridge.
 * Separate stores so one book key cannot satisfy both arms.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import type { EpicRuntimeCorePorts } from "../epic-runtime-core";
import { buildEpicRuntimeCorePorts } from "../epic-runtime-core-ports";
import { epicRuntimeCorePortSourceOf } from "../install-epic-runtime-core";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  ensureProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import { createRendererRuntimeEnvironment } from "../../runtime-environment";
import { absentLaneUnaries } from "../../../test-support/absent-lane-unaries";

const ARTIFACT = "art-equality";
const EPOCH = "epoch-1";
const DOC_GUID = "guid-equality";

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${parsed.kind}`);
  }
  return parsed;
}

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  /** Deliver the status snapshot, which is what installs the lanes. */
  installLanes(): void;
  /** The host serves this body, once something has subscribed to it. */
  seed(): Promise<void>;
}

function createLaneRig(epicId: string): LaneRig {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let bodyCallbacks: ArtifactStreamCallbacks | null = null;

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, cbs) => {
    statusCallbacks = cbs;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = () => ({
    close: () => undefined,
  });
  const artifactFactory: ArtifactStreamClientFactory = ({ callbacks }) => {
    bodyCallbacks = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };

  const laneSelection: EpicLaneSelectionSources = {
    support: () => "unknown",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  return {
    handle,
    installLanes(): void {
      if (statusCallbacks === null) throw new Error("no status client");
      statusCallbacks.onSnapshot(statusSnapshot());
    },
    async seed(): Promise<void> {
      if (bodyCallbacks === null) {
        // Reached only if the script seeds before anything subscribed.
        throw new Error("no body lane was opened - subscribe before seeding");
      }
      const donor = new Y.Doc();
      // Pinned for the reason `runScript`'s `edited` is - see the comment there.
      donor.clientID = 2;
      donor
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
        .insert(0, [new Y.XmlText("seeded body")]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: DOC_GUID,
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      bodyCallbacks.onDoc(parsed, Y.encodeStateAsUpdate(donor));
      await handle.flush();
      await handle.flush();
    },
  };
}

/** The three plane figures plus residency, read at one instant. */
interface Checkpoint {
  readonly label: string;
  readonly hotSettled: number;
  readonly hotProvisional: number;
  readonly hotHolders: number;
  readonly replicaSettled: number;
  readonly replicaProvisional: number;
  readonly replicaHolders: number;
  readonly docsResident: number;
}

function takeCheckpoint(label: string): Checkpoint {
  const memory = ensureProcessMemoryRuntime(createRendererRuntimeEnvironment());
  const snapshot = memory.accountant.snapshot();
  // The CONSTANTS, never string literals.
  const hot = snapshot.planes.find(
    (plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs,
  );
  const replicas = snapshot.planes.find(
    (plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas,
  );
  if (hot === undefined || replicas === undefined) {
    // A throw rather than a zero default.
    throw new Error(`[${label}] expected both planes in the snapshot`);
  }
  return {
    label,
    hotSettled: hot.settledBytes,
    hotProvisional: hot.provisionalBytes,
    hotHolders: hot.holderCount,
    replicaSettled: replicas.settledBytes,
    replicaProvisional: replicas.provisionalBytes,
    replicaHolders: replicas.holderCount,
    docsResident: memory.hotDocs.docsResident(),
  };
}

interface MaterializeAnswer {
  readonly docKey: string | null;
  readonly update: Uint8Array | null;
  readonly docGuid: string | null;
}

interface Settlement {
  readonly accepted: boolean;
  readonly settledBytes: number;
  readonly reason: "not-held" | "newer-generation" | "pinned" | null;
}

interface ReleaseAnswer {
  readonly released: boolean;
  readonly reason: "not-held" | "newer-generation" | "pinned" | null;
}

/**
 * How one arm performs each body call. The script below is shared, so this is
 * the only thing that differs between the two runs.
 */
interface ArmCalls {
  materialize(artifactId: string): Promise<MaterializeAnswer>;
  settle(input: {
    readonly docKey: string;
    readonly generation: number;
    readonly docGuid: string;
    readonly update: Uint8Array;
  }): Promise<Settlement>;
  release(docKey: string): Promise<ReleaseAnswer>;
}

/** Arm A: the ports, called directly. No bridge. */
function directCalls(ports: EpicRuntimeCorePorts): ArmCalls {
  return {
    materialize: async (artifactId) => {
      const answer = await ports.bodies.materialize(artifactId);
      // The ports answer `null` for not-held; the wire answers `docKey: null`.
      if (answer === null) {
        return { docKey: null, update: null, docGuid: null };
      }
      return {
        docKey: answer.docKey,
        update: answer.update,
        docGuid: answer.docGuid,
      };
    },
    settle: (input) => ports.bodies.settle(input),
    release: (docKey) => Promise.resolve(ports.bodies.release(docKey)),
  };
}

/** Arm B: the same ports, reached by posting frames at the bridge. */
function bridgedCalls(opened: OpenedStoreForTest): ArmCalls {
  return {
    materialize: async (artifactId) => {
      const answer = await opened.workerPort.call(
        "body/materialize",
        { artifactId },
        [],
      );
      return {
        docKey: answer.docKey,
        update: answer.update,
        docGuid: answer.docGuid,
      };
    },
    settle: (input) => opened.workerPort.call("body/demote", input, []),
    release: (docKey) => opened.workerPort.call("body/release", { docKey }, []),
  };
}

/** What one arm's script produced, for comparison against the other's. */
interface ArmRun {
  readonly checkpoints: readonly Checkpoint[];
  readonly awaiting: MaterializeAnswer;
  readonly grantedBytes: number;
  readonly grantedDocGuid: string | null;
  readonly settlement: Settlement;
  readonly releaseAfterSettle: ReleaseAnswer;
}

/** The one script, run by both arms. `release` AFTER `settle` on purpose. */
async function runScript(rig: LaneRig, calls: ArmCalls): Promise<ArmRun> {
  const checkpoints: Checkpoint[] = [];
  const opened = rig.handle;

  rig.installLanes();
  await opened.flush();
  checkpoints.push(takeCheckpoint("lanes-installed"));

  // On this arm the materialize IS the subscribe, so the first one legitimately finds no bytes and
  // answers AWAITING.
  const awaiting = await calls.materialize(ARTIFACT);
  await opened.flush();
  checkpoints.push(takeCheckpoint("awaiting"));

  await rig.seed();
  checkpoints.push(takeCheckpoint("seeded"));

  const granted = await calls.materialize(ARTIFACT);
  await opened.flush();
  checkpoints.push(takeCheckpoint("materialized"));

  const docKey = granted.docKey;
  const docGuid = granted.docGuid;
  const grantedUpdate = granted.update;
  if (docKey === null || docGuid === null || grantedUpdate === null) {
    throw new Error("expected the seeded body to materialize with bytes");
  }

  // The edit, made against a doc built from what the arm was handed - what an editor does with the
  // materialize answer.
  const edited = new Y.Doc({ guid: docGuid });
  // PINNED, and this is a correctness fix to the measurement rather than tidiness.
  edited.clientID = 1;
  Y.applyUpdate(edited, grantedUpdate);
  edited.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("the body grew by this much")]);
    edited
      .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
      .insert(0, [paragraph]);
  });
  await opened.flush();
  checkpoints.push(takeCheckpoint("edited"));

  const settlement = await calls.settle({
    docKey,
    generation: 1,
    docGuid,
    update: Y.encodeStateAsUpdate(edited),
  });
  await opened.flush();
  checkpoints.push(takeCheckpoint("settled"));

  const releaseAfterSettle = await calls.release(docKey);
  await opened.flush();
  checkpoints.push(takeCheckpoint("released"));

  return {
    checkpoints,
    awaiting,
    grantedBytes: grantedUpdate.byteLength,
    grantedDocGuid: docGuid,
    settlement,
    releaseAfterSettle,
  };
}

describe("owed #4 - the body lifetime charges identically on both arms", () => {
  const live: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of live.splice(0)) handle.dispose();
    resetProcessMemoryRuntimeForTests();
  });

  /** Runs Arm A then Arm B, each from a FRESH set of process books. */
  async function runBothArms(): Promise<{ armA: ArmRun; armB: ArmRun }> {
    resetProcessMemoryRuntimeForTests();
    const rigA = createLaneRig("epic-arm-a");
    live.push(rigA.handle);
    const ports = buildEpicRuntimeCorePorts(
      epicRuntimeCorePortSourceOf(rigA.handle.runtime),
      { onDocUpdate: () => {}, onAwareness: () => {} },
    );
    const armA = await runScript(rigA, directCalls(ports));
    ports.releaseAllBodyHolds();
    rigA.handle.dispose();
    live.length = 0;

    resetProcessMemoryRuntimeForTests();
    const rigB = createLaneRig("epic-arm-b");
    live.push(rigB.handle);
    const armB = await runScript(rigB, bridgedCalls(rigB.handle));
    return { armA, armB };
  }

  it("produces the same plane totals and residency at every checkpoint", async () => {
    const { armA, armB } = await runBothArms();

    // Checkpoint by checkpoint rather than only at the end.
    expect(armB.checkpoints).toEqual(armA.checkpoints);
    expect(armA.checkpoints.map((point) => point.label)).toEqual([
      "lanes-installed",
      "awaiting",
      "seeded",
      "materialized",
      "edited",
      "settled",
      "released",
    ]);
    // The comparison above is vacuous if the script charged nothing anywhere, so the run has to be
    // shown to have MOVED the books at all. By LABEL, not by index.
    const materialized = armA.checkpoints.find(
      (point) => point.label === "materialized",
    );
    if (materialized === undefined) throw new Error("no materialized point");
    expect(materialized.docsResident).toBe(1);
    expect(
      materialized.hotSettled + materialized.hotProvisional,
    ).toBeGreaterThan(0);
  });

  it("agrees on the answers themselves, refusals included", async () => {
    const { armA, armB } = await runBothArms();

    expect(armB.awaiting).toEqual(armA.awaiting);
    expect(armB.grantedBytes).toBe(armA.grantedBytes);
    expect(armB.grantedDocGuid).toBe(armA.grantedDocGuid);
    expect(armB.settlement).toEqual(armA.settlement);
    expect(armB.releaseAfterSettle).toEqual(armA.releaseAfterSettle);

    // Stated rather than left implicit: `toEqual` above passes just as happily
    // for two arms that are both wrong in the same way.
    expect(armA.awaiting.docKey).not.toBeNull();
    expect(armA.awaiting.update).toBeNull();
    expect(armA.grantedDocGuid).toBe(DOC_GUID);
    expect(armA.settlement.accepted).toBe(true);
    expect(armA.releaseAfterSettle.released).toBe(false);
  });
});
