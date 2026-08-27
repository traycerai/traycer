import type { HostUpdateAttemptRead } from "./decode";
import {
  HOST_UPDATE_ATTEMPT_SCHEMA_VERSION,
  attemptIdentityOf,
  continuationLegalFor,
  executionForPhase,
  isParkedPhase,
  isTerminalPhase,
  nextAttemptCounter,
  sameAttemptIdentity,
  type HostUpdateAttemptContinuation,
  type HostUpdateAttemptError,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptPhase,
  type HostUpdateAttemptProgress,
  type HostUpdateAttemptRecovery,
  type HostUpdateAttemptRecord,
  type HostUpdateTrigger,
} from "./record";

// The pure transition core (§1.1 "chooses exactly one legal action", §1.4
// write-ahead ordering, §1.5 park semantics).
//
// Every function here is total, synchronous, and clock-free: the caller
// passes `nowIso` and a freshly-minted attempt id. Nothing writes. The
// separation is the point - the decision about what a contender is allowed
// to do is exhaustively testable without a filesystem, and the code that
// moves bytes cannot reach a state this module never produced.

/** Phases an attempt may be CREATED in - never a park, never a terminal. */
export type ActiveHostUpdateAttemptPhase = Exclude<
  HostUpdateAttemptPhase,
  | "waiting-for-work"
  | "waiting-to-activate"
  | "complete"
  | "failed"
  | "superseded"
>;

/**
 * The operation an update request authorizes.  This is deliberately not a
 * UI label: it is part of the request's authority tuple alongside the exact
 * attempt identity and target.  In particular, an authorization to resume
 * bytes that have not been promoted cannot be replayed as an activation (or
 * vice versa) after the durable record changes.
 */
export type AttemptClaimAction =
  | "start"
  | "resume-apply"
  | "activate"
  | "force"
  | "defer";

export interface AttemptClaimRequest {
  readonly targetVersion: string;
  readonly trigger: HostUpdateTrigger;
  /** The exact operation this request may perform. */
  readonly action: AttemptClaimAction;
  /**
   * The attempt identity this contender was authorized against, when it is
   * acting on a request minted earlier (Force, Defer, Activate - §1.3: "each
   * request must carry `attemptId` plus expected generation/sequence and be
   * consumed under the attempt lock").
   *
   * `null` for a contender deciding from what it just read under the lock,
   * which has nothing stale to guard against.
   */
  readonly expected: HostUpdateAttemptIdentity | null;
  /**
   * A freshly minted id, used only if the decision turns out to be `create`.
   * Passed in rather than generated here so this module stays pure - and so
   * the executor, which §1.2 makes the sole minter, is visibly the minter.
   */
  readonly newAttemptId: string;
  /** The phase a newly created attempt commits before its first side effect. */
  readonly initialPhase: ActiveHostUpdateAttemptPhase;
  readonly nowIso: string;
}

export interface AttemptClaimContext {
  /** The record as just decoded, in whatever state the decoder found it. */
  readonly current: HostUpdateAttemptRead;
  readonly request: AttemptClaimRequest;
  /**
   * The result of acquisition plus a holder probe, not a lossy boolean.
   *
   * `holder-live` is the only loser state that permits attach, and only for
   * an active record of the same target.  A busy-but-unparseable lock is not
   * evidence that an executor has durably adopted anything; a parked record
   * intentionally has no holder at all.  Collapsing those cases into
   * `lockHeld: false` used to acknowledge requests against a generation that
   * was about to be replaced by the real resumer.
   */
  readonly holder: AttemptClaimHolderDisposition;
}

export type AttemptClaimHolderDisposition =
  /** This caller acquired the canonical attempt lock and may mutate. */
  | { readonly kind: "held-by-self" }
  /** A lock-free probe positively proved another executor is live. */
  | { readonly kind: "holder-live" }
  /** The lock is absent. A claimant must acquire before acting. */
  | { readonly kind: "no-holder" }
  /** Busy, unparseable, or probe-failed: no attach or mutation authority. */
  | { readonly kind: "indeterminate" };

export type AttemptRefusalReason =
  // Corrupt, unreadable, or a schema version this build cannot act on.
  // §1.4: fail closed, preserve diagnostics, expose a repair action - never
  // silently replace with a new attempt.
  | "record-fail-closed"
  // The authorization this contender carries names an attempt identity the
  // record has already moved past. The request is stale; consuming it would
  // act on a superseded target (risk review P2).
  | "stale-expectation"
  // A non-parked, non-terminal record with the lock free. Either the
  // executing segment died, or it ended by design (a `restarting` segment
  // restarts the host and does not come back - §1.6). Both need durable
  // system evidence reconciled before the next transition, which is the
  // executor-adoption ticket's job, so the pure core refuses rather than
  // guessing a continuation from the phase alone.
  | "requires-recovery"
  // An identity-bound request whose attempt has already ended. Distinct from
  // `stale-expectation` (which names an identity that never matched) so a
  // caller can report "that update already finished" rather than "your
  // request was stale".
  | "attempt-already-terminal"
  // Another target is already in flight and this contender does not hold the
  // lock, so it cannot legally supersede it.
  | "target-conflict"
  // The action needs the lock and this contender does not hold it.
  | "lock-unavailable"
  // The request's target or action does not authorize the state it named.
  // These are distinct from a stale identity: the identity did match, so
  // callers can surface an authorization mismatch rather than claiming the
  // request was merely delayed.
  | "request-target-mismatch"
  | "request-action-mismatch"
  // A create over retained terminal evidence must mint a different logical
  // attempt. Reusing the old id would make two distinct attempts
  // incomparable only by untrusted timestamps and undermine late-write
  // rejection at the persistence boundary.
  | "new-attempt-id-reused"
  // `generation`/`sequence` can no longer be incremented safely. Only
  // reachable from a record carrying counters at the safe-integer ceiling,
  // which this code never writes.
  | "counter-exhausted";

export type AttemptClaimDecision =
  // Mint a new attempt. Write `record`, then execute.
  | { readonly kind: "create"; readonly record: HostUpdateAttemptRecord }
  // Take over a parked attempt. Write `record`, then execute the
  // continuation it carries.
  | {
      readonly kind: "resume";
      readonly record: HostUpdateAttemptRecord;
      readonly continuation: Exclude<HostUpdateAttemptContinuation, null>;
    }
  // Terminalize the in-flight attempt for the OLD target. Write `record`,
  // then decide again: the record is terminal at that point and the next
  // decision is `create` for the new target. Two explicit steps, because
  // superseding and creating are two durable facts and a crash between them
  // must leave the first one recorded.
  | {
      readonly kind: "supersede";
      readonly record: HostUpdateAttemptRecord;
      readonly superseded: HostUpdateAttemptIdentity;
    }
  // The same work is already in flight under a holder. Write nothing;
  // acknowledge the identity observed (§1.2 step 3).
  | { readonly kind: "attach"; readonly observed: HostUpdateAttemptRecord }
  | {
      readonly kind: "refuse";
      readonly reason: AttemptRefusalReason;
      readonly observed: HostUpdateAttemptRecord | null;
    };

// ---- Interrupted active-segment recovery ----------------------------------
//
// An active record without a live holder is intentionally not resumed by
// `decideAttemptClaim`: phase alone cannot say whether bytes moved before the
// process died. This is the single sanctioned extension point. The caller
// gathers typed install/stage/running evidence *while it holds the canonical
// lock*, and this pure algebra turns only that evidence into one legal record.

export type AttemptRecoveryArtifactEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "verified"; readonly version: string }
  | { readonly kind: "missing"; readonly version: string }
  | { readonly kind: "unreadable" };

export type AttemptRecoveryRunningEvidence =
  | { readonly kind: "absent" }
  | {
      readonly kind: "verified";
      readonly version: string;
      readonly owner: "host-home-bound";
    }
  | { readonly kind: "unbound"; readonly version: string }
  | { readonly kind: "unreadable" };

export interface AttemptRecoveryEvidence {
  readonly installed: AttemptRecoveryArtifactEvidence;
  readonly staged: AttemptRecoveryArtifactEvidence;
  readonly running: AttemptRecoveryRunningEvidence;
}

export interface AttemptRecoveryRequest {
  /** The interrupted record this recovery was authorized against. */
  readonly expected: HostUpdateAttemptIdentity;
  /** The same request authority that would be required to resume a park. */
  readonly action: AttemptClaimAction;
  /** The current desired target; it may make a reconciled old attempt stale. */
  readonly requestedTargetVersion: string;
  readonly evidence: AttemptRecoveryEvidence;
  readonly nowIso: string;
}

export type AttemptRecoveryHolderDisposition =
  /**
   * The canonical acquisition succeeded for this actor. Acquisition itself
   * proved no live predecessor: an indeterminate holder never yields a
   * handle, so recovery cannot reinterpret it as stale.
   */
  | { readonly kind: "recovery-lock-held" }
  | { readonly kind: "holder-live" }
  | { readonly kind: "indeterminate" };

export type AttemptRecoveryRefusal =
  | "record-not-recoverable"
  | "identity-mismatch"
  | "holder-not-proven-absent"
  | "evidence-unreadable"
  | "counter-exhausted"
  | "evidence-insufficient"
  | "request-action-mismatch";

export type AttemptRecoveryDecision =
  | {
      readonly kind: "resume-new-generation";
      readonly record: HostUpdateAttemptRecord;
      readonly continuation: Exclude<HostUpdateAttemptContinuation, null>;
    }
  | {
      readonly kind: "terminalize-complete";
      readonly record: HostUpdateAttemptRecord;
    }
  | {
      readonly kind: "terminalize-failed";
      readonly record: HostUpdateAttemptRecord;
    }
  | {
      readonly kind: "supersede";
      readonly record: HostUpdateAttemptRecord;
      readonly superseded: HostUpdateAttemptIdentity;
    }
  | { readonly kind: "refuse"; readonly reason: AttemptRecoveryRefusal };

export interface AttemptRecoveryContext {
  readonly current: HostUpdateAttemptRecord;
  readonly request: AttemptRecoveryRequest;
  readonly holder: AttemptRecoveryHolderDisposition;
}

/**
 * Decide recovery from lock-scoped facts, never from phase alone.
 *
 * `terminalize-complete` intentionally bypasses the normal `verifying ->
 * complete` edge only when it has the same substantive proof: exact target
 * bytes recorded in the install tree *and* an exact running host positively
 * bound to this home. An installed-but-not-restarted target instead resumes
 * the activation continuation through `preparing`.
 */
export function decideAttemptRecovery(
  context: AttemptRecoveryContext,
): AttemptRecoveryDecision {
  const { current, request, holder } = context;
  if (holder.kind !== "recovery-lock-held") {
    return { kind: "refuse", reason: "holder-not-proven-absent" };
  }
  if (
    current.execution !== "active" ||
    !sameAttemptIdentity(attemptIdentityOf(current), request.expected)
  ) {
    return {
      kind: "refuse",
      reason:
        current.execution !== "active"
          ? "record-not-recoverable"
          : "identity-mismatch",
    };
  }
  if (hasUnreadableEvidence(request.evidence)) {
    return { kind: "refuse", reason: "evidence-unreadable" };
  }

  const summary = recoverySummary(request.evidence);
  const installedTarget = artifactMatches(
    request.evidence.installed,
    current.targetVersion,
  );
  const runningTarget = runningMatches(
    request.evidence.running,
    current.targetVersion,
  );

  if (installedTarget && runningTarget) {
    const record = recoveredTerminalRecord(
      current,
      "complete",
      summary,
      null,
      request.nowIso,
    );
    return record === null
      ? { kind: "refuse", reason: "counter-exhausted" }
      : { kind: "terminalize-complete", record };
  }

  if (recoveryEvidenceContradicts(current, request.evidence)) {
    const record = recoveredTerminalRecord(
      current,
      "failed",
      summary,
      {
        code: "recovery-evidence-contradiction",
        message:
          "lock-scoped install, stage, and running-host evidence disagreed during recovery",
        phase: current.phase,
      },
      request.nowIso,
    );
    return record === null
      ? { kind: "refuse", reason: "counter-exhausted" }
      : { kind: "terminalize-failed", record };
  }

  // An exact, independently verified old target is completed above. For any
  // other reconciled active segment a new desired target may safely follow
  // the core's ordinary two-write protocol: this write terminalizes only the
  // old attempt; its caller separately invokes the existing `create` intent.
  if (request.requestedTargetVersion !== current.targetVersion) {
    const record = supersededRecord(current, request.nowIso, {
      recoveredBy: "attempt-executor",
      outcome: "superseded",
      evidence: summary,
    });
    return record === null
      ? { kind: "refuse", reason: "counter-exhausted" }
      : {
          kind: "supersede",
          record,
          superseded: attemptIdentityOf(current),
        };
  }

  const continuation = recoveryContinuation(current, request.evidence);
  if (continuation === null) {
    const record = recoveredTerminalRecord(
      current,
      "failed",
      summary,
      {
        code: "recovery-evidence-insufficient",
        message:
          "recovery could not prove a legal apply or activation continuation",
        phase: current.phase,
      },
      request.nowIso,
    );
    return record === null
      ? { kind: "refuse", reason: "counter-exhausted" }
      : { kind: "terminalize-failed", record };
  }
  // Recovery never upgrades a request's action. Physical evidence determines
  // which continuation is safe *to offer*; the request still decides whether
  // this actor is authorized to claim that continuation. In particular a
  // defer request can reconcile to a terminal fact but can never start work.
  if (!actionMayResume(request.action, continuation)) {
    return { kind: "refuse", reason: "request-action-mismatch" };
  }
  const record = recoveredResumedRecord(current, continuation, request.nowIso);
  return record === null
    ? { kind: "refuse", reason: "counter-exhausted" }
    : { kind: "resume-new-generation", record, continuation };
}

function hasUnreadableEvidence(evidence: AttemptRecoveryEvidence): boolean {
  return (
    evidence.installed.kind === "unreadable" ||
    evidence.staged.kind === "unreadable" ||
    evidence.running.kind === "unreadable"
  );
}

function artifactMatches(
  evidence: AttemptRecoveryArtifactEvidence,
  targetVersion: string,
): boolean {
  return evidence.kind === "verified" && evidence.version === targetVersion;
}

function runningMatches(
  evidence: AttemptRecoveryRunningEvidence,
  targetVersion: string,
): boolean {
  return (
    evidence.kind === "verified" &&
    evidence.owner === "host-home-bound" &&
    evidence.version === targetVersion
  );
}

function recoveryEvidenceContradicts(
  current: HostUpdateAttemptRecord,
  evidence: AttemptRecoveryEvidence,
): boolean {
  const target = current.targetVersion;
  if (
    (evidence.installed.kind === "missing" &&
      evidence.installed.version === target) ||
    (evidence.staged.kind === "missing" && evidence.staged.version === target)
  ) {
    return true;
  }
  if (
    evidence.running.kind === "unbound" &&
    evidence.running.version === target
  ) {
    return true;
  }
  // A host process bound to this home cannot genuinely run the target while
  // its canonical install record proves a different placed target.
  return (
    evidence.running.kind === "verified" &&
    evidence.running.version === target &&
    evidence.installed.kind === "verified" &&
    evidence.installed.version !== target
  );
}

function recoveryContinuation(
  current: HostUpdateAttemptRecord,
  evidence: AttemptRecoveryEvidence,
): Exclude<HostUpdateAttemptContinuation, null> | null {
  // Verified installed bytes without the positive running leg are the
  // post-placement/pre-restart state. This MUST go through activation,
  // starting at preparing, so it can never fabricate waiting-to-activate.
  if (artifactMatches(evidence.installed, current.targetVersion)) {
    return "activate";
  }
  // A verified stage is enough to re-enter the apply segment. Its executor
  // still revalidates stage evidence before writing `applying`.
  if (artifactMatches(evidence.staged, current.targetVersion)) {
    return "resume-apply";
  }
  return null;
}

function recoverySummary(
  evidence: AttemptRecoveryEvidence,
): HostUpdateAttemptRecovery["evidence"] {
  return {
    installed: {
      kind: evidence.installed.kind,
      version:
        evidence.installed.kind === "verified" ||
        evidence.installed.kind === "missing"
          ? evidence.installed.version
          : null,
    },
    staged: {
      kind: evidence.staged.kind,
      version:
        evidence.staged.kind === "verified" ||
        evidence.staged.kind === "missing"
          ? evidence.staged.version
          : null,
    },
    running: {
      kind: evidence.running.kind,
      version:
        evidence.running.kind === "verified" ||
        evidence.running.kind === "unbound"
          ? evidence.running.version
          : null,
      ownerBound:
        evidence.running.kind === "verified" &&
        evidence.running.owner === "host-home-bound",
    },
  };
}

function recoveredTerminalRecord(
  current: HostUpdateAttemptRecord,
  outcome: Exclude<HostUpdateAttemptRecovery["outcome"], "superseded">,
  evidence: HostUpdateAttemptRecovery["evidence"],
  error: HostUpdateAttemptError,
  nowIso: string,
): HostUpdateAttemptRecord | null {
  const generation = nextAttemptCounter(current.generation);
  const sequence = nextAttemptCounter(current.sequence);
  if (generation === null || sequence === null) return null;
  const phase = outcome === "complete" ? "complete" : "failed";
  return {
    ...current,
    generation,
    sequence,
    phase,
    execution: "terminal",
    continuation: null,
    progress: null,
    updatedAt: nowIso,
    completedAt: nowIso,
    error,
    recovery: { recoveredBy: "attempt-executor", outcome, evidence },
  };
}

function recoveredResumedRecord(
  current: HostUpdateAttemptRecord,
  continuation: Exclude<HostUpdateAttemptContinuation, null>,
  nowIso: string,
): HostUpdateAttemptRecord | null {
  return resumedRecord(current, continuation, nowIso);
}

export function decideAttemptClaim(
  context: AttemptClaimContext,
): AttemptClaimDecision {
  const { current, request, holder } = context;
  const lockHeld = holder.kind === "held-by-self";

  if (current.kind !== "valid" && current.kind !== "absent") {
    return { kind: "refuse", reason: "record-fail-closed", observed: null };
  }

  // `start` is the sole unbound operation. Every other request is bound to a
  // concrete record; otherwise a force/defer/activation token could be
  // replayed as a fresh update after retention cleanup.
  if (request.action !== "start" && request.expected === null) {
    return { kind: "refuse", reason: "stale-expectation", observed: null };
  }
  if (request.action === "start" && request.expected !== null) {
    return {
      kind: "refuse",
      reason: "request-action-mismatch",
      observed: null,
    };
  }

  // ---- Identity-bound requests are checked FIRST, before any create path.
  //
  // A Force / Activate / Defer request names an attempt that was live when
  // it was authorized. If that attempt is gone - cleaned up, or already
  // terminal - the request has nothing left to act on, and the one thing it
  // must NOT do is mint a fresh attempt out of its own `targetVersion` and
  // `initialPhase`. That is a delayed request replaying as a brand-new
  // update, days later, against a target the user may have long since
  // changed. Running this ahead of the absent/terminal create branches is
  // what makes that unreachable rather than merely unlikely.
  if (request.expected !== null) {
    if (current.kind === "absent") {
      return { kind: "refuse", reason: "stale-expectation", observed: null };
    }
    if (
      !sameAttemptIdentity(request.expected, attemptIdentityOf(current.value))
    ) {
      return {
        kind: "refuse",
        reason: "stale-expectation",
        observed: current.value,
      };
    }
    if (current.value.execution === "terminal") {
      return {
        kind: "refuse",
        reason: "attempt-already-terminal",
        observed: current.value,
      };
    }
    if (current.value.targetVersion !== request.targetVersion) {
      return {
        kind: "refuse",
        reason: "request-target-mismatch",
        observed: current.value,
      };
    }
  }

  if (current.kind === "absent") {
    if (!lockHeld) {
      return { kind: "refuse", reason: "lock-unavailable", observed: null };
    }
    return { kind: "create", record: createdRecord(request) };
  }

  const record = current.value;

  if (!lockHeld) {
    // Attach is an acknowledgement of another executor's *durably active*
    // segment, not a generic response to contention.  A park is expected to
    // be holder-free; a busy/unparseable observation says nothing useful; and
    // neither can safely acknowledge the pre-adoption identity.
    if (
      holder.kind === "holder-live" &&
      record.execution === "active" &&
      record.targetVersion === request.targetVersion &&
      request.action === "start"
    ) {
      return { kind: "attach", observed: record };
    }
    if (record.targetVersion !== request.targetVersion) {
      return { kind: "refuse", reason: "target-conflict", observed: record };
    }
    return { kind: "refuse", reason: "lock-unavailable", observed: record };
  }

  // A terminal record is retained evidence, not an obstacle: a newer attempt
  // replaces it (§1.5, "replacing it only when a newer attempt is durably
  // claimed"). Unreachable for an identity-bound request, which was already
  // refused above.
  if (record.execution === "terminal") {
    if (request.newAttemptId === record.attemptId) {
      return {
        kind: "refuse",
        reason: "new-attempt-id-reused",
        observed: record,
      };
    }
    return { kind: "create", record: createdRecord(request) };
  }

  // ---- Recovery outranks supersession, for EVERY active record.
  //
  // Checked before the target comparison, and that order is the whole point.
  // An executor that died after promoting the install tree but before its
  // write-after record leaves a record still reading `applying`. Letting a
  // request for a DIFFERENT target terminalize that record would mint a
  // fresh attempt without ever reconciling `install.json`, the staged
  // artifacts, or the filesystem generation - which is exactly the
  // reconciliation §1.4 requires before choosing resume, supersede, or fail.
  // The recovery layer may still decide to supersede; it just may not be
  // skipped on the way there.
  if (record.execution === "active") {
    return { kind: "refuse", reason: "requires-recovery", observed: record };
  }

  // Parked from here down: no holder by design, and the durable state is
  // exactly what the parking segment committed.
  if (record.targetVersion !== request.targetVersion) {
    const superseded = supersededRecord(record, request.nowIso, undefined);
    if (superseded === null) {
      return { kind: "refuse", reason: "counter-exhausted", observed: record };
    }
    return {
      kind: "supersede",
      record: superseded,
      superseded: attemptIdentityOf(record),
    };
  }

  const continuation = record.continuation;
  if (continuation === null) {
    // Unreachable through `decodeHostUpdateAttempt`, which rejects a park
    // with no continuation as corrupt. Kept as a refusal rather than a
    // throw so a record that reached memory some other way still fails
    // closed instead of resuming with no idea what it is resuming.
    return { kind: "refuse", reason: "record-fail-closed", observed: record };
  }
  if (!actionMayResume(request.action, continuation)) {
    return {
      kind: "refuse",
      reason: "request-action-mismatch",
      observed: record,
    };
  }
  const resumed = resumedRecord(record, continuation, request.nowIso);
  if (resumed === null) {
    return { kind: "refuse", reason: "counter-exhausted", observed: record };
  }
  return { kind: "resume", record: resumed, continuation };
}

/**
 * Exactly which authorization can adopt each parked continuation.
 *
 * `force` is a request to proceed through the pre-apply busy gate, so it
 * may resume only `resume-apply`. Activation has its own action because
 * `waiting-to-activate` says promotion is already complete. `defer` is a
 * future in-segment parking action, not a claim action, and therefore cannot
 * accidentally turn into a resume while the durable-core API has no request
 * journal to consume it from.
 */
function actionMayResume(
  action: AttemptClaimAction,
  continuation: Exclude<HostUpdateAttemptContinuation, null>,
): boolean {
  if (continuation === "resume-apply") {
    return action === "resume-apply" || action === "force";
  }
  return action === "activate";
}

function createdRecord(request: AttemptClaimRequest): HostUpdateAttemptRecord {
  return {
    schemaVersion: HOST_UPDATE_ATTEMPT_SCHEMA_VERSION,
    attemptId: request.newAttemptId,
    generation: 1,
    sequence: 1,
    trigger: request.trigger,
    targetVersion: request.targetVersion,
    phase: request.initialPhase,
    execution: executionForPhase(request.initialPhase),
    continuation: null,
    progress: null,
    startedAt: request.nowIso,
    updatedAt: request.nowIso,
    completedAt: null,
    error: null,
  };
}

// `null` when either counter can no longer be incremented in a way that
// provably advances - see `nextAttemptCounter`. Refusing the transition is
// the only safe answer: a "bump" that returns the same number would leave
// the old segment's writes indistinguishable from the new one's.
function supersededRecord(
  record: HostUpdateAttemptRecord,
  nowIso: string,
  recovery: HostUpdateAttemptRecovery | undefined,
): HostUpdateAttemptRecord | null {
  // The generation bump is what disarms the old segment: a process still
  // holding generation N is provably no longer the owner once N+1 is on
  // disk, so its late write is rejected rather than resurrecting a target
  // that has been explicitly abandoned.
  const generation = nextAttemptCounter(record.generation);
  const sequence = nextAttemptCounter(record.sequence);
  if (generation === null || sequence === null) return null;
  return {
    ...record,
    generation,
    sequence,
    phase: "superseded",
    execution: "terminal",
    continuation: null,
    updatedAt: nowIso,
    completedAt: nowIso,
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function resumedRecord(
  record: HostUpdateAttemptRecord,
  continuation: Exclude<HostUpdateAttemptContinuation, null>,
  nowIso: string,
): HostUpdateAttemptRecord | null {
  const generation = nextAttemptCounter(record.generation);
  const sequence = nextAttemptCounter(record.sequence);
  if (generation === null || sequence === null) return null;
  return {
    ...record,
    generation,
    sequence,
    // `preparing`, for BOTH continuations, and never the phase that does the
    // work:
    //
    //  - `resume-apply` must re-verify stage evidence before `applying` is
    //    committed (§1.4 adoption checks). Landing in `applying` would
    //    durably claim a promotion this segment has not re-validated.
    //  - `activate` must run the final drain / force check BEFORE
    //    `restarting` is written, because §4 forbids any deferrable gate
    //    after that phase. Landing in `restarting` would put the drain check
    //    on the wrong side of the promise of immediate bootout.
    phase: "preparing",
    execution: "active",
    // Deliberately RETAINED through the active segment. It is what still
    // says "bytes are already placed, do not re-apply" if this segment dies
    // before it reaches its next write.
    continuation,
    // The creating trigger is the attempt's provenance and does not change
    // when someone else resumes it. Force authorization travels in the
    // request (§1.3), never by rewriting the record's trigger - that is what
    // stops an automatic attempt from inventing force permission for itself.
    trigger: record.trigger,
    updatedAt: nowIso,
  };
}

// ---- In-segment advance -----------------------------------------------------

/**
 * Which phases may legally follow which, within a segment.
 *
 * Two entries carry the plan's load-bearing prohibitions and are not
 * housekeeping:
 *
 *  - `waiting-to-activate` has NO edge to `applying`. Bytes are already
 *    placed at that park; re-applying is not a retry, it is a corruption
 *    (§1.5).
 *  - nothing reaches `complete` except `verifying`. §1.4: completion is
 *    never inferred from phase alone - it requires a healthy host answering
 *    with the exact target version.
 */
const LEGAL_SUCCESSORS: ReadonlyMap<
  HostUpdateAttemptPhase,
  ReadonlySet<HostUpdateAttemptPhase>
> = new Map([
  [
    "downloading",
    new Set<HostUpdateAttemptPhase>([
      "downloading",
      "preparing",
      "waiting-for-work",
      "failed",
      "superseded",
    ]),
  ],
  [
    "preparing",
    new Set<HostUpdateAttemptPhase>([
      "preparing",
      "downloading",
      "applying",
      "waiting-for-work",
      "waiting-to-activate",
      "restarting",
      "verifying",
      "failed",
      "superseded",
    ]),
  ],
  [
    "applying",
    new Set<HostUpdateAttemptPhase>([
      "applying",
      "waiting-to-activate",
      "restarting",
      "verifying",
      "failed",
      "superseded",
    ]),
  ],
  [
    "waiting-for-work",
    new Set<HostUpdateAttemptPhase>(["preparing", "failed", "superseded"]),
  ],
  [
    "waiting-to-activate",
    new Set<HostUpdateAttemptPhase>([
      "preparing",
      "restarting",
      "failed",
      "superseded",
    ]),
  ],
  [
    "restarting",
    new Set<HostUpdateAttemptPhase>(["verifying", "failed", "superseded"]),
  ],
  [
    "verifying",
    new Set<HostUpdateAttemptPhase>([
      "verifying",
      "complete",
      "failed",
      "superseded",
    ]),
  ],
  ["complete", new Set<HostUpdateAttemptPhase>([])],
  ["failed", new Set<HostUpdateAttemptPhase>([])],
  ["superseded", new Set<HostUpdateAttemptPhase>([])],
]);

export function isLegalPhaseTransition(
  from: HostUpdateAttemptPhase,
  to: HostUpdateAttemptPhase,
): boolean {
  return LEGAL_SUCCESSORS.get(from)?.has(to) ?? false;
}

/**
 * Phases an in-flight continuation forbids, whatever the generic successor
 * table says.
 *
 * `activate` means the bytes for this target are ALREADY PLACED. Applying
 * again is not a retry, it is a second promotion of an install tree that is
 * already promoted; downloading again re-fetches an artifact that is already
 * on disk and staged. The generic table cannot express this because it is
 * keyed on phase alone, and the resume path deliberately lands `activate` in
 * `preparing` - whose ordinary successors include `applying`.
 */
const CONTINUATION_FORBIDDEN_PHASES: ReadonlyMap<
  Exclude<HostUpdateAttemptContinuation, null>,
  ReadonlySet<HostUpdateAttemptPhase>
> = new Map([
  ["activate", new Set<HostUpdateAttemptPhase>(["applying", "downloading"])],
  // `resume-apply` exists precisely to reach `applying`; it forbids nothing.
  ["resume-apply", new Set<HostUpdateAttemptPhase>([])],
]);

export interface AttemptAdvance {
  readonly phase: HostUpdateAttemptPhase;
  /**
   * Stated explicitly rather than derived, so an inconsistency is a loud
   * rejection instead of a silent correction - and, more importantly, so
   * that erasing or swapping an in-flight continuation is something the
   * caller must ask for and be refused, rather than something it can do by
   * omission. See `continuationRejection`.
   */
  readonly continuation: HostUpdateAttemptContinuation;
  readonly progress: HostUpdateAttemptProgress;
  readonly error: HostUpdateAttemptError;
  readonly nowIso: string;
}

export type AttemptAdvanceRejection =
  // A different attempt entirely - the late writer case (§8).
  | "identity-mismatch"
  // Same attempt, but this segment's claim has been superseded.
  | "generation-superseded"
  // The record has moved on since this segment last wrote. Only the holder
  // writes, so this means the holder's own view is stale.
  | "sequence-stale"
  | "terminal"
  // The current record is PARKED. Leaving a park is a claim, not an advance.
  | "not-active"
  | "illegal-phase"
  | "illegal-continuation"
  // The in-flight continuation forbids the requested phase - `activate`
  // reaching for `applying` or `downloading`.
  | "continuation-forbids-phase"
  // The continuation's durable phase provenance does not authorize this
  // next state: a resumed apply has not written `applying` yet, or an
  // activation segment has skipped its restart boundary.
  | "continuation-phase-order"
  | "counter-exhausted";

export type AttemptAdvanceOutcome =
  | { readonly kind: "advanced"; readonly record: HostUpdateAttemptRecord }
  | { readonly kind: "rejected"; readonly reason: AttemptAdvanceRejection };

/**
 * Advance the attempt one write, WITHIN a segment.
 *
 * `current` must be the record as it is on disk right now (re-read under the
 * lock); `held` is the identity this segment last committed.
 *
 * This function can never leave a park, and that restriction is load-bearing
 * rather than tidiness. Leaving a park is an adoption: it bumps `generation`
 * and must pass `decideAttemptClaim`'s expected-identity check. An advance
 * bumps only `sequence`. Allowing `waiting-to-activate -> restarting` here
 * would let a holder walk straight out of a park with no generation bump at
 * all, silently disarming the very check that rejects a stale
 * Force/Activate request.
 */
export function advanceAttempt(
  current: HostUpdateAttemptRecord,
  held: HostUpdateAttemptIdentity,
  advance: AttemptAdvance,
): AttemptAdvanceOutcome {
  if (current.attemptId !== held.attemptId) {
    return { kind: "rejected", reason: "identity-mismatch" };
  }
  if (current.generation !== held.generation) {
    return { kind: "rejected", reason: "generation-superseded" };
  }
  if (current.sequence !== held.sequence) {
    return { kind: "rejected", reason: "sequence-stale" };
  }
  if (current.execution === "terminal") {
    return { kind: "rejected", reason: "terminal" };
  }
  if (current.execution !== "active") {
    return { kind: "rejected", reason: "not-active" };
  }
  if (!isLegalPhaseTransition(current.phase, advance.phase)) {
    return { kind: "rejected", reason: "illegal-phase" };
  }
  if (
    current.continuation !== null &&
    (CONTINUATION_FORBIDDEN_PHASES.get(current.continuation)?.has(
      advance.phase,
    ) ??
      false)
  ) {
    return { kind: "rejected", reason: "continuation-forbids-phase" };
  }
  const continuationRejected = continuationRejection(current, advance);
  if (continuationRejected) {
    return { kind: "rejected", reason: "illegal-continuation" };
  }
  if (continuationPhaseOrderRejected(current, advance)) {
    return { kind: "rejected", reason: "continuation-phase-order" };
  }
  const sequence = nextAttemptCounter(current.sequence);
  if (sequence === null) {
    return { kind: "rejected", reason: "counter-exhausted" };
  }

  const execution = executionForPhase(advance.phase);
  return {
    kind: "advanced",
    record: {
      ...current,
      sequence,
      phase: advance.phase,
      execution,
      continuation: advance.continuation,
      progress: advance.progress,
      error: advance.error,
      updatedAt: advance.nowIso,
      // Stamped once, when the attempt actually ends. Timestamps are display
      // and staleness inputs only (§1.3) - never ordering - so this is the
      // one place a terminal record's age comes from.
      completedAt: execution === "terminal" ? advance.nowIso : null,
    },
  };
}

/**
 * The generic phase graph intentionally cannot answer these questions: the
 * same `preparing` phase means different things before byte placement, while
 * re-applying after an activation park is corruption. The continuation is the
 * durable provenance that disambiguates those states.
 *
 * `waiting-to-activate` is evidence that packaged-Mac bytes were placed, so
 * it may be BORN only by an `applying` write. An already-resumed `activate`
 * segment may re-park from `preparing` when its final drain defers; that is
 * not a new placement claim. A resumed `resume-apply` segment carries its
 * continuation unchanged until it has itself committed `applying`, and only
 * then may reach restart, verification, or the activation park. Finally an
 * `activate` segment has exactly its final-drain -> restart -> verify route.
 */
function continuationPhaseOrderRejected(
  current: HostUpdateAttemptRecord,
  advance: AttemptAdvance,
): boolean {
  if (advance.phase === "waiting-to-activate") {
    const bornFromApplying = current.phase === "applying";
    const reparkedActivation =
      current.phase === "preparing" && current.continuation === "activate";
    if (!bornFromApplying && !reparkedActivation) return true;
  }

  if (current.continuation === "resume-apply") {
    const hasWrittenApplying =
      current.phase === "applying" ||
      current.phase === "restarting" ||
      current.phase === "verifying";
    if (
      !hasWrittenApplying &&
      (advance.phase === "restarting" ||
        advance.phase === "verifying" ||
        advance.phase === "waiting-to-activate")
    ) {
      return true;
    }
    return false;
  }

  if (current.continuation !== "activate") return false;

  if (current.phase === "preparing") {
    return !(
      advance.phase === "preparing" ||
      advance.phase === "waiting-to-activate" ||
      advance.phase === "restarting" ||
      advance.phase === "failed" ||
      advance.phase === "superseded"
    );
  }
  if (current.phase === "restarting") {
    return !(
      advance.phase === "verifying" ||
      advance.phase === "failed" ||
      advance.phase === "superseded"
    );
  }
  if (current.phase === "verifying") return false;

  // An `activate` continuation in any other active phase is impossible for
  // records this core writes. Refuse rather than allowing a corrupt history
  // to re-enter the activation route from a byte-placement phase.
  return true;
}

/**
 * Whether the requested continuation is illegal for this advance.
 *
 * Three rules, each closing a different way to lose the "bytes are already
 * placed" fact:
 *
 *  - **terminal target** - must be `null`. The attempt is over; there is
 *    nothing left to continue.
 *  - **parked target** - must be that park's own continuation AND, if one is
 *    already in flight, the same one. One deliberate handoff exists:
 *    `resume-apply` may become `activate` only at
 *    `applying -> waiting-to-activate`, where the latter is the durable
 *    evidence that byte placement completed. So an `activate` segment may
 *    only ever re-park at `waiting-to-activate`; it cannot park as
 *    `waiting-for-work` and come back believing it still has an apply to do.
 *  - **active target** - must be EXACTLY what is already in flight. This is
 *    the erase-and-swap gate: a caller cannot quietly pass `null` and drop
 *    the continuation on the floor, nor swap `activate` for `resume-apply`
 *    and re-apply placed bytes one phase later.
 *
 * A continuation is therefore born at a park and dies at a terminal, and in
 * between it can only be carried unchanged.
 */
function continuationRejection(
  current: HostUpdateAttemptRecord,
  advance: AttemptAdvance,
): boolean {
  if (!continuationLegalFor(advance.phase, advance.continuation)) return true;
  if (isTerminalPhase(advance.phase)) return false;
  if (isParkedPhase(advance.phase)) {
    if (
      current.continuation === "resume-apply" &&
      current.phase === "applying" &&
      advance.phase === "waiting-to-activate" &&
      advance.continuation === "activate"
    ) {
      return false;
    }
    return (
      current.continuation !== null &&
      current.continuation !== advance.continuation
    );
  }
  return advance.continuation !== current.continuation;
}
