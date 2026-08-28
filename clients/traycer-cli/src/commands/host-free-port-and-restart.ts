import {
  killConflictingPortOwner,
  type KillConflictingPortOwnerResult,
} from "../host/free-port-kill";
import { portRepairFailure } from "../host/free-port-outcome";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliLock } from "../store/cli-lock";

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
    const { kill, attestation } = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-free-port-and-restart",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
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
        ctx.progress({
          stage: "service-restart",
          message: `requesting restart for service '${label.id}'`,
          percent: null,
          bytes: null,
          totalBytes: null,
          workUnits: null,
        });
        await createServiceController().restart(label);
        return {
          kill: killInner,
          attestation: await attestInstallRuntime(ctx.runtime.environment),
        };
      },
    );
    // Rendered from what actually happened to the signal, matching the sibling
    // `host free-port`. Three distinct paths reach success here:
    //   - no kill requested (`--pid`/`--port` omitted): a plain restart;
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
        ? `restart requested for service '${label.id}'`
        : kill.killed
          ? `sent SIGTERM to pid ${args.pid ?? "?"} (${kill.releaseDetail}); restart requested for service '${label.id}'`
          : `pid ${args.pid ?? "?"} could not be signalled (${kill.killError}); port verified free anyway (${kill.releaseDetail}); restart requested for service '${label.id}'`;
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
        restartedLabel: label.id,
        installGeneration: attestation.installGeneration,
        runtimeVersion: attestation.runtimeVersion,
        runtimeWasNull: attestation.runtimeWasNull,
      },
      human,
      exitCode: 0,
    };
  };
}
