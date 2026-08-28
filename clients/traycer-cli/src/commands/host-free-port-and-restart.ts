import {
  killConflictingPortOwner,
  type KillConflictingPortOwnerResult,
} from "../host/free-port-kill";
import { portRepairFailure } from "../host/free-port-outcome";
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
// CLI-owned mapping for Doctor's Free-Port-and-Restart fix.
//
// PUBLIC (#1505 flipped the registration in `index.ts`), because `host doctor`
// prints this exact line for a person to type when it finds a port conflict: a
// command a diagnostic hands to a user belongs in `--help`. That is why every
// failure message below is written for a human audience rather than only for
// Desktop's error toast.
//
// Still destructive and still last-resort. The renderer confirms the foreign
// process's identity with the user before dispatching it over NDJSON, and a
// typed invocation re-verifies that identity here
// (`killConflictingPortOwner` refuses to signal a PID that does not own the
// port) rather than trusting the numbers on the command line.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): the kill (if requested), its verification, and the
// restart all execute inside ONE lock acquisition, so this can never enter
// another actor's apply/install/activation critical section, and no other
// actor can take the freed port between the verification and the restart.
//
// THE KILL GATES THE RESTART. This command used to call `controller.restart`
// unconditionally and return `exitCode: 0` even when the termination failed,
// with the reason demoted to a warning inside the success envelope. That is
// the worst possible shape for this particular repair: the host is restarted
// into a port a foreign process still holds, so it cannot bind and comes back
// down, while Doctor and Desktop are told the port conflict was fixed and the
// user is sent looking somewhere else entirely (audit finding CLI-011).
//
// So the sequence is now kill -> verify -> restart, and a verification that
// does not confirm release throws a structured error BEFORE the restart. The
// host is left exactly as it was: still down on a held port, which is the
// truthful state and the one whose error message names the process to deal
// with. Desktop's non-macOS path maps the thrown error onto its `failed`
// outcome after `reloadAfterServiceCycleFailure()`, which is correct here
// because no service cycle was attempted.
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
    // `--pid` and `--port` are both-or-neither.
    //
    // The `--pid`-alone direction was always rejected: without a port there is
    // nothing to verify ownership against, and signalling an unverified PID is
    // the one thing this command must never do. The `--port`-alone direction
    // was NOT, and silently degraded to a bare restart - no kill attempted, no
    // error, exit 0, and human output announcing a successful repair. That is
    // the same failure shape as CLI-011 itself (a repair reporting success it
    // did not earn), and it only became reachable by a human when `host
    // doctor` started printing this command for users to type: a half-typed
    // line now answers "port conflict fixed" for a conflict it never touched.
    //
    // Passing NEITHER remains legal and remains a plain restart. Desktop's
    // `HostController#freePortAndRestart` pushes the two flags conditionally
    // (host-controller.ts), so a bare `["host","free-port-and-restart"]` is a
    // live machine call, and the help text names that behaviour rather than
    // hiding it. Note what is deliberately NOT done here: refusing the bare
    // form for "interactive" callers only. Inferring a safety boundary from a
    // TTY is exactly the anti-pattern the audit calls out for `host start`,
    // and a contract that changes with the shape of the caller's stdout is
    // not a contract.
    if ((args.pid === null) !== (args.port === null)) {
      const missing = args.pid === null ? "--pid" : "--port";
      const supplied = args.pid === null ? "--port" : "--pid";
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          `host free-port-and-restart: ${supplied} requires ${missing}. ` +
          "Both are needed to verify that the PID actually owns the conflicting port before anything is signalled - " +
          "'traycer host doctor' prints the full command with both values filled in. " +
          "To restart the host without freeing a port, pass neither flag (or use 'traycer host restart').",
        details: { pid: args.pid, port: args.port },
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
    const { kill, restarted, deferredForParkedActivation, attestation } =
      await withCliUpdateContenderContext(
        contenderOptions,
        async (capability, _cliLock, contenderContext) => {
          let killInner: KillConflictingPortOwnerResult | null = null;
          if (args.pid !== null && args.port !== null) {
            ctx.progress({
              stage: "kill-conflicting",
              message: `sending SIGTERM to pid ${args.pid}`,
              percent: null,
              bytes: null,
              totalBytes: null,
              workUnits: null,
            });
            killInner = await killConflictingPortOwner({
              pid: args.pid,
              port: args.port,
              commandName: "host free-port-and-restart",
              verifyMutationCapability: () =>
                requireCliUpdateMutationCapability(
                  capability,
                  contenderOptions,
                ),
            });
            // Thrown from INSIDE the lock, before the restart below. Leaving
            // the lock first would open a window for another actor to act on
            // the state this failure is about, and - far more importantly -
            // reaching the restart at all is the defect: a host restarted onto
            // a port it cannot bind is strictly worse than a host left down,
            // because the restart consumes the supervisor's backoff budget and
            // erases the pid metadata Doctor reads to diagnose the conflict.
            const failure = portRepairFailure({
              result: killInner,
              pid: args.pid,
              port: args.port,
              commandName: "host free-port-and-restart",
              restartWasSkipped: true,
            });
            if (failure !== null) throw failure;
          }
          const controller = createServiceController();
          const restart = contenderContext.recoveryAction === "restart-current";
          // Classified under the same lock acquisition that guards the action
          // below. Refusing beats stopping for a caller whose intent is "make
          // this host reachable again": the port is already freed above, and
          // stopping the service would add a down host to a parked update.
          if (!restart && args.deferIfParked) {
            return {
              kill: killInner,
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
            kill: killInner,
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
    // The kill sentence composes with whichever service action actually ran -
    // a stop-only or deferred outcome must not claim a restart was requested.
    const action = restarted
      ? `restart requested for service '${label.id}'`
      : noRelaunch;
    // Rendered from what actually happened to the signal, matching the sibling
    // `host free-port`. Three distinct paths reach success here:
    //   - no kill requested (`--pid`/`--port` omitted): the service action
    //     above ran alone;
    //   - SIGTERM delivered, port then verified free;
    //   - the signal FAILED and the port was verified free regardless -
    //     `killed` is false, and claiming SIGTERM was sent would describe an
    //     act that did not happen. Worded neutrally rather than as an exit:
    //     `killError` covers ESRCH ("already gone") and EPERM ("still there,
    //     not ours to signal") alike, and EPERM reaching a released port is
    //     reachable when an operator stops a root-owned listener inside the
    //     verification window. The errno is quoted so the reader can tell.
    //
    // "sent SIGTERM to" rather than "terminated" in the second case: the
    // signal is all this command did to the process, and a server that closes
    // its listener while draining connections satisfies the repair without
    // dying. What was verified is in `releaseDetail`.
    const human =
      kill === null
        ? action
        : kill.killed
          ? `sent SIGTERM to pid ${args.pid ?? "?"} (${kill.releaseDetail}); ${action}`
          : `pid ${args.pid ?? "?"} could not be signalled (${kill.killError}); port verified free anyway (${kill.releaseDetail}); ${action}`;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        processName: null,
        // `killed: false` now means only "no kill was requested" (`--pid`
        // omitted). A requested-but-failed kill never reaches this payload -
        // it threw above - which is what makes the exit-0 envelope of this
        // command a trustworthy statement that the port was freed.
        killed: kill?.killed ?? false,
        killError: kill?.killError ?? null,
        release: kill?.release ?? null,
        releaseDetail: kill?.releaseDetail ?? null,
        holderPid: kill?.holderPid ?? null,
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
