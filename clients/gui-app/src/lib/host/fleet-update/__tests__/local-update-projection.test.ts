import { describe, expect, it } from "vitest";
import type { HostStatusUpdateOperation } from "@traycer/protocol/host/status/index";
import { projectLocalUpdate } from "@/lib/host/fleet-update/local-update-projection";
import {
  holdsLifecycleGate,
  warrantsFastPoll,
  LOCAL_LIVENESS_PROOF_MS,
  type FleetUpdateRecordObservation,
  type FleetUpdateWireObservation,
} from "@/lib/host/fleet-update/fleet-update-view";

// `projectLocalUpdate` is the ONE precedence-plus-projection the landing
// banner's hook and the selected-host Overview share. Its whole subject is
// which of the two legs answers, and — since cold review C — which CLOCK each
// leg is answering against.

const NOW_MS = 1_000_000;

/**
 * The fresh window while an update is ACTIVE: `observationFromCanonicalRead`
 * derives `freshUntilMs` as `dataUpdatedAt + 2.5 × pollDelay`, and the
 * accelerator drives the poll to 2 s during an attempt — so 5 s.
 *
 * That is the window a slow round trip has to BREACH for the regression to
 * bite, not the latency itself: a relayed `host.status` can take several
 * seconds, and it is the ones that overrun 5 s that a shared clock would read
 * as the host having stopped reporting.
 */
const ACTIVE_FRESH_WINDOW_MS = 5_000;

/** A round trip that overruns the window above — the case under test. */
const LATE_ROUND_TRIP_MS = ACTIVE_FRESH_WINDOW_MS + 1_000;

function wireObservation(
  overrides: Partial<FleetUpdateWireObservation>,
): FleetUpdateWireObservation {
  return {
    hostId: "host-1",
    source: "selected",
    observedAtMs: NOW_MS,
    freshUntilMs: NOW_MS + ACTIVE_FRESH_WINDOW_MS,
    operation: attemptOperation({}),
    transaction: { recordSchemaVersion: 2, authority: "attempt" },
    coarseProgress: null,
    legacyFacts: null,
    ...overrides,
  };
}

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
    phase: "restarting",
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

function recordObservation(
  overrides: Partial<FleetUpdateRecordObservation>,
): FleetUpdateRecordObservation {
  return {
    hostId: "host-1",
    source: "durable-record",
    observedAtMs: NOW_MS,
    attemptId: "attempt-1",
    targetVersion: "2.1.0",
    phase: "restarting",
    liveness: "unknown",
    livenessObservedAtMs: null,
    updatedAt: new Date(NOW_MS).toISOString(),
    generation: 1,
    sequence: 1,
    ...overrides,
  };
}

describe("projectLocalUpdate — the wire leg is NOT aged by the record leg's tick (cold review C, F3)", () => {
  it("a live attempt whose next poll overruns the fresh window keeps its kind, the lifecycle gate and the fast poll — and still OUTRANKS the record", () => {
    // THE PIN. A slow `host.status` round trip is not a state change on the
    // host, and the wire read's own deadline says so: `freshUntilMs` was
    // derived from the same `dataUpdatedAt` this is measured against, with the
    // query's health already folded in, so a HEALTHY read is fresh by
    // construction and only health demotes it.
    //
    // Falsifies BOTH consumers of `wireNowMs`, which is why the record below
    // is not `null`:
    //
    //  - PRECEDENCE (`preferLiveOverRecord`'s `clock.wireNowMs <=
    //    wire.freshUntilMs`). With `record: null` that function returns before
    //    it reads a clock at all, so the freshness line there would be free to
    //    take `recordNowMs` with nothing red. Handing it a record — one that
    //    would win on a stale wire, same attempt, one `sequence` ahead — makes
    //    the comparison decide, and `observation.source` is what it decided.
    //  - PROJECTION (`projectFleetUpdateView`'s `nowMs > freshUntilMs`), via
    //    `projectLocalUpdate` routing the winner to `wireNowMs`.
    //
    // The tick below has moved past the 5 s active fresh window, so a single
    // shared clock demotes this to `unknown` + "last seen", hands the slot to
    // the record, releases the page-wide lifecycle gate mid-restart, and drops
    // the fast poll that was keeping the wire caught up. Every cycle, on a
    // host that is answering perfectly well and is merely far away.
    const wireReadAtMs = NOW_MS;
    const tickMs = wireReadAtMs + LATE_ROUND_TRIP_MS;
    const projection = projectLocalUpdate({
      wire: wireObservation({ observedAtMs: wireReadAtMs }),
      record: recordObservation({ sequence: 2 }),
      clock: { wireNowMs: wireReadAtMs, recordNowMs: tickMs },
      connected: true,
    });
    expect(projection.observation?.source).toBe("selected");
    expect(projection.view.kind).toBe("restarting");
    expect(projection.view.lastKnownKind).toBeNull();
    expect(holdsLifecycleGate(projection.view)).toBe(true);
    expect(warrantsFastPoll(projection.view)).toBe(true);
  });

  it("the SAME wire read demoted by its OWN instant still decays — this is a clock split, not an exemption", () => {
    // The other half of the pin, so nobody "fixes" F3 by making the wire leg
    // unconditionally fresh. Health is what demotes a wire read, and
    // `observationFromCanonicalRead` expresses that by stamping an unhealthy
    // read's `freshUntilMs` in the past — which this models directly.
    const wireReadAtMs = NOW_MS;
    const projection = projectLocalUpdate({
      wire: wireObservation({
        observedAtMs: wireReadAtMs,
        freshUntilMs: wireReadAtMs - 1,
      }),
      record: null,
      clock: { wireNowMs: wireReadAtMs, recordNowMs: wireReadAtMs },
      connected: true,
    });
    expect(projection.view.kind).toBe("unknown");
    // `restarting`, not `reconnecting`: the WIRE arm reads the caller's
    // `connected` vantage, and this call passes `true`. Only the record arm
    // hard-codes `false` (reading a record IS the disconnected vantage).
    expect(projection.view.lastKnownKind).toBe("restarting");
    expect(holdsLifecycleGate(projection.view)).toBe(false);
  });

  it("the record leg's proof is still aged by the TICK while the wire instant stands still", () => {
    // The complement, and the reason the two instants cannot simply be
    // collapsed onto `dataUpdatedAt` either: with no wire read at all the
    // record answers, and its five-second proof must expire on a clock that
    // keeps moving while the host is down. Only `recordNowMs` differs between
    // the two calls below — `wireNowMs` is passed but never consulted here,
    // since `preferLiveOverRecord` returns the record before reading a clock
    // when there is no wire at all. The pin above is the one that holds the
    // wire instant's own consumers.
    const probeAtMs = NOW_MS;
    const record = recordObservation({
      liveness: "live",
      livenessObservedAtMs: probeAtMs,
    });
    const fresh = projectLocalUpdate({
      wire: null,
      record,
      clock: { wireNowMs: probeAtMs, recordNowMs: probeAtMs },
      connected: false,
    });
    expect(fresh.view.kind).toBe("restarting");
    expect(holdsLifecycleGate(fresh.view)).toBe(true);

    const expired = projectLocalUpdate({
      wire: null,
      record,
      clock: {
        wireNowMs: probeAtMs,
        recordNowMs: probeAtMs + LOCAL_LIVENESS_PROOF_MS + 1,
      },
      connected: false,
    });
    expect(expired.view.kind).toBe("unknown");
    expect(holdsLifecycleGate(expired.view)).toBe(false);
  });

  it("a stale wire read hands over to the record, whose proof is then judged on the tick", () => {
    // The two legs meeting: the wire is stale on its OWN instant (health
    // demoted it), so the record wins precedence — and the winner is then
    // projected against the record's clock, not the wire's. If
    // `projectLocalUpdate` routed the winner to `wireNowMs`, this proof would
    // read as fresh forever, which is the same frozen-deadline defect from the
    // other direction.
    const wireReadAtMs = NOW_MS;
    const projection = projectLocalUpdate({
      wire: wireObservation({
        observedAtMs: wireReadAtMs,
        freshUntilMs: wireReadAtMs - 1,
        operation: attemptOperation({ attemptId: "attempt-0" }),
      }),
      record: recordObservation({
        liveness: "live",
        livenessObservedAtMs: wireReadAtMs,
      }),
      clock: {
        wireNowMs: wireReadAtMs,
        recordNowMs: wireReadAtMs + LOCAL_LIVENESS_PROOF_MS + 1,
      },
      connected: false,
    });
    expect(projection.observation?.source).toBe("durable-record");
    expect(projection.view.kind).toBe("unknown");
    expect(holdsLifecycleGate(projection.view)).toBe(false);
  });
});
