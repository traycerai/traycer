import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { Environment } from "../runner/environment";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { findForegroundHostRun } from "../host/foreground-host-run";
import { clearStopIntent } from "../host/stop-intent";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { stopHostServiceWithAttempt } from "../host/update-mutation";

// `traycer host stop` - asks the OS service manager to stop the
// host. Idempotent: a not-running host resolves cleanly.
//
// `--force`: skip the cooperative shutdown claim and kill the host process
// (SIGTERM, then SIGKILL after the exit grace). The claim exists to protect
// in-flight work, and a busy host denies it indefinitely - any open plain
// terminal tab is enough - so without an explicit escape hatch "stop the
// host to free resources" has no supported path. Force is that consent:
// running sessions and in-flight agent work are killed.
//
// `--if-idle` (hidden, internal - the desktop's automatic quit-time stop in
// Linked and Stop-if-idle modes): after acquiring the lock, probe the host's
// busy state immediately before `controller.stop()`; busy (or not provably
// idle) -> `E_HOST_BUSY` with nothing touched, the stop intent included.
// Plain stop keeps today's per-platform semantics, which are NOT an idle-only
// stop: Linux `systemctl stop`, Windows `schtasks /End` and a CLI-owned macOS
// `launchctl kill` reach the host without asking it. Mutually exclusive with
// `--force` - one flag widens the busy gate, the other removes it, the same
// pairing `host restart` refuses.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal stop must not enter another actor's
// apply/install/activation critical section and kill the process it
// just started - the stop itself executes inside the lock, short-held,
// and linearizes after a foreign holder releases.
/**
 * A plain or `--if-idle` stop asks the SERVICE manager, and a host started by
 * `traycer host start` in a terminal is not the service's: the stop reached
 * nothing, and the command used to print "requested stop for service …" with
 * exit 0 while that host ran on. Checked after the stop, inside the same
 * lock, so what it reports is what the stop actually left running.
 *
 * The stop intent the stop announced is withdrawn first. Left behind, it
 * would tell the foreground supervisor that its child's next exit was asked
 * for, and a crash in the freshness window would not be relaunched.
 */
async function refuseIfForegroundHostSurvived(
  environment: Environment,
): Promise<void> {
  const foreground = await findForegroundHostRun(environment);
  if (foreground === null) return;
  await clearStopIntent(environment);
  throw cliError({
    code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    message: `host stop: the running host was started in a terminal (supervisor pid ${String(foreground.supervisorPid)}) and is not run by the service; stop it there with Ctrl-C, or pass --force`,
    details: {
      supervisorPid: foreground.supervisorPid,
      hostPid: foreground.hostPid,
    },
    exitCode: 1,
  });
}

export interface HostStopArgs {
  readonly force: boolean;
  readonly ifIdle: boolean;
}

export function buildHostStopCommand(args: HostStopArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Validated INSIDE the CommandFn so the runner catches it (CliError ->
    // NDJSON error envelope), and before the lock so a refused invocation
    // contends with nobody.
    if (args.ifIdle && args.force) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host stop: --if-idle and --force are mutually exclusive; pass one or the other",
        details: null,
        exitCode: 1,
      });
    }
    const label = serviceLabelFor(ctx.runtime.environment);
    // ONE options value for acquisition and revalidation: two literals that
    // must stay identical are how admission policies drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-stop",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "service-maintenance",
    };
    await withCliUpdateContender(contenderOptions, async (capability) => {
      await stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        createServiceController(),
        label,
        { force: args.force },
        args.ifIdle ? "if-idle" : "unconditional",
      );
      if (!args.force) {
        await refuseIfForegroundHostSurvived(ctx.runtime.environment);
      }
    });
    return {
      data: { stopped: true, label: label.id, forced: args.force },
      human: args.force
        ? `force-stopped service '${label.id}'`
        : `requested stop for service '${label.id}'`,
      exitCode: 0,
    };
  };
}
