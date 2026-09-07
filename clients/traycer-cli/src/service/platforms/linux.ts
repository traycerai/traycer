import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
} from "../mutation-authority";
import { dirname, isAbsolute } from "node:path";
import {
  publishedHostProcessGone,
  readHostPidMetadata,
  type HostPidMetadata,
} from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { forceStopHostProcess } from "./desktop-agent-shutdown";
import type { CliInvocation } from "../cli-binary";
import { buildCompatibleHostStartScript } from "./host-start-script";
import { fileExists } from "../install-binary";
import { serviceManifestPath, type ServiceLabel } from "../label";
import { ProcessRunError, runCommand, type RunResult } from "../process-runner";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type {
  InstallServiceOptions,
  RestartStop,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";

// Linux service controller - systemd-user. The unit's ExecStart points
// at the per-user CLI binary with `host start` (the slot is baked into
// the CLI build) so an in-place host install never needs a unit-file
// rewrite.
//
// `loginctl enable-linger` is best-effort. The Tech Plan accepts a
// silent skip if polkit would prompt - Doctor surfaces the missing
// linger as a warning so the user can enable it later.

// The pluggable runner seam is live on Linux too: `null` selects the real
// `runCommand`, tests inject a fake to drive the install/uninstall flows
// (preflight, rollback-on-failure) without a systemd instance. Same factory
// signature as macOS/Windows
// (`createMacos|Linux|WindowsController(runner: ProcessRunner | null)`).
export function createLinuxController(
  runner: ProcessRunner | null,
): ServiceController {
  const unverifiedRun: ProcessRunner = runner ?? runCommand;
  const run: ProcessRunner = async (command, args, options) => {
    await verifyServiceMutationAuthority();
    return unverifiedRun(command, args, options);
  };
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label),
    stop: (label, options) => stopService(label, run, options.force, "stop"),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run),
    hostStartAdoptionLabel: (label) => Promise.resolve(label.id),
    // No longer `stopService` (Q13). A restart's stop must not disarm the
    // service manager, and `systemctl stop` does exactly that - see
    // `stopForRestartService`.
    stopForRestart: (label, options) =>
      stopForRestartService(label, run, options.force),
    // Consumes `forcedRecycle`, and must (cold review B). A plain
    // `systemctl --user start` no-ops against a unit systemd still considers
    // active - the SAME no-op `forcedRecycle` was invented to name on macOS.
    // So the Linux stop that could not prove the old instance gone would issue
    // a start that does nothing, and the run would proceed to activation over
    // a host still serving the PRE-SWAP bytes: the exact failure the field
    // exists for, on the one platform this round changed.
    //
    // `restart` rather than a second kill: it is an explicit stop job followed
    // by a start, so it tears down whatever still holds the unit and leaves it
    // ACTIVE. That last part is why it is safe here and `stop` is not - the
    // Q13 hazard is a unit left INACTIVE with `Restart=` disarmed, and a
    // restart job never ends there.
    relaunchAfterRestart: (label, stop) =>
      stop.forcedRecycle
        ? restartService(label, run)
        : startService(label, run),
    // SMAppService is macOS-only, so there is no second registration path
    // that could compete with systemd's user unit here.
    retireCompetingRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
    takeoverDesktopRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
  };
}

// Pluggable runner shape kept consistent with macOS so the three
// controllers expose the same factory signature, even when Linux
// doesn't currently use the seam.
export type ProcessRunner = typeof runCommand;

/**
 * Proves the user systemd instance is reachable BEFORE anything is written.
 *
 * `systemctl --user` needs a per-user service manager on a session bus, and
 * that is exactly what does not exist on a WSL distro without systemd
 * enabled, in a `sudo su <user>` shell, or over SSH to a box whose logind
 * never started a user manager. The previous order wrote the unit file
 * first and then let `daemon-reload` throw a raw `ProcessRunError`: an
 * orphan unit file left behind, and a stack trace naming neither systemd
 * nor WSL. Failing here fails with nothing installed and an error that
 * says what to do.
 */
async function assertSystemdUserReachable(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "show-environment"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message:
        `the systemd user manager is not reachable, so the ${unitName(label)} service cannot be installed: ${describeCause(cause)}. ` +
        `If this is WSL, enable systemd ('[boot]' / 'systemd=true' in /etc/wsl.conf, then 'wsl --shutdown' from Windows). ` +
        `On a headless machine, log in through a systemd session first. Nothing was installed.`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function installService(
  options: InstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  await assertSystemdUserReachable(options.label, run);
  const manifestPath = serviceManifestPath(options.label);
  await verifyServiceMutationAuthority();
  await mkdir(dirname(manifestPath), { recursive: true });
  await verifyServiceMutationAuthority();
  await writeFile(
    manifestPath,
    buildUnit({ label: options.label, cli: options.cli }),
    "utf8",
  );
  // daemon-reload picks up the new unit; enable --now both registers
  // the auto-start and starts the unit immediately.
  try {
    await run("systemctl", ["--user", "daemon-reload"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
    await run(
      "systemctl",
      ["--user", "enable", "--now", unitName(options.label)],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 15_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    // Roll the write back: a unit file systemd was never told about (or
    // refused to enable) must not outlive the failed install - it would sit
    // in ~/.config/systemd/user as an orphan that a later daemon-reload
    // silently registers. All cleanup steps are best-effort; the error the
    // operator sees is the install failure, not the rollback's.
    //
    // `enable --now` is enable-then-start as two separate steps: a start
    // failure after a successful enable leaves the enablement symlinks in
    // place (systemd does not roll them back), so `disable` must run BEFORE
    // the manifest is removed - otherwise the surviving symlinks point at a
    // unit file that no longer exists.
    await run(
      "systemctl",
      ["--user", "disable", "--now", unitName(options.label)],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 10_000,
        tolerateNonZeroExit: true,
      },
    ).catch((cause) => {
      if (isServiceMutationAuthorityError(cause)) throw cause;
    });
    await verifyServiceMutationAuthority();
    await rm(manifestPath, { force: true }).catch(() => undefined);
    await run("systemctl", ["--user", "daemon-reload"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: true,
    }).catch((cleanupCause) => {
      if (isServiceMutationAuthorityError(cleanupCause)) throw cleanupCause;
    });
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `systemd registration failed for ${unitName(options.label)}: ${describeCause(cause)} (the partially-written unit file was removed)`,
      details: { unit: unitName(options.label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
  if (options.enableLinger) {
    await tryEnableLinger(run);
  }
}

async function tryEnableLinger(run: ProcessRunner): Promise<void> {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  if (user.length === 0) return;
  // Tolerate non-zero exit so a polkit prompt or already-enabled state
  // doesn't fail the install. Doctor flags the absence later.
  await run("loginctl", ["enable-linger", user], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
}

async function uninstallService(
  options: UninstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  await run(
    "systemctl",
    ["--user", "disable", "--now", unitName(options.label)],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: true,
    },
  );
  await verifyServiceMutationAuthority();
  await rm(serviceManifestPath(options.label), { force: true });
  await run("systemctl", ["--user", "daemon-reload"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
  // A unit that ended up `failed` (e.g. it restart-looped before this
  // uninstall) leaves a failed entry in the user manager even after its
  // file is gone; clear it so `systemctl --user list-units` and
  // `is-system-running` stop reporting a service that no longer exists.
  await run("systemctl", ["--user", "reset-failed", unitName(options.label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  }).catch((cause) => {
    if (isServiceMutationAuthorityError(cause)) throw cause;
  });
}

async function statusService(label: ServiceLabel): Promise<ServiceStatus> {
  const manifestExists = await fileExists(serviceManifestPath(label));
  if (!manifestExists) {
    return statusNotInstalled();
  }
  const pidMetadata = await readHostPidMetadata(label.environment);
  if (pidMetadata !== null && !publishedHostProcessGone(pidMetadata)) {
    return {
      state: "running",
      version: pidMetadata.version,
      listenUrl: pidMetadata.websocketUrl,
      pid: pidMetadata.pid,
    };
  }
  return { state: "stopped", version: null, listenUrl: null, pid: null };
}

/**
 * The restart half's stop: take the host down WITHOUT disarming systemd.
 *
 * ## Why this cannot be `systemctl stop` (Q13)
 *
 * `systemctl --user stop` puts the unit in `inactive`, and `Restart=` does
 * not apply to a unit stopped that way - this file already relies on that,
 * in `cancelScheduledAutoRestart`, which uses a stop precisely BECAUSE it
 * cancels a scheduled relaunch. So an update's pre-swap stop turned the
 * service manager off with the manager's own off-switch, and the only thing
 * that turned it back on was the CLI that had just promised the restart. Kill
 * that CLI between the stop and the start - the Linux E6L wedge - and nothing
 * on a CLI-only install ever brings the host back: the reconciler that could
 * lives inside the host that is down.
 *
 * Signalling the unit leaves it loaded and its restart policy armed, so the
 * manager is still the actor that finishes what this stop started. What
 * decides whether the relaunched supervisor may actually spawn is the attempt
 * record, not this function.
 *
 * ## The ladder is now OURS, and that is not a workaround
 *
 * PLATFORM SEMANTICS, citation not pin, because systemd owns it and no test
 * here can observe it: `systemctl kill` delivers a signal and returns - it
 * runs no stop JOB - so `TimeoutStopSec` does not apply to this path at all.
 * Nothing escalates but us. The ladder below is therefore the sole deadline,
 * and it is derived from the host's own force-exit watchdog rather than from
 * a unit directive, exactly as the force path's is.
 *
 * That also REMOVES a mismatch rather than adding one. The old non-force stop
 * could not promise the host was down: its runner caps the subprocess at 15s
 * while the unit inherits systemd's 90s default, which is why `--force` needs
 * a confirm-and-escalate dance to promise anything. Owning the whole ladder
 * lets this path promise what the old one could not.
 *
 * ## Confirmation is INSTANCE-BOUND, and must be
 *
 * Two obvious confirmations are both wrong here, and wrong because of this
 * very change. Unit state never settles to `inactive` any more - the manager
 * is armed, so it keeps starting supervisors. And endpoint liveness is worse
 * than useless: a relaunched host ANSWERS the probe, so "something is
 * serving" would report the old instance alive when it is gone, or a
 * replacement as the thing we signalled.
 *
 * So the question is "is THIS process gone", asked against the identity
 * captured BEFORE the signal. `publishedHostProcessGone` answers it with the
 * polarity this needs: `false` means "not proven gone", never "proven alive".
 *
 * A host that published no identity at all - a pre-stamp `pid.json`, or a
 * platform whose probe returned nothing - is therefore UNPROVABLE, not gone.
 * It falls through to `forcedRecycle: true`, which is the safe direction: a
 * needless recycle costs a restart, a false "gone" activates over a host that
 * is still running.
 */
// The exhausted-ladder path is untestable at production timing: proving the
// escalation runs means letting the SIGTERM grace expire, and that grace is
// the host's own force-exit watchdog. Tests inject a short ladder here.
// Mirrors `setSwapRenameDelaysForTests`'s shape. Never set in production.
let restartStopGracesOverrideMs: {
  readonly sigtermMs: number;
  readonly sigkillMs: number;
} | null = null;
export function setRestartStopGracesForTests(
  graces: { readonly sigtermMs: number; readonly sigkillMs: number } | null,
): void {
  restartStopGracesOverrideMs = graces;
}

function restartStopGraces(): {
  readonly sigtermMs: number;
  readonly sigkillMs: number;
} {
  return (
    restartStopGracesOverrideMs ?? {
      sigtermMs: FORCE_STOP_SIGTERM_GRACE_MS,
      sigkillMs: FORCE_STOP_SIGKILL_GRACE_MS,
    }
  );
}

async function stopForRestartService(
  label: ServiceLabel,
  run: ProcessRunner,
  force: boolean,
): Promise<RestartStop> {
  const graces = restartStopGraces();
  // BEFORE the signal. Captured afterwards, this would read whatever the
  // armed manager has started since, and confirm the death of a process that
  // was never signalled.
  const signalled = await readHostPidMetadata(label.environment);
  await killUnit(label, run, "SIGTERM");
  if (await waitForSignalledHostGone(signalled, graces.sigtermMs)) {
    return { forcedRecycle: false };
  }
  await killUnit(label, run, "SIGKILL");
  if (await waitForSignalledHostGone(signalled, graces.sigkillMs)) {
    return { forcedRecycle: false };
  }
  // The signalled instance could not be proven gone through the unit's own
  // cgroup. For an ordinary restart that is simply `forcedRecycle`: the
  // relaunch recycles instead of starting, and the update proceeds.
  //
  // `--force` promises more than that, and Q13's first cut silently dropped
  // the promise. This function replaced `stopService(label, run,
  // options.force, "restart")`, and the replacement took no `force` at all -
  // so `host restart --force` on Linux stopped escalating to the published
  // host and stopped REPORTING a stop that had not taken effect. A hung host
  // is not "unprovable, carry on"; it is a forced stop that failed, and the
  // caller asked to be told.
  //
  // So the last escalation is restored, with the operation carried through
  // so the message names `host restart --force` rather than `host stop
  // --force`. It reaches the host process directly, outside the unit's
  // cgroup, which is the one place left that a unit-scoped kill cannot.
  if (force) {
    await finishForcedStopForPublishedHost(label, "restart");
  }
  // `true` even when the forced stop above SUCCEEDED, and that is deliberate
  // rather than a missed branch (cold review B: the obvious tidy here returns
  // `false`, which is the dangerous direction).
  //
  // What a successful `finishForcedStopForPublishedHost` proves is that the
  // PUBLISHED host is gone. It says nothing about the unit instance this
  // function signalled, which the ladder above already failed to prove dead -
  // and the manager is still armed, so a replacement may be starting anyway.
  // `false` would tell the relaunch to `systemctl start`, which no-ops against
  // a unit systemd still considers active; the update would then activate over
  // whatever is still serving. A needless recycle costs one restart. A false
  // "gone" costs the swap.
  return { forcedRecycle: true };
}

async function killUnit(
  label: ServiceLabel,
  run: ProcessRunner,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  await run(
    "systemctl",
    ["--user", "kill", `--signal=${signal}`, unitName(label)],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: true,
    },
  );
}

/**
 * Poll until the instance we signalled is provably gone, or the budget runs
 * out. `false` is always "could not prove", never "still alive".
 */
async function waitForSignalledHostGone(
  signalled: HostPidMetadata | null,
  timeoutMs: number,
): Promise<boolean> {
  // Nothing was published, so there is no instance to prove anything about.
  // Unprovable, and the caller treats that as a forced recycle.
  if (signalled === null) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (publishedHostProcessGone(signalled)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FORCE_STOP_POLL_MS);
    });
  }
}

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
  force: boolean,
  operation: "stop" | "restart",
): Promise<void> {
  await run("systemctl", ["--user", "stop", unitName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 15_000,
    tolerateNonZeroExit: true,
  });
  if (!force) return;
  // `--force` promises the host is DOWN when this returns, and the plain
  // stop above cannot promise that: the runner caps the subprocess at 15s
  // while the unit (no TimeoutStopSec) inherits systemd's 90s default, so a
  // host that survives SIGTERM outlives the subprocess and a bare return
  // would report a stop that has not happened. Confirm through systemd's own
  // unit state - never a pid, so a recycled pid.json entry cannot misdirect
  // this - and escalate with `systemctl kill -s SIGKILL`, which signals the
  // unit's OWN cgroup.
  if (await waitForUnitInactive(label, run, FORCE_STOP_SIGTERM_GRACE_MS)) {
    await cancelScheduledAutoRestart(label, run);
    // Re-confirm AFTER the cancel. The settle just observed can be a crash
    // (`failed`) whose Restart=on-failure relaunch already fired - the
    // cancel then races or tears down that replacement, and its runner
    // failures and timeouts are deliberately swallowed, so the cancel
    // itself vouches for nothing. Only a fresh positive read may. An
    // unconfirmed cancel falls through to the SIGKILL escalation instead of
    // reporting a stop it cannot prove.
    if (await waitForUnitInactive(label, run, FORCE_STOP_CONFIRM_GRACE_MS)) {
      await finishForcedStopForPublishedHost(label, operation);
      return;
    }
  }
  await run(
    "systemctl",
    ["--user", "kill", "--signal=SIGKILL", unitName(label)],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: true,
    },
  );
  // Cancel BEFORE polling: if the plain stop above never registered a stop
  // job (a transient user-bus failure is swallowed by tolerateNonZeroExit),
  // the SIGKILL lands outside any stop request and `Restart=on-failure`
  // schedules a relaunch in RestartSec - the unit would sit in
  // activating(auto-restart) and the poll below would time out over a host
  // that IS down. The renewed stop both cancels that schedule and lets the
  // state settle at inactive/failed.
  await cancelScheduledAutoRestart(label, run);
  if (await waitForUnitInactive(label, run, FORCE_STOP_SIGKILL_GRACE_MS)) {
    await finishForcedStopForPublishedHost(label, operation);
    return;
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message: `host stop --force: unit ${unitName(label)} is still active after SIGKILL; stop did not take effect.`,
    details: { unit: unitName(label) },
    exitCode: 1,
  });
}

// A settled unit state is not yet proof that NOTHING is scheduled: the unit
// can settle at `failed` because the host CRASHED during the grace rather
// than exiting from our stop request, and `Restart=on-failure` then has a
// relaunch scheduled for RestartSec later - reporting success and purging
// pid.json right before systemd resurrects the host. `systemctl stop` on a
// unit in auto-restart cancels the scheduled relaunch, and is a no-op on a
// unit that is genuinely down, so issuing it after (or around) every
// confirmation is pure insurance. Best-effort: the confirmation itself is
// the poll's job, not this call's.
async function cancelScheduledAutoRestart(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "stop", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: true,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    // The runner itself failing must not fail a stop the poll confirmed.
  }
}

// The confirmed-down unit is only HALF of what `--force` promises: pid.json
// can name a live host running OUTSIDE the unit (started manually, or
// orphaned by a corrupted teardown), and `is-active` says nothing about it.
// Silently succeeding would leave that host serving - and a
// `restart --force` would then start the unit BESIDE it, manufacturing the
// dual-host state the rest of this codebase actively fights. Finish with
// the same child-kill engine the macOS force paths use: it re-reads
// pid.json, identity-gates every signal, SIGTERM→SIGKILLs a live occupant,
// and purges the record only on an exact instance match - so the Linux
// contract becomes the macOS contract, "unit down AND published host down,
// or a loud failure".
//
// Outcome mapping differs from the macOS ENTRY paths on `no-metadata`
// deliberately: there the child engine is the whole stop, so nothing-to-kill
// is a failure ("a booting host may not have published yet"); here the unit
// teardown already ran with positive confirmation, and an absent record is
// the NORMAL trace of a host that exited gracefully and unlinked its own
// file - success, nothing further to finish.
/**
 * The clause both forced-stop failures open with - and Q13 made it false on
 * one of the two paths (cold review B).
 *
 * Only the VERB was parameterised when `stopForRestart` started reusing this
 * function; the PREMISE stayed "the systemd unit is stopped". That is true
 * after `stop --force`, which really does run `systemctl stop`. It is false
 * after `restart --force`: the ladder is `systemctl kill`, which runs no stop
 * job, so the unit stays LOADED with `Restart=` armed and `RestartSec=5` means
 * systemd is very likely starting a replacement while the operator reads the
 * message. This is the sentence someone reads while deciding whether their
 * host is down, so it has to describe the world they are actually in.
 */
function forcedStopPremise(operation: "stop" | "restart"): string {
  return operation === "stop"
    ? "the systemd unit is stopped"
    : "the unit was signalled and remains armed, so systemd will relaunch it";
}

/**
 * What to actually do about it, which differs for the same reason.
 *
 * "Remove the stale record and reinstall" is advice for a unit that is down
 * and staying down. Given to someone whose unit is cycling it is worse than
 * unhelpful - it invites an uninstall in the middle of a relaunch.
 */
function forcedStopRemediation(operation: "stop" | "restart"): string {
  return operation === "stop"
    ? "Retry in a moment; if the host is known dead, remove the stale record via 'traycer host service uninstall' and reinstall."
    : "Retry in a moment; a replacement host is probably already starting, so check 'traycer host status' before intervening - do not uninstall a unit that is still cycling.";
}

async function finishForcedStopForPublishedHost(
  label: ServiceLabel,
  operation: "stop" | "restart",
): Promise<void> {
  const outcome = await forceStopHostProcess(label.environment, operation);
  const premise = forcedStopPremise(operation);
  switch (outcome.kind) {
    case "stopped":
    case "no-host":
    case "no-metadata":
      return;
    case "identity-unverified":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host ${operation} --force: ${premise}, but pid.json names pid=${outcome.pid} and its identity cannot be verified (the pid may have been recycled), so refusing to signal it. ${forcedStopRemediation(operation)}`,
        details: { unit: unitName(label), pid: outcome.pid },
        exitCode: 1,
      });
    case "hung":
      // "MAY come up beside it" is hedged on purpose, and the hedge is load
      // bearing - do not harden it to "will" (reviewer C). The two-host
      // reading assumes the survivor is genuinely OUTSIDE the unit, which is
      // the case this message names and the one that costs a data dir. It is
      // not the only way to survive SIGKILL: a process INSIDE the cgroup stuck
      // in uninterruptible sleep survives it too, and there the unit stays
      // active, systemd relaunches nothing, and the operator has one stuck
      // process rather than two hosts.
      //
      // Nothing here can tell those apart, which is why the remedy is the same
      // either way - `host status` first, before intervening. The sentence
      // describes the worse branch because that is the one worth planning for;
      // stating it as certain would send an operator hunting a second host
      // that does not exist.
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host ${operation} --force: ${premise}, but the published host (pid=${outcome.pid}, running outside the unit) survived SIGKILL through the exit grace; the stop did not take effect.${
          operation === "restart"
            ? " A relaunched host may come up beside it, so treat this as two hosts over one data dir until the survivor is dealt with."
            : ""
        }`,
        details: { unit: unitName(label), pid: outcome.pid },
        exitCode: 1,
      });
  }
}

// Mirrors the macOS force-stop grace: the host's own force-exit watchdog
// bounds a graceful SIGTERM shutdown, so waiting any less would escalate
// over a host that is draining exactly as designed.
const FORCE_STOP_SIGTERM_GRACE_MS =
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
const FORCE_STOP_SIGKILL_GRACE_MS = 10_000;
// Post-cancel re-confirmation window. The cancel's own subprocess blocks up
// to 15s tearing down any replacement it caught mid-start, so by the time
// this poll begins a torn-down unit has usually settled; one that has not
// falls through to the SIGKILL escalation.
const FORCE_STOP_CONFIRM_GRACE_MS = 10_000;
const FORCE_STOP_POLL_MS = 500;

/**
 * Polls `systemctl is-active` until the unit POSITIVELY reports a settled
 * state (`inactive`/`failed`/`unknown` on stdout) or the deadline passes.
 * Only a recognized state is evidence: `is-active` reports settled states
 * through a nonzero exit WITH the state on stdout, but a probe that cannot
 * reach the user manager at all ("Failed to connect to bus") also exits
 * nonzero - printing nothing - and says nothing about the unit. Anything
 * unrecognized reads as NOT settled, so the caller escalates or fails
 * loudly rather than reporting a stop it could not confirm.
 */
async function waitForUnitInactive(
  label: ServiceLabel,
  run: ProcessRunner,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const settled = await probeUnitSettled(label, run);
    if (settled) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FORCE_STOP_POLL_MS);
    });
  }
}

async function probeUnitSettled(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<boolean> {
  let result: RunResult;
  try {
    result = await run("systemctl", ["--user", "is-active", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: true,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return false;
  }
  const state = result.stdout.trim();
  // POSITIVE confirmation only. An exclusion list ("not active, not
  // activating, ...") would also match an EMPTY answer - which is what a
  // probe that could not reach the systemd user manager produces
  // (`tolerateNonZeroExit` resolves it: nonzero exit, error on stderr,
  // nothing on stdout) - and would report a stop this command never
  // confirmed. `inactive`/`failed` are systemd's settled states; `unknown`
  // is older systemctl's answer for a unit that is not loaded at all.
  // Everything else - including `activating` (something is bringing the
  // unit UP), `deactivating`, and any unrecognized or empty answer - reads
  // as not settled, and the caller keeps waiting, escalates, or fails
  // loudly.
  return state === "inactive" || state === "failed" || state === "unknown";
}

async function startService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "start", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `systemctl start failed for ${unitName(label)}: ${describeCause(cause)}`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "restart", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `systemctl restart failed for ${unitName(label)}: ${describeCause(cause)}`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

function unitName(label: ServiceLabel): string {
  // systemd allows dots in unit-name prefixes - `ai.traycer.host.service`
  // parses unambiguously thanks to the `.service` suffix.
  return `${label.id}.service`;
}

function statusNotInstalled(): ServiceStatus {
  return { state: "not-installed", version: null, listenUrl: null, pid: null };
}

function describeCause(cause: unknown): string {
  if (cause instanceof ProcessRunError) {
    return `${cause.message} (exit=${cause.exitCode})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

interface BuildUnitOptions {
  readonly label: ServiceLabel;
  readonly cli: CliInvocation;
}

function buildUnit(options: BuildUnitOptions): string {
  const programArgs = [
    "/bin/sh",
    "-c",
    buildCompatibleHostStartScript(options.label.id),
    options.cli.command,
    ...options.cli.args,
  ];
  // systemd treats `%` as a specifier introducer and `;`/`\n`/`\t` as
  // line/argument separators inside an Exec= value. Reject any token
  // containing those rather than emit a unit file systemd parses
  // incorrectly - surface as SERVICE_INSTALL_FAILED with the offending
  // token so the operator can rename / relocate the binary.
  const forbidden = /[%;\n\t]/;
  const offending = programArgs.find((arg) => forbidden.test(arg));
  if (offending !== undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `systemd unit: argument '${offending}' contains a character (% ; \\n \\t) that systemd would mis-parse in ExecStart; relocate the CLI binary to a path without these characters`,
      details: { offending, unit: `${options.label.id}.service` },
      exitCode: 1,
    });
  }
  // systemd ExecStart - quote each token so paths with spaces don't
  // break the unit file; backslash-escape inner quotes per the systemd
  // unit-file spec.
  const execStart = programArgs
    .map((arg) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(" ");
  // A definition can outlive the CLI it points at (the CLI package removed
  // while the unit stays enabled). Without the condition, every login then
  // exec's a missing $0, `Restart=on-failure` loops it into a `failed` unit
  // on every boot, and `systemctl --user is-system-running` degrades. With
  // it, systemd skips the start as "condition not met" - inert and visible
  // in `systemctl --user status`, not failing. A skipped condition does not
  // trigger Restart=, and a later `systemctl start` (the reinstall path)
  // re-evaluates it fresh. Conditions require absolute paths; the CLI
  // command always is one in production (guarded here for the self-invoke
  // fallback).
  const condition = isAbsolute(options.cli.command)
    ? `ConditionFileIsExecutable=${options.cli.command}\n`
    : "";
  // SyslogIdentifier: journald names a stream after the FIRST executable of
  // the Exec line - /bin/sh - and the stream is opened before the wrapper
  // exec's the CLI, so without this every supervisor line lands in the
  // journal as `sh[pid]`. The label id keys the lines to the exact
  // service instance (`journalctl --user -t ai.traycer.host`).
  return `[Unit]
Description=${options.label.displayName}
After=default.target
${condition}
[Service]
Type=simple
SyslogIdentifier=${options.label.id}
ExecStart=${execStart}
# Keep an OOM-killed agent/tool process from causing systemd to stop the
# entire host unit and every sibling workload in its cgroup.
OOMPolicy=continue
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export { buildUnit as buildSystemdUnit };
