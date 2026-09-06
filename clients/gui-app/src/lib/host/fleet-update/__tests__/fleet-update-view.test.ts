import { describe, expect, it } from "vitest";
import type {
  HostStatusUpdateOperation,
  HostStatusUpdateProgress,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";
import {
  holdsLifecycleGate,
  isQuietUpdateView,
  offersForceRestart,
  projectFleetUpdateView,
  warrantsFastPoll,
  preferLiveOverRecord,
  LOCAL_LIVENESS_PROOF_MS,
  LOCAL_LIVENESS_CLOCK_SLACK_MS,
  type FleetUpdateRecordObservation,
  type FleetUpdateWireObservation,
  type FleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
} from "@/lib/host/fleet-update/fleet-update-view";

// `projectFleetUpdateView` is the ONE pure projection every update surface
// (landing banner, Settings selector badge, selected-host Overview) derives
// from - see the module's own doc for the rule it exists to enforce: absence
// of evidence is never evidence of absence. Table-driven because it is a pure
// function with no I/O and no clock of its own - the caller supplies `nowMs`.

const NOW_MS = 1_000_000;
const FRESH_UNTIL_MS = NOW_MS + 30_000;

function attemptOperation(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    trigger: "manual",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: null,
    busyBreakdown: null,
    error: null,
    ...overrides,
  };
}

const TRANSACTION: HostUpdateTransactionCapability = {
  recordSchemaVersion: 2,
  authority: "attempt",
};

// Builds a WIRE observation. Retyped (annotation only — no assertion changed)
// when Ticket 07 §5.2.7 made `FleetUpdateObservation` a union: `Partial<union>`
// does not narrow, so the literal below no longer identified an arm.
function observation(
  overrides: Partial<FleetUpdateWireObservation>,
): FleetUpdateWireObservation {
  return {
    hostId: "host-1",
    source: "selected",
    observedAtMs: NOW_MS,
    freshUntilMs: FRESH_UNTIL_MS,
    operation: attemptOperation({}),
    transaction: TRANSACTION,
    coarseProgress: null,
    legacyFacts: null,
    ...overrides,
  };
}

describe("projectFleetUpdateView — no observation / operation: null", () => {
  it("no observation at all projects unknown", () => {
    const view = projectFleetUpdateView({
      observation: null,
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
  });

  it("operation: null (a pre-1.3 peer, or a per-host manual-policy remote host's steady state) projects unknown - NEVER idle", () => {
    const view = projectFleetUpdateView({
      observation: observation({ operation: null }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.kind).not.toBe("idle");
  });

  it("a STALE operation:null observation is unknown too - not idle, even though it was fresh once", () => {
    const view = projectFleetUpdateView({
      observation: observation({ operation: null, freshUntilMs: NOW_MS - 1 }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
  });
});

describe("projectFleetUpdateView — operation: null + coarse updateProgress (pre-1.3 peer)", () => {
  // A pre-@1.3 peer cannot report an attempt at all, but it CAN report the
  // coarse `updateProgress` marker (`host.status@1.1`) — for that cohort the
  // marker is the ONLY update signal there is, and `coarseProgressView` is
  // now consulted here FIRST, exactly as it already is for `kind: "none"`.
  // These mirror the assertions in the "coarse updateProgress beside
  // {kind:'none'}" describe below, because the two arms share one helper and
  // must not drift on how they render it.

  const UPDATING: HostStatusUpdateProgress = { state: "updating", error: null };
  const FAILED_WITH_ERROR: HostStatusUpdateProgress = {
    state: "failed",
    error: "health probe failed",
  };

  it("a fresh updating marker projects kind 'updating', indeterminate progress, unqualified, no error", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: null,
        coarseProgress: UPDATING,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("updating");
    expect(view.qualified).toBe(false);
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: null,
      totalBytes: null,
    });
    expect(view.errorMessage).toBeNull();
  });

  it("a fresh failed marker with error text projects kind 'failed', progress none, and carries the error message", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: null,
        coarseProgress: FAILED_WITH_ERROR,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.progress).toEqual({ kind: "none" });
    expect(view.errorMessage).toBe("health probe failed");
  });

  it("a fresh failed marker with a null error falls back to the default sentence", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: null,
        coarseProgress: { state: "failed", error: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.errorMessage).toBe(
      "The last update attempt failed on this host.",
    );
  });

  it("a STALE coarse-updating marker decays to unknown, retaining lastKnownKind 'updating' and the observed time", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        observedAtMs: NOW_MS - 5_000,
        operation: null,
        coarseProgress: UPDATING,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("updating");
    expect(view.lastObservedAtMs).toBe(NOW_MS - 5_000);
  });

  // `coarseProgress: null` here still falls through to UNKNOWN_FLEET_UPDATE_VIEW
  // (never `idle`) — already covered above by "operation: null ... projects
  // unknown - NEVER idle" and the STALE variant right before this describe,
  // both of which use the `observation()` fixture's `coarseProgress: null`
  // default. Not duplicated here.

  it("operation: null and operation: {kind:'none'} project IDENTICAL views for the same fresh coarse marker - the two arms share one helper and must not drift", () => {
    const viaOperationNull = projectFleetUpdateView({
      observation: observation({
        operation: null,
        coarseProgress: UPDATING,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    const viaKindNone = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: UPDATING,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(viaOperationNull).toEqual(viaKindNone);
  });

  it("operation: null and operation: {kind:'none'} project IDENTICAL views for the same STALE coarse marker", () => {
    const staleOverrides = {
      freshUntilMs: NOW_MS - 1,
      observedAtMs: NOW_MS - 5_000,
      coarseProgress: FAILED_WITH_ERROR,
    };
    const viaOperationNull = projectFleetUpdateView({
      observation: observation({ ...staleOverrides, operation: null }),
      nowMs: NOW_MS,
      connected: true,
    });
    const viaKindNone = projectFleetUpdateView({
      observation: observation({
        ...staleOverrides,
        operation: { kind: "none" },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(viaOperationNull).toEqual(viaKindNone);
  });
});

describe("projectFleetUpdateView — the three distinct 'nothing to show' answers", () => {
  it("{kind: 'none'} projects idle - the host looked and there is nothing", () => {
    const view = projectFleetUpdateView({
      observation: observation({ operation: { kind: "none" } }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("idle");
  });

  it("{kind: 'unavailable'} projects unavailable - fail-closed record evidence, not idle and not failed", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: {
          kind: "unavailable",
          reason: "corrupt",
          cause: "checksum mismatch",
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unavailable");
    expect(view.kind).not.toBe("idle");
    expect(view.kind).not.toBe("failed");
  });

  it("operation: null, {kind: 'none'}, and {kind: 'unavailable'} never collapse into the same view kind", () => {
    const unknownView = projectFleetUpdateView({
      observation: observation({ operation: null }),
      nowMs: NOW_MS,
      connected: true,
    });
    const idleView = projectFleetUpdateView({
      observation: observation({ operation: { kind: "none" } }),
      nowMs: NOW_MS,
      connected: true,
    });
    const unavailableView = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "unavailable", reason: "unreadable", cause: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    const kinds = new Set([
      unknownView.kind,
      idleView.kind,
      unavailableView.kind,
    ]);
    expect(kinds.size).toBe(3);
  });
});

describe("projectFleetUpdateView — staleness", () => {
  it("a stale attempt observation projects unknown, qualified, and retains the last phase and target", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        operation: attemptOperation({
          phase: "preparing",
          targetVersion: "2.5.0",
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.qualified).toBe(true);
    expect(view.targetVersion).toBe("2.5.0");
    // The attempt identity is retained too, not only the target - a surface
    // needs it to say "last seen preparing v2.5.0" rather than going blank.
    expect(view.attemptId).toBe("attempt-1");
  });

  it("unavailable is NOT downgraded by staleness - it is a durable fact, not a live reading", () => {
    const freshView = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS + 1,
        operation: { kind: "unavailable", reason: "corrupt", cause: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    const staleView = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        operation: { kind: "unavailable", reason: "corrupt", cause: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(freshView.kind).toBe("unavailable");
    expect(staleView.kind).toBe("unavailable");
    // The one thing staleness DOES still affect for this arm: it is qualified
    // when the read that produced it can no longer be refreshed.
    expect(freshView.qualified).toBe(false);
    expect(staleView.qualified).toBe(true);
  });
});

// G4 (independent cold review, finding 4): staleness used to overwrite the
// observed phase with `unknown` and drop it. `lastKnownKind` is what a surface
// reads to say "last seen preparing v1.2.3" instead of a bare "offline" — and
// the invariant that makes it SAFE to add beside `kind` is that it can never
// leak into a gate or a cadence decision: `lastKnownKind !== null` implies
// `kind === "unknown"`, and every gate reads `kind`.
describe("projectFleetUpdateView — retained last-known phase (lastKnownKind)", () => {
  it("a stale attempt retains the phase AND its observed time", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        observedAtMs: NOW_MS - 5_000,
        operation: attemptOperation({ phase: "downloading" }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("downloading");
    expect(view.lastObservedAtMs).toBe(NOW_MS - 5_000);
  });

  it("THE INVARIANT: lastKnownKind !== null implies kind === 'unknown', across every arm this projection can produce", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly view: FleetUpdateView;
    }> = [
      {
        name: "no observation",
        view: projectFleetUpdateView({
          observation: null,
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "operation: null",
        view: projectFleetUpdateView({
          observation: observation({ operation: null }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "fresh idle",
        view: projectFleetUpdateView({
          observation: observation({ operation: { kind: "none" } }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "stale idle (retains lastKnownKind: 'idle')",
        view: projectFleetUpdateView({
          observation: observation({
            freshUntilMs: NOW_MS - 1,
            operation: { kind: "none" },
          }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "unavailable",
        view: projectFleetUpdateView({
          observation: observation({
            operation: { kind: "unavailable", reason: "corrupt", cause: null },
          }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "fresh active attempt",
        view: projectFleetUpdateView({
          observation: observation({ operation: attemptOperation({}) }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "stale active attempt",
        view: projectFleetUpdateView({
          observation: observation({
            freshUntilMs: NOW_MS - 1,
            operation: attemptOperation({ phase: "preparing" }),
          }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "interrupted liveness (failed)",
        view: projectFleetUpdateView({
          observation: observation({
            operation: attemptOperation({ liveness: "interrupted" }),
          }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
      {
        name: "indeterminate liveness",
        view: projectFleetUpdateView({
          observation: observation({
            operation: attemptOperation({ liveness: "indeterminate" }),
          }),
          nowMs: NOW_MS,
          connected: true,
        }),
      },
    ];
    for (const { name, view } of cases) {
      if (view.lastKnownKind !== null) {
        expect(
          view.kind,
          `${name}: lastKnownKind set but kind !== unknown`,
        ).toBe("unknown");
      }
    }
  });

  it("GATES: a retained (stale) downloading attempt holds NEITHER holdsLifecycleGate NOR warrantsFastPoll — reading kind, not lastKnownKind", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        operation: attemptOperation({
          phase: "downloading",
          execution: "active",
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("downloading");
    expect(holdsLifecycleGate(view)).toBe(false);
    expect(warrantsFastPoll(view)).toBe(false);
  });

  it("a fresh (non-stale) view never carries a retained phase - it IS the current phase, not a memory of one", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "verifying" }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("verifying");
    expect(view.lastKnownKind).toBeNull();
    expect(view.lastObservedAtMs).toBeNull();
  });
});

describe("projectFleetUpdateView — liveness", () => {
  it("liveness: interrupted overrides the phase and projects failed", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          phase: "downloading",
          liveness: "interrupted",
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.errorMessage).not.toBeNull();
  });

  it("liveness: indeterminate keeps the phase but marks the view qualified - and NEVER produces failed", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          phase: "applying",
          liveness: "indeterminate",
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("applying");
    expect(view.kind).not.toBe("failed");
    expect(view.qualified).toBe(true);
  });

  it("a live (non-interrupted, non-indeterminate) attempt is not qualified by liveness alone", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "applying", liveness: "active" }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("applying");
    expect(view.qualified).toBe(false);
  });
});

describe("projectFleetUpdateView — restarting vs reconnecting", () => {
  it("phase: restarting while still connected projects restarting", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "restarting" }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("restarting");
  });

  it("phase: restarting while disconnected projects reconnecting - the client's own vantage on the SAME host phase", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "restarting" }),
      }),
      nowMs: NOW_MS,
      connected: false,
    });
    expect(view.kind).toBe("reconnecting");
  });
});

describe("projectFleetUpdateView — progress", () => {
  it("execution !== 'active' (parked or terminal) projects progress: none, even with a stored percent", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          phase: "waiting-for-work",
          execution: "parked",
          progress: { percent: 40, bytes: 4_000, totalBytes: 10_000 },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({ kind: "none" });
  });

  it("active execution with percent: null projects indeterminate - NEVER 0%", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          execution: "active",
          progress: { percent: null, bytes: null, totalBytes: null },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: null,
      totalBytes: null,
    });
    expect(view.progress).not.toEqual({
      kind: "determinate",
      percent: 0,
      bytes: null,
      totalBytes: null,
    });
  });

  it("active execution with no progress object at all also projects indeterminate, not none and not 0%", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ execution: "active", progress: null }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: null,
      totalBytes: null,
    });
  });

  // G5 (independent cold review, finding 5): the wire makes `percent`,
  // `bytes` and `totalBytes` independently nullable, so an active operation
  // with no percentage can still have MEASURED bytes — a host streaming an
  // unsized body. The first shape of `projectProgress` discarded them the
  // moment `percent` was null, leaving a bar with no counters beside it.
  it("active execution with bytes measured but percent: null carries the bytes on the INDETERMINATE arm — never dropped", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          execution: "active",
          progress: {
            percent: null,
            bytes: 80_000_000,
            totalBytes: 200_000_000,
          },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: 80_000_000,
      totalBytes: 200_000_000,
    });
  });

  it("active execution with only `bytes` measured (no totalBytes, no percent) still carries bytes on the indeterminate arm", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          execution: "active",
          progress: { percent: null, bytes: 80_000_000, totalBytes: null },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: 80_000_000,
      totalBytes: null,
    });
  });

  it("no bytes measured at all (percent, bytes and totalBytes all null) carries null bytes on the indeterminate arm — never fabricated", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          execution: "active",
          progress: { percent: null, bytes: null, totalBytes: null },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: null,
      totalBytes: null,
    });
  });

  it("active execution with a genuine measured percent projects determinate with that percent", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({
          execution: "active",
          progress: { percent: 55, bytes: 5_500, totalBytes: 10_000 },
        }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.progress).toEqual({
      kind: "determinate",
      percent: 55,
      bytes: 5_500,
      totalBytes: 10_000,
    });
  });
});

describe("offersForceRestart", () => {
  function viewOf(overrides: Partial<FleetUpdateView>): FleetUpdateView {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "waiting-for-work",
      attemptId: "attempt-1",
      targetVersion: "2.1.0",
      progress: { kind: "none" },
      qualified: false,
      ...overrides,
    };
  }

  it("is true for waiting-for-work with a reported POSITIVE blocking count", () => {
    expect(offersForceRestart(viewOf({ blockingSessionCount: 3 }))).toBe(true);
  });

  it("is false when the count is null - a null count is not zero and not offered", () => {
    expect(offersForceRestart(viewOf({ blockingSessionCount: null }))).toBe(
      false,
    );
  });

  it("is false when the reported count is genuinely zero", () => {
    expect(offersForceRestart(viewOf({ blockingSessionCount: 0 }))).toBe(false);
  });

  it("is false for any other view kind, even with a positive count", () => {
    expect(
      offersForceRestart(
        viewOf({ kind: "downloading", blockingSessionCount: 5 }),
      ),
    ).toBe(false);
  });
});

describe("warrantsFastPoll", () => {
  function viewOf(overrides: Partial<FleetUpdateView>): FleetUpdateView {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      attemptId: "attempt-1",
      targetVersion: "2.1.0",
      progress: { kind: "indeterminate", bytes: null, totalBytes: null },
      qualified: false,
      ...overrides,
    };
  }

  const ACTIVE_KINDS: readonly FleetUpdateView["kind"][] = [
    "downloading",
    "preparing",
    "applying",
    "restarting",
    "reconnecting",
    "verifying",
  ];
  const PARKED_OR_TERMINAL_KINDS: readonly FleetUpdateView["kind"][] = [
    "unknown",
    "idle",
    "waiting-for-work",
    "waiting-to-activate",
    "complete",
    "failed",
    "unavailable",
  ];

  it.each(ACTIVE_KINDS)(
    "is true for an unqualified, genuinely active kind: %s",
    (kind) => {
      expect(warrantsFastPoll(viewOf({ kind, qualified: false }))).toBe(true);
    },
  );

  it.each(PARKED_OR_TERMINAL_KINDS)(
    "is false for a parked/terminal kind even when unqualified: %s",
    (kind) => {
      expect(warrantsFastPoll(viewOf({ kind, qualified: false }))).toBe(false);
    },
  );

  it.each([...ACTIVE_KINDS, ...PARKED_OR_TERMINAL_KINDS])(
    "is false for EVERY kind once qualified - a qualified view is evidence we cannot refresh: %s",
    (kind) => {
      expect(warrantsFastPoll(viewOf({ kind, qualified: true }))).toBe(false);
    },
  );
});

// G8: direct `holdsLifecycleGate` unit coverage, independently of any banner
// or Overview seam — the finding-7 gap was that the only proof lived behind an
// interaction test that could not fail for the right reason.
describe("holdsLifecycleGate — direct unit coverage", () => {
  function viewOf(kind: FleetUpdateView["kind"]): FleetUpdateView {
    return { ...UNKNOWN_FLEET_UPDATE_VIEW, kind };
  }

  const HOLDING_KINDS: readonly FleetUpdateView["kind"][] = [
    "downloading",
    "preparing",
    "applying",
    "restarting",
    "verifying",
  ];
  const NON_HOLDING_KINDS: readonly FleetUpdateView["kind"][] = [
    "reconnecting",
    "waiting-for-work",
    "waiting-to-activate",
    "complete",
    "failed",
    "unavailable",
    "idle",
    "unknown",
  ];

  it.each(HOLDING_KINDS)(
    "holds the gate for a genuinely EXECUTING kind: %s",
    (kind) => {
      expect(holdsLifecycleGate(viewOf(kind))).toBe(true);
    },
  );

  it.each(NON_HOLDING_KINDS)(
    "does NOT hold the gate for a parked/terminal/unknown kind: %s",
    (kind) => {
      expect(holdsLifecycleGate(viewOf(kind))).toBe(false);
    },
  );

  it("THE PRE-@1.3 BOUNDARY: `unknown` fails OPEN — a peer that never speaks the attempt protocol must never lock the page through this predicate", () => {
    // A pre-1.3 peer produces `updateOperation: null`, which `projectFleetUpdateView`
    // maps to `UNKNOWN_FLEET_UPDATE_VIEW` — `kind: "unknown"`. Consumers at the
    // banner/Overview layer fall back to the coarse `updateProgress.state ===
    // "updating"` field for such a peer; this predicate's own contract is that
    // it never holds for `unknown` regardless of how it got there, which is
    // what makes that fallback safe to layer on top rather than racing it.
    expect(holdsLifecycleGate(UNKNOWN_FLEET_UPDATE_VIEW)).toBe(false);
  });
});

// ---- Ticket 07 §5.2.7 — the record-derived arm ----------------------------

function recordObservation(
  overrides: Partial<FleetUpdateRecordObservation>,
): FleetUpdateRecordObservation {
  return {
    hostId: "host-1",
    source: "durable-record",
    observedAtMs: NOW_MS,
    attemptId: "attempt-1",
    targetVersion: "2.0.0",
    phase: "preparing",
    // Un-probed by default, which is what a parked or terminal record carries
    // and what every case here that is not ABOUT liveness should assert
    // against — `live` is the exceptional verdict, so it has to be asked for.
    liveness: "unknown",
    livenessObservedAtMs: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
    generation: 1,
    sequence: 1,
    ...overrides,
  };
}

describe("projectFleetUpdateView — the durable-record arm (host-down window)", () => {
  it("a FAILED record projects unknown + lastKnownKind:'failed', never a live failure", () => {
    // Codex round 3, end to end. The read boundary now lets `failed` through
    // (it used to be dropped with every terminal phase), and this asserts what
    // it becomes: the retained-phase channel, not a live `kind`.
    //
    // Both halves matter. `kind` must stay `unknown` because every gate and
    // cadence decision reads it, so a host we cannot reach must hold no gate
    // and earn no active poll; `lastKnownKind` must be `failed` so a surface
    // can say "last seen failed" instead of rendering a blank offline badge for
    // the one outcome a person needs to act on.
    // Composed through the REAL read boundary, not a hand-built observation
    // literal. Building the observation directly would bypass
    // `recordObservationFromLocalAttempt` entirely, so the assertion would hold
    // whether or not `failed` is admitted there - which is exactly what an
    // ablation caught this test doing on its first draft.
    const observed = recordObservationFromLocalAttempt({
      hostId: "host-1",
      localAttempt: {
        attemptId: "attempt-1",
        generation: 1,
        sequence: 1,
        targetVersion: "2.0.0",
        phase: "failed",
        continuation: null,
        updatedAt: "2026-08-27T00:00:00.000Z",
        // A terminal record is never probed (D13), so Desktop publishes
        // `unknown` with no observation timestamp.
        liveness: "unknown",
        livenessObservedAtMs: null,
      },
      observedAtMs: NOW_MS,
    });
    if (observed === null) {
      throw new Error("the read boundary dropped a failed record");
    }
    const view = projectFleetUpdateView({
      observation: observed,
      nowMs: NOW_MS,
      connected: true,
    });

    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("failed");
    // The invariant the retained-phase field documents.
    expect(view.lastKnownKind !== null && view.kind === "unknown").toBe(true);
    // It must not earn the acceleration or hold a lifecycle gate.
    expect(warrantsFastPoll(view)).toBe(false);
    expect(holdsLifecycleGate(view)).toBe(false);
  });

  it("distinguishes 'attempt exists, host unreachable' from 'attempt progressing'", () => {
    // The §5.2.7 requirement, asserted directly rather than inferred from the
    // shape. Same phase, two evidence sources, two different renderings.
    const fromWire = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "preparing" }),
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    const fromRecord = projectFleetUpdateView({
      observation: recordObservation({ phase: "preparing" }),
      nowMs: NOW_MS,
      connected: true,
    });

    // Progressing: the phase IS the kind, unqualified.
    expect(fromWire.kind).toBe("preparing");
    expect(fromWire.qualified).toBe(false);
    // Exists but unreachable: kind decays, the phase is retained and qualified.
    expect(fromRecord.kind).toBe("unknown");
    expect(fromRecord.qualified).toBe(true);
    expect(fromRecord.lastKnownKind).toBe("preparing");
  });

  it("carries what the record establishes, and nothing it does not", () => {
    const view = projectFleetUpdateView({
      observation: recordObservation({}),
      nowMs: NOW_MS,
      connected: true,
    });

    expect(view.attemptId).toBe("attempt-1");
    expect(view.targetVersion).toBe("2.0.0");
    // NOT fabricated: a record says nothing about progress, busy sessions or
    // errors, so none of them may appear. A synthesized `operation` would have
    // had to invent all three.
    expect(view.progress).toEqual({ kind: "none" });
    expect(view.blockingSessionCount).toBeNull();
    expect(view.blockingBreakdown).toBeNull();
    expect(view.errorMessage).toBeNull();
  });

  it("honours the lastKnownKind invariant: a retained phase implies kind unknown", () => {
    for (const phase of ["downloading", "applying", "verifying"] as const) {
      const view = projectFleetUpdateView({
        observation: recordObservation({ phase }),
        nowMs: NOW_MS,
        connected: true,
      });
      expect(view.lastKnownKind).toBe(phase);
      expect(view.kind).toBe("unknown");
    }
  });

  it("maps `restarting` to `reconnecting` — reading the record IS the disconnected vantage", () => {
    // This is the pin-4 detector. A second, local copy of the phase->kind
    // mapping would almost certainly return "restarting" here, because the
    // vantage split is the one rule that is easy to omit when copying a switch.
    // It also proves `connected: true` from the caller cannot leak in: the host
    // is not answering, which is why we are reading a file about it.
    const view = projectFleetUpdateView({
      observation: recordObservation({ phase: "restarting" }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.lastKnownKind).toBe("reconnecting");
  });

  it("is not aged out by nowMs — a durable fact does not go stale on a lapsed poll", () => {
    const view = projectFleetUpdateView({
      observation: recordObservation({ phase: "applying" }),
      nowMs: NOW_MS + 10_000_000,
      connected: true,
    });
    // The record was read from this machine's disk; there is no poll to miss.
    expect(view.lastKnownKind).toBe("applying");
  });
});

describe("preferLiveOverRecord — the record arm fills the host-down window only", () => {
  const record = recordObservation({});

  it("a FRESH wire read outranks the record", () => {
    const wire = observation({ freshUntilMs: NOW_MS + 1000 });
    expect(preferLiveOverRecord(wire, record, NOW_MS)).toBe(wire);
  });

  it("a STALE wire read loses to the record", () => {
    // The load-bearing case. A recency comparison would get this backwards in
    // the other direction too - see the next test.
    const wire = observation({ freshUntilMs: NOW_MS - 1 });
    expect(preferLiveOverRecord(wire, record, NOW_MS)).toBe(record);
  });

  it("a fresh wire read wins even when the record was observed MORE recently", () => {
    // Why this is not "whichever is newest": the record is re-read every tick,
    // so its `observedAtMs` is always the newer one. A recency rule would let
    // it permanently suppress real progress from a healthy host.
    const wire = observation({
      freshUntilMs: NOW_MS + 1000,
      observedAtMs: NOW_MS - 5000,
    });
    const newerRecord = recordObservation({ observedAtMs: NOW_MS });
    expect(preferLiveOverRecord(wire, newerRecord, NOW_MS)).toBe(wire);
  });

  it("keeps a stale wire read when there is no record, rather than dropping it", () => {
    // Its own stale arm still carries `lastKnownKind`; returning null here
    // would throw away the last thing we knew.
    const wire = observation({ freshUntilMs: NOW_MS - 1 });
    expect(preferLiveOverRecord(wire, null, NOW_MS)).toBe(wire);
  });

  it("returns the record when there is no wire read at all, and null when there is neither", () => {
    expect(preferLiveOverRecord(null, record, NOW_MS)).toBe(record);
    expect(preferLiveOverRecord(null, null, NOW_MS)).toBeNull();
  });
});

describe("projectFleetUpdateView — probed local liveness on a `restarting` record (Ticket 06 D13)", () => {
  it("live liveness with a fresh stamp projects the live restarting kind, gate held, no retained phase", () => {
    // Falsifies: `localLivenessProofHolds` returning false for a fresh, valid
    // stamp, or `recordObservationView` not routing a holding proof to the
    // live `restarting` arm.
    const view = projectFleetUpdateView({
      observation: recordObservation({
        phase: "restarting",
        liveness: "live",
        livenessObservedAtMs: NOW_MS - LOCAL_LIVENESS_PROOF_MS / 2,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("restarting");
    expect(view.qualified).toBe(false);
    expect(view.progress.kind).toBe("indeterminate");
    expect(holdsLifecycleGate(view)).toBe(true);
    expect(view.lastKnownKind).toBeNull();
  });

  it("the SAME observation, once nowMs advances past the 5s proof window, decays to unknown with the gate released", () => {
    // Falsifies: dropping the upper bound (`ageMs <= LOCAL_LIVENESS_PROOF_MS`)
    // in `localLivenessProofHolds` — a proof that never expires would hold this
    // host's lifecycle gate open forever on a payload nothing is refreshing.
    const livenessObservedAtMs = NOW_MS;
    // Deliberately DISTINCT from the liveness stamp. The builder defaults
    // `observedAtMs` to `NOW_MS` too, so leaving it alone would make the
    // `lastObservedAtMs` assertion below pass whichever of the two fields the
    // record arm retained — and the two are different facts: when this
    // renderer READ the record, versus when the holder probe stamped it.
    const observedAtMs = NOW_MS - 250;
    const nowAfterDeadline = livenessObservedAtMs + LOCAL_LIVENESS_PROOF_MS + 1;
    const view = projectFleetUpdateView({
      observation: recordObservation({
        phase: "restarting",
        liveness: "live",
        livenessObservedAtMs,
        observedAtMs,
      }),
      nowMs: nowAfterDeadline,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(holdsLifecycleGate(view)).toBe(false);
    // The record arm's phase->kind mapping calls `phaseKind(phase, false)` —
    // never `input.connected` — because reading a record IS the disconnected
    // vantage, and `restarting` under `connected: false` maps to
    // `reconnecting`. Asserting what the code actually produces, not what a
    // naive reading of "restarting expired" might guess ("restarting" or
    // "unknown").
    expect(view.lastKnownKind).toBe("reconnecting");
    expect(view.lastObservedAtMs).toBe(observedAtMs);
  });

  it("a NEGATIVE age beyond the clock-slack bound projects unknown, gate released", () => {
    // Falsifies: dropping the lower bound entirely from
    // `localLivenessProofHolds` (the ticket's own ablation) — a wall-clock
    // step backward would otherwise read as "even fresher than new" to a
    // check that only looks at the upper bound. Stepped back well past
    // `LOCAL_LIVENESS_CLOCK_SLACK_MS` (1s) rather than by ~500ms, because a
    // step inside the slack is the ordinary quantisation case this bound is
    // deliberately built to tolerate, not the defect it guards against.
    const livenessObservedAtMs = NOW_MS;
    const nowBeforeStamp =
      livenessObservedAtMs - LOCAL_LIVENESS_CLOCK_SLACK_MS - 9_000;
    const view = projectFleetUpdateView({
      observation: recordObservation({
        phase: "restarting",
        liveness: "live",
        livenessObservedAtMs,
      }),
      nowMs: nowBeforeStamp,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(holdsLifecycleGate(view)).toBe(false);
  });

  it("an absent or NaN liveness stamp projects unknown even with liveness:'live'", () => {
    // Falsifies: `localLivenessProofHolds` treating a missing/unparseable
    // stamp as "nothing to compare, so allow it" instead of refusing.
    const nullStamp = projectFleetUpdateView({
      observation: recordObservation({
        phase: "restarting",
        liveness: "live",
        livenessObservedAtMs: null,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(nullStamp.kind).toBe("unknown");

    const nanStamp = projectFleetUpdateView({
      observation: recordObservation({
        phase: "restarting",
        liveness: "live",
        livenessObservedAtMs: Number.NaN,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(nanStamp.kind).toBe("unknown");
  });

  it("'interrupted' and 'unknown' liveness on a restarting record never reach the live arm, regardless of the stamp", () => {
    // Falsifies: `localLivenessProofHolds` checking only the stamp's age and
    // forgetting the `liveness !== "live"` guard.
    for (const liveness of ["interrupted", "unknown"] as const) {
      const view = projectFleetUpdateView({
        observation: recordObservation({
          phase: "restarting",
          liveness,
          livenessObservedAtMs: NOW_MS,
        }),
        nowMs: NOW_MS,
        connected: true,
      });
      expect(view.kind).toBe("unknown");
      expect(view.lastKnownKind).toBe("reconnecting");
      expect(holdsLifecycleGate(view)).toBe(false);
    }
  });
});

describe("preferLiveOverRecord — same-attempt ordering and the different-attempt bound (Ticket 06 D13)", () => {
  it("a repeated read of ONE unchanged record never outranks a HEALTHY wire frame of the same attempt, across three reads", () => {
    // Falsifies: comparing on read time / recency instead of freshness — see
    // the module's own invariant doc at `preferLiveOverRecord`.
    const wire = observation({
      freshUntilMs: NOW_MS + 30_000,
      operation: attemptOperation({
        attemptId: "attempt-1",
        generation: 1,
        sequence: 1,
      }),
    });
    const unchangedRecord = recordObservation({
      attemptId: "attempt-1",
      generation: 1,
      sequence: 1,
    });
    for (let read = 0; read < 3; read += 1) {
      expect(preferLiveOverRecord(wire, unchangedRecord, NOW_MS)).toBe(wire);
    }
  });

  it("a record with a HIGHER sequence outranks a STALE wire frame of the same attempt", () => {
    // Falsifies: `recordIsBehind` treating equality or a higher sequence as
    // "behind", or the caller only consulting `preferLiveOverRecord` while the
    // wire is fresh.
    const staleWire = observation({
      freshUntilMs: NOW_MS - 1,
      operation: attemptOperation({
        attemptId: "attempt-1",
        generation: 1,
        sequence: 1,
      }),
    });
    const aheadRecord = recordObservation({
      attemptId: "attempt-1",
      generation: 1,
      sequence: 2,
    });
    expect(preferLiveOverRecord(staleWire, aheadRecord, NOW_MS)).toBe(
      aheadRecord,
    );
  });

  it("a FUTURE-dated updatedAt on a DIFFERENT attempt loses to a stale wire — the wire must be stale for this to prove anything", () => {
    // A fresh wire always wins unconditionally (see the healthy-frame pin
    // above), so this pin deliberately stales the wire first: only then
    // does `recordTimestampIsSane`'s future-allowance become the deciding
    // factor. "Future" exceeds LOCAL_LIVENESS_CLOCK_SLACK_MS by a full day, far
    // past the one-tick slack the bound tolerates.
    // Falsifies: `recordTimestampIsSane` accepting an unbounded future
    // timestamp instead of comparing against `LOCAL_LIVENESS_CLOCK_SLACK_MS`.
    const staleWire = observation({
      freshUntilMs: NOW_MS - 1,
      operation: attemptOperation({ attemptId: "attempt-1" }),
    });
    const futureRecord = recordObservation({
      attemptId: "attempt-2",
      updatedAt: new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(preferLiveOverRecord(staleWire, futureRecord, NOW_MS)).toBe(
      staleWire,
    );
  });

  it("mirror: a different-attempt record with a SANE updatedAt beats a stale wire", () => {
    // Falsifies: `recordTimestampIsSane` refusing an ordinary, plausible
    // timestamp (over-tightening the bound would make this fail alongside the
    // future-dated pin above).
    const staleWire = observation({
      freshUntilMs: NOW_MS - 1,
      operation: attemptOperation({ attemptId: "attempt-1" }),
    });
    const saneRecord = recordObservation({
      attemptId: "attempt-2",
      updatedAt: new Date(NOW_MS - 60_000).toISOString(),
    });
    expect(preferLiveOverRecord(staleWire, saneRecord, NOW_MS)).toBe(
      saneRecord,
    );
  });

  it("an unparseable updatedAt on a different attempt loses to a stale wire", () => {
    // Falsifies: `recordTimestampIsSane` treating `Date.parse`'s `NaN` as
    // "unknown, so allow it" instead of refusing — the doc's explicit
    // "invalid loses" vs. "invalid silently wins" distinction.
    const staleWire = observation({
      freshUntilMs: NOW_MS - 1,
      operation: attemptOperation({ attemptId: "attempt-1" }),
    });
    const unparseableRecord = recordObservation({
      attemptId: "attempt-2",
      updatedAt: "not-a-date",
    });
    expect(preferLiveOverRecord(staleWire, unparseableRecord, NOW_MS)).toBe(
      staleWire,
    );
  });
});

// ---- coarse `updateProgress`, carried beside `updateOperation: {kind:"none"}` ----
//
// The shipped legacy `traycer host update` path never writes a schema-v2
// attempt record: it reports through this two-state marker alone. A @1.3 host
// running it answers `updateOperation: {kind:"none"}` (it looked; there is no
// attempt) AND `updateProgress: {state:"updating"}` at the same time, and only
// this field lets the projector tell that host apart from a genuinely quiet
// one — see `coarseKind`'s doc.
describe("projectFleetUpdateView — coarse updateProgress beside {kind:'none'}", () => {
  it("updating: projects kind 'updating', indeterminate progress, unqualified - and is INFORMATIONAL: it neither holds the lifecycle gate nor earns the fast poll", () => {
    // The marker carries no liveness: a legacy updater that crashed after
    // writing it leaves a host serving `{state:"updating"}` forever. A gate
    // held by it would disable Restart / Diagnostics / the service verbs
    // indefinitely (the fail-open rule `unknown` already follows), and a fast
    // poll earned by it would be the unbounded cadence the poll policy forbids.
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: { state: "updating", error: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("updating");
    expect(view.qualified).toBe(false);
    expect(view.progress).toEqual({
      kind: "indeterminate",
      bytes: null,
      totalBytes: null,
    });
    expect(holdsLifecycleGate(view)).toBe(false);
    expect(warrantsFastPoll(view)).toBe(false);
  });

  it("failed with an error: projects kind 'failed', progress none, and carries that error message", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: { state: "failed", error: "health probe failed" },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.progress).toEqual({ kind: "none" });
    expect(view.errorMessage).toBe("health probe failed");
  });

  it("failed with a null error: falls back to the default sentence", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: { state: "failed", error: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.errorMessage).toBe(
      "The last update attempt failed on this host.",
    );
  });

  it("a STALE coarse-updating read decays to unknown, retaining lastKnownKind 'updating' and the observed time", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        observedAtMs: NOW_MS - 5_000,
        operation: { kind: "none" },
        coarseProgress: { state: "updating", error: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("updating");
    expect(view.lastObservedAtMs).toBe(NOW_MS - 5_000);
    // Invariant holds here too: a retained phase never holds a gate or poll.
    expect(holdsLifecycleGate(view)).toBe(false);
    expect(warrantsFastPoll(view)).toBe(false);
  });

  it("a coarse: null read leaves the old idle behaviour unchanged", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: null,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("idle");
    expect(view.qualified).toBe(false);
  });

  it("a coarse: updating marker does NOT override a real attempt record — the attempt's own phase still projects", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "applying" }),
        coarseProgress: { state: "updating", error: null },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    // The coarse-marker branch only fires under `kind: "none"`; a genuine
    // attempt record is read first and the coarse field is never consulted.
    expect(view.kind).toBe("applying");
  });
});

describe("isQuietUpdateView", () => {
  function viewOf(overrides: Partial<FleetUpdateView>): FleetUpdateView {
    return { ...UNKNOWN_FLEET_UPDATE_VIEW, ...overrides };
  }

  it("is true for a fresh idle view", () => {
    expect(isQuietUpdateView(viewOf({ kind: "idle" }))).toBe(true);
  });

  it("is true for unknown with no retained phase at all", () => {
    expect(
      isQuietUpdateView(viewOf({ kind: "unknown", lastKnownKind: null })),
    ).toBe(true);
  });

  it("is true for unknown whose retained phase is idle", () => {
    expect(
      isQuietUpdateView(viewOf({ kind: "unknown", lastKnownKind: "idle" })),
    ).toBe(true);
  });

  it("is true for unknown whose retained phase is itself unknown", () => {
    expect(
      isQuietUpdateView(viewOf({ kind: "unknown", lastKnownKind: "unknown" })),
    ).toBe(true);
  });

  it("is false for unknown with a retained downloading phase — there is real progress to qualify", () => {
    expect(
      isQuietUpdateView(
        viewOf({ kind: "unknown", lastKnownKind: "downloading" }),
      ),
    ).toBe(false);
  });

  it("is false for a live 'updating' view", () => {
    expect(isQuietUpdateView(viewOf({ kind: "updating" }))).toBe(false);
  });

  it("is false for a live 'failed' view", () => {
    expect(isQuietUpdateView(viewOf({ kind: "failed" }))).toBe(false);
  });
});

// ---- record-derived parks (legacyFacts) — Ticket beside 07 §5.2.7 ----------
//
// `legacyFactsView` is consulted in BOTH the `operation === null` arm and the
// `operation.kind === "none"` arm, AFTER the coarse `updateProgress` marker
// and BEFORE `unknown`/`idle`. See the module's own doc on `legacyFactsView`
// for the full precedence story; these tests pin it end to end through
// `projectFleetUpdateView` rather than calling the (unexported) helper
// directly, so a precedence regression shows up exactly where a surface would
// see it.

describe("projectFleetUpdateView — record-derived parks (legacyFacts)", () => {
  it("activation debt under operation:{kind:'none'} projects waiting-to-activate, targetVersion = installed, unqualified, no blocking count", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("waiting-to-activate");
    expect(view.targetVersion).toBe("1.3.0-rc.3");
    expect(view.qualified).toBe(false);
    expect(view.blockingSessionCount).toBeNull();
  });

  it("SAME activation debt under operation: null (a pre-1.3 peer) - the legacy updater parks the same way on either cohort", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: null,
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("waiting-to-activate");
    expect(view.targetVersion).toBe("1.3.0-rc.3");
    expect(view.qualified).toBe(false);
    expect(view.blockingSessionCount).toBeNull();
  });

  it("staged wait projects waiting-for-work, targetVersion = staged, and carries the blocking count - offersForceRestart follows it", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: null,
          stagedWait: { stagedVersion: "1.3.0-rc.4", blockingSessionCount: 2 },
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("waiting-for-work");
    expect(view.targetVersion).toBe("1.3.0-rc.4");
    expect(view.blockingSessionCount).toBe(2);
    expect(offersForceRestart(view)).toBe(true);
  });

  it("staged wait with a null blocking count offers no force - a null count is a claim, not countable work", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: null,
          stagedWait: {
            stagedVersion: "1.3.0-rc.4",
            blockingSessionCount: null,
          },
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("waiting-for-work");
    expect(view.blockingSessionCount).toBeNull();
    expect(offersForceRestart(view)).toBe(false);
  });

  it("debt AND staged wait both present - debt wins (the restart is the smaller, always-available step)", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: { stagedVersion: "1.3.0-rc.4", blockingSessionCount: 2 },
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("waiting-to-activate");
    expect(view.targetVersion).toBe("1.3.0-rc.3");
  });

  it("a coarse 'updating' marker outranks the facts - a live updater is working right now, ahead of its own park", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: { state: "updating", error: null },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("updating");
  });

  it("a coarse 'failed' marker outranks the facts and keeps its failure text - real evidence, not papered over", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        coarseProgress: { state: "failed", error: "health probe failed" },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("failed");
    expect(view.errorMessage).toBe("health probe failed");
  });

  it("a genuine attempt record outranks the facts - the kind comes from the attempt's own phase", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: attemptOperation({ phase: "applying" }),
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("applying");
  });

  it("'unavailable' outranks the facts - fail-closed record evidence stays fail-closed", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "unavailable", reason: "corrupt", cause: null },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unavailable");
  });

  it("a STALE park decays to unknown, retaining lastKnownKind, the observed time, and the target version", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        freshUntilMs: NOW_MS - 1,
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("unknown");
    expect(view.lastKnownKind).toBe("waiting-to-activate");
    expect(view.lastObservedAtMs).toBe(NOW_MS);
    expect(view.targetVersion).toBe("1.3.0-rc.3");
  });

  it("neither park kind holds the lifecycle gate or earns the fast poll, and neither reads as quiet", () => {
    const debtView = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: { installedVersion: "1.3.0-rc.3" },
          stagedWait: null,
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    const stagedView = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: {
          activationDebt: null,
          stagedWait: { stagedVersion: "1.3.0-rc.4", blockingSessionCount: 2 },
        },
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(holdsLifecycleGate(debtView)).toBe(false);
    expect(holdsLifecycleGate(stagedView)).toBe(false);
    expect(warrantsFastPoll(debtView)).toBe(false);
    expect(warrantsFastPoll(stagedView)).toBe(false);
    expect(isQuietUpdateView(debtView)).toBe(false);
    expect(isQuietUpdateView(stagedView)).toBe(false);
  });

  // Regression pin: with `legacyFacts: null` (the fixture default) and no
  // coarse marker, `{kind:"none"}` must still fall through to plain `idle` -
  // exactly the pre-legacyFacts behaviour. Falsification: a bug that made
  // `legacyFactsView` return a non-null park for `legacyFacts: null` would
  // turn this into `waiting-to-activate` or `waiting-for-work`.
  it("legacyFacts: null with kind:'none' and no coarse marker still projects idle - unchanged from before this feature", () => {
    const view = projectFleetUpdateView({
      observation: observation({
        operation: { kind: "none" },
        legacyFacts: null,
      }),
      nowMs: NOW_MS,
      connected: true,
    });
    expect(view.kind).toBe("idle");
  });
});
