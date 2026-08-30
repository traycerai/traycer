/**
 * Owed #4: the body lifetime charges the SAME bytes whether the core ports are
 * called in-process or reached across the bridge.
 *
 * **What the two arms are.** Both run the real composition — the real replica
 * runtime, the real tier, the real `buildEpicRuntimeCorePorts`. The single
 * variable is how a body call reaches those ports:
 *
 * - **Arm A** calls `ports.bodies.*` directly, on a second set of ports built
 *   over the harness's own runtime with `epicRuntimeCorePortSourceOf` — the
 *   mapping production passes, not a copy. A hand-written mapping here would be
 *   a second implementation, so a miswired entry would sit on one side of the
 *   comparison only and this pin would read green while comparing production
 *   against its own restatement.
 * - **Arm B** posts `body/*` frames at `workerPort`, which is the bridge:
 *   dispatch, `structuredClone`, the worker host, the core, the same ports.
 *
 * Each arm opens its own store, so each mints its own runtime token and
 * therefore its own `epicReplicaBookKey`. That is required, not incidental:
 * one book key shared by two arms would let Arm A's charges satisfy Arm B's
 * assertions.
 *
 * **On the LANE arm, deliberately.** `@1` bodies are forward-only and carry
 * `docGuid: null` by design, so there is no cold state to settle and the
 * demote half of the lifetime is unreachable there — a `@1` version of this
 * script would compare two arms that both skipped the interesting call. The
 * lane arm has real cold state, so `materialize -> edit -> settle -> release`
 * is a lifetime rather than a subset of one.
 *
 * **Why the transfer list cannot be the difference.** Arm B's bytes cross a
 * `structuredClone` pipe that genuinely detaches what it transfers; Arm A hands
 * the ports a buffer the tier can still see. The books cannot observe that,
 * and the reason is a property with its own pin rather than an argument: every
 * charge is a byte COUNT taken from what the tier stored
 * (`epic-runtime-core-ports.test.ts`'s "reports settledBytes from what the TIER
 * stored, not from the input"), never from the caller's buffer. The one read
 * that WOULD differ is `update.byteLength` on the sender's copy after the call
 * — zero on Arm B, intact on Arm A — and no accounting path performs it. If a
 * future change makes the books read the input, that pin goes red first and
 * this one second.
 *
 * ## What the ablations proved, and the one they did NOT
 *
 * | Ablation | Result |
 * | --- | --- |
 * | `epic-runtime-core.ts` `demoteBody` drops the settle for a non-empty update | **RED**, both tests — `hotSettled` diverges at the `settled` checkpoint and `settlement.accepted` diverges with it |
 * | `epic-runtime-worker-host.ts` `body/materialize` materializes twice | green, and correctly so: `holdResidentLease` drops the second lease, so a repeated materialize charges once by design |
 * | `main-accounting-bridge.ts` `hot-doc` settles twice | **green — and this is a real limit on what this pin covers** |
 *
 * That last row is the honest boundary. BOTH arms compose their runtime with
 * `host.accounting`, so the worker→main accounting seam is common to them and a
 * defect inside it moves both totals by the same amount. This pin therefore
 * covers the CALL path (dispatch, clone/transfer, the host handlers, the core's
 * gate and its idempotence cache) and NOT the accounting seam itself, which is
 * `accounting-seam.test.ts`'s subject. Making the seam the variable would mean
 * building Arm A on a directly-constructed `createProcessBackedAccountingPort`
 * rather than on the harness — a different construction, not an assertion this
 * suite is missing. Recorded here rather than left for someone to discover by
 * writing the ablation a second time.
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
        // Reached only if the script seeds before anything subscribed. On this
        // arm the subscribe IS the materialize, so that ordering would seed a
        // lane nobody opened - a silent no-op rather than an error, which is
        // why it is checked.
        throw new Error("no body lane was opened - subscribe before seeding");
      }
      const donor = new Y.Doc();
      // Pinned for the reason `runScript`'s `edited` is - see the comment
      // there. The two are the COMPLETE set of docs in this file whose bytes
      // reach the books, and a pin on one of them is worth nothing: the first
      // fix pinned only `edited` and the suite still failed one run in three,
      // one byte apart, on this doc's id instead.
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
      // Two drains, for the reason `lane-body-awaiting-seed.test.ts` states:
      // the frame's projection turns the room `ready`, and the retry that
      // projection triggers is issued DURING that delivery, so its answer is
      // queued behind the drain that caused it.
      await handle.flush();
      await handle.flush();
    },
  };
}

/**
 * The three plane figures plus residency, read at one instant.
 *
 * `holderCount` rides along with the byte figures deliberately: two arms can
 * agree on bytes while disagreeing on how many holders those bytes are spread
 * across, and a leaked holder is exactly the shape a bridged release would fail
 * at. Bytes alone would not see it.
 */
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
  // The CONSTANTS, never string literals. `BudgetPlaneId` is wide enough that
  // `plane.planeId === "hotDocs"` - the object's KEY rather than its value -
  // compiles clean and matches nothing, which is how the first version of this
  // helper was written. The guard below is what caught it.
  const hot = snapshot.planes.find(
    (plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs,
  );
  const replicas = snapshot.planes.find(
    (plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas,
  );
  if (hot === undefined || replicas === undefined) {
    // A throw rather than a zero default. A plane missing from the snapshot is
    // "this arm never registered its books", which a zero would report as "this
    // arm charged nothing" - and the two arms would then agree on being broken.
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

/** One arm's normalised materialize answer. */
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
      // Normalised HERE rather than asserted apart, so the comparison below is
      // between two identical shapes and a difference is a difference in fact,
      // not in spelling.
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

/**
 * The one script, run by both arms.
 *
 * `release` AFTER `settle` on purpose. The settle is the terminal move for a
 * body with bytes, so the release that follows it must be refused - and the
 * REFUSAL is part of what the two arms have to agree on. An arm that answered
 * `released: true` here would be letting go of a hold twice, which is the
 * double-release no byte total shows.
 */
async function runScript(rig: LaneRig, calls: ArmCalls): Promise<ArmRun> {
  const checkpoints: Checkpoint[] = [];
  const opened = rig.handle;

  rig.installLanes();
  await opened.flush();
  checkpoints.push(takeCheckpoint("lanes-installed"));

  // On this arm the materialize IS the subscribe, so the first one legitimately
  // finds no bytes and answers AWAITING. Asserted rather than skipped: an arm
  // that answered NOT-HELD here would have closed the subscription that is
  // about to deliver, which is the cold-open defect this ticket fixed.
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

  // The edit, made against a doc built from what the arm was handed - what an
  // editor does with the materialize answer. It is what makes the settle carry
  // MORE bytes than the materialize did: settling the same bytes back would not
  // distinguish an arm that charged the growth from one that charged nothing.
  const edited = new Y.Doc({ guid: docGuid });
  // PINNED, and this is a correctness fix to the measurement rather than
  // tidiness. A `Y.Doc` mints a RANDOM `clientID`, every struct the edit below
  // creates is tagged with it, and its varint encoding is one to five bytes -
  // so two arms running the identical script encode updates of DIFFERENT
  // lengths, and the byte totals differ by the clientID delta. The first run of
  // this pin failed exactly that way (68 vs 71 provisional bytes) and the
  // difference was the random id, not the bridge. Left unpinned the pin would
  // be a coin flip that occasionally accuses the seam.
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

  /**
   * Runs Arm A then Arm B, each from a FRESH set of process books.
   *
   * Absolute totals rather than deltas, which is only comparable from a clean
   * accountant - and the reset between the arms is what makes it clean. Arm A
   * is disposed before Arm B opens so its books are gone rather than merely
   * ignored: a still-attached book would answer the reconcile Arm B triggers.
   */
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

    // Checkpoint by checkpoint rather than only at the end. Two arms that agree
    // on the final total while disagreeing in the middle have a charge that was
    // made and unmade on one side, which is the shape a double-charge takes
    // when its release is doubled too.
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
    // The comparison above is vacuous if the script charged nothing anywhere,
    // so the run has to be shown to have MOVED the books at all.
    // By LABEL, not by index. `checkpoints[3]` is typed non-optional here, so
    // its `undefined` guard is dead code the linter rejects - and an index
    // would silently name a different point the moment a checkpoint is added
    // ahead of it, which is the failure the guard was reaching for anyway.
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
