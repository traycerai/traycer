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
}

function createCountingStateFactory(): CountingStateFactory {
  let opens = 0;
  let closes = 0;
  const factory: EpicStateStreamClientFactory = () => {
    opens += 1;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return { factory, openCount: () => opens, closeCount: () => closes };
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
  let requiredLaneUnsupported = 0;
  const arm = createEpicLaneArm({
    epicId: "epic-lane-arm-test",
    environment: createRendererRuntimeEnvironment(),
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
    getCurrentUserId: () => null,
    isDisposed: () => false,
    onStateSlices: () => undefined,
    onControlEvent: () => undefined,
    onReplacementRequested: () => undefined,
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
