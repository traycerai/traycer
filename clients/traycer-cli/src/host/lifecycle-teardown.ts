import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";
import type { UpdateContenderAdmission } from "@traycer-clients/shared/host-update";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import type { ILogger } from "../logger";
import { isServiceMutationAuthorityError } from "../service/mutation-authority";
import type {
  CooperativeShutdownOutcome,
  ForcedShutdownOutcome,
} from "../service/platforms/desktop-agent-shutdown";
import type { PublishedProcessIdentityVerdict } from "../store/process-identity";
import type { HostPidMetadata } from "./pid-metadata";

// The supervisor's own teardown of its own host (lifecycle mechanics, "The
// teardown actuator (supervisor-owned stop)"; critique round 1, R3).
//
// Sending SIGTERM to the child is not a stop: the signal handler only
// forwards, Node's SIGTERM on Windows is `TerminateProcess` with no host
// cleanup, and neither purges `pid.json`. This is the stop the supervisor
// runs when the policy observer's stop rule has held past the crash grace,
// against the host child it spawned and nothing else:
//
// | Step | Action | Outcome |
// | ---- | ------ | ------- |
// | 1 | Take the CLI lifecycle lock as a `lifecycle-teardown-maintenance` contender, bounded wait (admitted over a park, refused over an active attempt) | busy / refused -> retry next tick, nothing latched or touched |
// | 2 | Inside the lock, re-read both records (not yet committed only) | rule no longer due -> stand down, nothing latched |
// | 3 | Commit: latch `shuttingDown` + `markShutdownRequested()` | the relaunch loop can no longer bring the host back |
// | 4 | Address: this supervisor's live child, and `pid.json` only if it names that child | no live child -> step 7 |
// | 5 | Cooperative: `requestCooperativeShutdown(env, "lifecycle-presence-stop", "shutdown")` (published child only) | stopped / no-host / no-metadata -> 6's wait; busy / unreachable / hung -> force |
// | 6 | Force. Windows: `killSupervisedHostTree` (root = child, supervisor excluded). POSIX, published: `forceStopHostProcessReporting`; unpublished: SIGTERM then SIGKILL through the child's own handle | identity-unverified / hung / tree not proved down -> retry next tick |
// | 6' | Wait for the child's own exit, bounded | not ended -> retry next tick |
// | 7 | Confirm `pid.json`'s instance gone by pid + start identity; purge on an exact match only (a committed attempt with no live child runs only this step, without the lock) | a live foreign record is left alone |
// | 8 | Complete: the observer stops and the supervisor exits 0, removing `supervisor.json` on the way | |
//
// Committed is committed. From step 3 on, a later tick resumes the sequence
// whatever the records say: the host has been told to stop, and un-latching a
// supervisor whose child may already be mid-shutdown would hand it back to a
// relaunch loop that reads the death as a crash.
//
// Never a service stop: `launchctl kill`, `systemctl stop` and `schtasks /End`
// all end THIS process. The service instance ends with the supervisor's own
// exit 0, which no service manager answers with a relaunch.

/** The shutdown claim's operation label (`transitionId` `cli-<operation>-…`). */
export const LIFECYCLE_TEARDOWN_OPERATION = "lifecycle-presence-stop";

/**
 * The update-contender admission the lock is taken under. Its own name, not
 * `service-maintenance`: it is admitted over a PARKED update and leaves the
 * park standing for the next supervisor start, where `service-maintenance`
 * refuses every nonterminal record and would let a park defer the stop for
 * as long as it stands. Every active attempt still refuses it.
 */
export const LIFECYCLE_TEARDOWN_ADMISSION =
  "lifecycle-teardown-maintenance" satisfies UpdateContenderAdmission;

/**
 * How long one attempt waits for the lifecycle lock. Short on purpose: the
 * stop condition is standing, so a busy lock costs one observer tick, never
 * the teardown - and waiting longer would only hold the tick while an update
 * that owns the host finishes its swap.
 */
export const LIFECYCLE_TEARDOWN_LOCK_WAIT_MS = 5_000;

/**
 * How long a SIGTERM through the child's handle gets before SIGKILL: the
 * host's own force-exit watchdog plus the stop margin, the same derivation as
 * the supervisor's raced-stop grace and the stop path's exit timeout, so a
 * host moments from finishing the shutdown asked for is never killed.
 */
const OWNED_CHILD_TERM_GRACE_MS =
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;

/** The host child this supervisor spawned, through its own handle. */
export interface OwnedHostChild {
  readonly pid: number;
  /** The child's `exit` (or spawn `error`) has been observed. */
  readonly ended: () => boolean;
  /** Resolves `true` once ended, `false` if `timeoutMs` passes first. */
  readonly waitForEnd: (timeoutMs: number) => Promise<boolean>;
  /**
   * Signal through the `ChildProcess` handle, never by pid: Node refuses once
   * the child has been reaped, so this cannot reach a recycled pid.
   */
  readonly signal: (signal: "SIGTERM" | "SIGKILL") => void;
}

/** The platform machinery the actuator drives; injected for tests. */
export interface LifecycleTeardownPlatform {
  readonly platform: NodeJS.Platform;
  /**
   * Run `run` inside the CLI lifecycle lock, as a
   * `LIFECYCLE_TEARDOWN_ADMISSION` contender with a bounded wait. Rejects -
   * without running `run` - when the lock or the update attempt record
   * refuses. `verify` re-proves the hold before a destructive step.
   */
  readonly withLock: (
    environment: Environment,
    run: (verify: () => Promise<void>) => Promise<TeardownAttemptResult>,
  ) => Promise<TeardownAttemptResult>;
  readonly readPidMetadata: (
    environment: Environment,
  ) => Promise<HostPidMetadata | null>;
  readonly requestCooperativeShutdown: (
    environment: Environment,
    operation: string,
    intent: ShutdownClaimIntent,
  ) => Promise<CooperativeShutdownOutcome>;
  /** POSIX: `forceStopHostProcessReporting` against the published host. */
  readonly forceStopPublishedHost: (
    environment: Environment,
    operation: string,
  ) => Promise<ForcedShutdownOutcome>;
  /**
   * Windows: `killSupervisedHostTree` - the verified tree kill rooted at
   * `rootPid` with this supervisor excluded. Throws when the tree cannot be
   * proved down.
   */
  readonly killHostTree: (
    environment: Environment,
    rootPid: number,
    verify: () => Promise<void>,
  ) => Promise<void>;
  readonly verifyPublishedInstance: (
    pid: number,
    startIdentity: ProcessStartIdentity | null,
  ) => Promise<PublishedProcessIdentityVerdict>;
  /** `removeHostPidMetadataIfUnchanged`: remove on an exact pid + identity match. */
  readonly removePidMetadataIfUnchanged: (
    environment: Environment,
    instance: Pick<HostPidMetadata, "pid" | "processStartIdentity">,
  ) => Promise<boolean>;
}

/**
 * - `complete` - the host is gone and its record handled; exit 0.
 * - `retry` - a step could not complete; the observer tries again next tick.
 * - `cancelled` - not committed, and it will not be this tick: the rule no
 *   longer held on the fresh read, or the supervisor began exiting first.
 *
 * `reason` is a bounded enum for the log line, never a message.
 */
export type TeardownAttemptResult =
  | { readonly kind: "complete" }
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string };

export interface LifecycleTeardown {
  /** Step 3 has happened: the supervisor is latched and owes the rest. */
  readonly committed: () => boolean;
  /**
   * One pass of the sequence. `reconfirm` is the observer's fresh re-read
   * (asked inside the lock, before committing only); `aborted` is whether
   * the supervisor has begun exiting for another reason.
   */
  readonly attempt: (
    reconfirm: () => Promise<boolean>,
    aborted: () => boolean,
  ) => Promise<TeardownAttemptResult>;
}

export interface LifecycleTeardownInput {
  readonly environment: Environment;
  readonly logger: ILogger;
  readonly platform: LifecycleTeardownPlatform;
  /** The latest host child this supervisor spawned, or `null` before any. */
  readonly ownChild: () => OwnedHostChild | null;
  /** Latch `shuttingDown` and `markShutdownRequested()`. */
  readonly commit: () => void;
}

export function createLifecycleTeardown(
  input: LifecycleTeardownInput,
): LifecycleTeardown {
  const { environment, logger, platform } = input;
  let committed = false;

  const retry = (reason: string): TeardownAttemptResult => ({
    kind: "retry",
    reason,
  });

  // Step 6. `null` on success; otherwise the reason to retry.
  const forceOwnHost = async (
    child: OwnedHostChild,
    published: HostPidMetadata | null,
    verify: () => Promise<void>,
  ): Promise<string | null> => {
    if (platform.platform === "win32") {
      // The tree kill needs no `pid.json`: its root is the child's own pid,
      // which the scan places only as a validated child of this supervisor.
      await platform.killHostTree(environment, child.pid, verify);
      return null;
    }
    if (published !== null) {
      const forced = await platform.forceStopPublishedHost(
        environment,
        LIFECYCLE_TEARDOWN_OPERATION,
      );
      switch (forced.kind) {
        case "stopped":
        case "no-host":
          return null;
        case "identity-unverified":
          return "identity-unverified";
        case "hung":
          return "host-hung";
        case "no-metadata":
          // The record vanished between our read and the helper's: nothing
          // left to address by pid, so the child's own handle below.
          break;
      }
    }
    // An unpublished child (still booting, or its record already gone): no
    // pid-addressed helper can reach it, and the handle can reach nothing
    // else. SIGTERM first so the host runs its own graceful shutdown.
    child.signal("SIGTERM");
    if (await child.waitForEnd(OWNED_CHILD_TERM_GRACE_MS)) return null;
    logger.warn("Host lifecycle teardown escalating to SIGKILL", {
      reason: "owned-child-survived-sigterm",
    });
    child.signal("SIGKILL");
    return null;
  };

  // Steps 4-6'. `null` on success; otherwise the reason to retry.
  const stopLiveChild = async (
    child: OwnedHostChild,
    verify: () => Promise<void>,
  ): Promise<string | null> => {
    const record = await platform.readPidMetadata(environment);
    // `pid.json` is addressed only when it names THIS child. A record naming
    // anything else - another supervisor's host, or on a Windows dev wrapper
    // the grandchild under a `cmd.exe` child - is never dialled or signalled
    // by pid; the child's own tree is what gets stopped.
    const published =
      record !== null && record.pid === child.pid ? record : null;
    let force = true;
    if (published !== null) {
      await verify();
      const cooperative = await platform.requestCooperativeShutdown(
        environment,
        LIFECYCLE_TEARDOWN_OPERATION,
        "shutdown",
      );
      switch (cooperative.kind) {
        case "stopped":
        case "no-host":
        case "no-metadata":
          force = false;
          break;
        case "busy":
        case "unreachable":
        case "hung":
          // The run is desktop-owned under a `stop` verdict: the mode's
          // promise is that the host ends with the app, busy or not.
          logger.warn("Host lifecycle teardown escalating to a forced stop", {
            reason: `cooperative-${cooperative.kind}`,
          });
          break;
      }
    }
    if (force) {
      await verify();
      const failure = await forceOwnHost(child, published, verify);
      if (failure !== null) return failure;
    }
    // The child's own exit is the proof this process can trust without a
    // probe; the host's own watchdog has already had its grace above.
    return (await child.waitForEnd(STOP_EXIT_GRACE_MARGIN_MS))
      ? null
      : "host-survived";
  };

  // Step 7: confirm `pid.json`'s instance gone and purge it on an exact match.
  const confirmAndPurge = async (
    child: OwnedHostChild | null,
  ): Promise<TeardownAttemptResult> => {
    const record = await platform.readPidMetadata(environment);
    if (record === null) {
      logger.info("Host lifecycle teardown found no host record to settle", {
        reason: "record-absent",
      });
      return { kind: "complete" };
    }
    const ours = child !== null && child.ended() && record.pid === child.pid;
    const verdict = await platform.verifyPublishedInstance(
      record.pid,
      record.processStartIdentity,
    );
    switch (verdict) {
      case "current":
        // Our child's pid alive and wearing its identity contradicts the
        // ended handle - try again. A live FOREIGN host keeps its record.
        if (ours) return retry("host-survived");
        logger.info(
          "Host lifecycle teardown left a foreign host record alone",
          {
            reason: "foreign-host-live",
            verdict,
          },
        );
        return { kind: "complete" };
      case "indeterminate":
        // Not proof. Our own ended child is proved gone by its handle; a
        // foreign record is never purged on a guess.
        if (!ours) {
          logger.info(
            "Host lifecycle teardown left a foreign host record alone",
            { reason: "foreign-host-unverifiable", verdict },
          );
          return { kind: "complete" };
        }
        break;
      case "dead":
      case "mismatch":
        break;
    }
    const removed = await platform.removePidMetadataIfUnchanged(
      environment,
      record,
    );
    logger.info("Host lifecycle teardown settled the host record", {
      reason: removed ? "purged" : "record-changed",
      verdict,
    });
    return { kind: "complete" };
  };

  const attempt = async (
    reconfirm: () => Promise<boolean>,
    aborted: () => boolean,
  ): Promise<TeardownAttemptResult> => {
    // Committed with nothing left to stop - the child already ended, by our
    // earlier attempt or by a concurrent stop that signalled it: the rest is
    // step 7, which needs no lock (it removes only a provably-gone instance's
    // record, on an exact match, so it cannot interleave with a swap). Taking
    // the lock here anyway would deadlock against that concurrent stop, which
    // holds the lock while it waits for THIS process to exit.
    if (committed) {
      const child = input.ownChild();
      if (child === null || child.ended()) {
        try {
          return await confirmAndPurge(child);
        } catch (cause) {
          return retry(classifyTeardownFailure(cause));
        }
      }
    }
    try {
      return await platform.withLock(environment, async (verify) => {
        if (!committed) {
          if (!(await reconfirm())) {
            return { kind: "cancelled", reason: "not-reconfirmed" };
          }
          // Checked and committed with no await between, so a supervisor
          // exit that stopped the observer either happened first (and we
          // stand down) or sees `committed` and defers to us.
          if (aborted()) {
            return { kind: "cancelled", reason: "supervisor-exiting" };
          }
          committed = true;
          input.commit();
          logger.info(
            "Host supervisor stopping its host: the owning desktop is gone under a stop verdict",
            {
              reason: LIFECYCLE_TEARDOWN_OPERATION,
              admission: LIFECYCLE_TEARDOWN_ADMISSION,
            },
          );
        }
        const child = input.ownChild();
        if (child !== null && !child.ended()) {
          const failure = await stopLiveChild(child, verify);
          if (failure !== null) return retry(failure);
        }
        return confirmAndPurge(child);
      });
    } catch (cause) {
      return retry(classifyTeardownFailure(cause));
    }
  };

  return { committed: () => committed, attempt };
}

/**
 * A thrown step, as a bounded reason. The lock refusals come first because
 * they are the expected, self-clearing case: an update or activation owns
 * the host right now.
 */
export function classifyTeardownFailure(cause: unknown): string {
  if (isServiceMutationAuthorityError(cause)) return "lock-lost";
  if (cause instanceof CliError) {
    switch (cause.code) {
      case CLI_ERROR_CODES.CLI_LOCK_BUSY:
        return "cli-lock-busy";
      case CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE:
        return "update-attempt-active";
      case CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID:
        return "update-record-unverifiable";
      case CLI_ERROR_CODES.SERVICE_CONTROL_FAILED:
        return "tree-kill-refused";
      default:
        return "step-refused";
    }
  }
  return "step-threw";
}
