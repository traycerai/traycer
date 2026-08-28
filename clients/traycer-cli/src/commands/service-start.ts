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
import { readHostPidMetadata } from "../host/pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";

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
 * Is the process pid metadata names actually the one that published it?
 *
 * `dead` / `mismatch` (a recycled pid) and an unreadable record all answer
 * "no", so the caller starts the service rather than trusting a `running`
 * status derived from a bare liveness check. An indeterminate OS probe also
 * answers "no": attempting a start that turns out to be unnecessary is
 * recoverable, leaving a stopped host down is not.
 */
async function isPublishedHostCurrent(
  environment: Environment,
): Promise<boolean> {
  try {
    const metadata = await readHostPidMetadata(environment);
    if (metadata === null) return false;
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) return false;
    const verdict = await getPublishedProcessIdentityVerdict(
      metadata.pid,
      metadata.processStartIdentity,
    );
    return verdict === "current";
  } catch {
    return false;
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
      // ADVISORY, not a gate. On Windows `statusService` maps every
      // `schtasks /Query` failure - a timeout, a transient access denial - to
      // `not-installed`, so refusing on it meant a genuinely registered
      // service could not be started whenever the preliminary query happened
      // to fail. The platform start is the authoritative attempt; this read
      // only decides what to SAY when that attempt fails.
      const before = await controller.status(label);
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
      // `running` is not enough on its own. Every platform's `statusService`
      // derives it from `isProcessAlive(pid)` over pid metadata, so stale
      // metadata naming a RECYCLED pid - or an indeterminate OS probe - reports
      // a running host that is not there. Skipping the start on that leaves a
      // genuinely stopped host down until someone repairs the metadata, which
      // is the opposite of what this command was asked to do. Confirm the
      // recorded process is the one that published before taking the shortcut.
      const runningConfirmed =
        before.state === "running" &&
        (await isPublishedHostCurrent(environment));
      if (runningConfirmed) {
        ctx.runtime.logger.info("Service start command found a running host", {
          environment: ctx.runtime.environment,
          label: label.id,
        });
        return {
          data: startData(label, before.state, before, true),
          human: humanSummary(label.id, before.state, before),
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
        if (before.state === "not-installed") {
          throw cliError({
            code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
            message: `host service start: could not start the service, and no OS service appears to be registered for environment=${ctx.runtime.environment}; run 'traycer host service install' to register and start it, or 'traycer host ensure' to install the host as well (start failed: ${cause instanceof Error ? cause.message : String(cause)})`,
            details: { environment: ctx.runtime.environment, label: label.id },
            exitCode: 1,
          });
        }
        throw cause;
      }
      const after = await controller.status(label);
      ctx.runtime.logger.info("Service start command completed", {
        environment: ctx.runtime.environment,
        label: label.id,
        priorState: before.state,
        state: after.state,
      });
      return {
        data: startData(label, before.state, after, false),
        human: humanSummary(label.id, before.state, after),
        exitCode: 0,
      };
    },
  );
};

function startData(
  label: ServiceLabel,
  priorState: ServiceStatus["state"],
  observed: ServiceStatus,
  alreadyRunning: boolean,
): Record<string, unknown> {
  return {
    label: label.id,
    environment: label.environment,
    priorState,
    state: observed.state,
    pid: observed.pid,
    listenUrl: observed.listenUrl,
    version: observed.version,
    alreadyRunning,
  };
}

function humanSummary(
  labelId: string,
  priorState: ServiceStatus["state"],
  after: ServiceStatus,
): string {
  if (priorState === "running") {
    return `service '${labelId}' was already running${after.pid === null ? "" : ` (pid ${after.pid})`}`;
  }
  // "requested", not "started": every backend returns once the service
  // manager has ACCEPTED the launch, and a job that is registered but
  // unspawnable still reports success there. `host status` is the honest
  // readiness check, so point at it rather than overclaiming here.
  return after.state === "running"
    ? `started service '${labelId}'${after.pid === null ? "" : ` (pid ${after.pid})`}`
    : `requested start for service '${labelId}'; run 'traycer host status' to confirm the host came up`;
}
