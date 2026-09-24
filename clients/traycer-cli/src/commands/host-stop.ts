import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
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
    await withCliUpdateContender(contenderOptions, (capability) =>
      stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        createServiceController(),
        label,
        { force: args.force },
        args.ifIdle ? "if-idle" : "unconditional",
      ),
    );
    return {
      data: { stopped: true, label: label.id, forced: args.force },
      human: args.force
        ? `force-stopped service '${label.id}'`
        : `requested stop for service '${label.id}'`,
      exitCode: 0,
    };
  };
}
