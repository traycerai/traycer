import { describe, expect, it } from "vitest";
import type {
  HostStatusUpdateOperation,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";
import {
  holdsLifecycleGate,
  offersForceRestart,
  projectFleetUpdateView,
  warrantsFastPoll,
  preferLiveOverRecord,
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
