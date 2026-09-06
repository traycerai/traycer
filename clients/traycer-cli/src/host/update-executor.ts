import {
  attemptIdentityOf,
  decideAttemptClaim,
  decideAttemptRecovery,
  isTerminalPhase,
  readUpdateAttemptRecord,
  type AttemptClaimDecision,
  type AttemptClaimRefresh,
  type AttemptCommitOutcome,
  type AttemptClaimRequest,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRead,
  type HostUpdateAttemptRecord,
  type HostUpdateTrigger,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
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
  /**
   * The continuation a created attempt is already executing (D5), and the
   * claim baseline `createdRecord` writes verbatim (D19).
   *
   * Both are facts read UNDER the lock, which is exactly why the request is
   * now produced by a selector rather than fixed before it: the pre-lock
   * plan is advisory, and a baseline copied from it could name an install
   * generation another actor has since replaced.
   */
  readonly initialContinuation: AttemptClaimRequest["initialContinuation"];
  readonly claim: AttemptClaimRequest["claim"];
}

/**
 * What the caller's selector decided when it saw the record under the lock.
 *
 * `release` is a first-class answer, not a failure: an intent whose work is
 * already done, or whose park belongs to someone else, must leave the record
 * untouched and say WHY - the reason is what the dispatch ACK reports, so it
 * belongs to the ACK's reason grammar (`^[a-z0-9-]{1,64}$`).
 */
export type ExecutorClaimSelection =
  | { readonly kind: "claim"; readonly request: ExecutorClaimRequest }
  | { readonly kind: "release"; readonly reason: string };

/**
 * Decide the claim from the record read under the lock.
 *
 * Asynchronous on purpose. A caller whose selection depends on live evidence
 * - the activation-debt arm re-reading `install.json` and the running host,
 * the no-op arm reading the install record for its projection - has nowhere
 * else legal to do those reads: the advisory plan runs BEFORE the lock (where
 * both facts can still move), and `execute` runs AFTER the claim (where a
 * phase is already written and "nothing to do" is no longer expressible). So
 * the await happens here, inside the lock and before any write.
 */
export type ExecutorClaimSelector = (
  current: HostUpdateAttemptRead,
) => Promise<ExecutorClaimSelection>;

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

/**
 * The execution callback's NON-terminal write, and its only one.
 *
 * A sibling of `complete` for the same structural reason: `contender.ts` is a
 * two-importer module by construction - the shared barrel and this file - and
 * every other write inside a segment has to arrive through a closure this file
 * builds. An executing caller (`host update`'s record writer) advances a phase,
 * a progress tick, a park or a terminal by calling this; it never reaches the
 * contender module itself, and the architecture suite in `clients/shared` pins
 * that it cannot.
 *
 * Not session-guarded the way `complete` is, and deliberately: a terminal write
 * escaping its session would be unrecoverable, whereas an advance carries the
 * `held` identity the caller was handed and the record's own held-identity
 * check refuses it once anything has superseded that claim. It fails closed on
 * the durable state rather than on a flag.
 */
export type AdvanceExecutorSegment = (
  intent: Extract<AttemptMutationIntent, { readonly kind: "advance" }>,
) => Promise<AttemptCommitOutcome>;

export interface RunAttemptExecutorClaimOptions {
  /**
   * The CLI derives the rollout decision itself from this installed platform.
   * A caller cannot pass a pre-built `eligible` verdict to opt around the
   * shadow fence.
   */
  readonly platform: HostInstallPlatform;
  readonly contender: WithCliAttemptExecutorOptions;
  /** Awaited under the lock, with the record this executor just read. */
  readonly request: ExecutorClaimSelector;
  /**
   * Where a recovered `activate` continuation goes.
   *
   * `"park"` re-parks it as `waiting-to-activate` before releasing, for a
   * caller that performs no activation of its own (the verifier: activation
   * belongs to Desktop, and an active-and-unheld record left behind is the
   * stranding LOOP `parkResumedActivation` documents).
   *
   * `"execute"` hands the resumed ACTIVE record to `execute`, for a caller
   * that is about to perform the activation itself.
   */
  readonly recoveredActivation: "park" | "execute";
  /**
   * What happens after a recovery TERMINALIZED the interrupted attempt.
   *
   * `"report"` returns that terminal outcome to the caller unchanged.
   *
   * `"reselect"` re-reads and asks the selector once more, so an interrupted
   * A followed by a request for B completes A and then starts B in one run.
   * Post-recovery selection is caller policy precisely because the two
   * callers differ: a dispatcher named a target and still wants it, while the
   * verifier is REPORTING on one attempt and must never re-apply its own
   * pre-recovery request to a record whose generation recovery just bumped.
   */
  readonly afterRecovery: "reselect" | "report";
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
    }
  /**
   * The selector declined the work under the lock. Nothing was claimed and
   * nothing was written by the selection itself.
   *
   * `outcome` is the terminal record a RECOVERY wrote just before the decline
   * - the reselect arm - and `null` for a plain release. That distinction is
   * the whole point of the arm: an interrupted attempt that recovery ended
   * and a caller that then found nothing left to do is not a generic "nothing
   * to do", and the caller (and the ACK behind it) must be able to report the
   * fate of the attempt that actually ran.
   */
  | {
      readonly kind: "released";
      readonly reason: string;
      readonly outcome: HostUpdateAttemptRecord | null;
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
    advance: AdvanceExecutorSegment,
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
      // Built HERE for the same reason `complete` is: it is the only way an
      // executing caller can write, and building it anywhere else would put a
      // second production importer on `contender.ts`.
      // `commitCliExecutorAttemptMutation` recomputes the host home from these
      // options rather than forwarding a caller's, which is also what keeps it
      // out of the shared suite's verbatim-forwarder ("transparent
      // laundering") detector.
      const advance: AdvanceExecutorSegment = (intent) =>
        commitCliExecutorAttemptMutation(capability, options.contender, intent);
      try {
        return {
          kind: "executed",
          claim,
          result: await execute(capability, claim, complete, advance),
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
  // AWAITED here, between the under-lock read and the first write. The
  // selector may read whatever live evidence its intent needs; until it
  // resolves this executor has written nothing, and if it throws it has
  // written nothing at all - the caller's pre-claim throw path is what turns
  // that into an ACK.
  const selection = await options.request(current);
  if (selection.kind === "release") {
    return { kind: "released", reason: selection.reason, outcome: null };
  }
  const request = claimRequestAtExecutor(selection.request, options.nowIso());
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
  return commitDecidedClaim(capability, options, request, decision);
}

/**
 * Act on a claim decision the core did NOT refuse.
 *
 * Shared by the ordinary claim and by the post-recovery reselect so the two
 * cannot drift: a second copy of this ladder is how a reselect would quietly
 * grow its own supersede semantics.
 */
async function commitDecidedClaim(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  request: AttemptClaimRequest,
  decision: Exclude<AttemptClaimDecision, { readonly kind: "refuse" }>,
): Promise<ExecutorClaimOutcome> {
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
    advance: AdvanceExecutorSegment,
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
        return { kind: "committed" as const, recovery, committed, final };
      }
      const committed = await commitCliExecutorRecoveryMutation(
        capability,
        options.contender,
        { kind: "recover", recovery: recoveryRequest },
      );
      return { kind: "committed" as const, recovery, committed, final };
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
  const { recovery, committed, final } = outcome;
  if (committed.kind !== "committed") {
    return rejectedCommit(committed, current);
  }
  await options.faults.hit("after-recovery-write-before-action");
  switch (recovery.kind) {
    case "resume-new-generation":
      // A caller that performs the activation itself takes the resumed ACTIVE
      // record; one that does not must not leave it active-and-unheld.
      return options.recoveredActivation === "execute"
        ? acknowledgedClaim(committed.record, recovery.continuation)
        : parkResumedActivation(
            capability,
            options,
            committed.record,
            recovery.continuation,
            final,
          );
    case "terminalize-complete":
      return afterTerminalizingRecovery(
        capability,
        options,
        committed.record,
        "complete",
      );
    case "terminalize-failed":
      return afterTerminalizingRecovery(
        capability,
        options,
        committed.record,
        "failed",
      );
    case "supersede":
      // Preserve the core's two durable facts. A crash after the recovery
      // terminalization leaves the old attempt safely superseded; only this
      // next call may mint the requested replacement.
      return createAfterSupersede(capability, options);
  }
}

/**
 * Post-recovery disposition (D4), which is CALLER policy rather than a
 * property of the recovery.
 *
 * `"report"` is the verifier's: the terminalized outcome is what it was asked
 * for, and its own fixed request - minted before the lock, carrying the
 * PRE-recovery identity - must never be re-applied to a record whose
 * generation this recovery just bumped.
 *
 * `"reselect"` is the dispatcher's: the interrupted attempt is finished, the
 * target it was asked for may still be unmet, so the selector sees the
 * now-terminal record and answers once more. Three answers, three arms:
 *
 *  - a claim the core accepts starts (or supersedes-then-starts) the new work;
 *  - a decline keeps the RECOVERY's reason and terminal record, never the
 *    selector's - "nothing more to do" after finishing an attempt is a report
 *    about that attempt, and the ACK reason is what the GUI renders;
 *  - a claim the core REFUSES is `rejected`. The terminal write already
 *    stands, so the honest answer is that this request did not match the
 *    record recovery left, not that the recovery failed.
 */
async function afterTerminalizingRecovery(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
  terminal: HostUpdateAttemptRecord,
  outcome: "complete" | "failed",
): Promise<ExecutorClaimOutcome> {
  if (options.afterRecovery === "report")
    return terminalized(terminal, outcome);
  const current = await readUpdateAttemptRecord(
    options.contender.hostHomeDir ?? hostHomeDir(options.contender.environment),
  );
  const selection = await options.request(current);
  if (selection.kind === "release") {
    return {
      kind: "released",
      reason:
        outcome === "complete" ? "recovered-complete" : "recovered-failed",
      outcome: terminal,
    };
  }
  const request = claimRequestAtExecutor(selection.request, options.nowIso());
  const decision = decideAttemptClaim({
    current,
    request,
    holder: { kind: "held-by-self" },
  });
  if (decision.kind === "refuse") {
    // Deliberately NOT a second recovery pass: the record this reselect sees
    // is the terminal one this run just wrote, and a `requires-recovery`
    // refusal here would mean something else replaced it under a lock we
    // hold. Refusing is the fail-closed direction.
    return {
      kind: "rejected",
      reason: decision.reason,
      observed: decision.observed,
    };
  }
  return commitDecidedClaim(capability, options, request, decision);
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
  observed: AttemptRecoveryEvidenceObservation,
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
        // Refreshed from the very observation this recovery decided on (D19),
        // which read the install and stage records under this same lock.
        //
        // Load-bearing, not bookkeeping. A record that died at `restarting`
        // and came back through the verifier is parked here; the `activate`
        // that follows compares the live install record with THIS baseline
        // under the lock, and a stale one - the identity the attempt was
        // created against, before its own apply promoted new bytes - would
        // terminalize that park `failed {install-changed}` for a mismatch its
        // own successful apply caused.
        claimRefresh: claimRefreshFrom(observed),
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

/**
 * The claim baseline a park writes, from the install and stage facts an
 * observation already read under this lock.
 *
 * `installGeneration` goes through `encodeInstallGeneration` - the one
 * encoder every producer calls (`apply.ts`, `install.ts`, `provision.ts`) -
 * so a baseline written here and the generation a later resume re-reads are
 * byte-equal strings rather than two encodings that merely look alike.
 *
 * `null` when nothing could be read: the core reads that as "carry the
 * record's prior baseline unchanged", which is strictly better than minting
 * one from an observation that saw no install record. (A record with no
 * baseline at all stays without one; a refresh cannot grant an authorization
 * nobody issued.)
 */
function claimRefreshFrom(
  observed: AttemptRecoveryEvidenceObservation,
): AttemptClaimRefresh | null {
  const identity = observed.installIdentity;
  if (identity === null) return null;
  return {
    installedVersion: identity.version,
    installGeneration: encodeInstallGeneration(identity),
    stageFingerprint: observed.stageFingerprint,
  };
}

async function createAfterSupersede(
  capability: UpdateMutationCapability,
  options: RunAttemptExecutorClaimOptions,
): Promise<ExecutorClaimOutcome> {
  const current = await readUpdateAttemptRecord(
    options.contender.hostHomeDir ?? hostHomeDir(options.contender.environment),
  );
  // Selected AGAIN, against the post-supersede read. The supersede is durable
  // by now, so this second decision must be made from what is actually on
  // disk - and the baseline it writes must come from facts read after it, not
  // from a request minted before the record moved.
  const selection = await options.request(current);
  if (selection.kind === "release") {
    return { kind: "released", reason: selection.reason, outcome: null };
  }
  const next = {
    ...claimRequestAtExecutor(selection.request, options.nowIso()),
    // The second write is a plain core `create`, whatever the selector asked
    // for: the record it would have resumed is the one this run just
    // superseded.
    action: "start" as const,
    expected: null,
  };
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
  return createAfterSupersede(capability, options);
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

/**
 * The one place the executor stamps its own clock onto a selected request.
 *
 * Everything else is carried verbatim: the selector ran under the lock, so
 * the continuation and the claim baseline it chose are exactly the facts this
 * claim should record. Dispatch cannot pre-date a claim, which is why the
 * timestamp is the executor's and not the request's.
 */
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
      readonly kind: "released";
      readonly outcome: Extract<
        ExecutorClaimOutcome,
        { readonly kind: "released" }
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
    case "released":
      return { kind: "released", outcome: acknowledgement.outcome };
  }
}
