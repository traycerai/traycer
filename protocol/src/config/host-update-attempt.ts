// The durable host-update attempt record (Host update progress tech plan
// §1.3) and the pure algebra over it: identity, ordering, phase/execution
// classification, terminal retention, and the total decode of the raw bytes.
//
// Nothing here touches the filesystem or the clock - callers pass `nowIso`
// / `nowMs` in. That is what lets the whole transition core be exercised
// without a temp dir or a fake timer.
//
// ### Why this lives in `@traycer/protocol/config`
//
// `update-attempt.json` is read by three processes in TWO repositories: the
// CLI and the desktop (through `@traycer-clients/shared/host-update`, which
// re-exports this module) and `traycer-host`, which cannot import that
// package at all. It is the same situation - and the same answer - as
// `./host-stop-intent`, `./installation-records`, and `./credentials`: the
// shape lives here so both sides resolve one definition instead of two
// decoders that agree only for as long as someone keeps them in step. The
// record already grew a field without a schema bump (`recovery`, deliberately,
// so retained v2 records stay readable); a second decoder that had not learned
// about it would read a perfectly good record as `corrupt`, which is a
// fail-closed VERDICT, not a missing detail.
//
// ### This module is renderer-safe, and must stay that way
//
// It imports nothing from `node:*`. `host/status/contracts.ts` takes an
// `import type` from here so the wire vocabulary cannot drift from the record
// vocabulary, and that contracts module is reachable from the RPC registry the
// renderer imports. Anything needing `node:path` belongs in
// `./host-update-attempt-paths`; anything needing `node:fs` belongs in
// `./host-update-attempt-fs`. Same split, same reason, as
// `./installation-records` vs `./installation`.

/**
 * Schema version of the durable record. `2` from the outset, deliberately:
 * v1 is the released coarse `update-progress.json` marker, which this
 * record supersedes rather than extends. A reader that finds any other
 * version fails closed (see `decodeHostUpdateAttempt`); it never rewrites it.
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
 * How the phase relates to a lock holder - the property recovery actually
 * branches on, which is why it is stored rather than only derived:
 *
 * - `active`   - a segment is executing and SHOULD hold `update-attempt.lock`.
 *                Finding no live holder here is the interrupted case.
 * - `parked`   - the absence of a holder is intentional and expected. A
 *                parked attempt is never "interrupted", however old it is.
 * - `terminal` - the attempt is over. Retained as evidence only.
 */
export type HostUpdateAttemptExecution = "active" | "parked" | "terminal";

/**
 * What a parked attempt is waiting to do, carried through the segment that
 * resumes it.
 *
 * - `resume-apply` - bytes are NOT yet placed; the disruptive apply was
 *   deferred because the host was busy.
 * - `activate` - bytes ARE already placed (packaged-macOS `apply
 *   --no-service`); only activation may proceed. Re-applying would be
 *   incorrect, which is why the phase graph refuses
 *   `waiting-to-activate -> applying`.
 */
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

/**
 * Durable provenance for a terminal conclusion written by crash recovery.
 *
 * A normal executor reaches `complete` through its verifying segment. Recovery
 * is allowed to terminalize only after independently reconciling durable
 * install evidence with a positively host-home-bound running process. Keeping
 * this compact summary on the record makes that exceptional conclusion
 * auditable without retaining raw paths, pids, or lock tokens.
 */
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

/**
 * The continuation a parked phase MUST carry, and the only one it may.
 * `null` for every phase that is not a park - an active phase may still
 * carry the continuation it is executing (see `continuationLegalFor`).
 */
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

/**
 * The execution class a phase implies. The record stores `execution`
 * explicitly (the projection in §5 carries it), but the mapping is fixed:
 * a record whose stored pair disagrees is corrupt, not a third state.
 */
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
 *
 * Parked and terminal phases are exact: a park means precisely one pending
 * continuation, and a finished attempt has none. An ACTIVE phase is
 * permissive HERE on purpose - a segment that resumed `waiting-to-activate`
 * keeps `activate` set while it works, so a crash mid-segment still leaves
 * durable evidence of which continuation was in flight rather than
 * flattening it to `null` and making recovery re-derive it from the
 * install tree alone.
 *
 * This is a SHAPE predicate, not the whole rule. It answers "could a record
 * in this phase legally carry this continuation" - it deliberately cannot
 * see the previous record, so it cannot tell a carried continuation from a
 * swapped one. Whether a TRANSITION may change the continuation is decided
 * by `advanceAttempt`, which compares against the current record and
 * refuses any erase or swap while one is in flight.
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
 * The ordering key, in full. `updatedAt` is NEVER part of it - two clients
 * with skewed clocks must not be able to disagree about which write is
 * newer, and a reader must never win a write by timestamp.
 *
 * - `attemptId` - the logical attempt. Minted once, by the process that
 *   wins creation.
 * - `generation` - the EXECUTION SEGMENT. Bumped exactly once each time a
 *   contender claims the attempt (create = 1, every resume/supersede = +1).
 *   This is the field that rejects a late writer: a process holding
 *   generation N is provably no longer the owner once N+1 exists.
 * - `sequence` - the write counter, monotonic across the WHOLE attempt and
 *   deliberately never reset on a generation bump, so it alone totally
 *   orders every write the attempt ever made.
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
 * Total order WITHIN one attempt: negative if `a` precedes `b`, positive if
 * it follows, `0` if identical.
 *
 * `null` for two DIFFERENT attempts, which are genuinely incomparable -
 * there is no clock-free fact that orders them, and inventing one (by
 * `startedAt`, say) is how a stale process talks itself into overwriting a
 * newer attempt. Supersession is an explicit, lock-held transition for
 * exactly this reason.
 */
export function compareAttemptOrder(
  a: HostUpdateAttemptIdentity,
  b: HostUpdateAttemptIdentity,
): number | null {
  if (a.attemptId !== b.attemptId) return null;
  // Compared, never subtracted. Subtraction of two counters near
  // `Number.MAX_SAFE_INTEGER` loses precision and can report `0` - "same
  // position" - for two genuinely different writes. The decoder rejects
  // unsafe counters, but this function is reachable with identities from
  // anywhere, and an ordering primitive must not depend on its callers
  // having sanitized their inputs.
  if (a.generation !== b.generation)
    return a.generation < b.generation ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return 0;
}

/**
 * The largest counter value that may still be incremented. One below
 * `Number.MAX_SAFE_INTEGER`, so `value + 1` is itself still exactly
 * representable.
 */
export const MAX_INCREMENTABLE_ATTEMPT_COUNTER = Number.MAX_SAFE_INTEGER - 1;

/**
 * `value + 1`, or `null` when the increment cannot be trusted to advance.
 *
 * At `2^53` (`Number.MAX_SAFE_INTEGER + 1`) ordinary `+ 1` returns the SAME
 * number, so a write would report success while leaving `sequence`
 * unchanged - silently disabling the monotonic ordering that rejects late
 * writers. Every generation/sequence bump goes through here so the
 * exhausted case is a first-class refusal instead of a no-op.
 */
export function nextAttemptCounter(value: number): number | null {
  if (!Number.isSafeInteger(value)) return null;
  if (value < 1) return null;
  if (value > MAX_INCREMENTABLE_ATTEMPT_COUNTER) return null;
  return value + 1;
}

// ---- Terminal retention -----------------------------------------------------

/**
 * How long the latest terminal record is kept (§1.5). Cleanup is
 * best-effort and performed by a lock-holding contender or a maintenance
 * pass; a newer attempt replaces the record before this expires.
 */
export const TERMINAL_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a terminal record has aged past retention.
 *
 * Fails CLOSED - retains - for a non-terminal record, an unparseable stamp,
 * or a future-dated one. Deleting retained evidence is the irreversible
 * direction; keeping a stale terminal record one cycle longer costs a file.
 */
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

// ---- Total decode -----------------------------------------------------------
//
// Total decode of `update-attempt.json`. Never throws, and every failure
// mode is a DISTINCT arm because each one is a different decision for the
// caller (§1.4): `absent` admits a new attempt, `unsupported-version` and
// `corrupt` must fail closed and expose a repair action, and `unreadable`
// is not evidence of anything at all.
//
// `DurableBytes` / `DurableRecord` below are declared here rather than
// imported from the clients' `host-lifecycle` layer - that package is not
// reachable from `traycer-host`, which is the whole reason this module
// exists. They are structurally identical to the lifecycle vocabulary, so
// `@traycer-clients/shared/host-update/decode` keeps re-exporting the
// LIFECYCLE types verbatim and every existing client caller sees no change
// at all.
//
// The version gate is `schemaVersion` (the tech plan names the field), NOT
// the lifecycle decoder's `v`/`version`: `targetVersion` already lives in
// this shape, so a generic gate reaching for `obj.version` would be one
// rename away from gating on the wrong field.

/**
 * Input to a durable-record decoder. Callers map fs errors into this shape
 * so the decoder itself stays pure and total.
 */
export type DurableBytes =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "bytes"; readonly text: string };

/**
 * Versioned durable on-disk record decode verdict. Total over raw shapes -
 * never returns a shape a caller could read as "absent". Each arm is a
 * distinct planner input.
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

  // The stored execution class must agree with the phase. A disagreement is
  // corrupt rather than "trust one of them": recovery branches on exactly
  // this field to decide whether a missing lock holder is intentional, and
  // guessing which half of a contradiction to believe is how a parked
  // attempt gets replayed as an interrupted one.
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
  // Recovery provenance describes an exceptional terminal conclusion. A
  // partial/crashed writer must not be able to leave it attached to a live
  // segment and make that look like a claimed recovery.
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

// SAFE integer, not merely integer. `generation`/`sequence` are the ordering
// key, and every bump is `+ 1`: at `2^53` that addition returns the same
// number, so a counter above the safe range makes "the sequence advanced"
// unenforceable and lets a late writer's record compare equal to the one
// that superseded it. A record carrying such a counter was not written by
// this code, so rejecting it as corrupt is both safe and honest.
function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

// ---- Required nullable fields ----------------------------------------------
//
// `continuation`, `progress`, `completedAt`, and `error` are REQUIRED by the
// v2 shape, with explicit `null` expressing absence. A missing key is
// therefore `"invalid"`, not `null`.
//
// Normalizing `undefined` to `null` looked harmless and was not: it let a
// writer claim `schemaVersion: 2` while emitting an arbitrary subset of the
// contract, and made a partially-written record indistinguishable from a
// complete one whose optional facts happened to be absent. Both are exactly
// what the version gate and the fail-closed rule exist to catch. JSON never
// produces an `undefined` VALUE, so `=== undefined` here means "key absent".

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
  // NaN/Infinity survive `typeof value === "number"`. They cannot arrive
  // through `JSON.parse` (`JSON.stringify(NaN)` emits `null`), so this only
  // ever fires for a caller that assembled `DurableBytes` some other way -
  // kept because the decoder's totality claim should not rest on how its
  // input was produced.
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
  // The field was added without a schema-version bump so retained schema-v2
  // records written before recovery existed remain readable. Once present it
  // is deliberately exact rather than best-effort diagnostic JSON.
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
