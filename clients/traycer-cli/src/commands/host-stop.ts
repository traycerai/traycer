import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { Environment } from "../runner/environment";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import {
  findForegroundHostRun,
  foregroundRunRefusal,
  refuseForegroundHostRun,
} from "../host/foreground-host-run";
import type { HostStartOrigin } from "../host/lifecycle-origin";
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
// Plain stop keeps the per-platform semantics, which are NOT an idle-only
// stop: Linux `systemctl stop` and a CLI-owned macOS `launchctl kill` reach
// the host without asking it. Windows and a Desktop-managed macOS host ask it
// to stand down first, and a host that answers busy refuses the stop with
// `E_HOST_BUSY`, but only at the moment of the ask and with no probe of its
// own. Mutually exclusive with `--force` - one flag widens the busy gate, the
// other removes it, the same pairing `host restart` refuses.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal stop must not enter another actor's
// apply/install/activation critical section and kill the process it
// just started - the stop itself executes inside the lock, short-held,
// and linearizes after a foreign holder releases.
//
// A host started by `traycer host start` in a terminal (a `foreground` run)
// is not the service's, and this command leaves it alone unless a person at
// a terminal says otherwise:
// - A plain or `--if-idle` stop asks the service manager, which does not own
//   that host, so it is refused FIRST inside the lock - before the busy
//   probe, the stop intent, `controller.stop()` or any kill. Not after: the
//   service stop is not harmless to it - Windows' tree kill matches the slot's
//   install path the terminal host runs from, and the `--if-idle` busy probe
//   dials the terminal host itself, whose `E_HOST_BUSY` the desktop's Linked
//   quit answers with `--force`.
// - A DESKTOP-origin stop is refused first under `--force` too: the app's quit
//   or crash never tears down a terminal-started host, and a force sent from
//   the app's quit modal is still the app's quit. The desktop reads
//   `E_HOST_NOT_SERVICE_RUN` as `not-service-run` and quits with the host kept.
// - A terminal `--force` is the person's explicit act and kills it directly.
//
// The check before the stop writes nothing, so a refusal there leaves every
// file - a stop intent another actor wrote included - exactly as it was.
/**
 * The same refusal, checked again AFTER a plain or `--if-idle` stop, inside
 * the same lock. The lock admits no new spawn while it is held (every host
 * spawn is admitted under this update-attempt lock), so the first check's
 * answer normally stands; this one covers a foreground run the first check
 * could not yet confirm - a host still coming up, an endpoint that did not
 * answer - and the service stop did not end. What this command reports is
 * what the stop actually left running.
 *
 * Only here is a stop intent withdrawn: the one this stop announced, inside
 * this lock. Left behind, it would tell the foreground supervisor that its
 * child's next exit was asked for, and a crash in the freshness window would
 * not be relaunched.
 */
async function refuseIfForegroundHostSurvived(
  environment: Environment,
  origin: HostStartOrigin,
): Promise<void> {
  const foreground = await findForegroundHostRun(environment);
  if (foreground === null) return;
  await clearStopIntent(environment);
  throw foregroundRunRefusal("host stop", foreground, origin);
}

export interface HostStopArgs {
  readonly force: boolean;
  readonly ifIdle: boolean;
  /** Who asked: `desktop` for every stop the app issues. */
  readonly lifecycleOrigin: HostStartOrigin;
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
      if (!args.force || args.lifecycleOrigin === "desktop") {
        await refuseForegroundHostRun(
          "host stop",
          ctx.runtime.environment,
          args.lifecycleOrigin,
        );
      }
      await stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        createServiceController(),
        label,
        { force: args.force },
        args.ifIdle ? "if-idle" : "unconditional",
      );
      if (!args.force) {
        await refuseIfForegroundHostSurvived(
          ctx.runtime.environment,
          args.lifecycleOrigin,
        );
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
