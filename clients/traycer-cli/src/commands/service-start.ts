import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceStatus,
} from "../service";
import { withCliLock } from "../store/cli-lock";

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
// a command that only promised to start it.
//
// `cli-lock` for the same reason `host stop` takes it: a start must not land
// inside another actor's install/apply critical section and race the process
// that section is about to swap out.
export const serviceStartCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  ctx.runtime.logger.info("Service start command started", {
    environment: ctx.runtime.environment,
  });
  const label = serviceLabelFor(ctx.runtime.environment);
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
      // be gone by the time the start runs, and the refusal below is the one
      // piece of guidance a user acts on.
      const before = await controller.status(label);
      if (before.state === "not-installed") {
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: `host service start: no OS service is registered for environment=${ctx.runtime.environment}; run 'traycer host service install' to register and start it, or 'traycer host ensure' to install the host as well`,
          details: { environment: ctx.runtime.environment, label: label.id },
          exitCode: 1,
        });
      }
      ctx.progress({
        stage: "start",
        message: `starting service '${label.id}'`,
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      });
      // Idempotent by contract on every backend (`launchctl kickstart` of a
      // loaded job, `systemctl --user start` of a running unit, and the
      // Windows task launcher all no-op), matching `host stop`'s own
      // already-stopped behaviour - so an already-running host is reported,
      // never refused.
      //
      // `externally-managed` (macOS, Desktop's SMAppService registration owns
      // the label) is deliberately NOT refused: a registration exists, the
      // user asked for the host to be running, and the macOS backend already
      // redirects the start to the agent label that launchd can actually
      // start. Refusing here would leave the one platform where Desktop is
      // the common setup without a background start.
      await controller.start(label);
      const after = await controller.status(label);
      ctx.runtime.logger.info("Service start command completed", {
        environment: ctx.runtime.environment,
        label: label.id,
        priorState: before.state,
        state: after.state,
      });
      return {
        data: {
          label: label.id,
          environment: label.environment,
          priorState: before.state,
          state: after.state,
          pid: after.pid,
          listenUrl: after.listenUrl,
          version: after.version,
          alreadyRunning: before.state === "running",
        },
        human: humanSummary(label.id, before.state, after),
        exitCode: 0,
      };
    },
  );
};

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
