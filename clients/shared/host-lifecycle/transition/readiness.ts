import type {
  AttemptReadiness,
  HostPidMetadata,
  ReadinessRung,
} from "../shared/host-process";

export type ReadinessBaseline = {
  readonly priorPid: number | null;
  readonly markerIdentity: string | null;
  readonly markerLength: number;
};

export type AttemptReadinessObservation = {
  /** PID reported for the launchd registration currently under observation. */
  readonly launchdPid: number | null;
  /** Attempt marker written by the live supervisor, not the host child. */
  readonly supervisorAttemptId: string | null;
  readonly supervisorPid: number | null;
  readonly attemptMarkerIdentity: string | null;
  readonly attemptMarkerLength: number;
  readonly pidMetadata: HostPidMetadata | null;
  readonly pidGeneration: string | null;
  readonly expectedGeneration: string | null;
  readonly endpoint: "reachable" | "unreachable" | "indeterminate";
  /** A terminal marker is authoritative only for the same attempt. */
  readonly terminal: {
    readonly attemptId: string;
    readonly reason: string;
  } | null;
};

export type AttemptReadinessEvaluation = {
  readonly readiness: AttemptReadiness;
  readonly highestRung: ReadinessRung;
};

/**
 * The oracle is intentionally strict: old pid.json, an outgoing endpoint, or
 * an earlier supervisor marker can never satisfy an incoming attempt.  The
 * caller preserves the baseline itself; this function evaluates only current
 * attempt-scoped observations.
 */
export function evaluateAttemptReadiness(input: {
  readonly attemptId: string;
  readonly baseline: ReadinessBaseline;
  readonly observation: AttemptReadinessObservation;
}): AttemptReadinessEvaluation {
  const baseline: AttemptReadinessEvaluation = {
    readiness: {
      kind: "in-progress",
      attemptId: input.attemptId,
      highestRung: "baseline",
    },
    highestRung: "baseline",
  };
  if (
    input.observation.terminal !== null &&
    input.observation.terminal.attemptId === input.attemptId
  ) {
    return {
      readiness: {
        kind: "failed",
        attemptId: input.attemptId,
        reason: input.observation.terminal.reason,
      },
      highestRung: "baseline",
    };
  }
  if (input.observation.launchdPid === null) return baseline;

  const supervisor: AttemptReadinessEvaluation = {
    readiness: {
      kind: "in-progress",
      attemptId: input.attemptId,
      highestRung: "supervisor-pid",
    },
    highestRung: "supervisor-pid",
  };
  if (
    input.observation.supervisorAttemptId !== input.attemptId ||
    input.observation.supervisorPid !== input.observation.launchdPid ||
    !isFreshAttemptMarker(input.baseline, input.observation)
  ) {
    return supervisor;
  }

  const marker: AttemptReadinessEvaluation = {
    readiness: {
      kind: "in-progress",
      attemptId: input.attemptId,
      highestRung: "attempt-marker",
    },
    highestRung: "attempt-marker",
  };
  const pid = input.observation.pidMetadata;
  if (
    pid === null ||
    // The supervisor is the launchd job. The host is its child and therefore
    // must publish a distinct pid. Equating the two made every legitimate
    // supervisor→child attempt permanently stop at its attempt marker.
    pid.pid === input.observation.launchdPid ||
    pid.pid === input.baseline.priorPid ||
    (input.observation.expectedGeneration !== null &&
      input.observation.pidGeneration !== input.observation.expectedGeneration)
  ) {
    return marker;
  }

  const metadata: AttemptReadinessEvaluation = {
    readiness: {
      kind: "in-progress",
      attemptId: input.attemptId,
      highestRung: "pid-metadata",
    },
    highestRung: "pid-metadata",
  };
  if (input.observation.endpoint === "indeterminate") {
    return {
      readiness: { kind: "indeterminate", cause: "endpoint-probe" },
      highestRung: "pid-metadata",
    };
  }
  if (input.observation.endpoint !== "reachable") return metadata;
  return {
    readiness: { kind: "ready", attemptId: input.attemptId },
    highestRung: "endpoint",
  };
}

function isFreshAttemptMarker(
  baseline: ReadinessBaseline,
  observation: AttemptReadinessObservation,
): boolean {
  if (observation.attemptMarkerIdentity === null) return false;
  return (
    observation.attemptMarkerIdentity !== baseline.markerIdentity ||
    observation.attemptMarkerLength > baseline.markerLength
  );
}

export type ReadinessPollingDeps = {
  readonly observe: () => Promise<AttemptReadinessObservation>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
};

export type ReadinessPollingOptions = {
  readonly attemptId: string;
  readonly baseline: ReadinessBaseline;
  readonly initialBudgetMs: number;
  readonly progressExtensionMs: number;
  readonly maximumBudgetMs: number;
  readonly pollIntervalMs: number;
};

/**
 * Production callers pass their real cadence.  Progress earns extra budget;
 * stalled attempts do not endlessly wait behind an outgoing healthy host.
 */
export async function waitForAttemptReadiness(
  deps: ReadinessPollingDeps,
  options: ReadinessPollingOptions,
): Promise<AttemptReadinessEvaluation> {
  const startedAt = deps.now();
  let deadline = startedAt + options.initialBudgetMs;
  const hardDeadline = startedAt + options.maximumBudgetMs;
  let highest: ReadinessRung = "baseline";

  while (deps.now() <= deadline) {
    const evaluation = evaluateAttemptReadiness({
      attemptId: options.attemptId,
      baseline: options.baseline,
      observation: await deps.observe(),
    });
    if (
      evaluation.readiness.kind === "ready" ||
      evaluation.readiness.kind === "failed"
    ) {
      return evaluation;
    }
    if (rungRank(evaluation.highestRung) > rungRank(highest)) {
      highest = evaluation.highestRung;
      deadline = Math.min(
        hardDeadline,
        Math.max(deadline, deps.now() + options.progressExtensionMs),
      );
    }
    await deps.sleep(options.pollIntervalMs);
  }
  return {
    readiness: {
      kind: "failed",
      attemptId: options.attemptId,
      reason: "readiness-timeout",
    },
    highestRung: highest,
  };
}

function rungRank(rung: ReadinessRung): number {
  switch (rung) {
    case "baseline":
      return 0;
    case "supervisor-pid":
      return 1;
    case "attempt-marker":
      return 2;
    case "pid-metadata":
      return 3;
    case "endpoint":
      return 4;
    default:
      return exhaustiveRung(rung);
  }
}

function exhaustiveRung(rung: never): never {
  throw new Error(`Unhandled readiness rung: ${rung}`);
}
