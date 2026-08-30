import { platform as osPlatform } from "node:os";
import {
  finalizePendingCliUpgrade,
  type FinalizePendingCliUpgradeOutcome,
} from "./cli-upgrade";
import { writePostFinalizeMarkerFile } from "./cli-finalize-upgrade";
import { assertHostNotBusy } from "../host/busy-check";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
} from "../service";
import { withCliUpdateContenderContext } from "../host/update-contender";
import {
  relaunchHostAfterRestartWithAttempt,
  stopHostServiceWithAttempt,
  stopHostForRestartWithAttempt,
} from "../host/update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { cliPostFinalizeMarkerPath } from "../store/paths";
import {
  defaultSpawnImpl,
  defaultWriteImpl,
  reconcilePostFinalizeMarker,
  scheduleFinalizationHelper,
  type ReconcileOutcome,
  type ScheduleHelperResult,
  type SpawnImpl,
  type WriteImpl,
} from "../upgrade/finalize-helper";

// `traycer host restart` - kicks the OS service so the supervisor
// re-spawns the host. The supervisor itself re-reads the install
// record at spawn time, so this is also how a freshly-installed
// host gets picked up after `host install` if the service was
// already running on the previous binary.
//
// Restart is also the moment we get to finalise a pending CLI upgrade.
// `traycer cli upgrade` stages the new binary and records
// `pendingUpgrade` when the live binary is locked (Windows: the
// supervisor process holds the CLI .exe open; cross-platform:
// read-only install dir). Between `stop` and `start` the supervisor's
// lock is released, so we attempt the staged-binary swap in that
// window and then start the service back on the new binary.
//
// On Windows the *current CLI process* (the one running this command)
// is itself executing from the live `.exe`, so even after the
// supervisor releases its lock, renameSync still fails with EBUSY.
// For that case we hand off to a detached helper that waits for the
// CLI process to exit and then completes the swap + service start
// asynchronously. See upgrade/finalize-helper.ts.
//
// A failed in-process finalize is non-fatal: the service is still
// started, the pending state remains visible in Doctor, and the next
// restart (or the helper) retries the swap.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal restart must not enter another actor's
// apply/install/activation critical section and stop/kill the process
// it just started - the whole marker-reconcile -> stop -> finalize ->
// start sequence runs inside ONE lock acquisition.
//
// `--if-idle` (hidden, internal - the CLI-owned activation mode): after
// acquiring the lock, probe `assertHostNotBusy` before the disruptive
// step; busy -> `E_HOST_BUSY`, the lock releases with nothing touched.
// The only step between the probe and `controller.stop()` is
// `reconcilePostFinalizeMarker`'s local file read - not the network or
// long-running work the TOCTOU-floor principle guards against - so the
// probe runs immediately before this call rather than being threaded
// into `restartWithPendingCliUpgradeFinalize` itself. Plain `host
// restart` (no `--if-idle`) skips the probe entirely, keeping today's
// unconditional semantics for explicit user restarts.
// `--force` (user-facing): skip the cooperative shutdown claim and kill the
// host process before relaunching. The user explicitly accepted losing
// running sessions and in-flight agent work; see `host stop --force` for the
// mechanics. Mutually exclusive with `--if-idle` - one flag widens the busy
// gate, the other removes it, and a command carrying both has no coherent
// intent.
// `--defer-if-parked` (hidden, internal - the Desktop force-restart path):
// when the canonical recovery classification says `stop-only`, do NOT stop the
// service; refuse and report, leaving a running host running.
//
// ## Why this is a flag on THIS command rather than a check by the caller
//
// The classification and the action it authorizes must happen under ONE
// acquisition of the contender lock. Desktop previously read the attempt record
// itself, decided the record was not an active continuation, and only then
// shelled this command - a snapshot, not a condition on the restart. A new
// contender can park `preparing/activate` in the window between that read and
// this command taking the lock, so the caller's "safe to restart" verdict was
// already stale when it was acted on: the CLI would then classify the NEW
// record as `stop-only`, stop the service, and report `restarted:false`,
// leaving the host down with a continuation on disk. That is the stranding the
// Desktop check existed to prevent, produced by the check itself.
//
// Deciding here closes the window by construction, because
// `contenderContext.recoveryAction` is computed from the record under the same
// lock that guards the stop/restart below. It also removes the second copy of
// the policy: which phases are recoverable is `recoveryActionFor`'s call in
// shared, and no caller re-derives it.
export interface HostRestartArgs {
  readonly ifIdle: boolean;
  readonly force: boolean;
  readonly deferIfParked: boolean;
}

export function buildHostRestartCommand(args: HostRestartArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Validated INSIDE the CommandFn so the runner catches it (CliError →
    // NDJSON error envelope) - same reason as host install's flag check.
    if (args.ifIdle && args.force) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host restart: --if-idle and --force are mutually exclusive; pass one or the other",
        details: null,
        exitCode: 1,
      });
    }
    const label = serviceLabelFor(ctx.runtime.environment);
    const controller = createServiceController();
    const locked = await withCliUpdateContenderContext(
      {
        environment: ctx.runtime.environment,
        reason: "host-restart",
        waitMs: 30_000,
        pollIntervalMs: 100,
        admission: "recovery-maintenance",
      },
      async (capability, _cliLock, contenderContext) => {
        if (args.ifIdle) {
          await assertHostNotBusy(ctx.runtime.environment);
        }
        if (contenderContext.recoveryAction === "stop-only") {
          // Classified from the record under the SAME lock acquisition that
          // guards the action below, so no contender can change the record
          // between the decision and its effect.
          if (args.deferIfParked) {
            // Refuse without touching the service. For a caller whose whole
            // purpose is "get this host running", stopping it is strictly
            // worse than doing nothing: a stop leaves the machine down AND
            // the continuation parked, which is the state the caller was
            // trying to escape. Doing nothing leaves a running host running
            // and a down host no worse, and the parked record stays for the
            // admitted activation flow either way.
            return {
              kind: "deferred-for-parked-activation" as const,
              attestation: await attestInstallRuntime(ctx.runtime.environment),
            };
          }
          // An activate-continuation record proves that packaged-Mac bytes
          // are waiting for the update executor's explicit activation edge.
          // Force restart remains a usable recovery control, but relaunching
          // the generic supervisor here could activate those parked bytes
          // outside that continuation. Stop the current service safely and
          // leave the parked record for the admitted activation flow.
          await stopHostServiceWithAttempt(
            capability,
            {
              environment: ctx.runtime.environment,
              reason: "host-restart",
              waitMs: 30_000,
              pollIntervalMs: 100,
              admission: "recovery-maintenance",
            },
            controller,
            label,
            { force: args.force },
          );
          return {
            kind: "stopped-for-parked-activation" as const,
            attestation: await attestInstallRuntime(ctx.runtime.environment),
          };
        }
        const result = await restartWithPendingCliUpgradeFinalizeWithAttempt(
          {
            environment: ctx.runtime.environment,
            controller,
            label,
            parentPid: process.pid,
            platform: osPlatform(),
            spawnImpl: defaultSpawnImpl,
            writeImpl: defaultWriteImpl,
            force: args.force,
          },
          capability,
          {
            environment: ctx.runtime.environment,
            reason: "host-restart",
            waitMs: 30_000,
            pollIntervalMs: 100,
            admission: "recovery-maintenance",
          },
        );
        return {
          kind: "restarted" as const,
          result,
          attestation: await attestInstallRuntime(ctx.runtime.environment),
        };
      },
    );
    const restarted = locked.kind === "restarted";
    // A distinct fact from `restarted:false`. Both mean "no relaunch", but a
    // safe-stop STOPPED the service and this one deliberately did not touch
    // it, and a caller that cannot tell them apart cannot tell "your host is
    // now down" from "your host is still up, activation is pending".
    const deferredForParkedActivation =
      locked.kind === "deferred-for-parked-activation";
    return {
      data: {
        restarted,
        deferredForParkedActivation,
        label: label.id,
        cliUpgrade: restarted ? locked.result.finalize : null,
        helper: restarted ? locked.result.helper : null,
        markerReconcile: restarted ? locked.result.markerReconcile : null,
        installGeneration: locked.attestation.installGeneration,
        runtimeVersion: locked.attestation.runtimeVersion,
        runtimeWasNull: locked.attestation.runtimeWasNull,
      },
      human: restarted
        ? humanForRestart(label.id, locked.result)
        : deferredForParkedActivation
          ? `left service '${label.id}' untouched because a packaged update is waiting for its explicit activation`
          : `stopped service '${label.id}' without relaunch because a packaged update is waiting for its explicit activation`,
      exitCode: 0,
    };
  };
}

interface RestartFinalizeArgs {
  readonly environment: import("../runner/environment").Environment;
  readonly controller: ServiceController;
  readonly label: ServiceLabel;
  readonly parentPid: number;
  readonly platform: NodeJS.Platform;
  readonly spawnImpl: SpawnImpl;
  readonly writeImpl: WriteImpl;
  readonly force: boolean;
}

export interface RestartFinalizeResult {
  readonly finalize: FinalizePendingCliUpgradeOutcome;
  // Set when this restart scheduled a detached helper to complete the
  // swap after the current CLI process exits.
  readonly helper: ScheduleHelperResult | null;
  // Set when a prior helper attempt left a marker the host-restart
  // command consumed at the top of this run.
  readonly markerReconcile: ReconcileOutcome | null;
  // True when the helper takes ownership of starting the service. When
  // true we deliberately skip the controller.start() call.
  readonly helperOwnsServiceStart: boolean;
}

// Split out so tests can inject a controller stub + spawn/write stubs
// without monkey-patching the OS-level helpers.
export async function restartWithPendingCliUpgradeFinalize(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
): Promise<RestartFinalizeResult> {
  return restartWithActuators(args, actuators);
}

async function restartWithPendingCliUpgradeFinalizeWithAttempt(
  args: RestartFinalizeArgs,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<RestartFinalizeResult> {
  return restartWithActuators(args, {
    stop: () =>
      stopHostForRestartWithAttempt(
        capability,
        contenderOptions,
        args.controller,
        args.label,
        { force: args.force },
      ),
    relaunch: (stopped) =>
      relaunchHostAfterRestartWithAttempt(
        capability,
        contenderOptions,
        args.controller,
        args.label,
        stopped,
      ),
  });
}

export interface RestartActuators {
  stop(): Promise<import("../service").RestartStop>;
  relaunch(stopped: import("../service").RestartStop): Promise<void>;
}

async function restartWithActuators(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
): Promise<RestartFinalizeResult> {
  // 1. Apply any marker from a prior helper attempt. This may clear
  //    pendingUpgrade if the helper succeeded on the last cycle.
  const markerReconcile = await reconcilePostFinalizeMarker({
    environment: args.environment,
  });

  // `stopForRestart`, never `stop`: on a Desktop-managed machine a host whose
  // RPC endpoint is unreachable (or that outlived its own force-exit
  // watchdog) makes `stop` throw, and this command would exit before ever
  // relaunching - the exact broken-host state report 2 asked `host restart`
  // to repair. The restart half reports that as `forcedRecycle` instead, and
  // the relaunch below recycles the job rather than no-opping a kickstart
  // against a process that never left. A busy host still throws.
  const stop = await actuators.stop();

  // 2. Try the in-process finalize. On POSIX this almost always works
  //    once the host supervisor releases the binary.
  const finalize = await finalizePendingCliUpgrade({
    environment: args.environment,
  });

  // 3. Windows-specific: if the live binary is still locked after stop
  //    (because the *current CLI process* holds its own .exe), hand
  //    the swap off to a detached helper. The helper will start the
  //    service once the swap completes, so we deliberately do NOT
  //    call controller.start() here.
  let helper: ScheduleHelperResult | null = null;
  let helperOwnsServiceStart = false;
  if (finalize.status === "still-locked" && args.platform === "win32") {
    helper = await scheduleFinalizationHelper({
      environment: args.environment,
      stagedBinaryPath: finalize.stagedBinaryPath,
      livePath: finalize.livePath,
      parentPid: args.parentPid,
      parentExitTimeoutSeconds: 60,
      platform: args.platform,
      spawnImpl: args.spawnImpl,
      writeImpl: args.writeImpl,
    });
    helperOwnsServiceStart = helper.status === "scheduled";
  }

  if (!helperOwnsServiceStart) {
    // The in-process path can replace the binary successfully and then fail
    // to update the manifest. Preserve the same `swapped` evidence as the
    // detached helper so the next restart can reconcile the stale pending
    // record instead of misclassifying the moved staged file as missing.
    if (finalize.status === "manifest-update-failed") {
      let relaunchError: unknown = null;
      try {
        await actuators.relaunch(stop);
      } catch (err) {
        relaunchError = err;
      }
      let markerWriteError: unknown = null;
      try {
        await writePostFinalizeMarkerFile(
          cliPostFinalizeMarkerPath(args.environment),
          {
            status: "swapped",
            attemptedAt: new Date().toISOString(),
            livePath: finalize.livePath,
            stagedBinaryPath: finalize.stagedBinaryPath,
            errorMessage: finalize.errorMessage,
            serviceStartError:
              relaunchError === null
                ? null
                : relaunchError instanceof Error
                  ? relaunchError.message
                  : String(relaunchError),
          },
        );
      } catch (err) {
        markerWriteError = err;
      }
      // Preserve lifecycle failure precedence if both operations fail: the
      // host is still down, which is more urgent than lost reconciliation
      // evidence. A marker-only failure is still returned to the caller.
      if (relaunchError !== null) throw relaunchError;
      if (markerWriteError !== null) throw markerWriteError;
    } else {
      await actuators.relaunch(stop);
    }
  }

  return {
    finalize,
    helper,
    markerReconcile,
    helperOwnsServiceStart,
  };
}

function humanForRestart(
  labelId: string,
  result: RestartFinalizeResult,
): string {
  const base = `requested restart for service '${labelId}'`;
  const reconcilePrefix = describeMarkerReconcile(result.markerReconcile);
  if (result.helper !== null && result.helper.status === "scheduled") {
    return `${reconcilePrefix}${base}; cli upgrade live binary held by current CLI process - scheduled detached helper (pid=${
      result.helper.helperPid ?? "?"
    }) to complete the swap after this process exits`;
  }
  if (result.helper !== null && result.helper.status === "failed") {
    return `${reconcilePrefix}${base}; cli upgrade helper failed to launch (${result.helper.errorMessage}) - pending state retained`;
  }
  const outcome = result.finalize;
  switch (outcome.status) {
    case "finalised":
      return `${reconcilePrefix}${base}; finalised cli upgrade ${outcome.previousVersion} → ${outcome.version}`;
    case "still-locked":
      return `${reconcilePrefix}${base}; cli upgrade ${outcome.stagedBinaryPath} still locked (${outcome.errorMessage}) - pending state retained`;
    case "staged-binary-missing":
      return `${reconcilePrefix}${base}; cli upgrade staged binary for ${outcome.stagedVersion} missing at ${outcome.stagedBinaryPath} - re-run 'traycer cli upgrade'`;
    case "publish-failed":
      // The host was relaunched regardless - the restart the user asked
      // for is not forfeited because a staged CLI swap could not be
      // published. The live binary is untouched and pending state stands.
      return `${reconcilePrefix}${base}; cli upgrade could not publish ${outcome.stagedBinaryPath} over ${outcome.livePath} (${outcome.errorMessage}) - live binary unchanged, pending state retained`;
    case "manifest-update-failed":
      return `${reconcilePrefix}${base}; cli ${outcome.version} was installed, but the CLI manifest update failed (${outcome.errorMessage}) - service relaunched and pending state retained for reconciliation`;
    case "no-pending":
    case "no-manifest":
      return `${reconcilePrefix}${base}`;
  }
}

function describeMarkerReconcile(reconcile: ReconcileOutcome | null): string {
  if (reconcile === null) return "";
  switch (reconcile.status) {
    case "applied-swapped":
      return `prior helper finalised cli upgrade ${reconcile.previousVersion} → ${reconcile.version}; `;
    case "applied-swap-failed":
      // Surface the service-start failure when there was one: the marker
      // is gone after reconciliation, so this line is the last chance to
      // say why the host was left down rather than merely un-upgraded.
      return reconcile.serviceStartError !== null
        ? `prior helper swap failed (${reconcile.errorMessage}) and could not restart the service (${reconcile.serviceStartError}); `
        : `prior helper swap failed (${reconcile.errorMessage}); `;
    case "applied-parent-still-alive":
      return "prior helper timed out waiting for CLI exit; ";
    case "marker-invalid":
      return `prior helper marker invalid (${reconcile.errorMessage}); `;
    case "stale-marker-discarded":
      // Named explicitly rather than folded into silence: this is the one
      // outcome where a marker existed, looked successful, and was
      // deliberately NOT applied. Someone reading a restart that did not
      // finalise the upgrade they expected needs to see why.
      return `discarded a stale helper marker (marker staged=${reconcile.markerStagedBinaryPath} live=${reconcile.markerLivePath} at=${reconcile.markerAttemptedAt}; pending staged=${reconcile.pendingStagedBinaryPath} live=${reconcile.manifestBinaryPath} at=${reconcile.pendingStagedAt}); `;
    case "no-marker":
      return "";
  }
}
