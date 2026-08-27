import { killConflictingPortOwner } from "../host/free-port-kill";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import {
  requireCliUpdateMutationCapability,
  withCliUpdateContenderContext,
} from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import {
  restartHostServiceWithAttempt,
  stopHostServiceWithAttempt,
} from "../host/update-mutation";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";

// `traycer host free-port-and-restart --pid <pid> --port <port>` - the
// CLI-owned mapping for Doctor's Free-Port-and-Restart fix. Hidden from
// `--help` because it's a destructive, last-resort knob the renderer
// dispatches via NDJSON after confirming process identity with the user.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): the kill (if requested) and the restart both execute
// inside ONE lock acquisition, so this can never enter another actor's
// apply/install/activation critical section.
export interface HostFreePortAndRestartArgs {
  readonly pid: number | null;
  readonly port: number | null;
  /**
   * Refuse without stopping when the canonical classification says the parked
   * bytes make a generic restart unsafe.
   *
   * Same contract and same reasoning as `host restart --defer-if-parked`; this
   * command reaches the identical `stop-only` branch from the port-conflict
   * repair, so it is the same stop-without-relaunch hazard by another entry
   * point rather than a separate concern.
   */
  readonly deferIfParked: boolean;
}

export function buildHostFreePortAndRestartCommand(
  args: HostFreePortAndRestartArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.pid !== null && args.port === null) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host free-port-and-restart: --pid requires --port so we can verify the PID actually owns the conflicting port",
        details: { pid: args.pid, port: null },
        exitCode: 1,
      });
    }
    const label = serviceLabelFor(ctx.runtime.environment);
    // ONE options value for acquisition and every in-segment revalidation:
    // separate literals that must stay identical are how admission policies
    // drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-free-port-and-restart",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "recovery-maintenance",
    };
    const {
      killed,
      killError,
      restarted,
      deferredForParkedActivation,
      attestation,
    } = await withCliUpdateContenderContext(
      contenderOptions,
      async (capability, _cliLock, contenderContext) => {
        let killedInner = false;
        let killErrorInner: string | null = null;
        if (args.pid !== null && args.port !== null) {
          ctx.progress({
            stage: "kill-conflicting",
            message: `sending SIGTERM to pid ${args.pid}`,
            percent: null,
            bytes: null,
            totalBytes: null,
            workUnits: null,
          });
          const result = await killConflictingPortOwner({
            pid: args.pid,
            port: args.port,
            commandName: "host free-port-and-restart",
            verifyMutationCapability: () =>
              requireCliUpdateMutationCapability(capability, contenderOptions),
          });
          killedInner = result.killed;
          killErrorInner = result.killError;
        }
        const controller = createServiceController();
        const restart = contenderContext.recoveryAction === "restart-current";
        // Classified under the same lock acquisition that guards the action
        // below. Refusing beats stopping for a caller whose intent is "make
        // this host reachable again": the port is already freed above, and
        // stopping the service would add a down host to a parked update.
        if (!restart && args.deferIfParked) {
          return {
            killed: killedInner,
            killError: killErrorInner,
            restarted: false,
            deferredForParkedActivation: true,
            attestation: await attestInstallRuntime(ctx.runtime.environment),
          };
        }
        ctx.progress({
          stage: restart ? "service-restart" : "service-stop",
          message: restart
            ? `requesting restart for service '${label.id}'`
            : `stopping service '${label.id}' without activating parked update bytes`,
          percent: null,
          bytes: null,
          totalBytes: null,
          workUnits: null,
        });
        if (restart) {
          await restartHostServiceWithAttempt(
            capability,
            contenderOptions,
            controller,
            label,
          );
        } else {
          await stopHostServiceWithAttempt(
            capability,
            contenderOptions,
            controller,
            label,
            { force: false },
          );
        }
        return {
          killed: killedInner,
          killError: killErrorInner,
          restarted: restart,
          deferredForParkedActivation: false,
          attestation: await attestInstallRuntime(ctx.runtime.environment),
        };
      },
    );
    // Both no-relaunch outcomes need distinct copy: one stopped the service,
    // the other deliberately left it alone. Reporting them with one sentence
    // would tell a user their host is down when it is still running.
    const noRelaunch = deferredForParkedActivation
      ? `left '${label.id}' untouched because a packaged update is waiting for its explicit activation`
      : `stopped '${label.id}' without activating parked update bytes`;
    // The kill warning composes with whichever service action actually ran —
    // a failed SIGTERM on a stop-only or deferred outcome must not claim a
    // restart was requested.
    const action = restarted
      ? `restart requested for service '${label.id}'`
      : noRelaunch;
    const human =
      killError !== null
        ? `${action}; warning: failed to terminate pid ${args.pid ?? "?"}: ${killError}`
        : args.pid !== null
          ? `terminated pid ${args.pid}; ${action}`
          : action;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        processName: null,
        killed,
        killError,
        deferredForParkedActivation,
        restartedLabel: restarted ? label.id : null,
        installGeneration: attestation.installGeneration,
        runtimeVersion: attestation.runtimeVersion,
        runtimeWasNull: attestation.runtimeWasNull,
      },
      human,
      exitCode: 0,
    };
  };
}
