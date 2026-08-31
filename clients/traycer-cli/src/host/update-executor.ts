import {
  attemptIdentityOf,
  decideAttemptClaim,
  decideAttemptRecovery,
  isTerminalPhase,
  readUpdateAttemptRecord,
  type AttemptCommitOutcome,
  type AttemptClaimRequest,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRecord,
  type HostUpdateTrigger,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type { AttemptMutationIntent } from "@traycer-clients/shared/host-update/store";
import {
  commitExecutorAttemptMutation,
  commitExecutorRecoveryMutation,
  withUpdateExecutorCompletionSegment,
  type ExecutorCompletionSession,
} from "@traycer-clients/shared/host-update/contender";
import { hostHomeDir } from "../store/paths";
import {
  withCliAttemptMutation,
  withCliExecutorRecoveryEvidence,
  type WithCliAttemptExecutorOptions,
} from "./update-contender";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { HostInstallPlatform } from "../manifest/host-install";
import { decideUpdateExecutorCohort } from "./update-executor-cohort";
import {
  observeAttemptRecoveryEvidence,
  sameAttemptRecoveryEvidenceObservation,
  type AttemptRecoveryEvidenceObservation,
} from "./update-recovery-evidence";

/** Clock-free request carried into the executor. The executor stamps its own write. */
export interface ExecutorClaimRequest {
  readonly targetVersion: string;
  readonly trigger: HostUpdateTrigger;
  readonly action: AttemptClaimRequest["action"];
  readonly expected: HostUpdateAttemptIdentity | null;
  readonly newAttemptId: string;
  readonly initialPhase: AttemptClaimRequest["initialPhase"];
}

/** Every boundary is injectable so parent/child/write crash tests stay deterministic. */
export interface UpdateExecutorFaults {
  hit(
    point:
      | "before-dispatch-spawn"
      | "after-dispatch-spawn-before-ack"
      | "before-claim-write"
      | "after-claim-write-before-ack"
      | "after-private-ack-before-action"
      | "before-recovery-evidence"
      | "after-recovery-evidence-before-write"
      | "after-recovery-write-before-action"
      | "before-terminal-write"
      | "after-terminal-evidence-before-write"
      | "after-terminal-write",
  ): Promise<void>;
}

export const NO_UPDATE_EXECUTOR_FAULTS: UpdateExecutorFaults = {
  async hit(): Promise<void> {},
};

/**
 * The three privileged CLI executor authorities are deliberately colocated
 * with their sole consumer. They are module-private, so no trusted bridge can
 * re-export, alias, wrap, or otherwise launder them to another caller.
 */
async function withCliAttemptExecutorCompletion<T>(
  options: WithCliAttemptExecutorOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
    completion: ExecutorCompletionSession,
  ) => Promise<T>,
): Promise<T> {
  const outcome = await withUpdateExecutorCompletionSegment(
    {
      hostHomeDir: options.hostHomeDir ?? hostHomeDir(options.environment),
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
    },
    run,
  );
  return unwrapExecutorContenderOutcome(options, outcome);
}

async function commitCliExecutorAttemptMutation(
  capability: UpdateMutationCapability,
  options: WithCliAttemptExecutorOptions,
  intent: Exclude<AttemptMutationIntent, { readonly kind: "recover" }>,
): Promise<AttemptCommitOutcome> {
  return commitExecutorAttemptMutation(
    capability,
    options.hostHomeDir ?? hostHomeDir(options.environment),
    intent,
  );
}

async function commitCliExecutorRecoveryMutation(
  capability: UpdateMutationCapability,
  options: WithCliAttemptExecutorOptions,
  intent: Extract<AttemptMutationIntent, { readonly kind: "recover" }>,
): Promise<AttemptCommitOutcome> {
  return commitExecutorRecoveryMutation(
    capability,
    options.hostHomeDir ?? hostHomeDir(options.environment),
    intent,
  );
}

function unwrapExecutorContenderOutcome<T>(
  options: WithCliAttemptExecutorOptions,
  outcome: UpdateContenderOutcome<T>,
): T {
  switch (outcome.kind) {
    case "ran":
      return outcome.result;
    case "busy":
    case "held-in-process":
      throw cliError({
        code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
        message: "another host update contender is in progress",
        details: { reason: options.reason, holder: outcome.holder },
        exitCode: 75,
      });
    case "nonterminal-attempt":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
        message:
          "a host update attempt is in progress; executor admission was refused",
        details: {
          reason: options.reason,
          disposition: outcome.disposition,
          attemptId: outcome.record.attemptId,
          phase: outcome.record.phase,
        },
        exitCode: 75,
      });
    case "record-fail-closed":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
        message: "host update attempt state cannot be verified",
        details: { reason: options.reason, recordKind: outcome.record.kind },
        exitCode: 1,
      });
    case "lock-not-live":
      throw cliError({
        code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
        message:
          "host update coordination was lost before executor work could run",
        details: { reason: options.reason, verdict: outcome.verdict.kind },
        exitCode: 75,
      });
  }
}

/**
 * The execution callback gets this lexical operation, not a completion
 * observation or proof. It captures the claimed identity and re-observes the
 * installed/running target itself immediately before the sole terminal write.
 */
export type CompleteExecutorSegment = () => Promise<AttemptCommitOutcome>;

export interface RunAttemptExecutorClaimOptions {
  /**
   * The CLI derives the rollout decision itself from this installed platform.
   * A caller cannot pass a pre-built `eligible` verdict to opt around the
   * shadow fence.
   */
  readonly platform: HostInstallPlatform;
  readonly contender: WithCliAttemptExecutorOptions;
  readonly request: ExecutorClaimRequest;
  /** Called only after the executor owns the canonical lock. */
  readonly readRecoveryEvidence: () => Promise<AttemptRecoveryEvidenceObservation>;
  /** The executor owns its own timestamps; dispatch cannot pre-date a claim. */
  readonly nowIso: () => string;
  readonly faults: UpdateExecutorFaults;
}

/** Production convenience path: evidence is always gathered under the lock. */
export type RunLocalAttemptExecutorSegmentOptions = Omit<
  RunAttemptExecutorClaimOptions,
  "readRecoveryEvidence"
>;

export type ExecutorClaimOutcome =
  | {
      readonly kind: "claimed";
      readonly identity: HostUpdateAttemptIdentity;
      readonly record: HostUpdateAttemptRecord;
      readonly continuation: "resume-apply" | "activate" | null;
    }
  | {
      readonly kind: "terminalized";
      readonly identity: HostUpdateAttemptIdentity;
      readonly record: HostUpdateAttemptRecord;
      readonly outcome: "complete" | "failed";
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly observed: HostUpdateAttemptRecord | null;
    };

/**
 * The raw terminal write stays module-private. Its only caller is the local
 * verifier below, which has just bound a healthy host.status response to the
 * current pid record and installed-byte generation while holding the live
 * executor capability. No caller may hand this function a testimonial object.
 */
async function completeAttemptExecutorSegment(
  capability: UpdateMutationCapability,
  options: WithCliAttemptExecutorOptions,
  claimed: HostUpdateAttemptIdentity,
  nowIso: string,
  faults: UpdateExecutorFaults,
  commit: (observation: {
    readonly expected: HostUpdateAttemptIdentity;
    readonly targetVersion: string;
    readonly runningVersion: string;
    readonly runningOwner: "host-home-bound";
    readonly nowIso: string;
  }) => Promise<AttemptCommitOutcome>,
): Promise<AttemptCommitOutcome> {
  const home = options.hostHomeDir ?? hostHomeDir(options.environment);
  // The final phase/identity read, live process proof, sealing and durable
  // write all run inside the caller's short inner CLI lock. The claim fixes
  // the attempt generation, but its sequence is necessarily stale after the
  // legal preparing/applying/restarting/verifying writes. Derive the exact
  // current verifying identity here; no caller-owned snapshot crosses this
  // boundary.
  const canonical = await readUpdateAttemptRecord(home);
  if (
    canonical.kind !== "valid" ||
    !sameClaimedAttemptGeneration(canonical.value, claimed) ||
    canonical.value.phase !== "verifying"
  ) {
    return { kind: "rejected", reason: "intent-not-legal", canonical };
  }
  const observation = await observeAttemptRecoveryEvidence(
    options.environment,
    home,
  );
  const evidence = observation.evidence;
  if (
    evidence.installed.kind !== "verified" ||
    evidence.installed.version !== canonical.value.targetVersion ||
    evidence.running.kind !== "verified" ||
    evidence.running.version !== canonical.value.targetVersion
  ) {
    return {
      kind: "rejected",
      reason: "intent-not-legal",
      canonical,
    };
  }
  await faults.hit("before-terminal-write");
  await faults.hit("after-terminal-evidence-before-write");
  const outcome = await commit({
    expected: attemptIdentityOf(canonical.value),
    targetVersion: canonical.value.targetVersion,
    runningVersion: evidence.running.version,
    runningOwner: "host-home-bound",
    nowIso,
  });
  if (outcome.kind === "committed") await faults.hit("after-terminal-write");
  return outcome;
}

export type ExecutorSegmentOutcome<T> =
  | {
      readonly kind: "executed";
      readonly claim: Extract<
        ExecutorClaimOutcome,
        { readonly kind: "claimed" }
      >;
      readonly result: T;
    }
  | Exclude<ExecutorClaimOutcome, { readonly kind: "claimed" }>;

/**
 * Claim, positively acknowledge, and execute one executor segment while the
 * exact outer capability remains held. This is the only API that hands a
 * capability to execution work. There is deliberately no claim-only API, so
 * a returned identity can never be misused as a transferable post-lock lease.
 */
/**
 * Does the canonical record name a live continuation this executor owns?
 *
 * The CLI half of Ticket 07 Finding 2, and deliberately the same shape as
 * Desktop's `hasAdoptedActivationContinuation` - the cohort gate stops NEW
 * attempts and must never abandon an ADOPTED one.
 *
 * Broader than Desktop's on exactly one axis, because the two executors own
 * different work: Desktop performs `activate` and nothing else, while this
 * executor owns every continuation the vocabulary has (`resume-apply` and
 * `activate`). So "a continuation this build owns" is any non-null
 * continuation on a live record.
 *
 * Consumes the canonical `isTerminalPhase` rather than listing phase names,
 * for the reason round 2 of Ticket 05 established: a second copy of that
 * classification is a bug with a plausible comment attached.
 *
 * An absent or unreadable record answers `false` and routes to the gate - the
 * fail-closed direction. Nothing is adopted, so refusing strands nothing.
 */
async function hasAdoptedContinuation(home: string): Promise<boolean> {
  const record = await readUpdateAttemptRecord(home);
  return (
    record.kind === "valid" &&
    record.value.continuation !== null &&
    !isTerminalPhase(record.value.phase)
  );
}

export async function runAttemptExecutorSegment<T>(
  options: RunAttemptExecutorClaimOptions,
  acknowledge: (
    claim: Extract<ExecutorClaimOutcome, { readonly kind: "claimed" }>,
  ) => Promise<void>,
  execute: (
    capability: UpdateMutationCapability,
    claim: Extract<ExecutorClaimOutcome, { readonly kind: "claimed" }>,
    complete: CompleteExecutorSegment,
  ) => Promise<T>,
): Promise<ExecutorSegmentOutcome<T>> {
  // Ticket 07 Finding 2 (CLI half). This gate is production-reachable today
  // through `host update-verify`, which Desktop dispatches after every
  // packaged-mac restart: `update-verify` -> `runLocalAttemptExecutorSegment`
  // -> here. Refusing an ADOPTED continuation on that path would abandon the
  // very attempt the verification exists to conclude.
  if (
    !(await hasAdoptedContinuation(
      options.contender.hostHomeDir ??
        hostHomeDir(options.contender.environment),
    ))
  ) {
    if (decideUpdateExecutorCohort(options.platform).kind !== "eligible") {
      return { kind: "rejected", reason: "cohort-disabled", observed: null };
    }
  }
  return withCliAttemptExecutorCompletion(
    options.contender,
    async (capability, _context, completion) => {
      const claim = await claimUnderExecutorCapability(capability, options);
      if (claim.kind !== "claimed") return claim;
      // This is the private positive acknowledgement boundary. If it throws,
      // the capability releases without an actuator; dispatch reconciles the
      // durable record instead of treating spawn as accepted.
      await acknowledge(claim);
      await options.faults.hit("after-private-ack-before-action");
      let active = true;
      const complete: CompleteExecutorSegment = async () => {
        if (!active) {
          throw new Error(
            "executor terminal completion was called outside its session",
          );
        }
        return withCliAttemptMutation(
          capability,
          { ...options.contender, admission: "attempt-executor" },
          async () => {
            if (!active) {
              throw new Error(
                "executor terminal completion was called outside its session",
              );
            }
            return completeAttemptExecutorSegment(
              capability,
              options.contender,
              claim.identity,
              options.nowIso(),
              options.faults,
              async (observation) => {
                if (!active) {
                  throw new Error(
                    "executor terminal completion was called outside its session",
                  );
                }
                return completion.complete(observation);
              },
            );
          },
        );
      };
      try {
        return {
          kind: "executed",
          claim,
          result: await execute(capability, claim, complete),
        };
      } finally {
        active = false;
      }
    },
  );
}

async function claimUnderExecutorCapability(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
): Promise<ExecutorClaimOutcome> {
  const current = await readUpdateAttemptRecord(
    options.contender.hostHomeDir ?? hostHomeDir(options.contender.environment),
  );
  const request = claimRequestAtExecutor(options.request, options.nowIso());
  const decision = decideAttemptClaim({
    current,
    request,
    holder: { kind: "held-by-self" },
  });

  if (decision.kind === "refuse") {
    if (decision.reason !== "requires-recovery" || current.kind !== "valid") {
      return {
        kind: "rejected",
        reason: decision.reason,
        observed: decision.observed,
      };
    }
    return recoverInterruptedAttempt(
      capability,
      options,
      current.value,
      request,
    );
  }
  if (decision.kind === "attach") {
    // An acquired canonical handle cannot truthfully attach to another
    // holder. Keep this defensive arm so a future lock implementation
    // cannot accidentally turn it into a work acceptance.
    return {
      kind: "rejected",
      reason: "unexpected-live-holder",
      observed: decision.observed,
    };
  }
  if (decision.kind === "supersede") {
    return commitSupersedeThenCreate(
      capability,
      options,
      request,
      decision.record,
    );
  }
  return commitClaimMutation(
    capability,
    options,
    { kind: decision.kind, request },
    decision.record,
  );
}

export async function runLocalAttemptExecutorSegment<T>(
  options: RunLocalAttemptExecutorSegmentOptions,
  acknowledge: (
    claim: Extract<ExecutorClaimOutcome, { readonly kind: "claimed" }>,
  ) => Promise<void>,
  execute: (
    capability: UpdateMutationCapability,
    claim: Extract<ExecutorClaimOutcome, { readonly kind: "claimed" }>,
    complete: CompleteExecutorSegment,
  ) => Promise<T>,
): Promise<ExecutorSegmentOutcome<T>> {
  const home =
    options.contender.hostHomeDir ?? hostHomeDir(options.contender.environment);
  return runAttemptExecutorSegment(
    {
      ...options,
      readRecoveryEvidence: () =>
        observeAttemptRecoveryEvidence(options.contender.environment, home),
    },
    acknowledge,
    execute,
  );
}

async function recoverInterruptedAttempt(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  current: HostUpdateAttemptRecord,
  request: AttemptClaimRequest,
): Promise<ExecutorClaimOutcome> {
  await options.faults.hit("before-recovery-evidence");
  // This is deliberately inside `withCliAttemptExecutor`: evidence assembled
  // before lock acquisition is advisory only and is never passed here.
  const initial = await withCliExecutorRecoveryEvidence(
    capability,
    options.contender,
    options.readRecoveryEvidence,
  );
  await options.faults.hit("after-recovery-evidence-before-write");
  // The final observation and recover write share the short inner CLI lock.
  // A stale initial snapshot is advisory: a post-hook install or host flap
  // never becomes a terminal conclusion after this boundary.
  const outcome = await withCliExecutorRecoveryEvidence(
    capability,
    options.contender,
    async () => {
      const final = await options.readRecoveryEvidence();
      if (!sameAttemptRecoveryEvidenceObservation(initial, final)) {
        return { kind: "flapped" as const };
      }
      const recovery = decideAttemptRecovery({
        current,
        request: {
          expected: attemptIdentityOf(current),
          action: request.action,
          requestedTargetVersion: request.targetVersion,
          evidence: final.evidence,
          nowIso: options.nowIso(),
        },
        holder: { kind: "recovery-lock-held" },
      });
      if (recovery.kind === "refuse") return recovery;
      const recoveryRequest = {
        expected: attemptIdentityOf(current),
        action: request.action,
        requestedTargetVersion: request.targetVersion,
        evidence: final.evidence,
        nowIso: recovery.record.updatedAt,
      };
      if (recovery.kind === "supersede") {
        const committed = await commitCliExecutorAttemptMutation(
          capability,
          options.contender,
          {
            kind: "supersede",
            request,
            recovery: recoveryRequest,
          },
        );
        return { kind: "committed" as const, recovery, committed };
      }
      const committed = await commitCliExecutorRecoveryMutation(
        capability,
        options.contender,
        { kind: "recover", recovery: recoveryRequest },
      );
      return { kind: "committed" as const, recovery, committed };
    },
  );
  if (outcome.kind === "flapped") {
    return {
      kind: "rejected",
      reason: "recovery-evidence-flapped",
      observed: current,
    };
  }
  if (outcome.kind === "refuse") {
    return { kind: "rejected", reason: outcome.reason, observed: current };
  }
  const { recovery, committed } = outcome;
  if (committed.kind !== "committed") {
    return rejectedCommit(committed, current);
  }
  await options.faults.hit("after-recovery-write-before-action");
  switch (recovery.kind) {
    case "resume-new-generation":
      return parkResumedActivation(
        capability,
        options,
        committed.record,
        recovery.continuation,
      );
    case "terminalize-complete":
      return terminalized(committed.record, "complete");
    case "terminalize-failed":
      return terminalized(committed.record, "failed");
    case "supersede":
      // Preserve the core's two durable facts. A crash after the recovery
      // terminalization leaves the old attempt safely superseded; only this
      // next call may mint the requested replacement.
      return createAfterSupersede(capability, options, request);
  }
}

/**
 * Hand a recovered ACTIVATION continuation back as a PARKED record, before
 * this segment releases its claim.
 *
 * ## The loop this closes (Ticket 07, orphan-recovery ruling)
 *
 * Recovery reconciles an orphaned attempt by resuming it, which lands an
 * ACTIVE `preparing/activate` record. The verify route's execute callback does
 * no activation work - activation belongs to Desktop - so the segment then
 * releases and leaves that record active-and-unheld. That is precisely the
 * shape `decideAttemptClaim` refuses as `requires-recovery`, so the next
 * Force-restart recovers it into the same state again: a stranding LOOP, not a
 * stranding that recovery resolves.
 *
 * Parking it converts the orphan into a legally claimable park before the lock
 * is dropped, so Desktop's ordinary activation segment can resume it with no
 * recovery evidence of its own - which is the property that matters, because a
 * Desktop-minted recovery evidence would be the structural forgery T3 closed.
 *
 * ## Why this is not a new transition
 *
 * `preparing/activate -> waiting-to-activate` is already legal and already
 * named: `continuationPhaseOrderRejected` admits it as `reparkedActivation`
 * ("an already-resumed `activate` segment may re-park from `preparing` when
 * its final drain defers"). This performs that same edge under the capability
 * the recovery write just used - no new writer, no widened authority.
 *
 * `resume-apply` is deliberately untouched: its park is a different phase with
 * different preconditions, and it has no caller in this route. Guessing one
 * here would be inventing a continuation contract.
 */
async function parkResumedActivation(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  recovered: HostUpdateAttemptRecord,
  continuation: "resume-apply" | "activate" | null,
): Promise<ExecutorClaimOutcome> {
  if (continuation !== "activate" || recovered.phase !== "preparing") {
    return acknowledgedClaim(recovered, continuation);
  }
  const parked = await commitCliExecutorAttemptMutation(
    capability,
    options.contender,
    {
      kind: "advance",
      held: attemptIdentityOf(recovered),
      advance: {
        phase: "waiting-to-activate",
        continuation: "activate",
        progress: null,
        error: null,
        nowIso: options.nowIso(),
      },
    },
  );
  // A refused park leaves the recovered record exactly as recovery wrote it.
  // Reporting the failure beats reporting a park that did not happen: the
  // caller must not be told to resume an identity that is not parked.
  if (parked.kind !== "committed") return rejectedCommit(parked, recovered);
  return acknowledgedClaim(parked.record, "activate");
}

async function createAfterSupersede(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  request: AttemptClaimRequest,
): Promise<ExecutorClaimOutcome> {
  const next = {
    ...request,
    action: "start" as const,
    expected: null,
    nowIso: options.nowIso(),
  };
  const current = await readUpdateAttemptRecord(
    options.contender.hostHomeDir ?? hostHomeDir(options.contender.environment),
  );
  const decision = decideAttemptClaim({
    current,
    request: next,
    holder: { kind: "held-by-self" },
  });
  if (decision.kind !== "create") {
    return {
      kind: "rejected",
      reason: decision.kind === "refuse" ? decision.reason : "create-not-legal",
      observed: current.kind === "valid" ? current.value : null,
    };
  }
  return commitClaimMutation(
    capability,
    options,
    { kind: "create", request: next },
    decision.record,
  );
}

async function commitSupersedeThenCreate(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  request: AttemptClaimRequest,
  expected: HostUpdateAttemptRecord,
): Promise<ExecutorClaimOutcome> {
  await options.faults.hit("before-claim-write");
  const committed = await commitCliExecutorAttemptMutation(
    capability,
    options.contender,
    { kind: "supersede", request },
  );
  if (committed.kind !== "committed")
    return rejectedCommit(committed, expected);
  await options.faults.hit("after-claim-write-before-ack");
  // The second write is intentionally a normal core `create`; do not fold it
  // into recovery or a synthetic transition. A crash above leaves the old
  // record durably superseded, which is the exact two-write invariant.
  return createAfterSupersede(capability, options, request);
}

async function commitClaimMutation(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  intent:
    | { readonly kind: "create"; readonly request: AttemptClaimRequest }
    | { readonly kind: "resume"; readonly request: AttemptClaimRequest },
  expected: HostUpdateAttemptRecord,
): Promise<ExecutorClaimOutcome> {
  await options.faults.hit("before-claim-write");
  const committed = await commitCliExecutorAttemptMutation(
    capability,
    options.contender,
    intent,
  );
  if (committed.kind !== "committed")
    return rejectedCommit(committed, expected);
  await options.faults.hit("after-claim-write-before-ack");
  return acknowledgedClaim(committed.record, committed.record.continuation);
}

function acknowledgedClaim(
  record: HostUpdateAttemptRecord,
  continuation: "resume-apply" | "activate" | null,
): ExecutorClaimOutcome {
  return {
    kind: "claimed",
    identity: attemptIdentityOf(record),
    record,
    continuation,
  };
}

function sameClaimedAttemptGeneration(
  record: HostUpdateAttemptRecord,
  claimed: HostUpdateAttemptIdentity,
): boolean {
  return (
    record.attemptId === claimed.attemptId &&
    record.generation === claimed.generation
  );
}

function terminalized(
  record: HostUpdateAttemptRecord,
  outcome: "complete" | "failed",
): ExecutorClaimOutcome {
  return {
    kind: "terminalized",
    identity: attemptIdentityOf(record),
    record,
    outcome,
  };
}

function rejectedCommit(
  outcome: Exclude<AttemptCommitOutcome, { readonly kind: "committed" }>,
  observed: HostUpdateAttemptRecord,
): ExecutorClaimOutcome {
  return {
    kind: "rejected",
    reason: outcome.kind === "rejected" ? outcome.reason : outcome.kind,
    observed,
  };
}

function claimRequestAtExecutor(
  request: ExecutorClaimRequest,
  nowIso: string,
): AttemptClaimRequest {
  return { ...request, nowIso };
}

/** Parent-side private-ack protocol; it never carries a lock handle or token. */
export interface ExecutorPrivateAcknowledgement {
  readonly nonce: string;
  readonly outcome: ExecutorClaimOutcome;
}

export interface SpawnedAttemptExecutor {
  waitForPrivateAcknowledgement(): Promise<ExecutorPrivateAcknowledgement | null>;
  /** Settles when the child has exited without a usable private ACK. */
  waitForExit(): Promise<void>;
}

/**
 * Transport for admitting a NEW attempt, and nothing else.
 *
 * The absences here are the contract, not an oversight. This shape carries no
 * `request`, no `expected`, no `attemptId`, no `continuation`, and no
 * `hostHomeDir` — because dispatch never continues an existing attempt and so
 * has no business naming one. Continuations route
 * `host update-verify` -> `runLocalAttemptExecutorSegment`, where the claim is
 * resolved against the canonical record under the lock.
 *
 * A future field that implies a continuation must FAIL the architecture gate
 * and force a design review rather than be "validated" inside dispatch. The
 * type and the architecture boundary ARE the fail-closed mechanism; there is
 * deliberately no runtime arm rejecting such a field, because a runtime check
 * would imply the field is expected to occur.
 *
 * `platform` is a rollout INPUT, never a caller-built verdict — dispatch
 * derives the cohort decision itself so a caller cannot hand in an `eligible`
 * object and opt around the fence.
 */
export interface DispatchAttemptExecutorOptions {
  /** CLI-owned rollout input; `dispatch` derives the verdict internally. */
  readonly platform: HostInstallPlatform;
  readonly nonce: string;
  readonly spawn: () => Promise<SpawnedAttemptExecutor>;
  /** Re-read durable evidence; do not spawn another executor on ambiguity. */
  readonly reconcile: () => Promise<HostUpdateAttemptRecord | null>;
  /** Dispatcher-owned bounded ACK race; production supplies a real timer. */
  readonly acknowledgementTimeoutMs: number;
  readonly waitForAcknowledgementTimeout: (ms: number) => Promise<void>;
  readonly faults: UpdateExecutorFaults;
}

export type DispatchAttemptExecutorOutcome =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "accepted";
      readonly claim: Extract<
        ExecutorClaimOutcome,
        { readonly kind: "claimed" }
      >;
    }
  | {
      readonly kind: "terminalized";
      readonly outcome: Extract<
        ExecutorClaimOutcome,
        { readonly kind: "terminalized" }
      >;
    }
  | {
      readonly kind: "rejected";
      readonly outcome: Extract<
        ExecutorClaimOutcome,
        { readonly kind: "rejected" }
      >;
    }
  | {
      readonly kind: "indeterminate";
      readonly canonical: HostUpdateAttemptRecord | null;
    };

/**
 * A parent reports accepted only after a private matching acknowledgement of
 * the child's durable claim. Spawn success, a missing ACK, and a bad nonce
 * all reconcile the canonical record once; none retries dispatch.
 */
export async function dispatchAttemptExecutor(
  options: DispatchAttemptExecutorOptions,
): Promise<DispatchAttemptExecutorOutcome> {
  // This gate is UNCONDITIONAL, and that is the ruled design rather than an
  // omission (Ticket 07, attempt-core ruling on the Finding-2 dispatch gate).
  //
  // Dispatch is **admission-only new-attempt transport**. "Stop admitting new
  // attempts" applies exactly here - before any spawn, before any
  // reconciliation - so an admission actor refusing admission IS the ruled
  // semantics, not a violation of them. There is no adopted continuation for
  // this gate to abandon, because continuations never arrive through dispatch:
  // they route `host update-verify` -> `runLocalAttemptExecutorSegment`, and
  // the SEGMENT's gate is the one scoped to skip for an adopted continuation.
  //
  // Two resolutions were considered and rejected, and the reasons generalize:
  //
  //  - Reading the adoption question from a caller-supplied field is
  //    authority-from-testimonial, the same forgeable shape as trusting
  //    `request.expected` instead of the record.
  //  - Consulting `reconcile()` here duplicates policy into an intentionally
  //    INERT path, and breaks the certified invariant that a disabled dispatch
  //    performs zero spawn, reconcile, timeout-wait, child-waiter and fault
  //    calls. That invariant is load-bearing: it is what makes the shipped
  //    shadow fence observably do nothing.
  //
  // The segment-level scoped gate is DEFENSE IN DEPTH beneath this one. It
  // never justifies relaxing this fence - a continuation reaching dispatch at
  // all would mean the routing invariant broke, and the correct response is to
  // fix the routing, not to teach dispatch to accept continuations.
  if (decideUpdateExecutorCohort(options.platform).kind !== "eligible") {
    return { kind: "disabled" };
  }
  await options.faults.hit("before-dispatch-spawn");
  let child: SpawnedAttemptExecutor;
  try {
    child = await options.spawn();
  } catch {
    return { kind: "indeterminate", canonical: await options.reconcile() };
  }
  let acknowledgement: ExecutorPrivateAcknowledgement | null;
  try {
    await options.faults.hit("after-dispatch-spawn-before-ack");
    const raced = await Promise.race([
      child
        .waitForPrivateAcknowledgement()
        .then((value) => ({ kind: "ack" as const, value }))
        .catch(() => ({ kind: "failed" as const })),
      child
        .waitForExit()
        .then(() => ({ kind: "exited" as const }))
        .catch(() => ({ kind: "failed" as const })),
      options
        .waitForAcknowledgementTimeout(options.acknowledgementTimeoutMs)
        .then(() => ({ kind: "timed-out" as const }))
        .catch(() => ({ kind: "failed" as const })),
    ]);
    if (raced.kind !== "ack") {
      return { kind: "indeterminate", canonical: await options.reconcile() };
    }
    acknowledgement = raced.value;
  } catch {
    return { kind: "indeterminate", canonical: await options.reconcile() };
  }
  if (acknowledgement === null || acknowledgement.nonce !== options.nonce) {
    return { kind: "indeterminate", canonical: await options.reconcile() };
  }
  switch (acknowledgement.outcome.kind) {
    case "claimed":
      return { kind: "accepted", claim: acknowledgement.outcome };
    case "terminalized":
      return { kind: "terminalized", outcome: acknowledgement.outcome };
    case "rejected":
      return { kind: "rejected", outcome: acknowledgement.outcome };
  }
}
