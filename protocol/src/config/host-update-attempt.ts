// The durable host-update attempt record (Host update progress tech plan §1.3) and the pure algebra over it: identity, ordering, phase/execution classification, terminal retention, and the total decode of the raw bytes.
// `host/status/contracts.ts` takes an `import type` from here so the wire vocabulary cannot drift from the record vocabulary, and that contracts module is reachable from the RPC registry the renderer imports.

/**
 * Schema version of the durable record.
 * A reader that finds any other version fails closed (see `decodeHostUpdateAttempt`); it never rewrites it.
 */
export const HOST_UPDATE_ATTEMPT_SCHEMA_VERSION = 2;

export const HOST_UPDATE_ATTEMPT_SUPPORTED_VERSIONS: readonly number[] = [
  HOST_UPDATE_ATTEMPT_SCHEMA_VERSION,
];

export type HostUpdateTrigger = "manual" | "automatic" | "support-floor";

export const HOST_UPDATE_TRIGGERS: readonly HostUpdateTrigger[] = [
  "manual",
  "automatic",
  "support-floor",
];

export type HostUpdateAttemptPhase =
  | "downloading"
  | "preparing"
  | "applying"
  | "waiting-for-work"
  | "waiting-to-activate"
  | "restarting"
  | "verifying"
  | "complete"
  | "failed"
  | "superseded";

export const HOST_UPDATE_ATTEMPT_PHASES: readonly HostUpdateAttemptPhase[] = [
  "downloading",
  "preparing",
  "applying",
  "waiting-for-work",
  "waiting-to-activate",
  "restarting",
  "verifying",
  "complete",
  "failed",
  "superseded",
];

/**
 * How the phase relates to a lock holder - the property recovery actually branches on, which is why it is stored rather than only derived
 * A parked attempt is never "interrupted", however old it is. - `terminal` - the attempt is over.
 */
export type HostUpdateAttemptExecution = "active" | "parked" | "terminal";

/** What a parked attempt is waiting to do, carried through the segment that resumes it. */
export type HostUpdateAttemptContinuation = "resume-apply" | "activate" | null;

export type HostUpdateAttemptProgress = {
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
} | null;

export type HostUpdateAttemptError = {
  readonly code: string;
  readonly message: string;
  readonly phase: string;
} | null;

/** Durable provenance for a terminal conclusion written by crash recovery. */
export type HostUpdateAttemptRecovery = {
  readonly recoveredBy: "attempt-executor";
  readonly outcome: "complete" | "failed" | "superseded";
  readonly evidence: {
    /** Every leg is retained verbatim enough to explain a recovery result. */
    readonly installed: HostUpdateAttemptRecoveryArtifactLeg;
    readonly staged: HostUpdateAttemptRecoveryArtifactLeg;
    readonly running: HostUpdateAttemptRecoveryRunningLeg;
  };
};

export type HostUpdateAttemptRecoveryArtifactLeg = {
  readonly kind: "absent" | "verified" | "missing" | "unreadable";
  readonly version: string | null;
};

export type HostUpdateAttemptRecoveryRunningLeg = {
  readonly kind: "absent" | "verified" | "unbound" | "unreadable";
  readonly version: string | null;
  readonly ownerBound: boolean;
};

export type HostUpdateAttemptRecord = {
  readonly schemaVersion: number;
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly trigger: HostUpdateTrigger;
  readonly targetVersion: string;
  readonly phase: HostUpdateAttemptPhase;
  readonly execution: HostUpdateAttemptExecution;
  readonly continuation: HostUpdateAttemptContinuation;
  readonly progress: HostUpdateAttemptProgress;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly error: HostUpdateAttemptError;
  /** Omitted for ordinary executor terminal writes and all active records. */
  readonly recovery?: HostUpdateAttemptRecovery;
};

// ---- Phase classification ---------------------------------------------------

const PARKED_PHASES: ReadonlySet<HostUpdateAttemptPhase> = new Set([
  "waiting-for-work",
  "waiting-to-activate",
]);

const TERMINAL_PHASES: ReadonlySet<HostUpdateAttemptPhase> = new Set([
  "complete",
  "failed",
  "superseded",
]);

/** The continuation a parked phase MUST carry, and the only one it may. */
const PARK_CONTINUATION: ReadonlyMap<
  HostUpdateAttemptPhase,
  Exclude<HostUpdateAttemptContinuation, null>
> = new Map([
  ["waiting-for-work", "resume-apply"],
  ["waiting-to-activate", "activate"],
]);

export function isParkedPhase(phase: HostUpdateAttemptPhase): boolean {
  return PARKED_PHASES.has(phase);
}

export function isTerminalPhase(phase: HostUpdateAttemptPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isActivePhase(phase: HostUpdateAttemptPhase): boolean {
  return !isParkedPhase(phase) && !isTerminalPhase(phase);
}

/** The execution class a phase implies. */
export function executionForPhase(
  phase: HostUpdateAttemptPhase,
): HostUpdateAttemptExecution {
  if (isTerminalPhase(phase)) return "terminal";
  if (isParkedPhase(phase)) return "parked";
  return "active";
}

/** The continuation a park must carry, or `null` for any other phase. */
export function parkContinuationFor(
  phase: HostUpdateAttemptPhase,
): HostUpdateAttemptContinuation {
  return PARK_CONTINUATION.get(phase) ?? null;
}

/**
 * Whether `continuation` is legal for `phase`.
 * It answers "could a record in this phase legally carry this continuation" - it deliberately cannot see the previous record, so it cannot tell a carried continuation from a swapped one.
 */
export function continuationLegalFor(
  phase: HostUpdateAttemptPhase,
  continuation: HostUpdateAttemptContinuation,
): boolean {
  if (isTerminalPhase(phase)) return continuation === null;
  if (isParkedPhase(phase)) return continuation === parkContinuationFor(phase);
  return true;
}

// ---- Identity and ordering --------------------------------------------------

/**
 * The ordering key, in full.
 * `updatedAt` is NEVER part of it - two clients with skewed clocks must not be able to disagree about which write is newer, and a reader must never win a write by timestamp.
 */
export type HostUpdateAttemptIdentity = {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
};

export function attemptIdentityOf(
  record: HostUpdateAttemptRecord,
): HostUpdateAttemptIdentity {
  return {
    attemptId: record.attemptId,
    generation: record.generation,
    sequence: record.sequence,
  };
}

export function sameAttemptIdentity(
  a: HostUpdateAttemptIdentity,
  b: HostUpdateAttemptIdentity,
): boolean {
  return (
    a.attemptId === b.attemptId &&
    a.generation === b.generation &&
    a.sequence === b.sequence
  );
}

/**
 * Total order WITHIN one attempt: negative if `a` precedes `b`, positive if it follows, `0` if identical.
 */
export function compareAttemptOrder(
  a: HostUpdateAttemptIdentity,
  b: HostUpdateAttemptIdentity,
): number | null {
  if (a.attemptId !== b.attemptId) return null;
  // Compared, never subtracted.
  // The decoder rejects unsafe counters, but this function is reachable with identities from anywhere, and an ordering primitive must not depend on its callers having sanitized their inputs.
  if (a.generation !== b.generation)
    return a.generation < b.generation ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return 0;
}

/** The largest counter value that may still be incremented. */
export const MAX_INCREMENTABLE_ATTEMPT_COUNTER = Number.MAX_SAFE_INTEGER - 1;

/**
 * `value + 1`, or `null` when the increment cannot be trusted to advance.
 * At `2^53` (`Number.MAX_SAFE_INTEGER + 1`) ordinary `+ 1` returns the SAME number, so a write would report success while leaving `sequence` unchanged - silently disabling the monotonic ordering that rejects late writers.
 */
export function nextAttemptCounter(value: number): number | null {
  if (!Number.isSafeInteger(value)) return null;
  if (value < 1) return null;
  if (value > MAX_INCREMENTABLE_ATTEMPT_COUNTER) return null;
  return value + 1;
}

// ---- Terminal retention -----------------------------------------------------

/** How long the latest terminal record is kept (§1.5). */
export const TERMINAL_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a terminal record has aged past retention. */
export function isTerminalRetentionExpired(
  record: HostUpdateAttemptRecord,
  nowMs: number,
): boolean {
  if (record.execution !== "terminal") return false;
  const stampedAt = record.completedAt ?? record.updatedAt;
  const stampedMs = Date.parse(stampedAt);
  if (Number.isNaN(stampedMs)) return false;
  return nowMs - stampedMs > TERMINAL_ATTEMPT_RETENTION_MS;
}

// Total decode

/**
 * Input to a durable-record decoder. Callers map fs errors into this shape
 * so the decoder itself stays pure and total.
 */
export type DurableBytes =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "bytes"; readonly text: string };

/**
 * Versioned durable on-disk record decode verdict.
 * Total over raw shapes - never returns a shape a caller could read as "absent".
 */
export type DurableRecord<T> =
  | { readonly kind: "valid"; readonly value: T; readonly version: number }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "unsupported-version"; readonly version: number };

export type HostUpdateAttemptRead = DurableRecord<HostUpdateAttemptRecord>;

const TRIGGERS: ReadonlySet<string> = new Set<string>(HOST_UPDATE_TRIGGERS);
const PHASES: ReadonlySet<string> = new Set<string>(HOST_UPDATE_ATTEMPT_PHASES);

export function decodeHostUpdateAttempt(
  input: DurableBytes,
): HostUpdateAttemptRead {
  if (input.kind === "missing") return { kind: "absent" };
  if (input.kind === "unreadable") {
    return { kind: "unreadable", cause: input.cause };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }
  const obj = parsed as Record<string, unknown>;

  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { kind: "corrupt" };
  }
  if (!HOST_UPDATE_ATTEMPT_SUPPORTED_VERSIONS.includes(schemaVersion)) {
    return { kind: "unsupported-version", version: schemaVersion };
  }

  const value = parseAttemptFields(obj, schemaVersion);
  if (value === null) return { kind: "corrupt" };
  return { kind: "valid", value, version: schemaVersion };
}

function parseAttemptFields(
  obj: Readonly<Record<string, unknown>>,
  schemaVersion: number,
): HostUpdateAttemptRecord | null {
  const attemptId = nonEmptyString(obj.attemptId);
  if (attemptId === null) return null;
  const generation = positiveInteger(obj.generation);
  if (generation === null) return null;
  const sequence = positiveInteger(obj.sequence);
  if (sequence === null) return null;
  if (!isTrigger(obj.trigger)) return null;
  const trigger = obj.trigger;
  const targetVersion = nonEmptyString(obj.targetVersion);
  if (targetVersion === null) return null;
  if (!isPhase(obj.phase)) return null;
  const phase = obj.phase;

  // The stored execution class must agree with the phase.
  if (obj.execution !== executionForPhase(phase)) return null;

  const continuation = parseContinuation(obj.continuation);
  if (continuation === "invalid") return null;
  if (!continuationLegalFor(phase, continuation)) return null;

  const progress = parseProgress(obj.progress);
  if (progress === "invalid") return null;

  if (typeof obj.startedAt !== "string") return null;
  if (typeof obj.updatedAt !== "string") return null;
  const completedAt = requiredNullableString(obj.completedAt);
  if (completedAt === "invalid") return null;

  const error = parseError(obj.error);
  if (error === "invalid") return null;

  const recovery = parseRecovery(obj.recovery);
  if (recovery === "invalid") return null;
  // Recovery provenance describes an exceptional terminal conclusion.
  // A partial/crashed writer must not be able to leave it attached to a live segment and make that look like a claimed recovery.
  if (recovery !== undefined && executionForPhase(phase) !== "terminal") {
    return null;
  }
  if (
    recovery !== undefined &&
    ((recovery.outcome === "complete" && phase !== "complete") ||
      (recovery.outcome === "failed" && phase !== "failed") ||
      (recovery.outcome === "superseded" && phase !== "superseded"))
  ) {
    return null;
  }

  return {
    schemaVersion,
    attemptId,
    generation,
    sequence,
    trigger,
    targetVersion,
    phase,
    execution: executionForPhase(phase),
    continuation,
    progress,
    startedAt: obj.startedAt,
    updatedAt: obj.updatedAt,
    completedAt,
    error,
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function isTrigger(value: unknown): value is HostUpdateTrigger {
  return typeof value === "string" && TRIGGERS.has(value);
}

function isPhase(value: unknown): value is HostUpdateAttemptPhase {
  return typeof value === "string" && PHASES.has(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// SAFE integer, not merely integer.
function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

// Required nullable fields
// Both are exactly what the version gate and the fail-closed rule exist to catch.

function requiredNullableString(value: unknown): string | null | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  return typeof value === "string" ? value : "invalid";
}

function requiredNullableFiniteNumber(
  value: unknown,
): number | null | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  if (typeof value !== "number") return "invalid";
  // NaN/Infinity survive `typeof value === "number"`.
  return Number.isFinite(value) ? value : "invalid";
}

function parseContinuation(
  value: unknown,
): HostUpdateAttemptContinuation | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  if (value === "resume-apply" || value === "activate") return value;
  return "invalid";
}

function parseProgress(value: unknown): HostUpdateAttemptProgress | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const raw = value as Record<string, unknown>;
  const percent = requiredNullableFiniteNumber(raw.percent);
  if (percent === "invalid") return "invalid";
  const bytes = requiredNullableFiniteNumber(raw.bytes);
  if (bytes === "invalid") return "invalid";
  const totalBytes = requiredNullableFiniteNumber(raw.totalBytes);
  if (totalBytes === "invalid") return "invalid";
  return { percent, bytes, totalBytes };
}

function parseError(value: unknown): HostUpdateAttemptError | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string") return "invalid";
  if (typeof raw.message !== "string") return "invalid";
  if (typeof raw.phase !== "string") return "invalid";
  return { code: raw.code, message: raw.message, phase: raw.phase };
}

function parseRecovery(
  value: unknown,
): HostUpdateAttemptRecovery | undefined | "invalid" {
  // The field was added without a schema-version bump so retained schema-v2 records written before recovery existed remain readable.
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "invalid";
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.recoveredBy !== "attempt-executor" ||
    (raw.outcome !== "complete" &&
      raw.outcome !== "failed" &&
      raw.outcome !== "superseded") ||
    raw.evidence === null ||
    typeof raw.evidence !== "object" ||
    Array.isArray(raw.evidence)
  ) {
    return "invalid";
  }
  const evidence = raw.evidence as Record<string, unknown>;
  const installed = parseRecoveryArtifactLeg(evidence.installed);
  const staged = parseRecoveryArtifactLeg(evidence.staged);
  const running = parseRecoveryRunningLeg(evidence.running);
  if (installed === "invalid" || staged === "invalid" || running === "invalid")
    return "invalid";
  return {
    recoveredBy: "attempt-executor",
    outcome: raw.outcome,
    evidence: { installed, staged, running },
  };
}

function parseRecoveryArtifactLeg(
  value: unknown,
): HostUpdateAttemptRecovery["evidence"]["installed"] | "invalid" {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "invalid";
  }
  const raw = value as Record<string, unknown>;
  const version = nullableNonEmptyString(raw.version);
  if (
    version === "invalid" ||
    (raw.kind !== "absent" &&
      raw.kind !== "verified" &&
      raw.kind !== "missing" &&
      raw.kind !== "unreadable") ||
    ((raw.kind === "verified" || raw.kind === "missing") && version === null) ||
    ((raw.kind === "absent" || raw.kind === "unreadable") && version !== null)
  ) {
    return "invalid";
  }
  return { kind: raw.kind, version };
}

function parseRecoveryRunningLeg(
  value: unknown,
): HostUpdateAttemptRecovery["evidence"]["running"] | "invalid" {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "invalid";
  }
  const raw = value as Record<string, unknown>;
  const version = nullableNonEmptyString(raw.version);
  if (
    version === "invalid" ||
    (raw.kind !== "absent" &&
      raw.kind !== "verified" &&
      raw.kind !== "unbound" &&
      raw.kind !== "unreadable") ||
    ((raw.kind === "verified" || raw.kind === "unbound") && version === null) ||
    ((raw.kind === "absent" || raw.kind === "unreadable") &&
      version !== null) ||
    typeof raw.ownerBound !== "boolean"
  ) {
    return "invalid";
  }
  if (raw.kind !== "verified" && raw.ownerBound) return "invalid";
  return { kind: raw.kind, version, ownerBound: raw.ownerBound };
}

function nullableNonEmptyString(value: unknown): string | null | "invalid" {
  if (value === undefined) return "invalid";
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : "invalid";
}
