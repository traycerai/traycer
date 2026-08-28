import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceLabel,
  type ServiceStatus,
} from "../service";
import { withCliLock } from "../store/cli-lock";
import type { Environment } from "../runner/environment";
import type { ILogger } from "../logger";
import { findLiveIncumbentHost } from "../host/incumbent-check";

// `traycer host service start` - ask the OS service manager to start the
// already-registered host in the BACKGROUND and return.
//
// This is the public counterpart to `host stop`, and the answer to the verb
// `host start` does not provide: that command is the long-running foreground
// supervisor every registered service definition executes, so it blocks for
// the life of the host and cannot also mean "start it in the background".
// Renaming it is not available - launchd plists, systemd units and Windows
// Scheduled Tasks already on machines invoke a CLI slot that is replaced
// independently of the definition, so a definition written a year ago must
// keep working against today's binary (see `service/platforms/*`, and
// `host-lifecycle/identity.ts`, which ATTESTS a registration by its
// `host start` tail). Adding the missing action beside `service
// install/status/uninstall` is the change that costs no compatibility.
//
// Registration is a prerequisite, not something this command creates: a
// machine with no service registered is told to run `host service install`
// (which registers AND starts) rather than having one silently registered by
// a command that only promised to start it. That guidance is attached to a
// FAILED start rather than gating the attempt - see the status read below.
//
// `cli-lock` for the same reason `host stop` takes it: a start must not land
// inside another actor's install/apply critical section and race the process
// that section is about to swap out.
/**
 * Is a host POSITIVELY serving right now?
 *
 * `findLiveIncumbentHost` is exactly the right instrument for this direction,
 * and using it here is not in tension with `host uninstall` refusing it: there
 * the question was "did the process DIE?", which its documented bias toward
 * `null` cannot answer. Here the question is "is one alive?", which is what it
 * positively establishes - something answers the recorded loopback endpoint,
 * and identity has not refuted it as a recycled-pid impostor.
 *
 * A bare identity verdict is NOT enough. `processStartIdentity` is nullable,
 * so an older live host's metadata yields `indeterminate` - and rejecting the
 * shortcut on that made `host service start` fail against a perfectly healthy
 * legacy host on Windows, where `MultipleInstancesPolicy=IgnoreNew` suppresses
 * the redundant `/Run` and `runTaskAndVerifyStart` then waits out its whole
 * verification timeout looking for spawn evidence that can never arrive.
 */
async function isHostPositivelyServing(
  environment: Environment,
): Promise<boolean> {
  try {
    return (await findLiveIncumbentHost(environment)) !== null;
  } catch {
    return false;
  }
}

/**
 * Never lets a descriptive probe decide the command's outcome - but does not
 * swallow it silently either: a status read that fails changes what this
 * command can SAY, and an operator debugging a confusing message needs to know
 * the probe is why.
 */
async function statusBestEffort(
  controller: { status(label: ServiceLabel): Promise<ServiceStatus> },
  label: ServiceLabel,
  logger: ILogger,
  phase: "pre-start" | "post-start",
): Promise<ServiceStatus | null> {
  try {
    return await controller.status(label);
  } catch (err) {
    logger.warn("Service start could not read the service status", {
      environment: label.environment,
      label: label.id,
      phase,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const serviceStartCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  ctx.runtime.logger.info("Service start command started", {
    environment: ctx.runtime.environment,
  });
  const environment = ctx.runtime.environment;
  const label = serviceLabelFor(environment);
  const controller = createServiceController();
  return withCliLock(
    {
      environment: ctx.runtime.environment,
      reason: "service-start",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      // Read INSIDE the lock: a registration observed before acquiring it can
      // be gone by the time the start runs.
      //
      // ADVISORY and BEST-EFFORT, not a gate. On Windows `statusService` maps
      // every `schtasks /Query` failure - a timeout, a transient access denial
      // - to `not-installed`, and a Linux manifest stat or a macOS
      // `launchctl print` can simply fail. Neither may stop the authoritative
      // start attempt: that would leave a registered, stopped host down
      // because an INSPECTION failed. This read only decides what to SAY.
      const before = await statusBestEffort(
        controller,
        label,
        ctx.runtime.logger,
        "pre-start",
      );
      // Already running: report it and touch NOTHING. The platform start is
      // skipped deliberately rather than relied on to no-op, because on
      // Windows it does not. The Scheduled Task is registered
      // `MultipleInstancesPolicy=IgnoreNew`, so `schtasks /Run` against a
      // live task is suppressed - and `runTaskAndVerifyStart` requires
      // POST-BASELINE spawn evidence before it will call the start a success.
      // Suppressed run plus no new evidence means it polls for the whole
      // verify timeout and then throws `E_SERVICE_CONTROL_FAILED`, so
      // "start an already-running host" would have been a slow hard failure
      // on Windows instead of the idempotent no-op this command advertises.
      // launchctl kickstart and `systemctl --user start` genuinely do no-op,
      // so returning early costs those platforms nothing and gives all three
      // one answer.
      //
      // `running` alone is not enough, twice over. It is derived from
      // `isProcessAlive(pid)` over pid metadata, so stale metadata naming a
      // RECYCLED pid reports a host that is not there - hence the positive
      // liveness confirmation. And even confirmed, it cannot attribute the
      // process to the service manager; the summary says so rather than
      // claiming the service was already running.
      const runningConfirmed =
        before?.state === "running" &&
        (await isHostPositivelyServing(environment));
      if (runningConfirmed) {
        ctx.runtime.logger.info("Service start command found a running host", {
          environment: ctx.runtime.environment,
          label: label.id,
        });
        return {
          data: startData(label, "running", before, true),
          human: humanSummary(label.id, true, before),
          exitCode: 0,
        };
      }

      ctx.progress({
        stage: "start",
        message: `starting service '${label.id}'`,
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      });
      // `externally-managed` (macOS, Desktop's SMAppService registration owns
      // the label) is deliberately NOT refused: a registration exists, the
      // user asked for the host to be running, and the macOS backend already
      // redirects the start to the agent label that launchd can actually
      // start. Refusing here would leave the one platform where Desktop is
      // the common setup without a background start.
      try {
        await controller.start(label);
      } catch (cause) {
        // The start failed AND the earlier read said nothing was registered:
        // that combination is what "you have no service" actually looks like,
        // so attach the actionable guidance here rather than refusing up
        // front on a read that cannot be trusted to mean it.
        if (before?.state === "not-installed") {
          throw cliError({
            code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
            message: `host service start: could not start the service, and no OS service appears to be registered for environment=${ctx.runtime.environment}; run 'traycer host service install' to register and start it, or 'traycer host ensure' to install the host as well (start failed: ${cause instanceof Error ? cause.message : String(cause)})`,
            details: { environment: ctx.runtime.environment, label: label.id },
            exitCode: 1,
          });
        }
        throw cause;
      }
      // Also best-effort: the start was ACCEPTED, and a descriptive readback
      // that fails afterwards must not turn that into a nonzero result. This
      // command promises an accepted request, not readiness.
      const after = await statusBestEffort(
        controller,
        label,
        ctx.runtime.logger,
        "post-start",
      );
      ctx.runtime.logger.info("Service start command completed", {
        environment: ctx.runtime.environment,
        label: label.id,
        priorState: before?.state ?? null,
        state: after?.state ?? null,
      });
      return {
        data: startData(label, before?.state ?? null, after, false),
        human: humanSummary(label.id, false, after),
        exitCode: 0,
      };
    },
  );
};

function startData(
  label: ServiceLabel,
  priorState: ServiceStatus["state"] | null,
  observed: ServiceStatus | null,
  alreadyRunning: boolean,
): Record<string, unknown> {
  return {
    label: label.id,
    environment: label.environment,
    priorState,
    state: observed?.state ?? null,
    pid: observed?.pid ?? null,
    listenUrl: observed?.listenUrl ?? null,
    version: observed?.version ?? null,
    alreadyRunning,
  };
}

function humanSummary(
  labelId: string,
  // The CONFIRMED decision, not the prior state it was derived from. A
  // `running` status that identity refused still starts the service, and
  // saying "was already running" there contradicted both the action taken and
  // the `alreadyRunning: false` in the same payload.
  alreadyRunning: boolean,
  after: ServiceStatus | null,
): string {
  const pid = after?.pid ?? null;
  if (alreadyRunning) {
    // Deliberately says "a host", not "the service". Nothing here can attribute
    // the running process to the SERVICE MANAGER: Linux and Windows both derive
    // `running` from the environment's shared pid metadata plus
    // `isProcessAlive`, so a foreground `traycer host start` in another
    // terminal satisfies it while the registration sits inactive. Claiming the
    // service was already running there would report success for a background
    // start that never happened, and the host would disappear when that
    // terminal closed.
    return `a host is already serving this environment${pid === null ? "" : ` (pid ${pid})`}, so no start was requested. If you started it with 'traycer host start' in a terminal, the background service is NOT running - stop it, then run this again`;
  }
  // "requested", not "started": every backend returns once the service
  // manager has ACCEPTED the launch, and a job that is registered but
  // unspawnable still reports success there. `host status` is the honest
  // readiness check, so point at it rather than overclaiming here.
  // "requested ... and a host is now serving", never "started the service".
  // The post-start readback has the same blind spot as the shortcut above:
  // Linux and Windows derive `running` from shared pid metadata, so it can be
  // observing a FOREGROUND host while this service's supervisor exited after
  // finding that incumbent. What is genuinely known is that the start was
  // accepted and that something is answering.
  return after?.state === "running"
    ? `requested start for service '${labelId}'; a host is now serving${pid === null ? "" : ` (pid ${pid})`}`
    : `requested start for service '${labelId}'; run 'traycer host status' to confirm the host came up`;
}
