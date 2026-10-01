import {
  supervisorRelaunchInstalledIdentityOf,
  verifyUpdateMutationCapability,
  withLifecycleTeardownContender,
  withSupervisorRelaunchContender,
  withUpdateContender,
  withUpdateContenderAdoption,
  type SupervisorRelaunchInstalledIdentity,
  type UpdateContenderAdmission,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type {
  HostUpdateAttemptRecord,
  UpdateMutationCapabilityAdoption,
} from "@traycer-clients/shared/host-update";
import { readHostInstallRecord } from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import {
  withCliLock,
  type AcquireCliLockOptions,
  type CliLockHandle,
} from "../store/cli-lock";
import { hostHomeDir } from "../store/paths";

/**
 * The CLI's only bridge from legacy mutation code into the shared update
 * contender boundary. The shared attempt lock is always acquired before the
 * CLI lock, and the capability is checked again after the inner lock wins.
 *
 * This is intentionally a shadow bridge: it never creates or advances a
 * schema-v2 attempt record. A nonterminal record is instead surfaced as a
 * conflict until the schema-v2 executor owns the legacy operation.
 */
export interface WithCliUpdateContenderOptions {
  readonly environment: Environment;
  /**
   * Internal root-maintenance may target a sudo caller's canonical host home
   * while the CLI process itself runs elevated. Normal CLI calls omit this
   * and retain the environment-derived path.
   */
  readonly hostHomeDir?: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly admission: UpdateContenderAdmission;
  /**
   * A parent segment's live-lock proof, when this invocation was spawned by an
   * executor that already holds the canonical lock (Ticket 05, Ruling 1).
   *
   * ADDITIVE. Absent - which is every solo invocation of every command - takes
   * the acquire-or-refuse path below, byte-identically to before this existed.
   * Present, the segment validates the parent's proof instead of contending
   * with it, because acquiring here would deadlock against the very process
   * that spawned this child: the parent holds the lock for its whole segment,
   * and this child is one step inside it.
   */
  readonly adoption?: UpdateMutationCapabilityAdoption;
}

/**
 * The executor's narrow admission shape. It intentionally does not accept an
 * arbitrary `admission`: schema-v2 claim/recovery is reachable only through
 * this API, while current command callers keep their reviewed shadow or
 * maintenance routes.
 */
export interface WithCliAttemptExecutorOptions {
  readonly environment: Environment;
  readonly hostHomeDir?: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

/**
 * Own the outer attempt capability for a whole execution segment. Network
 * resolution, download, verification and extraction belong inside this
 * segment; callers take the CLI lock only through `withCliAttemptMutation`
 * immediately around a durable promotion or service lifecycle mutation.
 */
export async function withCliUpdateExecutionSegment<T>(
  options: WithCliUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
  ) => Promise<T>,
): Promise<T> {
  const home = options.hostHomeDir ?? hostHomeDir(options.environment);
  const adoption = options.adoption;
  if (adoption !== undefined) {
    if (options.admission === "attempt-executor") {
      // Unreachable through the executor entries, which never carry a proof.
      // Stated anyway because the two authority models must not blend: an
      // adopted child works inside its parent's segment and is never itself
      // an attempt executor. The shared layer refuses this too; refusing here
      // as well means the mistake cannot even be constructed.
      throw cliError({
        code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
        message: "an adopted segment cannot claim attempt-executor admission",
        details: { reason: options.reason },
        exitCode: 75,
      });
    }
    return unwrapContenderOutcome(
      options,
      await withUpdateContenderAdoption(
        adoption,
        {
          hostHomeDir: home,
          reason: options.reason,
          waitMs: options.waitMs,
          pollIntervalMs: options.pollIntervalMs,
          admission: options.admission,
        },
        (capability) =>
          // The parent already read the record under the lock and decided this
          // child may run. Re-reading here would be a second, later read that
          // could disagree with the decision this invocation exists to carry
          // out - so the child inherits the admitted context instead.
          run(capability, {
            activeAttempt: null,
            recoveryAction: "restart-current",
          }),
      ),
    );
  }
  const outcome = await withUpdateContender(
    {
      hostHomeDir: home,
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: options.admission,
    },
    run,
  );

  return unwrapContenderOutcome(options, outcome);
}

/**
 * The installed identity the supervisor-relaunch admission judges a parked
 * activation against (`supervisorRelaunchDisposition`): the install record's
 * version and generation, read under the attempt lock, or `null` when there
 * is no readable record.
 *
 * ONE reader for both callers of that admission - the supervisor's own
 * relaunch (`host start`) and provisioning's start of the installed bytes
 * (`host ensure`) - so the two can never disagree about whether the same
 * record admits the same start.
 */
export async function readSupervisorRelaunchInstalledIdentity(
  environment: Environment,
): Promise<SupervisorRelaunchInstalledIdentity | null> {
  // The CLI's own read, for its error on a malformed record; the mapping is
  // the shared one the desktop's packaged-macOS start uses too.
  const record = await readHostInstallRecord(environment);
  return record === null ? null : supervisorRelaunchInstalledIdentityOf(record);
}

export interface WithCliSupervisorRelaunchSegmentOptions {
  readonly environment: Environment;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

/**
 * An execution segment admitted the way the supervisor's own relaunch is
 * (`withSupervisorRelaunchContender`): a standing attempt record admits it
 * exactly when that record would admit the supervisor spawning the installed
 * bytes - parked for work, parked on an activation of the installed
 * generation, or interrupted in a phase whose own next act is that start -
 * and refuses it otherwise, as `host ensure`'s shadow admission does.
 *
 * For a caller whose mutation IS that start and nothing more. The
 * disposition is the shared one, decided against the shared reader above, so
 * it is never re-derived here.
 */
export async function withCliSupervisorRelaunchSegment<T>(
  options: WithCliSupervisorRelaunchSegmentOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
  ) => Promise<T>,
): Promise<T> {
  const outcome = await withSupervisorRelaunchContender(
    {
      hostHomeDir: hostHomeDir(options.environment),
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      readInstalledIdentity: () =>
        readSupervisorRelaunchInstalledIdentity(options.environment),
    },
    run,
  );
  return unwrapContenderOutcome(
    { ...options, admission: "supervisor-relaunch-maintenance" },
    outcome,
  );
}

/**
 * The supervisor's lifecycle teardown lock (`withLifecycleTeardownContender`)
 * with the CLI lock inside it, as `withCliUpdateContender` takes both. Over
 * `waiting-to-activate` it is admitted exactly where the relaunch above
 * would be, judged by the same reader: a teardown never stops a host no
 * start could bring back.
 */
export async function withCliLifecycleTeardownSegment<T>(
  options: WithCliUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    cliLock: CliLockHandle,
  ) => Promise<T>,
): Promise<T> {
  const outcome = await withLifecycleTeardownContender(
    {
      hostHomeDir: options.hostHomeDir ?? hostHomeDir(options.environment),
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      readInstalledIdentity: () =>
        readSupervisorRelaunchInstalledIdentity(options.environment),
    },
    (capability) =>
      withCliAttemptMutation(capability, options, (cliLock) =>
        run(capability, cliLock),
      ),
  );
  return unwrapContenderOutcome(options, outcome);
}

/** Own the outer canonical capability for one schema-v2 executor segment. */
export async function withCliAttemptExecutor<T>(
  options: WithCliAttemptExecutorOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
  ) => Promise<T>,
): Promise<T> {
  const outcome = await withUpdateContender(
    {
      hostHomeDir: options.hostHomeDir ?? hostHomeDir(options.environment),
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: "attempt-executor",
    },
    run,
  );
  return unwrapContenderOutcome(
    { ...options, admission: "attempt-executor" },
    outcome,
  );
}

/**
 * Read recovery evidence under the same outer-attempt → inner-CLI ordering
 * as an install or service mutation. This keeps a mixed-version CLI that
 * only knows `cli-lock` from changing `install.json` or staged bytes midway
 * through the executor's recovery decision, while still holding the short
 * lock only for the observation itself.
 */
export async function withCliExecutorRecoveryEvidence<T>(
  capability: UpdateMutationCapability,
  options: WithCliAttemptExecutorOptions,
  read: () => Promise<T>,
): Promise<T> {
  return withCliAttemptMutation(
    capability,
    { ...options, admission: "attempt-executor" },
    async () => read(),
  );
}

/**
 * Capability-consuming inner mutation boundary. The update capability stays
 * held by its execution segment while the existing CLI lock is acquired only
 * for the short reconcile/promotion/service operation. It verifies after the
 * inner lock wins so a released or stolen capability cannot run an actuator.
 */
export async function withCliAttemptMutation<T>(
  capability: UpdateMutationCapability,
  options: WithCliUpdateContenderOptions,
  run: (cliLock: CliLockHandle) => Promise<T>,
): Promise<T> {
  await requireCliUpdateMutationCapability(capability, options);
  return withCliLock(cliLockOptions(options), async (cliLock) => {
    await requireCliUpdateMutationCapability(capability, options);
    return run(cliLock);
  });
}

export async function withCliUpdateContender<T>(
  options: WithCliUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    cliLock: CliLockHandle,
    context: UpdateContenderExecutionContext,
  ) => Promise<T>,
): Promise<T> {
  return withCliUpdateExecutionSegment(options, (capability, context) =>
    withCliAttemptMutation(capability, options, (cliLock) =>
      run(capability, cliLock, context),
    ),
  );
}

/**
 * Context-preserving name for an independent recovery action. The policy
 * context comes from the same canonical record read that admitted the outer
 * lock; no caller may re-read and race it after deciding whether to relaunch.
 * An alias, not a copy: the two entry points must never drift apart.
 */
export const withCliUpdateContenderContext = withCliUpdateContender;

export async function requireCliUpdateMutationCapability(
  capability: UpdateMutationCapability,
  options: WithCliUpdateContenderOptions,
): Promise<void> {
  const live = await verifyUpdateMutationCapability(
    capability,
    options.hostHomeDir ?? hostHomeDir(options.environment),
  );
  if (live.kind === "live") return;
  throw cliError({
    code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
    message:
      "host update coordination was lost before the CLI mutation could run",
    details: { reason: options.reason, verdict: live.kind },
    exitCode: 75,
  });
}

function unwrapContenderOutcome<T>(
  options: WithCliUpdateContenderOptions,
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
        message: `${
          outcome.disposition === "yield"
            ? "a host update attempt is in progress; this operation yielded to it"
            : "a host update attempt is in progress; this maintenance operation is refused"
        } (${describeNonterminalAttempt(outcome.record)})`,
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
        message:
          "host update attempt state cannot be verified; refusing a competing mutation",
        details: { reason: options.reason, recordKind: outcome.record.kind },
        exitCode: 1,
      });
    case "lock-not-live":
      throw cliError({
        code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
        message:
          "host update coordination was lost before the CLI mutation could run",
        details: { reason: options.reason, verdict: outcome.verdict.kind },
        exitCode: 75,
      });
  }
}

/**
 * The way out, named in the refusal itself.
 *
 * The service-shaped commands refuse while a nonterminal attempt record
 * stands - `service install` and `host stop` over every one, `service start`
 * and `host ensure` over every one the supervisor's own relaunch would refuse
 * (`supervisorRelaunchDisposition`) - and the one command that resumes a
 * record - `host update` - is not among them.
 * Without this clause an operator whose host is down beside a parked record
 * is sent from refusal to refusal (`host status` says "run host ensure", which
 * yields to the same record), which is how the 2026-09-27 staging host stayed
 * down for an hour with the recovery one command away.
 *
 * A PARKED record has no live updater by definition, so resuming it is always
 * the right next move. An ACTIVE one may have a live holder momentarily
 * outside the lock (the packaged-macOS executor releases between its spans),
 * so the guidance is to wait first; `host update` still recovers an
 * interrupted one, and says so when the holder is proven dead.
 */
function describeNonterminalAttempt(record: HostUpdateAttemptRecord): string {
  const where = `attempt ${record.attemptId} is ${record.phase}/${record.execution} for host ${record.targetVersion}`;
  // This site holds no install record to compare the park against, so the
  // park sentence names the one branch a resume can take that does NOT start
  // the host (`describeNonterminalRecordRecovery` in
  // `host/parked-activation-relaunch.ts` has the per-record version).
  return record.execution === "parked"
    ? `${where}; it is parked with no updater running - run 'traycer host update' to resume it, which also starts the host if none is running; if it exits reporting that the installed host changed, the stale record is retired and 'traycer host ensure' starts the host`
    : `${where}; wait for the running update to finish, or run 'traycer host update' to recover it if it was interrupted`;
}

function cliLockOptions(
  options: WithCliUpdateContenderOptions,
): AcquireCliLockOptions {
  return {
    environment: options.environment,
    reason: options.reason,
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
  };
}
