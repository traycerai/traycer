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

// Restart runs marker-reconcile -> stop -> pending-CLI-upgrade finalize -> start under one lock.
// `--defer-if-parked` must classify under that same lock; `--if-idle` probes busy immediately before stop.
export interface HostRestartArgs {
  readonly ifIdle: boolean;
  readonly force: boolean;
  readonly deferIfParked: boolean;
}

export function buildHostRestartCommand(args: HostRestartArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Validated inside the CommandFn so the runner catches it (CliError -> NDJSON error envelope).
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
          // Classified under the same lock that guards the action below.
          if (args.deferIfParked) {
            // Refuse without touching the service: stopping a parked activate continuation leaves the machine down and the continuation parked.
            return {
              kind: "deferred-for-parked-activation" as const,
              attestation: await attestInstallRuntime(ctx.runtime.environment),
            };
          }
          // Do not relaunch the generic supervisor over parked packaged-Mac bytes; stop safely and leave the parked record.
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
    // Distinct from `restarted:false`: that path stopped the service; this one left it running.
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
  readonly helper: ScheduleHelperResult | null;
  readonly markerReconcile: ReconcileOutcome | null;
  // When true the helper starts the service; skip controller.start().
  readonly helperOwnsServiceStart: boolean;
}

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
        null,
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
  const markerReconcile = await reconcilePostFinalizeMarker({
    environment: args.environment,
  });

  // `stopForRestart`, never `stop`: an unreachable host makes `stop` throw before relaunch. Busy still throws.
  const stop = await actuators.stop();

  const finalize = await finalizePendingCliUpgrade({
    environment: args.environment,
  });

  // If the live binary is still locked after stop (this CLI process holds its own .exe), the helper starts the service; skip controller.start().
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
    // Preserve `swapped` evidence after a successful binary replace with a failed manifest update, or the next restart misclassifies the moved staged file as missing.
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
      // Host-down outranks lost reconciliation evidence.
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
      // Restart is not forfeited because a staged CLI swap could not publish. Live binary untouched; pending state stands.
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
      // Marker is gone after reconciliation; this line is the last chance to say the host was left down.
      return reconcile.serviceStartError !== null
        ? `prior helper swap failed (${reconcile.errorMessage}) and could not restart the service (${reconcile.serviceStartError}); `
        : `prior helper swap failed (${reconcile.errorMessage}); `;
    case "applied-parent-still-alive":
      return "prior helper timed out waiting for CLI exit; ";
    case "marker-invalid":
      return `prior helper marker invalid (${reconcile.errorMessage}); `;
    case "stale-marker-discarded":
      // Marker existed, looked successful, and was deliberately not applied.
      return `discarded a stale helper marker (marker staged=${reconcile.markerStagedBinaryPath} live=${reconcile.markerLivePath} at=${reconcile.markerAttemptedAt}; pending staged=${reconcile.pendingStagedBinaryPath} live=${reconcile.manifestBinaryPath} at=${reconcile.pendingStagedAt}); `;
    case "no-marker":
      return "";
  }
}
