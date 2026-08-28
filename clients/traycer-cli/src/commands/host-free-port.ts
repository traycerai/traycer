import { killConflictingPortOwner } from "../host/free-port-kill";
import { portRepairFailure } from "../host/free-port-outcome";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// `traycer host free-port --pid <pid> --port <port>` - a kill-only
// sibling of `host free-port-and-restart` (Host Update Layer Redesign
// Tech Plan, "Lifecycle lock coverage"): Doctor's port-conflict repair
// uses this when the supervisor is already going to be restarted through
// a separate `host restart`/`host ensure` step, so a second unconditional
// restart here would be redundant.
//
// STAYS HIDDEN, unlike `free-port-and-restart`, which is now public because
// `host doctor` prints it for a person to type. Nothing prints this spelling
// for a human, and its end state - "port freed, host still down" - is not one
// to hand a user as a repair: on its own it resolves the conflict and leaves
// the machine no more usable than it was. It is a machine-only half-step for
// a caller that owns the restart, and the renderer still confirms process
// identity with the user before dispatching it.
//
// `cli-lock` coverage: the kill AND its post-kill verification execute
// inside a single lock acquisition, so this can never enter another actor's
// apply/install/activation critical section, and nothing can install a new
// host on the port between the SIGTERM and the check that it was released.
//
// SUCCESS MEANS THE PORT WAS FREED. A failed termination used to come back
// as `exitCode: 0` with the reason tucked into a `killError` field, so
// Doctor's port-conflict repair reported success over a conflict it had not
// resolved (audit finding CLI-011). The command now verifies the outcome and
// raises a structured non-zero error - `E_HOST_PORT_KILL_FAILED`,
// `E_HOST_PORT_STILL_HELD`, or `E_HOST_PORT_RELEASE_UNVERIFIED` - for
// anything short of a confirmed release. Desktop's packaged-macOS path
// (`host-controller.ts#freePortAndRestart`) already maps a thrown CLI error
// onto its `failed` outcome, so it now surfaces the real state without
// change; the exit-0 shape was the only thing hiding it.
export interface HostFreePortArgs {
  readonly pid: number;
  readonly port: number;
}

export function buildHostFreePortCommand(args: HostFreePortArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.progress({
      stage: "kill-conflicting",
      message: `sending SIGTERM to pid ${args.pid}`,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    const result = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-free-port",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        killConflictingPortOwner({
          pid: args.pid,
          port: args.port,
          commandName: "host free-port",
        }),
    );
    const failure = portRepairFailure({
      result,
      pid: args.pid,
      port: args.port,
      commandName: "host free-port",
      // This command never restarts, so there is no skipped restart to
      // explain - the caller (`host restart` / `host ensure`) owns that step.
      restartWasSkipped: false,
    });
    if (failure !== null) throw failure;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        killed: result.killed,
        // Retained at `null` on this path rather than dropped: the field is
        // part of the payload Desktop has always read, and every non-null
        // value is now a thrown error instead of a result.
        killError: result.killError,
        release: result.release,
        releaseDetail: result.releaseDetail,
        holderPid: result.holderPid,
      },
      // Rendered from what actually happened to the signal, not from the fact
      // that we reached the success path. Two ways to get here: the SIGTERM was
      // delivered, or it failed and the port turned out to be free regardless.
      // Saying "sent SIGTERM" in the second case describes an act this command
      // did not perform - a small lie, but the same kind the rest of this
      // change exists to remove.
      //
      // The failed-signal wording stays NEUTRAL rather than saying the process
      // exited. `killError` is set for any `process.kill` failure, and the two
      // common ones mean opposite things: ESRCH is "it was already gone",
      // EPERM is "it is still there and we may not signal it". EPERM reaching
      // a released port is reachable - an operator stops a root-owned listener
      // inside the verification window - and announcing an exit there would
      // assert the opposite of what happened. The errno is quoted so the
      // reader can tell which they had.
      //
      // "sent SIGTERM to", not "terminated", in the first case: the signal is
      // all this command did to the process, and a server that closes its
      // listener while draining connections satisfies the repair without
      // dying. The verified claim is the port one, in `releaseDetail`.
      human: result.killed
        ? `sent SIGTERM to pid ${args.pid}; port ${args.port} released (${result.releaseDetail})`
        : `pid ${args.pid} could not be signalled (${result.killError}); port ${args.port} verified free anyway (${result.releaseDetail})`,
      exitCode: 0,
    };
  };
}
