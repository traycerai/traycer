import { platform as osPlatform } from "node:os";
import {
  finalizePendingCliUpgrade,
  type FinalizePendingCliUpgradeOutcome,
} from "./cli-upgrade";
import { assertHostNotBusy } from "../host/busy-check";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
} from "../service";
import { withCliLock } from "../store/cli-lock";
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
export interface HostRestartArgs {
  readonly ifIdle: boolean;
}

export function buildHostRestartCommand(args: HostRestartArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const label = serviceLabelFor(ctx.runtime.environment);
    const controller = createServiceController();
    const locked = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-restart",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        if (args.ifIdle) {
          await assertHostNotBusy(ctx.runtime.environment);
        }
        const result = await restartWithPendingCliUpgradeFinalize({
          environment: ctx.runtime.environment,
          controller,
          label,
          parentPid: process.pid,
          platform: osPlatform(),
          spawnImpl: defaultSpawnImpl,
          writeImpl: defaultWriteImpl,
        });
        return {
          result,
          attestation: await attestInstallRuntime(ctx.runtime.environment),
        };
      },
    );
    return {
      data: {
        restarted: true,
        label: label.id,
        cliUpgrade: locked.result.finalize,
        helper: locked.result.helper,
        markerReconcile: locked.result.markerReconcile,
        installGeneration: locked.attestation.installGeneration,
        runtimeVersion: locked.attestation.runtimeVersion,
        runtimeWasNull: locked.attestation.runtimeWasNull,
      },
      human: humanForRestart(label.id, locked.result),
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
): Promise<RestartFinalizeResult> {
  // 1. Apply any marker from a prior helper attempt. This may clear
  //    pendingUpgrade if the helper succeeded on the last cycle.
  const markerReconcile = await reconcilePostFinalizeMarker({
    environment: args.environment,
  });

  await args.controller.stop(args.label);

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
    await args.controller.start(args.label);
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
      return `${reconcilePrefix}${base}; cli upgrade staged binary ${outcome.stagedBinaryPath} missing - re-run 'traycer cli upgrade'`;
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
      return `prior helper swap failed (${reconcile.errorMessage}); `;
    case "applied-parent-still-alive":
      return "prior helper timed out waiting for CLI exit; ";
    case "marker-invalid":
      return `prior helper marker invalid (${reconcile.errorMessage}); `;
    case "no-marker":
      return "";
  }
}
