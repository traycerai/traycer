import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import type { Evidence } from "../evidence";
import type { Reachability } from "./reachability";

/**
 * pid.json identity fields the probe cares about.
 *
 * `startedAt` is readiness publication time (existing field).
 * `processStartTimeMs` is the OS process start time (D1 / Windows annex §1.5
 * creation-time reader). Records written by shipped versions lack it —
 * absence is `null`, never a decode failure.
 */
export type HostPidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  /** Milliseconds since epoch; null when the field is absent (legacy). */
  readonly processStartTimeMs: number | null;
  /**
   * The kernel's own creation stamp for the publishing process, immune to
   * wall-clock adjustment. Null when absent (legacy) or malformed, which
   * means "cannot compare identity" and never "different process".
   */
  readonly processStartIdentity: ProcessStartIdentity | null;
};

/**
 * Platform-shared host process evidence. `pidMetadata` uses Evidence so
 * corrupt / unreadable bytes never become "absent" for the planner.
 * (Cause is a free string here; platform wrappers rebind as needed.)
 */
export type HostProcessEvidence = {
  readonly pidMetadata: Evidence<HostPidMetadata>;
  readonly pidLiveness: Evidence<boolean>;
  readonly endpoint: Reachability;
  readonly attemptScoped: AttemptReadiness;
};

/**
 * Attempt-scoped readiness rungs (plan F10). T3 only carries the evidence
 * shape — rung acceptance policy is the readiness oracle (later tickets).
 */
export type AttemptReadiness =
  | { readonly kind: "no-attempt" }
  | {
      readonly kind: "in-progress";
      readonly attemptId: string;
      readonly highestRung: ReadinessRung;
    }
  | {
      readonly kind: "ready";
      readonly attemptId: string;
    }
  | {
      readonly kind: "failed";
      readonly attemptId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "indeterminate";
      readonly cause: string;
    };

export type ReadinessRung =
  | "baseline"
  | "supervisor-pid"
  | "attempt-marker"
  | "pid-metadata"
  | "endpoint";

/** Closed causes for pid.json decode — mapped to platform unions at probe edge. */
export type PidMetadataDecodeCause = "corrupt" | "malformed" | "unreadable";

/**
 * Pure decode of pid.json text → Evidence. Does not throw; corrupt JSON
 * becomes indeterminate("corrupt"), missing fields indeterminate.
 */
export function decodeHostPidMetadata(
  text: string | null,
  readError: string | null,
): Evidence<HostPidMetadata, PidMetadataDecodeCause> {
  if (readError !== null) {
    return { kind: "indeterminate", cause: "unreadable" };
  }
  if (text === null) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "indeterminate", cause: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "indeterminate", cause: "corrupt" };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.hostId !== "string" ||
    typeof obj.version !== "string" ||
    typeof obj.websocketUrl !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return { kind: "indeterminate", cause: "malformed" };
  }
  // processStartTimeMs is additive (D1). Missing or non-number → null so
  // the creation-time reader is simply unavailable — never corrupt/malformed.
  const processStartTimeMs =
    typeof obj.processStartTimeMs === "number" &&
    Number.isFinite(obj.processStartTimeMs)
      ? obj.processStartTimeMs
      : null;
  return {
    kind: "observed",
    value: {
      pid: obj.pid,
      hostId: obj.hostId,
      version: obj.version,
      websocketUrl: obj.websocketUrl,
      startedAt: obj.startedAt,
      processStartTimeMs,
      processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
        ? obj.processStartIdentity
        : null,
    },
  };
}

/** Map shared pid decode causes onto a platform indeterminate union arm. */
export function mapPidMetadataEvidence<Cause extends string>(
  evidence: Evidence<HostPidMetadata, PidMetadataDecodeCause>,
  mapCause: (cause: PidMetadataDecodeCause) => Cause,
): Evidence<HostPidMetadata, Cause> {
  if (evidence.kind === "observed") {
    return { kind: "observed", value: evidence.value };
  }
  if (evidence.kind === "absent") {
    return { kind: "absent" };
  }
  return { kind: "indeterminate", cause: mapCause(evidence.cause) };
}
