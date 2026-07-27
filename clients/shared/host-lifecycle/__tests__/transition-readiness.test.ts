import { describe, expect, it } from "vitest";
import {
  evaluateAttemptReadiness,
  type AttemptReadinessObservation,
} from "../transition/readiness";

const attemptId = "attempt-current";
const baseline = {
  priorPid: 41,
  markerIdentity: "before.log",
  markerLength: 20,
};

function observation(
  override: Partial<AttemptReadinessObservation>,
): AttemptReadinessObservation {
  return {
    launchdPid: 100,
    supervisorAttemptId: attemptId,
    supervisorPid: 100,
    attemptMarkerIdentity: "after.log",
    attemptMarkerLength: 42,
    pidMetadata: {
      pid: 101,
      hostId: "host",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:1111/rpc",
      startedAt: "2026-07-27T00:00:00.000Z",
      processStartTimeMs: 1,
    },
    pidGeneration: "generation-1",
    expectedGeneration: "generation-1",
    endpoint: "reachable",
    terminal: null,
    ...override,
  };
}

describe("evaluateAttemptReadiness", () => {
  it("accepts the real supervisor→child topology", () => {
    const result = evaluateAttemptReadiness({
      attemptId,
      baseline,
      observation: observation({}),
    });

    expect(result).toEqual({
      readiness: { kind: "ready", attemptId },
      highestRung: "endpoint",
    });
  });

  it("rejects a child pid that impersonates the launchd supervisor", () => {
    const result = evaluateAttemptReadiness({
      attemptId,
      baseline,
      observation: observation({
        pidMetadata: {
          pid: 100,
          hostId: "host",
          version: "1.0.0",
          websocketUrl: "ws://127.0.0.1:1111/rpc",
          startedAt: "2026-07-27T00:00:00.000Z",
          processStartTimeMs: 1,
        },
      }),
    });

    expect(result.highestRung).toBe("attempt-marker");
    expect(result.readiness.kind).toBe("in-progress");
  });

  it("does not allow an old marker or a stale terminal record to satisfy this attempt", () => {
    const staleMarker = evaluateAttemptReadiness({
      attemptId,
      baseline,
      observation: observation({
        attemptMarkerIdentity: "before.log",
        attemptMarkerLength: 20,
      }),
    });
    const staleTerminal = evaluateAttemptReadiness({
      attemptId,
      baseline,
      observation: observation({
        terminal: { attemptId: "attempt-prior", reason: "child-exit-1" },
      }),
    });

    expect(staleMarker.highestRung).toBe("supervisor-pid");
    expect(staleMarker.readiness.kind).toBe("in-progress");
    expect(staleTerminal.readiness).toEqual({ kind: "ready", attemptId });
  });

  it("fails only for a terminal marker scoped to this attempt", () => {
    const result = evaluateAttemptReadiness({
      attemptId,
      baseline,
      observation: observation({
        terminal: { attemptId, reason: "child-exit-0" },
      }),
    });

    expect(result.readiness).toEqual({
      kind: "failed",
      attemptId,
      reason: "child-exit-0",
    });
  });
});
