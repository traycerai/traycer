import { describe, expect, it } from "vitest";
import type {
  HostStatusUpdateOperation,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  canonicalReadIsLive,
  observationFromCanonicalRead,
  type CanonicalReadHealth,
} from "@/lib/host/fleet-update/canonical-status-observation";
import { observationFromStatus } from "@/lib/host/fleet-update/borrowed-status-read";
import { projectFleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";

// This is the F1/F2 shared fix (independent cold review, finding 1): a
// canonical `host.status` read must carry its own freshness rather than being
// asserted as permanently current. `canonicalReadIsLive` is the health
// predicate; `observationFromCanonicalRead` is what stamps an already-expired
// deadline onto an unhealthy read WITHOUT touching the phase it carries — the
// stale-arm retention in `fleet-update-view.ts` is what turns that into a
// qualified "last seen" view.

const NOW_MS = 5_000_000;

function healthyHealth(): CanonicalReadHealth {
  return {
    isError: false,
    fetchStatus: "idle",
    isStale: false,
    hasLiveSource: true,
  };
}

const TRANSACTION: HostUpdateTransactionCapability = {
  recordSchemaVersion: 2,
  authority: "attempt",
};

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

function status(
  operation: HostStatusUpdateOperation,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: TRANSACTION,
  };
}

describe("canonicalReadIsLive — each demotion lane in isolation", () => {
  it("healthy (idle, not stale, error-free, live source) is live", () => {
    expect(canonicalReadIsLive(healthyHealth())).toBe(true);
  });

  it("isError demotes, regardless of every other signal", () => {
    expect(canonicalReadIsLive({ ...healthyHealth(), isError: true })).toBe(
      false,
    );
  });

  it("fetchStatus: 'paused' demotes — an offline client cannot claim a current reading", () => {
    expect(
      canonicalReadIsLive({ ...healthyHealth(), fetchStatus: "paused" }),
    ).toBe(false);
  });

  it("isStale with fetchStatus: 'idle' demotes — a missed refresh with nothing in flight", () => {
    expect(
      canonicalReadIsLive({
        ...healthyHealth(),
        isStale: true,
        fetchStatus: "idle",
      }),
    ).toBe(false);
  });

  it("hasLiveSource: false demotes even when every other signal looks healthy", () => {
    expect(
      canonicalReadIsLive({ ...healthyHealth(), hasLiveSource: false }),
    ).toBe(false);
  });

  it("fetchStatus: 'fetching' with isStale: true is still LIVE — no flicker in the refetch window", () => {
    expect(
      canonicalReadIsLive({
        ...healthyHealth(),
        isStale: true,
        fetchStatus: "fetching",
      }),
    ).toBe(true);
  });

  it("fetchStatus: 'fetching' does not override isError or hasLiveSource — those collapse first", () => {
    expect(
      canonicalReadIsLive({
        ...healthyHealth(),
        isError: true,
        fetchStatus: "fetching",
      }),
    ).toBe(false);
    expect(
      canonicalReadIsLive({
        ...healthyHealth(),
        hasLiveSource: false,
        fetchStatus: "fetching",
      }),
    ).toBe(false);
  });
});

describe("observationFromCanonicalRead", () => {
  it("a healthy read's deadline is IDENTICAL to observationFromStatus's own deadline for the same status/time", () => {
    const op = attemptOperation({});
    const expected = observationFromStatus({
      hostId: "host-a",
      status: status(op),
      nowMs: NOW_MS,
      source: "selected",
    });
    const actual = observationFromCanonicalRead({
      hostId: "host-a",
      status: status(op),
      dataUpdatedAt: NOW_MS,
      health: healthyHealth(),
      source: "selected",
    });
    expect(actual).toEqual(expected);
  });

  it("an unhealthy read still carries the phase, attempt id and target — but its deadline is already expired", () => {
    const op = attemptOperation({
      phase: "downloading",
      targetVersion: "3.0.0",
    });
    const observation = observationFromCanonicalRead({
      hostId: "host-a",
      status: status(op),
      dataUpdatedAt: NOW_MS,
      health: { ...healthyHealth(), isError: true },
      source: "selected",
    });
    expect(observation.operation).toEqual(op);
    // Already expired — `EXPIRED_FRESH_UNTIL_MS` is `Number.NEGATIVE_INFINITY`,
    // never `Number.POSITIVE_INFINITY`. Both are "not finite"; only one demotes.
    expect(observation.freshUntilMs).toBe(Number.NEGATIVE_INFINITY);
    expect(NOW_MS).toBeGreaterThan(observation.freshUntilMs);
  });

  it("THE RETAINED-ACTIVE DEFECT ITSELF: an active downloading read that goes unhealthy must NOT present as current", () => {
    // This is the exact scenario the independent cold review's finding 1
    // describes: a host reports an active downloading attempt and then the
    // read becomes unhealthy (error, paused, or aged past its own staleness
    // window) while the retained response still says "downloading". Before
    // the fix this module exists to make unrepeatable, the Overview built an
    // observation with `freshUntilMs: Infinity` here — which can never expire,
    // no matter how unhealthy the read becomes.
    const activeDownloading = attemptOperation({
      phase: "downloading",
      execution: "active",
    });
    const observation = observationFromCanonicalRead({
      hostId: "host-a",
      status: status(activeDownloading),
      dataUpdatedAt: NOW_MS,
      health: { ...healthyHealth(), isError: true },
      source: "selected",
    });
    // A finite, already-expired deadline is what lets `projectFleetUpdateView`
    // demote this to `unknown` — the ABLATION below shows what happens
    // without it.
    expect(observation.freshUntilMs).not.toBe(Number.POSITIVE_INFINITY);
    expect(observation.freshUntilMs).toBeLessThan(NOW_MS + 1);
  });

  it("ABLATION — drives the real production path: an unhealthy active-downloading read must demote through projectFleetUpdateView IMMEDIATELY, not eventually", () => {
    // Unlike the version this replaces (which compared a hand-built literal's
    // `freshUntilMs: Infinity` against `NOW_MS` — a tautology that never called
    // either production function and could not go red if the fix were
    // reverted), this drives BOTH real functions the fix touches:
    // `observationFromCanonicalRead` stamps the expiry, and
    // `projectFleetUpdateView` is what actually consumes it to decide whether
    // the host still reads as "downloading".
    //
    // `nowMs` is pinned to the SAME instant as `dataUpdatedAt` on purpose,
    // not pushed into the future: a merely finite (but short) freshness
    // window would also read as stale given enough elapsed time, which would
    // not discriminate a reverted guard from a working one. Only the real
    // guard's `EXPIRED_FRESH_UNTIL_MS` (`-Infinity`) is stale at the very
    // instant the read landed. If `observationFromCanonicalRead` ever
    // reverted to treating an unhealthy read as live (the old defect's
    // `freshUntilMs: Number.POSITIVE_INFINITY` construction, or simply
    // skipping the demotion), `view.kind` below would still read
    // "downloading" at this same instant, and this assertion — not a
    // comparison against a literal nobody produced — is what would catch it.
    const activeDownloading = attemptOperation({
      phase: "downloading",
      execution: "active",
    });
    const observation = observationFromCanonicalRead({
      hostId: "host-a",
      status: status(activeDownloading),
      dataUpdatedAt: NOW_MS,
      health: { ...healthyHealth(), isError: true },
      source: "selected",
    });
    const view = projectFleetUpdateView({
      observation,
      nowMs: NOW_MS,
      connected: true,
    });
    // The permanent-lock defect demoted to nothing: `kind` would still read
    // "downloading". The real fix demotes to a qualified `unknown` that still
    // remembers the phase, exactly like the direct-projection stale arm.
    expect(view.kind).toBe("unknown");
    expect(view.qualified).toBe(true);
    expect(view.lastKnownKind).toBe("downloading");
  });
});
