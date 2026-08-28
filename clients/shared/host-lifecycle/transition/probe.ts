// The Layer 0 frame is a host -> client wire payload, so `@traycer/protocol`
// owns it and both sides import the same declaration.
//
// This file used to carry a hand-written "wire-level copy" of the host's
// union, justified as keeping the internal host package out of the OSS client
// tree - which was a real constraint but the wrong remedy. The copy drifted:
// it kept a fourth `layer0: "unavailable"` variant the host cannot emit, and
// `transition-probe.test.ts` asserted exhaustiveness over the COPY, so the
// one test meant to catch drift was structurally unable to see it.
import type {
  Layer0Frame,
  Layer0IncumbentEvidence,
  Layer0UnavailableCause,
} from "@traycer/protocol/host/lifecycle";

export type { Layer0Frame, Layer0IncumbentEvidence, Layer0UnavailableCause };

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
      // A degraded lock is still a START. Layer 0 is fail-open by decided
      // policy, so this maps to the same awaiting-readiness outcome as
      // `acquired`, carrying the degradation for the record rather than as a
      // reason to stop.
      return {
        kind: "awaiting-readiness",
        attemptId: frame.attemptId,
        degradation: { cause: frame.cause, evidence: frame.evidence },
      };
    default:
      // Now genuinely reachable only by a host-side addition: the union is
      // imported from `@traycer/protocol`, so a new arm there turns this into
      // a compile error here rather than a silently-unhandled frame. That is
      // the property the old hand-copy could not have.
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
