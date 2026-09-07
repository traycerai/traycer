import type { InstallHostLifecycle, SwapLockRecovery } from "../installer";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { resolveServiceCliInvocation, type CliInvocation } from "./cli-binary";
import { didServiceRegistrationCommit } from "./cli-invocation-record";
import { isSelfNamingCliInvocation } from "./cli-invocation-shape";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
  type ServiceState,
} from "./index";
import { readRegisteredCliInvocation } from "./platforms/macos";
import {
  describeSlotLockHolders,
  epochMicrosNow,
  killLingeringSlotProcesses,
} from "./platforms/windows";
import type { Environment } from "../runner/environment";
import {
  isServiceMutationAuthorityError,
  withServiceMutationAuthority,
} from "./mutation-authority";
import type { HostStartAdoptionPublisher } from "../host/host-start-adoption";

// Windows only: the pre-swap stop kills every process the slot scan can see, but a handle it cannot (an orphaned child whose CWD is inside `install/`, an AV scan) still fails the swap rename with EBUSY.
// This seam lets the installer re-kill between rename attempts and, when the retries exhaust anyway, name the processes still matching the slot in the error it throws.
function swapLockRecoveryFor(label: ServiceLabel): SwapLockRecovery | null {
  if (process.platform !== "win32") return null;
  return {
    killLingeringProcesses: () =>
      killLingeringSlotProcesses(label, null, { now: epochMicrosNow }),
    describeLockHolders: () => describeSlotLockHolders(label, null),
  };
}

// Lifecycle hook state so the command can render an applied-but-not-converged outcome as success.
export interface ServiceInstallLifecycleState {
  priorState: ServiceState;
  stoppedBeforeSwap: boolean;
  // `install` (manifest rewrite + re-register) for CLI-owned registrations - plain start/restart there was removed deliberately (macOS kickstart runs launchd's cached definition and would leave a regenerated plist stale).
  // `start` is used ONLY on the Desktop-managed path: the agent label's definition lives in the app bundle and a host-bytes swap does not change it, so kickstarting it after the swap runs the current definition on the new bytes.
  postSwapAction: "start" | "install" | "none";
  postSwapError: string | null;
}

export interface ServiceInstallLifecycleHandle {
  readonly state: ServiceInstallLifecycleState;
  readonly lifecycle: InstallHostLifecycle;
}

// Opt-in payload for bootstrapping the OS service when there is no prior registration.
// `host install` passes this so a clean machine (Core Flow 1) ends with a registered, running host without an extra `traycer host service install` step.
export interface BootstrapServiceOptions {
  // Whether to attempt `loginctl enable-linger $USER` on Linux. Mirrors
  // `service install --no-linger` (negated).
  readonly enableLinger: boolean;
  // When true and no CLI manifest is available, register the service against the running process.
  // Used by the dev orchestrator and local-file installs before the packaged CLI is on disk.
  readonly allowSelfInvocation: boolean;
}

export interface CreateServiceInstallLifecycleOptions {
  readonly environment: Environment;
  // When non-null, the lifecycle will register and start the OS service after a successful swap if `priorState === "not-installed"`.
  // When null, the lifecycle leaves an unregistered service alone (legacy `host update` behaviour).
  readonly bootstrap: BootstrapServiceOptions | null;
  // Forwarded to the pre-swap `controller.stop`.
  // `false` keeps the cooperative contract: a busy host denies the shutdown claim and the install aborts with `E_HOST_BUSY` before anything is touched.
  readonly force: boolean;
}

// Build the lifecycle hooks `installHost` needs to keep the OS service in sync with the install dir swap.
// The returned `state` is mutated by the hooks; the command reads it after `installHost` resolves to populate its result payload.
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
  let verifyMutationCapability = async (): Promise<void> => {};
  let publishHostStartAdoption: HostStartAdoptionPublisher = async () => {};
  const lifecycle: InstallHostLifecycle = {
    swapLockRecovery: swapLockRecoveryFor(label),
    setMutationVerifier: (verify) => {
      verifyMutationCapability = verify;
    },
    setHostStartAdoptionPublisher: (publish) => {
      publishHostStartAdoption = publish;
    },
    beforeSwap: async () => {
      const status = await controller.status(label);
      state.priorState = status.state;
      // Only stop a host we actually saw running.
      // A registered-but-stopped service has no process to evict, and `not-installed` means there's no service to talk to at all - we'll register it post-swap if bootstrap was requested.
      if (status.state === "running" || process.platform === "win32") {
        await withServiceMutationAuthority(verifyMutationCapability, () =>
          controller.stop(label, { force: options.force }),
        );
        state.stoppedBeforeSwap = true;
        return;
      }
      // Desktop-managed macOS machines report `externally-managed` even while a host is live underneath.
      // This used to skip the stop silently - the install printed "stopping service", swapped under the running host, and the new bytes went live only at Desktop's next register cycle, which users reasonably read as "the install fixed it".
      if (
        status.state === "externally-managed" &&
        process.platform === "darwin"
      ) {
        try {
          await withServiceMutationAuthority(verifyMutationCapability, () =>
            controller.stop(label, { force: options.force }),
          );
          state.stoppedBeforeSwap = true;
        } catch (cause) {
          if (isServiceMutationAuthorityError(cause)) throw cause;
          if (
            cause instanceof CliError &&
            cause.code === CLI_ERROR_CODES.HOST_BUSY
          ) {
            throw cause;
          }
          createCliLogger(options.environment).warn(
            "Stopping the Desktop-managed host was unavailable; swapping the install anyway (the post-swap kickstart starts a stopped host; a live one picks the new bytes up at its next restart).",
            {
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          );
        }
      }
    },
    afterSwap: async () => {
      if (state.priorState === "externally-managed") {
        // Traycer Desktop's SMAppService owns registration here.
        // Any launchctl bootstrap/bootout (or manifest rewrite) against ITS label would corrupt the BTM registration it manages - `installService` refuses exactly that.
        state.postSwapAction = "none";
        // ...but a COMPETING CLI-label registration is a different object from the one Desktop owns, and leaving it alone is what produced the dual-host bug.
        // Retire it here rather than merely declining to add another: this is the one routine flow that both reaches a poisoned machine (`host install` / `host update` on a desktop-owned host) and is already an explicit host-lifecycle operation the user asked for.
        try {
          await withServiceMutationAuthority(verifyMutationCapability, () =>
            controller.retireCompetingRegistration(label),
          );
        } catch (cause) {
          // An unexpected best-effort repair error keeps the historical post-swap doctor path.
          // Authority loss is different: it is a hard stop and must never be converted into that best-effort outcome.
          if (isServiceMutationAuthorityError(cause)) throw cause;
          createCliLogger(options.environment).warn(
            "Competing-registration repair threw unexpectedly; the host install itself was unaffected.",
            { cause: cause instanceof Error ? cause.message : String(cause) },
          );
        }
        if (process.platform === "darwin") {
          // Bring the host up on the new bytes now. `host update` with bootstrap null refreshes the definition of an already-running service.
          try {
            await withServiceMutationAuthority(verifyMutationCapability, () =>
              (async () => {
                await runWithPublishedHostStartAdoption(
                  publishHostStartAdoption,
                  controller,
                  label,
                  async () =>
                    state.stoppedBeforeSwap
                      ? controller.relaunchAfterRestart(label, {
                          forcedRecycle: true,
                        })
                      : controller.start(label),
                );
              })(),
            );
            state.postSwapAction = "start";
          } catch (cause) {
            if (isServiceMutationAuthorityError(cause)) throw cause;
            state.postSwapError =
              cause instanceof Error ? cause.message : String(cause);
          }
        }
        return;
      }
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
            preservedCli: null,
            verifyMutationCapability,
            publishHostStartAdoption,
          });
        } catch (cause) {
          if (isServiceMutationAuthorityError(cause)) throw cause;
          // No rollback - the new host stays in place.
          // The command surfaces this as a warning and steers the user toward `traycer host doctor` / `traycer host service install` for recovery.
          state.postSwapError =
            cause instanceof Error ? cause.message : String(cause);
        }
        return;
      }
      // Existing registration: rewrite the OS service manifest and re-load it so the supervisor picks up definition changes (descriptor soft limits, ProgramArguments, env, ...).
      // Plain start/restart only instructs the already-loaded job to run - on macOS that is launchctl kickstart of a cached definition.
      state.postSwapAction = "install";
      try {
        // `host update` with bootstrap null refreshes the definition of an already-registered service; it must not no-op a kickstart against a process that never left.
        const registeredCli =
          options.bootstrap === null && process.platform === "darwin"
            ? await readRegisteredCliInvocation(label)
            : null;
        const preservedCli =
          registeredCli !== null &&
          (await isSelfNamingCliInvocation(registeredCli))
            ? null
            : registeredCli;
        await registerService({
          controller,
          label,
          environment: options.environment,
          // host update leaves bootstrap null (it must not invent a registration on a clean machine).
          // For an already-registered service, reuse the caller's bootstrap flags when present; otherwise re-resolve the CLI with linger off and self- invocation permitted.
          bootstrap: options.bootstrap ?? {
            enableLinger: false,
            allowSelfInvocation: true,
          },
          preservedCli,
          verifyMutationCapability,
          publishHostStartAdoption,
        });
      } catch (cause) {
        if (isServiceMutationAuthorityError(cause)) throw cause;
        // No rollback. New host is in place; surface the failure
        // so the command can warn the user and Doctor can flag it.
        state.postSwapError =
          cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
  return { state, lifecycle };
}

// The truly-bytes-only counterpart to `createServiceInstallLifecycle`: no status probe, no register/rewrite, no start - ever, on any prior service state.
// The single exception is Windows, where a stray host process holding the install dir open would fail the swap rename regardless of whether the caller wants the service touched, so `beforeSwap` still force- stops there.
export function createBytesOnlyInstallLifecycle(
  controller: ServiceController,
  label: ServiceLabel,
): InstallHostLifecycle {
  let verifyMutationCapability = async (): Promise<void> => {};
  return {
    swapLockRecovery: swapLockRecoveryFor(label),
    setMutationVerifier: (verify) => {
      verifyMutationCapability = verify;
    },
    beforeSwap: async (): Promise<void> => {
      if (process.platform !== "win32") return;
      await withServiceMutationAuthority(verifyMutationCapability, () =>
        controller.stop(label, { force: false }),
      );
    },
    afterSwap: (): Promise<void> => Promise.resolve(),
  };
}

interface RegisterServiceOptions {
  readonly controller: ServiceController;
  readonly label: ServiceLabel;
  readonly environment: Environment;
  readonly bootstrap: BootstrapServiceOptions;
  // Non-null when the caller wants the registered manifest's existing CLI invocation kept verbatim (host update's no-repoint contract) instead of re-resolving it.
  readonly preservedCli: CliInvocation | null;
  readonly verifyMutationCapability: () => Promise<void>;
  readonly publishHostStartAdoption: HostStartAdoptionPublisher;
}

async function registerService(opts: RegisterServiceOptions): Promise<void> {
  // CLI invocation resolution happens here (post-swap) so an unresolvable path becomes a `postSwapError` rather than rolling back a successful host install.
  // Doctor + `traycer host service install` are the recovery paths.
  const cli =
    opts.preservedCli ??
    (await resolveServiceCliInvocation({
      environment: opts.environment,
      override: null,
      allowSelfInvocation: opts.bootstrap.allowSelfInvocation,
    }));
  // `ServiceController.install` writes the manifest, registers with the OS service manager, and starts the host - matching Core Flow 1 / Flow 7 expectations that first-launch ends with a running host, and matching the existing-registration update path that must re-load the regenerated definition rather than kickstart a cache.
  await withServiceMutationAuthority(opts.verifyMutationCapability, () =>
    (async () => {
      await runWithPublishedHostStartAdoption(
        opts.publishHostStartAdoption,
        opts.controller,
        opts.label,
        () =>
          opts.controller.install({
            label: opts.label,
            cli,
            enableLinger: opts.bootstrap.enableLinger,
          }),
      );
    })(),
  );
}

async function runWithPublishedHostStartAdoption(
  publish: HostStartAdoptionPublisher,
  controller: Pick<ServiceController, "hostStartAdoptionLabel">,
  label: ServiceLabel,
  start: () => Promise<void>,
): Promise<void> {
  const serviceLabel = await controller.hostStartAdoptionLabel(label);
  const lease = await publish(serviceLabel);
  try {
    await start();
    await lease?.waitForSpawn();
  } catch (error) {
    // The invocation-record decorator can reject AFTER the service manager accepted the registration and began launching the supervisor (record commit, lifecycle write, stale-marker clear).
    // The supervisor is coming up and will present this lease; cancelling it now would refuse or kill an admitted child and leave a registered service hostless.
    if (didServiceRegistrationCommit(error)) {
      await lease?.waitForSpawn().catch(() => undefined);
    }
    throw error;
  } finally {
    // cancel() propagating out of this `finally` would swap in its own error
    // for the actuator or record error being reported.
    await lease?.cancel().catch(() => undefined);
  }
}
