/** Wire-level copy of the host's Layer0Frame.  This is deliberately a real
 * discriminated union so the CLI mapping is exhaustive without importing the
 * internal host package into the OSS client tree. */
export type Layer0Frame =
  | { readonly attemptId: string; readonly layer0: "acquired" }
  | {
      readonly attemptId: string;
      readonly layer0: "declined";
      readonly incumbentEvidence: Layer0IncumbentEvidence;
    }
  | {
      readonly attemptId: string;
      readonly layer0: "degraded";
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    }
  | {
      readonly attemptId: string;
      readonly layer0: "unavailable";
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    };

export type Layer0IncumbentEvidence =
  | {
      readonly kind: "pid-metadata";
      readonly pid: number;
      readonly hostId: string;
      readonly startedAt: string;
    }
  | {
      readonly kind: "held-retry-window";
      readonly lockPath: string;
      readonly observedForMs: number;
    };

export type Layer0UnavailableCause =
  | "addon-load-failed"
  | "fs-unsupported"
  | "lock-path-invalid"
  | {
      readonly kind: "os-error";
      readonly syscall: string;
      readonly code: string;
      readonly fsType: string | null;
    };

export type ProbeMarkerOutcome =
  | {
      readonly kind: "awaiting-readiness";
      readonly attemptId: string;
      readonly degradation: Layer0Degradation | null;
    }
  | {
      readonly kind: "lock-declined";
      readonly attemptId: string;
      readonly incumbentEvidence: Layer0IncumbentEvidence;
    }
  | {
      readonly kind: "unavailable";
      readonly attemptId: string;
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    }
  | { readonly kind: "terminal"; readonly reason: string };

export type Layer0Degradation = {
  readonly cause: Layer0UnavailableCause;
  readonly evidence: string;
};

export type ProbeSupervisorAttestation = {
  readonly serviceLabel: string;
  readonly supervisorPid: number;
  readonly capturedAt: string;
};

export type ProbeMarker = {
  readonly v: 1;
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly serviceLabel: string;
  readonly supervisorPid: number;
  readonly attestation: ProbeSupervisorAttestation;
  readonly outcome: ProbeMarkerOutcome;
};

export type ProbeVerdict =
  | { readonly kind: "lock-declined" }
  | { readonly kind: "became-ready" }
  | { readonly kind: "terminal"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    }
  | { readonly kind: "indeterminate"; readonly reason: string };

/** Exhaustive Layer0Frame → supervisor marker mapping. */
export function mapLayer0FrameToProbeOutcome(
  frame: Layer0Frame,
): ProbeMarkerOutcome {
  switch (frame.layer0) {
    case "acquired":
      return {
        kind: "awaiting-readiness",
        attemptId: frame.attemptId,
        degradation: null,
      };
    case "declined":
      return {
        kind: "lock-declined",
        attemptId: frame.attemptId,
        incumbentEvidence: frame.incumbentEvidence,
      };
    case "degraded":
    case "unavailable":
      return {
        kind: "awaiting-readiness",
        attemptId: frame.attemptId,
        degradation: { cause: frame.cause, evidence: frame.evidence },
      };
    default:
      return exhaustiveFrame(frame);
  }
}

/**
 * The reconciler validates only evidence captured by the still-live producer.
 * It must not call launchctl after a fast decline: the short-lived supervisor
 * may already be gone by then.
 */
export function interpretProbeMarker(input: {
  readonly marker: ProbeMarker | null;
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly expectedServiceLabel: string;
  readonly readiness: {
    readonly kind: "ready" | "not-ready" | "indeterminate";
    readonly attemptId: string | null;
  };
}): ProbeVerdict {
  const marker = input.marker;
  if (marker === null) {
    return { kind: "indeterminate", reason: "marker-absent" };
  }
  if (
    marker.transitionId !== input.transitionId ||
    marker.probeNonce !== input.probeNonce ||
    marker.serviceLabel !== input.expectedServiceLabel
  ) {
    return { kind: "indeterminate", reason: "marker-uncorrelated" };
  }
  if (
    marker.attestation.serviceLabel !== marker.serviceLabel ||
    marker.attestation.supervisorPid !== marker.supervisorPid ||
    marker.attestation.capturedAt.length === 0
  ) {
    return { kind: "indeterminate", reason: "marker-attestation-invalid" };
  }
  switch (marker.outcome.kind) {
    case "lock-declined":
      return { kind: "lock-declined" };
    case "terminal":
      return { kind: "terminal", reason: marker.outcome.reason };
    case "unavailable":
      return {
        kind: "unavailable",
        cause: marker.outcome.cause,
        evidence: marker.outcome.evidence,
      };
    case "awaiting-readiness":
      if (
        input.readiness.kind === "ready" &&
        input.readiness.attemptId === marker.outcome.attemptId
      ) {
        // This is deliberately reconciler-derived: the supervisor never
        // self-reports success merely because Layer 0 acquired the lock.
        return { kind: "became-ready" };
      }
      return input.readiness.kind === "indeterminate"
        ? { kind: "indeterminate", reason: "readiness-indeterminate" }
        : { kind: "indeterminate", reason: "readiness-not-yet-observed" };
    default:
      return exhaustiveOutcome(marker.outcome);
  }
}

function exhaustiveFrame(frame: never): never {
  throw new Error(`Unhandled Layer0Frame: ${JSON.stringify(frame)}`);
}

function exhaustiveOutcome(outcome: never): never {
  throw new Error(`Unhandled probe marker outcome: ${JSON.stringify(outcome)}`);
}
