import {
  verifyUpdateMutationCapability,
  withUpdateContender,
  withUpdateContenderAdoption,
  type UpdateContenderAdmission,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type { UpdateMutationCapabilityAdoption } from "@traycer-clients/shared/host-update";
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
        message:
          outcome.disposition === "yield"
            ? "a host update attempt is in progress; this operation yielded to it"
            : "a host update attempt is in progress; this maintenance operation is refused",
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
