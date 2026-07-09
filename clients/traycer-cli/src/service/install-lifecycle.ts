import type { InstallHostLifecycle } from "../installer";
import { resolveServiceCliInvocation } from "./cli-binary";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
  type ServiceState,
} from "./index";
import type { Environment } from "../runner/environment";

// State captured by the lifecycle hooks so the command can render an
// accurate `serviceLifecycle` block in its result.
//
//   - `priorState` - the service state observed *before* the swap.
//     `not-installed` means the bootstrap path: depending on the
//     lifecycle's `bootstrap` option we either register the service
//     post-swap (Core Flow 1 / Flow 7 - `host install` on a clean
//     machine) or skip touching the service (`host update`, which
//     assumes the service is already there).
//   - `stoppedBeforeSwap` - true iff we issued `controller.stop()`
//     because the service was running. Used to decide between
//     `restart` (was running) and `start` (was registered+stopped)
//     after the swap.
//   - `postSwapAction` - what we actually attempted after the swap.
//     `restart` if the host was running, `start` if it was
//     registered+stopped, `install` if we bootstrapped a fresh
//     registration, `none` if not registered and bootstrap was off.
//   - `postSwapError` - non-null iff the post-swap start/restart/install
//     threw. Per the Tech Plan we do NOT rollback in this case; the
//     new host stays installed and the operator is steered toward
//     `traycer host doctor`.
export interface ServiceInstallLifecycleState {
  priorState: ServiceState;
  stoppedBeforeSwap: boolean;
  postSwapAction: "restart" | "start" | "install" | "none";
  postSwapError: string | null;
}

export interface ServiceInstallLifecycleHandle {
  readonly state: ServiceInstallLifecycleState;
  readonly lifecycle: InstallHostLifecycle;
}

// Opt-in payload for bootstrapping the OS service when there is no
// prior registration. `host install` passes this so a clean machine
// (Core Flow 1) ends with a registered, running host without an
// extra `traycer host service install` step. `host update` leaves it
// null - an update implies the service should already be wired up.
export interface BootstrapServiceOptions {
  // Whether to attempt `loginctl enable-linger $USER` on Linux. Mirrors
  // `service install --no-linger` (negated).
  readonly enableLinger: boolean;
  // When true and no CLI manifest is available, register the service
  // against the running process. Used by the dev orchestrator and
  // local-file installs before the packaged CLI is on disk.
  readonly allowSelfInvocation: boolean;
}

export interface CreateServiceInstallLifecycleOptions {
  readonly environment: Environment;
  // When non-null, the lifecycle will register and start the OS
  // service after a successful swap if `priorState === "not-installed"`.
  // When null, the lifecycle leaves an unregistered service alone
  // (legacy `host update` behaviour).
  readonly bootstrap: BootstrapServiceOptions | null;
}

// Build the lifecycle hooks `installHost` needs to keep the OS
// service in sync with the install dir swap. The returned `state` is
// mutated by the hooks; the command reads it after `installHost`
// resolves to populate its result payload.
export function createServiceInstallLifecycle(
  options: CreateServiceInstallLifecycleOptions,
): ServiceInstallLifecycleHandle {
  const controller = createServiceController();
  const label = serviceLabelFor(options.environment);
  const state: ServiceInstallLifecycleState = {
    priorState: "not-installed",
    stoppedBeforeSwap: false,
    postSwapAction: "none",
    postSwapError: null,
  };
  const lifecycle: InstallHostLifecycle = {
    beforeSwap: async () => {
      const status = await controller.status(label);
      state.priorState = status.state;
      // Only stop a host we actually saw running. A
      // registered-but-stopped service has no process to evict, and
      // `not-installed` means there's no service to talk to at all -
      // we'll register it post-swap if bootstrap was requested. Windows is
      // the exception: its stop also force-kills stray host processes whose
      // open handles inside the install dir would fail the swap rename, so
      // it runs even when the service wasn't observed running.
      if (status.state === "running" || process.platform === "win32") {
        await controller.stop(label);
        state.stoppedBeforeSwap = true;
      }
    },
    afterSwap: async () => {
      if (state.priorState === "not-installed") {
        if (options.bootstrap === null) {
          // Update / non-bootstrap callers leave registration to the
          // operator (`traycer host service install`).
          state.postSwapAction = "none";
          return;
        }
        state.postSwapAction = "install";
        try {
          await registerService({
            controller,
            label,
            environment: options.environment,
            bootstrap: options.bootstrap,
          });
        } catch (cause) {
          // No rollback - the new host stays in place. The command
          // surfaces this as a warning and steers the user toward
          // `traycer host doctor` / `traycer host service install`
          // for recovery.
          state.postSwapError =
            cause instanceof Error ? cause.message : String(cause);
        }
        return;
      }
      const action: "restart" | "start" =
        state.priorState === "running" ? "restart" : "start";
      state.postSwapAction = action;
      try {
        await invokeServiceAction(controller, label, action);
      } catch (cause) {
        // No rollback. New host is in place; surface the failure
        // so the command can warn the user and Doctor can flag it.
        state.postSwapError =
          cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
  return { state, lifecycle };
}

interface RegisterServiceOptions {
  readonly controller: ServiceController;
  readonly label: ServiceLabel;
  readonly environment: Environment;
  readonly bootstrap: BootstrapServiceOptions;
}

async function registerService(opts: RegisterServiceOptions): Promise<void> {
  // CLI invocation resolution happens here (post-swap) so an unresolvable
  // path becomes a `postSwapError` rather than rolling back a successful
  // host install. Doctor + `traycer host service install` are the recovery
  // paths.
  const cli = await resolveServiceCliInvocation({
    environment: opts.environment,
    override: null,
    allowSelfInvocation: opts.bootstrap.allowSelfInvocation,
  });
  // `ServiceController.install` writes the manifest, registers with the
  // OS service manager, and starts the host - matching Core Flow 1
  // / Flow 7 expectations that first-launch ends with a running host.
  await opts.controller.install({
    label: opts.label,
    cli,
    enableLinger: opts.bootstrap.enableLinger,
  });
}

async function invokeServiceAction(
  controller: ServiceController,
  label: ServiceLabel,
  action: "restart" | "start",
): Promise<void> {
  if (action === "restart") {
    await controller.restart(label);
    return;
  }
  await controller.start(label);
}
