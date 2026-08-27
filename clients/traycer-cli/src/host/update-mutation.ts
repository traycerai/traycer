import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import {
  applyHost,
  type ApplyHostOptions,
  type ApplyHostOutcome,
} from "../installer/apply";
import {
  commitHostInstallSource,
  type CommitHostInstallSourceOptions,
  type CommitHostInstallSourceResult,
} from "../installer/install";
import type { WithCliUpdateContenderOptions } from "./update-contender";
import { requireCliUpdateMutationCapability } from "./update-contender";
import {
  verifyServiceMutationAuthority,
  withServiceMutationAuthority,
} from "../service/mutation-authority";
import { publishHostStartAdoption } from "./host-start-adoption";
import type {
  DesktopRegistrationTakeover,
  InstallServiceOptions,
  RestartStop,
  ServiceController,
  ServiceLabel,
  StopServiceOptions,
  UninstallServiceOptions,
} from "../service";

/**
 * The only contender-aware way for commands to mutate the install tree.
 *
 * The raw installer functions are intentionally still useful to the legacy
 * installer tests and bootstrapping internals, but command-level execution
 * must come through this module. The verifier is carried down to the exact
 * record-write, stop, rename and start edges in `installer/install.ts`.
 */
export async function applyHostWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  options: Omit<ApplyHostOptions, "verifyMutationCapability">,
): Promise<ApplyHostOutcome> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await requireCliUpdateMutationCapability(capability, contenderOptions);
  return applyHost({
    ...options,
    verifyMutationCapability: verify,
    publishHostStartAdoption: (serviceLabel) =>
      publishHostStartAdoption(capability, contenderOptions, serviceLabel),
  });
}

/** See `applyHostWithAttempt`; used by install and provisioning promotion. */
export async function commitHostInstallSourceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  options: Omit<CommitHostInstallSourceOptions, "verifyMutationCapability">,
): Promise<CommitHostInstallSourceResult> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  if (
    options.lifecycle !== null &&
    options.lifecycle.setHostStartAdoptionPublisher !== undefined
  ) {
    options.lifecycle.setHostStartAdoptionPublisher((serviceLabel) =>
      publishHostStartAdoption(capability, contenderOptions, serviceLabel),
    );
  }
  await requireCliUpdateMutationCapability(capability, contenderOptions);
  return commitHostInstallSource({
    ...options,
    verifyMutationCapability: verify,
  });
}

/** Final-actuator facade for an OS-service registration. */
export async function installHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "install" | "hostStartAdoptionLabel">,
  options: InstallServiceOptions,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      controller,
      options.label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.install(options);
      },
    );
  });
}

/** Final-actuator facade for an OS-service deregistration/bootout. */
export async function uninstallHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "uninstall">,
  options: UninstallServiceOptions,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, () =>
    controller.uninstall(options),
  );
}

/** Final-actuator facade for a stop or force-stop. */
export async function stopHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "stop">,
  label: ServiceLabel,
  options: StopServiceOptions,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, () =>
    controller.stop(label, options),
  );
}

/** Final-actuator facade for a restart. */
export async function restartHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "restart" | "hostStartAdoptionLabel">,
  label: ServiceLabel,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      controller,
      label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.restart(label);
      },
    );
  });
}

/** Final-actuator facade for a service start. */
export async function startHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "start" | "hostStartAdoptionLabel">,
  label: ServiceLabel,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      controller,
      label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.start(label);
      },
    );
  });
}

/** Final-actuator facade for the first half of a controlled restart. */
export async function stopHostForRestartWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "stopForRestart">,
  label: ServiceLabel,
  options: StopServiceOptions,
): Promise<RestartStop> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  return withServiceMutationAuthority(verify, () =>
    controller.stopForRestart(label, options),
  );
}

/** Final-actuator facade for the relaunch half of a controlled restart. */
export async function relaunchHostAfterRestartWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<
    ServiceController,
    "relaunchAfterRestart" | "hostStartAdoptionLabel"
  >,
  label: ServiceLabel,
  stopped: RestartStop,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      controller,
      label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.relaunchAfterRestart(label, stopped);
      },
    );
  });
}

async function runWithHostStartAdoption(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "hostStartAdoptionLabel">,
  label: ServiceLabel,
  start: () => Promise<void>,
): Promise<void> {
  // Resolving the effective service label and publishing the one-shot
  // adoption proof can both take long enough for a released or forged
  // capability to surface. Revalidate again at the exact service start edge;
  // otherwise the service manager could launch bytes selected by a stale
  // caller after its outer authority scope was established.
  await verifyServiceMutationAuthority();
  const serviceLabel = await controller.hostStartAdoptionLabel(label);
  const adoption = await publishHostStartAdoption(
    capability,
    contenderOptions,
    serviceLabel,
  );
  try {
    await verifyServiceMutationAuthority();
    await start();
    await adoption.waitForSpawn();
  } finally {
    // Cleanup must never replace the actuator error: callers classify it to
    // choose between park/abort and an ordinary busy refusal, and a rejected
    // cancel() propagating out of this `finally` would swap in its own error.
    await adoption.cancel().catch(() => undefined);
  }
}

/** Final-actuator facade for the Desktop-to-CLI service takeover. */
export async function takeoverDesktopRegistrationWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "takeoverDesktopRegistration">,
  label: ServiceLabel,
): Promise<DesktopRegistrationTakeover> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  return withServiceMutationAuthority(verify, () =>
    controller.takeoverDesktopRegistration(label),
  );
}

// Legacy-core facades keep raw service calls physically inside this actuator
// module. They exist only for pre-cutover command cores and test seams: all
// production contender paths above consume a live attempt capability. Naming
// them as legacy (rather than "without attempt") makes an unguarded escape
// impossible to introduce by accidentally importing a tempting bypass API.
export async function uninstallHostServiceLegacy(
  controller: Pick<ServiceController, "uninstall">,
  options: UninstallServiceOptions,
): Promise<void> {
  await controller.uninstall(options);
}

export async function stopHostServiceLegacy(
  controller: Pick<ServiceController, "stop">,
  label: ServiceLabel,
  options: StopServiceOptions,
): Promise<void> {
  await controller.stop(label, options);
}

export async function stopHostForRestartLegacy(
  controller: Pick<ServiceController, "stopForRestart">,
  label: ServiceLabel,
  options: StopServiceOptions,
): Promise<RestartStop> {
  return controller.stopForRestart(label, options);
}

export async function relaunchHostAfterRestartLegacy(
  controller: Pick<ServiceController, "relaunchAfterRestart">,
  label: ServiceLabel,
  stopped: RestartStop,
): Promise<void> {
  await controller.relaunchAfterRestart(label, stopped);
}

export async function startHostServiceLegacy(
  controller: Pick<ServiceController, "start">,
  label: ServiceLabel,
): Promise<void> {
  await controller.start(label);
}
