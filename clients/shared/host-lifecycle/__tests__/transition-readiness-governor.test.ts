import { describe, expect, it } from "vitest";
import {
  EMPTY_TRANSITION_GOVERNOR,
  evaluateGovernorEligibility,
  recordTransitionFailure,
  recordSustainedTransitionHealth,
} from "../transition/governor";
import {
  createTransitionJournal,
  failTransitionJournal,
  finishTransitionJournal,
} from "../transition/journal";
import { decodeTransitionJournal } from "../durable/decoder";
import {
  waitForAttemptReadiness,
  type AttemptReadinessObservation,
} from "../transition/readiness";

const BASELINE = { priorPid: 1, markerIdentity: null, markerLength: 0 };

function observation(
  overrides: Partial<AttemptReadinessObservation>,
): AttemptReadinessObservation {
  return {
    launchdPid: 2,
    supervisorAttemptId: "attempt-1",
    supervisorPid: 2,
    attemptMarkerIdentity: "marker-1",
    attemptMarkerLength: 1,
    pidMetadata: null,
    pidGeneration: null,
    expectedGeneration: null,
    endpoint: "unreachable",
    terminal: null,
    ...overrides,
  };
}

describe("T6 readiness polling and governor durability", () => {
  it("calls the polling oracle and lets observed rung progress earn time for endpoint readiness", async () => {
    let clock = 0;
    const observations = [
      observation({}),
      observation({
        pidMetadata: {
          pid: 3,
          hostId: "host-1",
          websocketUrl: "ws://127.0.0.1:1/rpc",
          version: "test",
          startedAt: "2026-07-27T00:00:00.000Z",
          processStartTimeMs: 1,
        },
        endpoint: "reachable",
      }),
    ];
    let calls = 0;

    const result = await waitForAttemptReadiness(
      {
        observe: async () =>
          observations[Math.min(calls++, observations.length - 1)] ??
          observation({}),
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
      },
      {
        attemptId: "attempt-1",
        baseline: BASELINE,
        initialBudgetMs: 1,
        progressExtensionMs: 10,
        maximumBudgetMs: 20,
        pollIntervalMs: 1,
      },
    );

    expect(result).toMatchObject({
      readiness: { kind: "ready", attemptId: "attempt-1" },
      highestRung: "endpoint",
    });
    expect(calls).toBe(2);
  });

  it("retries an indeterminate endpoint probe while readiness budget remains", async () => {
    let clock = 0;
    let calls = 0;
    const endpointMetadata = {
      pid: 3,
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:1/rpc",
      version: "test",
      startedAt: "2026-07-27T00:00:00.000Z",
      processStartTimeMs: 1,
    };
    const result = await waitForAttemptReadiness(
      {
        observe: async () => {
          calls += 1;
          return observation({
            pidMetadata: endpointMetadata,
            endpoint: calls === 1 ? "indeterminate" : "reachable",
          });
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
      },
      {
        attemptId: "attempt-1",
        baseline: BASELINE,
        initialBudgetMs: 5,
        progressExtensionMs: 5,
        maximumBudgetMs: 10,
        pollIntervalMs: 1,
      },
    );

    expect(result).toMatchObject({
      readiness: { kind: "ready", attemptId: "attempt-1" },
      highestRung: "endpoint",
    });
    expect(calls).toBe(2);
  });

  it("uses the production probe:poll cadence ratio and extends past the initial deadline for late progress", async () => {
    let clock = 0;
    let calls = 0;
    const endpointReady = observation({
      pidMetadata: {
        pid: 3,
        hostId: "host-1",
        websocketUrl: "ws://127.0.0.1:1/rpc",
        version: "test",
        startedAt: "2026-07-27T00:00:00.000Z",
        processStartTimeMs: 1,
      },
      endpoint: "reachable",
    });

    const result = await waitForAttemptReadiness(
      {
        observe: async () => {
          calls += 1;
          if (clock < 29_000) {
            return observation({
              attemptMarkerIdentity: null,
              attemptMarkerLength: 0,
            });
          }
          if (clock < 35_000) return observation({});
          return endpointReady;
        },
        sleep: async (milliseconds) => {
          // This is a virtual clock, but these are the production cadence
          // values: 1s polls, 30s initial budget, 15s earned extension, 90s
          // absolute ceiling. The test proves their actual ratio/contract
          // without spending a wall-clock minute in CI.
          expect(milliseconds).toBe(1_000);
          clock += milliseconds;
        },
        now: () => clock,
      },
      {
        attemptId: "attempt-1",
        baseline: BASELINE,
        initialBudgetMs: 30_000,
        progressExtensionMs: 15_000,
        maximumBudgetMs: 90_000,
        pollIntervalMs: 1_000,
      },
    );

    expect(result).toMatchObject({
      readiness: { kind: "ready", attemptId: "attempt-1" },
      highestRung: "endpoint",
    });
    // Marker progress appears at 29s and earns 15s more (deadline 44s), so
    // endpoint readiness at 35s passes. Removing extension would time out
    // after the 30s initial budget.
    expect(clock).toBe(35_000);
    expect(calls).toBe(36);
  });

  it("times out at the initial production budget when no new readiness rung appears", async () => {
    let clock = 0;
    const result = await waitForAttemptReadiness(
      {
        observe: async () =>
          observation({
            launchdPid: null,
            supervisorAttemptId: null,
            supervisorPid: null,
            attemptMarkerIdentity: null,
            attemptMarkerLength: 0,
          }),
        sleep: async (milliseconds) => {
          expect(milliseconds).toBe(1_000);
          clock += milliseconds;
        },
        now: () => clock,
      },
      {
        attemptId: "attempt-1",
        baseline: BASELINE,
        initialBudgetMs: 30_000,
        progressExtensionMs: 15_000,
        maximumBudgetMs: 90_000,
        pollIntervalMs: 1_000,
      },
    );

    expect(result).toEqual({
      readiness: {
        kind: "failed",
        attemptId: "attempt-1",
        reason: "readiness-timeout",
      },
      highestRung: "baseline",
    });
    expect(clock).toBe(31_000);
  });

  it("never extends beyond the hard readiness cap even when a late rung progresses", async () => {
    let clock = 0;
    const result = await waitForAttemptReadiness(
      {
        observe: async () =>
          clock < 59_000
            ? observation({
                launchdPid: null,
                supervisorAttemptId: null,
                supervisorPid: null,
                attemptMarkerIdentity: null,
                attemptMarkerLength: 0,
              })
            : observation({}),
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
      },
      {
        attemptId: "attempt-1",
        baseline: BASELINE,
        initialBudgetMs: 60_000,
        progressExtensionMs: 60_000,
        maximumBudgetMs: 90_000,
        pollIntervalMs: 1_000,
      },
    );

    expect(result).toMatchObject({
      readiness: { kind: "failed", reason: "readiness-timeout" },
      highestRung: "attempt-marker",
    });
    expect(clock).toBe(91_000);
  });

  it("bounds ping-pong with persisted backoff/breaker and permits a CDHash bypass only for LWCR", () => {
    const first = recordTransitionFailure({
      previous: EMPTY_TRANSITION_GOVERNOR,
      failureClass: "indeterminate",
      buildId: "build-1",
      cdHash: "hash-1",
      now: "2026-07-27T00:00:00.000Z",
      nextEligibleAt: "2026-07-27T00:05:00.000Z",
      breakerAfterAttempts: 3,
    });
    expect(
      evaluateGovernorEligibility({
        governor: first,
        now: "2026-07-27T00:01:00.000Z",
        cdHash: "hash-2",
      }),
    ).toEqual({ kind: "blocked", until: "2026-07-27T00:05:00.000Z" });
    expect(
      evaluateGovernorEligibility({
        governor: first,
        now: "2026-07-27T00:05:00.000Z",
        cdHash: "hash-1",
      }),
    ).toEqual({ kind: "eligible", reason: "elapsed" });

    const second = recordTransitionFailure({
      previous: first,
      failureClass: "indeterminate",
      buildId: "build-1",
      cdHash: "hash-1",
      now: "2026-07-27T00:05:00.000Z",
      nextEligibleAt: "2026-07-27T00:10:00.000Z",
      breakerAfterAttempts: 3,
    });
    const terminalJournal = failTransitionJournal({
      journal: createTransitionJournal({
        transitionId: "transition-1",
        probeNonce: "probe-nonce-1",
        kind: "reclaim",
        from: "raw-fallback",
        to: "smappservice",
        phase: "reclaim-awaiting-probe",
        expectedIdentities: ["identity-1"],
        startedAt: "2026-07-27T00:10:00.000Z",
        governor: second,
      }),
      failureClass: "indeterminate",
      buildId: "build-1",
      cdHash: "hash-1",
      now: "2026-07-27T00:10:00.000Z",
      nextEligibleAt: "2026-07-27T00:15:00.000Z",
      breakerAfterAttempts: 3,
    });
    const decodedAfterRestart = decodeTransitionJournal({
      kind: "bytes",
      text: JSON.stringify(terminalJournal),
    });
    if (
      decodedAfterRestart.kind !== "valid" ||
      decodedAfterRestart.value.governor === null
    ) {
      throw new Error(
        "Expected terminal journal governor to survive durable decode",
      );
    }
    const recoveredAfterRestart = decodedAfterRestart.value.governor;
    expect(recoveredAfterRestart).toMatchObject({
      attemptCount: 3,
      breaker: "open",
    });
    expect(
      evaluateGovernorEligibility({
        governor: recoveredAfterRestart,
        now: "2026-07-27T01:00:00.000Z",
        cdHash: "hash-new",
      }),
    ).toEqual({ kind: "eligible", reason: "elapsed" });

    const lwcr = recordTransitionFailure({
      previous: EMPTY_TRANSITION_GOVERNOR,
      failureClass: "lwcr",
      buildId: "build-1",
      cdHash: "hash-old",
      now: "2026-07-27T00:00:00.000Z",
      nextEligibleAt: "2099-01-01T00:00:00.000Z",
      breakerAfterAttempts: 3,
    });
    expect(
      evaluateGovernorEligibility({
        governor: lwcr,
        now: "2026-07-27T00:01:00.000Z",
        cdHash: "hash-new",
      }),
    ).toEqual({ kind: "eligible", reason: "lwcr-cdhash-change" });
  });

  it("reports a usable breaker retry time and clears it in a successful transition terminal write", () => {
    const blocked = {
      ...EMPTY_TRANSITION_GOVERNOR,
      failureClass: "indeterminate" as const,
      attemptCount: 3,
      nextEligibleAt: "2099-01-01T00:00:00.000Z",
      breaker: "open" as const,
    };
    expect(
      evaluateGovernorEligibility({
        governor: blocked,
        now: "2026-07-27T00:00:00.000Z",
        cdHash: "same",
      }),
    ).toEqual({ kind: "blocked", until: "2099-01-01T00:00:00.000Z" });

    const healthy = recordSustainedTransitionHealth({
      previous: blocked,
      at: "2026-07-27T00:10:00.000Z",
    });

    expect(healthy).toMatchObject({
      attemptCount: 0,
      failureClass: null,
      breaker: null,
      lastSustainedHealthAt: "2026-07-27T00:10:00.000Z",
    });
    expect(
      evaluateGovernorEligibility({
        governor: healthy,
        now: "2026-07-27T00:10:00.000Z",
        cdHash: "same",
      }),
    ).toEqual({ kind: "eligible", reason: "initial" });

    const finished = finishTransitionJournal({
      journal: createTransitionJournal({
        transitionId: "successful-transition",
        probeNonce: "nonce",
        kind: "fallback",
        from: "smappservice",
        to: "raw-fallback",
        phase: "fallback-committing",
        expectedIdentities: ["fallback"],
        startedAt: "2026-07-27T00:10:00.000Z",
        governor: blocked,
      }),
      outcome: "done",
      now: "2026-07-27T00:10:00.000Z",
    });
    expect(finished.governor).toMatchObject({
      attemptCount: 0,
      breaker: null,
      lastSustainedHealthAt: "2026-07-27T00:10:00.000Z",
    });
  });
});
