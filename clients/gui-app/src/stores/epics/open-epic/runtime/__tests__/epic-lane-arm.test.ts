/**
 * Behavioural coverage for `createEpicLaneArm` - the composition that wires
 * T10's lane adapters to T12's replicas (status + state + per-body lanes).
 *
 * `epic-lane-arm.ts`'s own module doc names four wiring obligations; this
 * suite pins the ones observable from OUTSIDE the arm, through the factory
 * functions it is given - exactly the seam `lane-adapter-probe.test.ts` drives
 * a layer up, at the full-runtime level. Here the arm is built directly, with
 * no `createEpicReplicaRuntime` in between, so a failure points straight at
 * the arm's own lifecycle bookkeeping (`statusAttached` / `stateAttached`)
 * rather than at the selection logic above it.
 *
 * Every collaborator `createEpicLaneArm` takes is a plain function, so every
 * fake here is a counting closure - no mocking framework, matching
 * `lane-adapter-probe.test.ts`'s convention. The one wire fixture in play (a
 * control-lane snapshot) is built through the real
 * `epicStatusSubscribeServerFrameSchemaV10.parse(...)`, for the same reason:
 * a hand-rolled object would let a field drift out of the contract with
 * nothing here noticing.
 *
 * Pins:
 *
 *  1. `probe()` opens the STATUS lane only - zero state clients.
 *  2. `attach()` after `probe()` ADOPTS the probe's stream - status stays at
 *     exactly 1, and a state client is newly opened.
 *  3. `attach()` with no prior probe opens both lanes.
 *  4. `probe()` is idempotent - three calls, one status client.
 *  5. The probe reports `"succeeded"` on the first control frame, and only
 *     once per arm lifetime.
 *  6. The probe reports `"unsupported"` on a method-incompatible close, and
 *     does NOT report anything on a different fatal close (`UNAUTHORIZED`) -
 *     a different failure that must not install the legacy arm.
 *  7. Lifecycle is guarded per lane: `closeTransport()` after a probe-only
 *     attach never constructs or touches a state client, and `detach()`
 *     after a probe-only attach closes the status client.
 */
import { describe, expect, it } from "vitest";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type {
  EpicStateDeltaFrame,
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  ReplicaReplacementReason,
  ReplicaTransitionToken,
} from "@traycer-clients/shared/replica-runtime";
import {
  createEpicLaneArm,
  type EpicLaneArm,
  type EpicLaneProbeOutcome,
} from "../epic-lane-arm";
import { createRendererRuntimeEnvironment } from "../runtime-environment";

// ── A real control-lane snapshot, through the wire schema's own `parse` ────

/**
 * A real control-lane snapshot, built through the wire schema's own `parse`.
 *
 * Hand-rolling the object would let a field drift out of the contract without
 * any test noticing - vitest does not type-check - so this goes through the
 * exported discriminated union and narrows the result, exactly as
 * `lane-adapter-probe.test.ts`'s `statusSnapshotFrame()` does.
 */
function statusSnapshotFrame(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: "epoch-1",
    securityEpoch: 1,
    permissionRole: "owner",
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

// ── Counting factories - trivial and honest, per the shared adapters' own
//    factory contracts ("(epicId, callbacks[, ...]) => { close(): void }") ──

interface CountingStatusFactory {
  readonly factory: EpicStatusStreamClientFactory;
  openCount(): number;
  closeCount(): number;
  /** Deliver the control lane's snapshot, the way a served subscription does. */
  deliverSnapshot(): void;
  /** Resolve the subscribe as closed, carrying an arbitrary close reason. */
  deliverClosed(reason: StreamCloseReason): void;
}

function createCountingStatusFactory(): CountingStatusFactory {
  let opens = 0;
  let closes = 0;
  let live: EpicStatusStreamCallbacks | null = null;
  const factory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    opens += 1;
    live = callbacks;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    openCount: () => opens,
    closeCount: () => closes,
    deliverSnapshot(): void {
      if (live === null) throw new Error("no status client was constructed");
      live.onSnapshot(statusSnapshotFrame());
    },
    deliverClosed(reason: StreamCloseReason): void {
      if (live === null) throw new Error("no status client was constructed");
      live.onConnectionStatus("closed", reason);
    },
  };
}

interface CountingStateFactory {
  readonly factory: EpicStateStreamClientFactory;
  openCount(): number;
  closeCount(): number;
  /** Deliver a snapshot, the way a served subscription does. */
  deliverSnapshot(frame: EpicStateSnapshotFrame): void;
  /** Deliver a delta on the live subscription. */
  deliverDelta(frame: EpicStateDeltaFrame): void;
}

function createCountingStateFactory(): CountingStateFactory {
  let opens = 0;
  let closes = 0;
  let live: EpicStateStreamCallbacks | null = null;
  const factory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    opens += 1;
    live = callbacks;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    openCount: () => opens,
    closeCount: () => closes,
    deliverSnapshot(frame): void {
      if (live === null) throw new Error("no state client was constructed");
      live.onSnapshot(frame);
    },
    deliverDelta(frame): void {
      if (live === null) throw new Error("no state client was constructed");
      live.onDelta(frame);
    },
  };
}

/**
 * A state-lane snapshot, built through the exported schema so a contract change
 * breaks the fixture rather than silently drifting past it.
 */
function stateSnapshotFrame(authorityEpoch: string): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    basis: "cold",
    authorityEpoch,
    position: 0,
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title: "Epic Title", updatedAt: 1000 } },
    artifactRecords: [],
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

/**
 * A delta on the still-open subscription, stamped with `authorityEpoch`.
 *
 * It carries one real upsert because the schema refuses an empty envelope -
 * "an empty envelope consumes a lane position for a commit that never
 * happened" - which is also why this is the honest fixture: the pin is about a
 * delta the replica would otherwise have applied.
 */
function stateDeltaFrame(
  authorityEpoch: string,
  seq: number,
): EpicStateDeltaFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    hasBinaryPayload: false,
    authorityEpoch,
    seq,
    artifactUpserts: [
      {
        kind: "spec",
        id: "artifact-1",
        folderName: "artifact-1",
        title: "A spec",
        createdAt: 1000,
        updatedAt: 1000,
        createdManually: true,
        parentId: null,
        revision: 1,
      },
    ],
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: null,
    roleClaims: null,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

interface UnusedArtifactFactory {
  readonly factory: ArtifactStreamClientFactory;
  openCount(): number;
}

/** No pin here opens a body, so this only counts and refuses. */
function createUnusedArtifactFactory(): UnusedArtifactFactory {
  let opens = 0;
  const factory: ArtifactStreamClientFactory = () => {
    opens += 1;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };
  return { factory, openCount: () => opens };
}

// ── Arm construction ────────────────────────────────────────────────────────

interface ArmRig {
  readonly arm: EpicLaneArm;
  readonly status: CountingStatusFactory;
  readonly state: CountingStateFactory;
  readonly artifacts: UnusedArtifactFactory;
  /** Every outcome `onProbeOutcome` has reported, in order. */
  readonly probeOutcomes: EpicLaneProbeOutcome[];
  /**
   * How many times the arm has reported a REQUIRED lane refused. Counted
   * rather than flagged: the contract is once per arm however many lanes and
   * tiles hit the refusal.
   */
  readonly requiredLaneUnsupportedCount: () => number;
  /** Every `(reason, transition)` the arm has funnelled upward, in order. */
  readonly replacements: Array<{
    readonly reason: ReplicaReplacementReason;
    readonly transition: ReplicaTransitionToken;
  }>;
}

/**
 * Builds a real `createEpicLaneArm`, wired to counting factories and no-op
 * sinks for everything the pins below do not assert on. `readDocSeed` answers
 * `null` and no pin ever calls `bodies.ensureAttached`, so the artifact
 * factory is never invoked - it exists only to prove that, by staying at 0.
 */
function buildArmRig(): ArmRig {
  const status = createCountingStatusFactory();
  const state = createCountingStateFactory();
  const artifacts = createUnusedArtifactFactory();
  const probeOutcomes: EpicLaneProbeOutcome[] = [];
  const replacements: Array<{
    readonly reason: ReplicaReplacementReason;
    readonly transition: ReplicaTransitionToken;
  }> = [];
  let requiredLaneUnsupported = 0;
  const arm = createEpicLaneArm({
    epicId: "epic-lane-arm-test",
    environment: createRendererRuntimeEnvironment(),
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
    getCurrentUserId: () => null,
    isDisposed: () => false,
    onStateLeadSnapshot: () => {},
    onStateSlices: () => undefined,
    onControlEvent: () => undefined,
    // REJECTS, so the tab-open read the arm now issues on `attach` fails and
    // establishes nothing - which is what keeps every pin below about the
    // lanes' own lifecycle rather than about a workspace context.
    getWorkspaceContext: () =>
      Promise.reject(new Error("no workspace-context transport in this rig")),
    onWorkspaceContext: () => undefined,
    onReplacementRequested: (reason, transition) => {
      replacements.push({ reason, transition });
    },
    artifactStreamClientFactory: artifacts.factory,
    readDocSeed: () => null,
    onRoomEvent: () => undefined,
    onProbeOutcome: (outcome) => {
      probeOutcomes.push(outcome);
    },
    onRequiredLaneUnsupported: () => {
      requiredLaneUnsupported += 1;
    },
  });
  return {
    arm,
    status,
    state,
    artifacts,
    probeOutcomes,
    requiredLaneUnsupportedCount: () => requiredLaneUnsupported,
    replacements,
  };
}

// ── 1. probe() opens the status lane only ───────────────────────────────────

describe("probe() opens the status lane only", () => {
  it("constructs one status client and zero state clients", () => {
    const rig = buildArmRig();

    rig.arm.probe();

    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);
  });
});

// ── 2. attach() after probe() adopts the probe's stream ─────────────────────

describe("attach() after probe() adopts the probe's stream", () => {
  it("keeps the status client count at exactly 1 and opens a state client", () => {
    const rig = buildArmRig();
    rig.arm.probe();
    expect(rig.status.openCount()).toBe(1);

    rig.arm.attach();

    // The only thing that catches a fix which opens a SECOND status stream on
    // adoption - such a fix would still appear to work, since the records
    // lane opening is the visible half of `attach()`.
    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(1);
  });
});

// ── 3. attach() with no prior probe opens both ──────────────────────────────

describe("attach() with no prior probe", () => {
  it("opens both the status and the state lane", () => {
    const rig = buildArmRig();

    rig.arm.attach();

    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(1);
  });
});

// ── 4. probe() is idempotent ────────────────────────────────────────────────

describe("probe() is idempotent", () => {
  it("three calls construct exactly one status client", () => {
    const rig = buildArmRig();

    rig.arm.probe();
    rig.arm.probe();
    rig.arm.probe();

    expect(rig.status.openCount()).toBe(1);
  });
});

// ── 5. one probe answer per arm lifetime ────────────────────────────────────

describe('the probe reports "succeeded" on the first control frame', () => {
  it("fires onProbeOutcome once, and a second frame does not fire it again", () => {
    const rig = buildArmRig();
    rig.arm.probe();

    rig.status.deliverSnapshot();
    expect(rig.probeOutcomes).toEqual<EpicLaneProbeOutcome[]>(["succeeded"]);

    // A second control frame on the same arm - the outcome is already
    // answered, so this must not report a second time.
    rig.status.deliverSnapshot();
    expect(rig.probeOutcomes).toEqual<EpicLaneProbeOutcome[]>(["succeeded"]);
  });
});

// ── 6. "unsupported" on a method-incompatible close only ────────────────────

describe('the probe reports "unsupported" on a method-incompatible close', () => {
  it('reports "unsupported" exactly once on an INCOMPATIBLE close', () => {
    const rig = buildArmRig();
    rig.arm.probe();

    rig.status.deliverClosed({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "epic.status.subscribe is not served by this host",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(rig.probeOutcomes).toEqual<EpicLaneProbeOutcome[]>(["unsupported"]);
  });

  it("does NOT report an outcome on an UNAUTHORIZED close - a different failure must not install the legacy arm", () => {
    const rig = buildArmRig();
    rig.arm.probe();

    rig.status.deliverClosed({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "the session is not authorized",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(rig.probeOutcomes).toEqual<EpicLaneProbeOutcome[]>([]);
  });
});

// ── 7. lifecycle is guarded per lane ────────────────────────────────────────

describe("lifecycle is guarded per lane (the probe leaves the arm HALF attached)", () => {
  it("closeTransport() after probe()-only never constructs or touches a state client, and does not throw", () => {
    const rig = buildArmRig();
    rig.arm.probe();
    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);

    expect(() => rig.arm.closeTransport()).not.toThrow();

    expect(rig.state.openCount()).toBe(0);
  });

  it('detach("superseded") after probe()-only closes the status client, with the state lane still untouched', () => {
    const rig = buildArmRig();
    rig.arm.probe();
    expect(rig.status.closeCount()).toBe(0);

    rig.arm.detach("superseded");

    expect(rig.status.closeCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);
  });
});

// ── A foreign-epoch TRANSACTION is acted on, not discarded ──────────────────

describe("a record transaction stamped with a foreign authority epoch", () => {
  it("funnels a replacement request keyed by the epoch the frame carries", () => {
    // The replica states this as a division of labour - it answers
    // `requires-replacement` and "the RUNTIME drives the rebuild, so two lanes
    // reporting one epoch change coalesce into a single replacement instead of
    // racing two" - and that only holds if the outcome is read.
    const rig = buildArmRig();
    rig.arm.attach();
    // Establishes the replica's epoch. A snapshot's own basis is `cold`, which
    // asks for nothing - so any replacement below came from the transaction.
    rig.state.deliverSnapshot(stateSnapshotFrame("epoch-1"));
    expect(rig.replacements).toEqual([]);

    // A delta on the STILL-OPEN subscription, at an epoch the replica is not
    // serving. `applyRecordTransaction` returns without touching its rows or
    // its cursor, so nothing else in this arm would ever notice.
    rig.state.deliverDelta(stateDeltaFrame("epoch-2", 2));

    // THE REDDENING ASSERTION. Discarding the outcome left the old projection
    // installed and every later delta at the new epoch dropped the same way,
    // until some snapshot happened to arrive and say so.
    expect(rig.replacements).toEqual([
      {
        reason: "authority-epoch-changed",
        transition: "authority-epoch:epoch-2",
      },
    ]);
  });

  it("a delta at the replica's OWN epoch asks for nothing", () => {
    // The control that makes the assertion above about the epoch rather than
    // about deltas: a fabricated replacement on the ordinary path would be far
    // worse than the bug being fixed.
    const rig = buildArmRig();
    rig.arm.attach();
    rig.state.deliverSnapshot(stateSnapshotFrame("epoch-1"));
    rig.state.deliverDelta(stateDeltaFrame("epoch-1", 2));
    expect(rig.replacements).toEqual([]);
  });
});

// ── A security-epoch reset reopens the body lanes it emptied ────────────────

describe("rebuildBodiesAfterReset", () => {
  function armWithOneOpenBody(): ArmRig {
    const rig = buildArmRig();
    rig.arm.attach();
    // The status snapshot is what names an authority epoch; without one the
    // body lane records demand and opens nothing.
    rig.status.deliverSnapshot();
    rig.arm.bodies.ensureAttached("artifact-1");
    expect(rig.artifacts.openCount()).toBe(1);
    return rig;
  }

  it("reopens a demanded body after a SECURITY-epoch reset, whose epoch never moved", () => {
    const rig = armWithOneOpenBody();

    // The runtime's order, not just the call: `resetAllPlanes` runs
    // `laneArm.reset()` (and empties the tier) before it gets here. Driving the
    // reset first is what makes this a pin on a LIVE fix rather than on a
    // method - a reset that blinded the epoch read would make the rebuild a
    // silent no-op, and this is the assertion that would catch it.
    rig.arm.reset({ origin: "authority", reason: "security-epoch-changed" });
    rig.arm.rebuildBodiesAfterReset({
      origin: "authority",
      reason: "security-epoch-changed",
    });

    // THE REDDENING ASSERTION. `resetAllPlanes` destroyed the body, and the
    // control handler's `syncToAuthorityEpoch` skips every lane already bound
    // to the epoch it is syncing to - which, with the authority epoch
    // unchanged, is all of them. Nothing reopened, the still-open subscription
    // owed no seed, and the mounted editor stayed empty for the session.
    expect(rig.artifacts.openCount()).toBe(2);
  });

  it("does nothing for a reason that MOVES the authority epoch", () => {
    // Those are already covered by `syncToAuthorityEpoch`, which closes and
    // reopens each lane under the new epoch. Rebuilding here as well would
    // tear down a subscription that is about to be torn down anyway.
    const rig = armWithOneOpenBody();
    rig.arm.rebuildBodiesAfterReset({
      origin: "authority",
      reason: "authority-epoch-changed",
    });
    expect(rig.artifacts.openCount()).toBe(1);
  });

  it("does nothing for a CLIENT-origin reset", () => {
    // `requestFreshSnapshot` closes and reopens the sockets itself, so its
    // lanes are rebuilt by the reconnect.
    const rig = armWithOneOpenBody();
    rig.arm.rebuildBodiesAfterReset({
      origin: "client",
      intent: "fresh-snapshot-requested",
    });
    expect(rig.artifacts.openCount()).toBe(1);
  });
});
