import type { KillConflictingPortOwnerResult } from "./free-port-kill";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";

// Shared failure shaping for the two port-conflict repairs (`host free-port`
// and `host free-port-and-restart`).
//
// Both commands used to return `exitCode: 0` whenever `killConflictingPortOwner`
// came back with a `killError`, demoting a failed repair to a warning string
// inside a success envelope; `free-port-and-restart` additionally restarted
// the host while the foreign listener was still bound. Doctor and Desktop
// could therefore report a completed port-conflict repair over a conflict
// that was never resolved (audit finding CLI-011).
//
// The shaping lives here rather than in either command because the two must
// not drift: they are the same repair, and Desktop picks between them purely
// on whether it is also driving the restart itself
// (`host-controller.ts#freePortAndRestart`). One place to change means one
// contract for both, and one set of codes for callers to switch on.

// Maps a non-`released` verification verdict onto the structured CLI error
// that ends the command. Returns `null` when the repair genuinely succeeded,
// so callers read as `const failure = portRepairFailure(...); if (failure !== null) throw failure;`.
//
// Every message names the pid and port, states what was and was not achieved,
// and ends with something the reader can do. `host free-port-and-restart` is a
// documented public command whose exact invocation `host doctor` prints for
// people to copy, so these strings have a human audience, not just Desktop's
// error toast.
export function portRepairFailure(opts: {
  readonly result: KillConflictingPortOwnerResult;
  readonly pid: number;
  readonly port: number;
  readonly commandName: string;
  // Whether the caller would have restarted the host after a successful
  // repair. Only affects copy: the reader needs to know the restart did NOT
  // happen, because the previous behaviour was to restart regardless and the
  // difference is the whole point of the fix.
  readonly restartWasSkipped: boolean;
}): CliError | null {
  const { result, pid, port, commandName } = opts;
  if (result.release === "released") return null;

  const restartNote = opts.restartWasSkipped
    ? " The host was NOT restarted: restarting it into a port another process still holds would fail to bind and leave the host down, while reporting the conflict as repaired."
    : "";
  const details = {
    pid,
    port,
    killed: result.killed,
    killError: result.killError,
    release: result.release,
    releaseDetail: result.releaseDetail,
    holderPid: result.holderPid,
    restartSkipped: opts.restartWasSkipped,
  };

  if (result.killError !== null) {
    return cliError({
      code: CLI_ERROR_CODES.HOST_PORT_KILL_FAILED,
      message:
        `${commandName}: could not terminate pid ${pid} holding port ${port}: ${result.killError}. ` +
        "The port conflict is unresolved." +
        restartNote +
        ` Terminate pid ${pid} yourself (it may belong to another user, in which case this needs elevated privileges) and re-run 'traycer host doctor'.`,
      details,
      exitCode: 1,
    });
  }

  if (result.release === "unverified") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_PORT_RELEASE_UNVERIFIED,
      message:
        `${commandName}: sent SIGTERM to pid ${pid}, but could not confirm that port ${port} was released - ${result.releaseDetail}. ` +
        "Treating an unverifiable repair as successful is how a port conflict gets reported as fixed while it is still live, so this is a failure." +
        restartNote +
        " Re-run 'traycer host doctor' to re-check the port; if the probe keeps failing, install 'lsof' (POSIX) so ownership can be verified.",
      details,
      exitCode: 1,
    });
  }

  return cliError({
    code: CLI_ERROR_CODES.HOST_PORT_STILL_HELD,
    message:
      `${commandName}: pid ${pid} ignored SIGTERM and still holds port ${port} - ${result.releaseDetail}.` +
      restartNote +
      ` Stop pid ${pid} yourself (it is trapping or ignoring SIGTERM, so it needs a stronger signal or its own shutdown command), then re-run 'traycer host doctor'.`,
    details,
    exitCode: 1,
  });
}
