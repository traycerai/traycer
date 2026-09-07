import {
  compareProcessStartIdentity,
  isProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle/process-start-identity";
import type {
  HostUpdateAttemptRead,
  HostUpdateAttemptRecord,
} from "@traycer/protocol/config/host-update-attempt";

// Read-side interruption derivation (§1.5), plus the pure half of the attempt-lock holder probe.
// `@traycer-clients/shared/host-update/lock.ts` owns the probe for the CLI and the desktop; it sits on `host-lock/cross-process-lock` + `host-lock/process-identity`, which `traycer-host` cannot import.

/**
 * How long an ACTIVE record may go without a write before a missing holder is allowed to mean interruption.
 */
export const RECOMMENDED_ATTEMPT_STALENESS_MS = 120_000;

export type AttemptLiveness =
  /** No attempt on disk. */
  | { readonly kind: "none" }
  /** A segment is running, or recently was and may still be. */
  | { readonly kind: "active"; readonly record: HostUpdateAttemptRecord }
  /** Holder absence is intentional. Never interrupted, at any age. */
  | { readonly kind: "parked"; readonly record: HostUpdateAttemptRecord }
  | { readonly kind: "terminal"; readonly record: HostUpdateAttemptRecord }
  /** Stale, active, and positively unheld. */
  | { readonly kind: "interrupted"; readonly record: HostUpdateAttemptRecord }
  /**
   * Nothing could be established.
   * Covers a fail-closed record (corrupt, unreadable, unsupported version) and an active record whose holder could not be judged either way.
   */
  | {
      readonly kind: "indeterminate";
      readonly cause: string;
      readonly record: HostUpdateAttemptRecord | null;
    };

/** The minimum `deriveAttemptLiveness` reads of a holder observation. */
export type AttemptHolderObservation =
  | { readonly kind: "no-holder" }
  | { readonly kind: "holder-live" }
  | { readonly kind: "indeterminate"; readonly cause: string };

export interface AttemptLivenessInput {
  readonly current: HostUpdateAttemptRead;
  readonly holder: AttemptHolderObservation;
  readonly nowMs: number;
  readonly stalenessMs: number;
}

export function deriveAttemptLiveness(
  input: AttemptLivenessInput,
): AttemptLiveness {
  const { current, holder, nowMs, stalenessMs } = input;

  if (current.kind === "absent") return { kind: "none" };
  if (current.kind === "corrupt") {
    return { kind: "indeterminate", cause: "record-corrupt", record: null };
  }
  if (current.kind === "unreadable") {
    return { kind: "indeterminate", cause: current.cause, record: null };
  }
  if (current.kind === "unsupported-version") {
    return {
      kind: "indeterminate",
      cause: `record-unsupported-version-${current.version}`,
      record: null,
    };
  }

  const record = current.value;
  if (record.execution === "terminal") return { kind: "terminal", record };
  // Checked BEFORE staleness and before the holder is consulted, because a park is defined by the absence of a holder.
  if (record.execution === "parked") return { kind: "parked", record };

  if (holder.kind === "holder-live") return { kind: "active", record };
  if (holder.kind === "indeterminate") {
    return { kind: "indeterminate", cause: holder.cause, record };
  }

  // `no-holder`: positive proof.
  const updatedAtMs = Date.parse(record.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return {
      kind: "indeterminate",
      cause: "record-updated-at-unparseable",
      record,
    };
  }
  // A future-dated stamp (clock step, skewed writer) is not stale.
  if (nowMs - updatedAtMs < stalenessMs) return { kind: "active", record };

  return { kind: "interrupted", record };
}

/**
 * Whether the holder probe may be skipped entirely for this read.
 * Callers must treat a `false` here as "probe now", never as "assume live": the whole point is that the skip is provably answer-preserving, and the moment it stops being provable the probe has to run.
 */
export function attemptHolderProbeRequired(
  current: HostUpdateAttemptRead,
): boolean {
  return current.kind === "valid" && current.value.execution === "active";
}

// ---- Holder projection ------------------------------------------------------

/**
 * The identity-only projection of an `update-attempt.lock` file - what a READER needs to judge whether the holder is still alive, and deliberately nothing more.
 */
export type AttemptLockHolder = {
  readonly pid: number;
  readonly token: string | null;
  readonly processStartIdentity: ProcessStartIdentity | null;
  readonly processStartedAtMs: number | null;
  /** `null`, not `undefined` - absence is a fact this reader states. */
  readonly supervisedProcessGroupId: number | null;
  readonly retainOnPublisherDeath: boolean;
};

/** Parse the lock file's bytes, or `null` when they are not a well-formed holder record. */
export function parseAttemptLockHolder(text: string): AttemptLockHolder | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.reason !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    token: typeof obj.token === "string" ? obj.token : null,
    processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
      : null,
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
    supervisedProcessGroupId:
      // `> 1`, matching the canonical parser in clients/shared/host-lock/cross-process-lock.ts: probing group 1 asks `kill(-1, 0)` - "is there ANY signalable process" - so a record carrying 1 must read as carrying no group at.
      typeof obj.supervisedProcessGroupId === "number" &&
      Number.isSafeInteger(obj.supervisedProcessGroupId) &&
      obj.supervisedProcessGroupId > 1
        ? obj.supervisedProcessGroupId
        : null,
    retainOnPublisherDeath: obj.retainOnPublisherDeath === true,
  };
}

/**
 * Cache key for one holder observation.
 * Fingerprinted on the holder's OWN identity, not merely on elapsed time, so a verdict expires on content change as well: a lock released and re-taken by a different process is never served from a stale entry however.
 */
export function attemptHolderFingerprint(
  // Only the identity fields, so the clients' richer `LockMetadata` is accepted here directly.
  holder: Pick<AttemptLockHolder, "pid" | "token" | "processStartIdentity">,
): string {
  const identity =
    holder.processStartIdentity === null
      ? "none"
      : JSON.stringify(holder.processStartIdentity);
  return `${String(holder.pid)}|${holder.token ?? "none"}|${identity}`;
}

/** Whether this holder can be judged by the plain publisher-identity probe. */
export function attemptHolderUsesPlainIdentityProbe(
  holder: AttemptLockHolder,
): boolean {
  return (
    holder.supervisedProcessGroupId === null && !holder.retainOnPublisherDeath
  );
}

/**
 * The liveness verdict vocabulary, structurally identical to `@traycer-clients/shared/host-lock/process-identity`'s `ProcessIdentityVerdict`.
 * A bidirectional type-equality assertion in the shared `lock.ts` delegation fails compilation if either union grows an arm the other lacks, so the duplication cannot drift silently.
 */
export type AttemptHolderLivenessVerdict =
  | "dead"
  | "alive-same"
  | "alive-different"
  | "indeterminate";

/** Tri-state OS liveness for a pid. */
export type AttemptHolderProcessLiveness = "alive" | "dead" | "indeterminate";

/**
 * Combine a tri-state liveness result with an INDEPENDENT identity read.
 * Treating "cannot compare" as "recycled pid" is what would let a reader declare a live holder an impostor.
 */
export function composeAttemptHolderVerdict(
  liveness: AttemptHolderProcessLiveness,
  recordedIdentity: ProcessStartIdentity | null,
  observedIdentity: ProcessStartIdentity | null,
): AttemptHolderLivenessVerdict {
  if (liveness === "dead") return "dead";
  switch (compareProcessStartIdentity(recordedIdentity, observedIdentity)) {
    case "same":
      return "alive-same";
    case "different":
      return "alive-different";
    case "unknown":
      return "indeterminate";
  }
}

/** The one mapping from a liveness verdict to holder evidence, shared by every reader. */
export function classifyAttemptHolderVerdict(
  verdict: AttemptHolderLivenessVerdict,
): AttemptHolderObservation["kind"] {
  switch (verdict) {
    case "alive-same":
      return "holder-live";
    case "dead":
    case "alive-different":
      return "no-holder";
    case "indeterminate":
      return "indeterminate";
  }
}
