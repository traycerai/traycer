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

  // A VERIFIED REPLACEMENT HOLDER OUTRANKS THE SIGNAL ERROR, and the order
  // here is the whole point.
  //
  // These two conditions co-occur in the ESRCH race: the original owner exits
  // between the ownership probe and the SIGTERM (so `killError` is set) while
  // a supervisor has already replaced it (so verification identified a
  // different holder). Checking `killError` first - as this did - emitted
  // "could not terminate pid <original>, terminate it yourself", naming a
  // process that is already gone and silently discarding the one piece of
  // evidence that could act on: the pid actually holding the port now.
  //
  // The signal error is still reported in `details.killError`; it is simply
  // not the most useful thing to say when we know who holds the port.
  const replacementHolder =
    result.holderPid !== null && result.holderPid !== pid
      ? result.holderPid
      : null;
  if (replacementHolder !== null) {
    return replacementHolderError({
      commandName,
      pid,
      port,
      replacementHolder,
      releaseDetail: result.releaseDetail,
      restartNote,
      details,
    });
  }

  // AN UNVERIFIED PORT OUTRANKS THE SIGNAL ERROR, for the same reason the
  // replacement holder does: it is the more accurate statement about the thing
  // the caller has to act on.
  //
  // The combination is reachable - the owner exits just before the SIGTERM
  // (ESRCH) and the follow-up probe is then unavailable or times out, leaving
  // no holder. Checking `killError` first told the user to terminate the
  // already-dead original pid and threw away the probe-specific recovery,
  // which is the only advice that could change the next result. Saying "we
  // could not determine whether the port is free" is both true and useful; the
  // signal's fate rides along in the message and in `details.killError`.
  if (result.release === "unverified") {
    // The probe advice has to name the probe this platform actually runs.
    // `pidOwnsPort` dispatches on `process.platform`: Windows never invokes
    // `lsof`, so telling a Windows user to install it cannot change the next
    // result and leaves the repair stuck with a recovery that reads as
    // actionable and is not.
    const probeAdvice =
      process.platform === "win32"
        ? " Re-run 'traycer host doctor' to re-check the port; if it keeps failing, check that 'netstat -ano' runs and returns output for this user, since that is what verifies ownership here."
        : " Re-run 'traycer host doctor' to re-check the port; if the probe keeps failing, install 'lsof' so ownership can be verified.";
    return cliError({
      code: CLI_ERROR_CODES.HOST_PORT_RELEASE_UNVERIFIED,
      message:
        (result.killError === null
          ? `${commandName}: signalled pid ${pid}, but could not confirm that port ${port} was released - ${result.releaseDetail}. `
          : `${commandName}: pid ${pid} could not be signalled (${result.killError}) and it could not be confirmed whether port ${port} is free - ${result.releaseDetail}. `) +
        "Treating an unverifiable repair as successful is how a port conflict gets reported as fixed while it is still live, so this is a failure." +
        restartNote +
        probeAdvice,
      details,
      exitCode: 1,
    });
  }

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

// The replacement-listener message, shared by the two orderings that reach it
// (a delivered SIGTERM whose target was replaced, and the ESRCH race where the
// target had already exited). Split out so both cases give byte-identical
// guidance: the reader's situation is the same either way, and only the
// signal's own fate differs - which is what `details.killError` is for.
function replacementHolderError(opts: {
  readonly commandName: string;
  readonly pid: number;
  readonly port: number;
  readonly replacementHolder: number;
  readonly releaseDetail: string;
  readonly restartNote: string;
  readonly details: Record<string, unknown>;
}): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_PORT_STILL_HELD,
    message:
      `${opts.commandName}: pid ${opts.pid} no longer holds port ${opts.port}, but pid ${opts.replacementHolder} is now listening on it - ${opts.releaseDetail}.` +
      opts.restartNote +
      ` The port is still occupied, so the conflict is unresolved. pid ${opts.replacementHolder} is most likely a supervised process being restarted automatically ` +
      "(killing it by hand will just produce another one) - stop whatever supervises it, or reconfigure that service off this port, then re-run 'traycer host doctor'.",
    details: opts.details,
    exitCode: 1,
  });
}
