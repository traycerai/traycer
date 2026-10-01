import {
  supervisorRelaunchAdmitsStandingRecord,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
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
import { reportBoundedWait } from "../runner/bounded-wait-progress";
import type { WithCliUpdateContenderOptions } from "./update-contender";
import {
  readSupervisorRelaunchInstalledIdentity,
  requireCliUpdateMutationCapability,
  withCliLifecycleTeardownSegment,
} from "./update-contender";
import {
  LIFECYCLE_TEARDOWN_ADMISSION,
  LIFECYCLE_TEARDOWN_LOCK_WAIT_MS,
  LIFECYCLE_TEARDOWN_OPERATION,
  type LifecycleTeardownPlatform,
} from "./lifecycle-teardown";
import {
  publishedHostProcessGone,
  readHostPidMetadata,
  readHostPidMetadataEvidence,
} from "./pid-metadata";
import {
  forceStopHostProcessReporting,
  removeHostPidMetadataIfUnchanged,
  requestCooperativeShutdown,
} from "../service/platforms/desktop-agent-shutdown";
import {
  epochMicrosNow,
  killSupervisedHostTree,
} from "../service/platforms/windows";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  verifyServiceMutationAuthority,
  withServiceMutationAuthority,
} from "../service/mutation-authority";
import {
  isUnacknowledgedSpawn,
  runWithLeaseAtServiceSpawnEdge,
} from "../service/spawn-edge";
import { assertHostIdleForStop } from "./busy-check";
import { publishHostStartAdoption } from "./host-start-adoption";
import { findLiveIncumbentHost } from "./incumbent-check";
import {
  defaultSupervisorRelaunchWaitDeps,
  findLiveServiceSupervisor,
  MAX_SUPERVISOR_RELAUNCH_WAITS,
  waitForSupervisorRelaunch,
} from "./service-supervisor-relaunch";
import type { HostStartOrigin } from "./lifecycle-origin";
import type {
  DesktopRegistrationTakeover,
  InstallServiceOptions,
  RestartStop,
  ServiceController,
  ServiceLabel,
  StopServiceOptions,
  UninstallServiceOptions,
} from "../service";
import type { ServiceDefinitionRefresher } from "../service/definition-refresh";
import type { ServiceDefinitionRefresh } from "../service/service-definition";

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
  origin: HostStartOrigin,
  options: Omit<
    ApplyHostOptions,
    "verifyMutationCapability" | "lifecycleOrigin"
  >,
): Promise<ApplyHostOutcome> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await requireCliUpdateMutationCapability(capability, contenderOptions);
  return applyHost({
    ...options,
    lifecycleOrigin: origin,
    verifyMutationCapability: verify,
    publishHostStartAdoption: (serviceLabel) =>
      publishHostStartAdoption(
        capability,
        contenderOptions,
        serviceLabel,
        origin,
      ),
  });
}

/** See `applyHostWithAttempt`; used by install and provisioning promotion. */
export async function commitHostInstallSourceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  origin: HostStartOrigin,
  options: Omit<CommitHostInstallSourceOptions, "verifyMutationCapability">,
): Promise<CommitHostInstallSourceResult> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  if (
    options.lifecycle !== null &&
    options.lifecycle.setHostStartAdoptionPublisher !== undefined
  ) {
    options.lifecycle.setHostStartAdoptionPublisher((serviceLabel) =>
      publishHostStartAdoption(
        capability,
        contenderOptions,
        serviceLabel,
        origin,
      ),
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
  origin: HostStartOrigin,
  controller: Pick<ServiceController, "install" | "hostStartAdoptionLabel">,
  options: InstallServiceOptions,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      origin,
      controller,
      options.label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.install(options);
      },
    );
  });
}

/**
 * Final-actuator facade for a definition-only refresh (`host service
 * refresh`, and the lifecycle mode change that runs it). Unlike
 * {@link installHostServiceWithAttempt} there is no host-start adoption: a
 * refresh starts nothing, so it publishes no grant and waits for no spawn.
 * The authority scope is what every platform write re-checks.
 */
export async function refreshHostServiceDefinitionWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  refresher: Pick<ServiceDefinitionRefresher, "refresh">,
  label: ServiceLabel,
): Promise<ServiceDefinitionRefresh> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  return withServiceMutationAuthority(verify, () => refresher.refresh(label));
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

/**
 * Whether a stop must first find the host idle.
 *
 * - `if-idle` - probe `assertHostIdleForStop` immediately before the
 *   controller's stop, inside the caller's lock and after the capability is
 *   re-proved; busy (or unprovably idle) throws `E_HOST_BUSY` with nothing
 *   touched, not even the stop intent (`withStopIntent` announces inside
 *   `controller.stop`). The same answer on every platform, which plain stop
 *   is not: Linux `systemctl stop`, Windows `schtasks /End` and a CLI-owned
 *   macOS `launchctl kill` reach the host with no probe at all.
 * - `unconditional` - today's stop, unchanged.
 */
export type HostStopBusyGate = "if-idle" | "unconditional";

/** Final-actuator facade for a stop or force-stop. */
export async function stopHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "stop">,
  label: ServiceLabel,
  options: StopServiceOptions,
  busyGate: HostStopBusyGate,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    if (busyGate === "if-idle") {
      await assertHostIdleForStop(label.environment);
    }
    reportBoundedWait("stopping the host service");
    await controller.stop(label, options);
  });
}

/** Final-actuator facade for a restart. */
export async function restartHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  origin: HostStartOrigin,
  controller: Pick<ServiceController, "restart" | "hostStartAdoptionLabel">,
  label: ServiceLabel,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await withServiceMutationAuthority(verify, async () => {
    await runWithHostStartAdoption(
      capability,
      contenderOptions,
      origin,
      controller,
      label,
      async () => {
        await requireCliUpdateMutationCapability(capability, contenderOptions);
        await controller.restart(label);
      },
    );
  });
}

/**
 * What a service start did.
 *
 * - `started` - a host-start adoption proof was published and the service
 *   manager was asked to start the service.
 * - `supervisor-relaunching` - the service's own supervisor is alive, so the
 *   host is down only between its relaunches: nothing was published and
 *   nothing started (`host/service-supervisor-relaunch.ts`). The caller waits
 *   for that relaunch OUTSIDE its lock, or reports it; it must not escalate.
 */
export type ServiceStartOutcome =
  | { readonly kind: "started" }
  | {
      readonly kind: "supervisor-relaunching";
      readonly supervisorPid: number;
    };

/**
 * Final-actuator facade for a service start.
 *
 * The one place every service start passes through - `host ensure` (and the
 * desktop's ensure through it), `host service start`, and the post-swap start
 * of `cli finalize-upgrade` - so the one place that asks first whether the
 * service's supervisor is still alive. A start then could never be consumed:
 * the service manager starts nothing for a running service, and the pending
 * proof it left made the supervisor refuse its own relaunches
 * (the crash-relaunch race with `host ensure`). A start after an update or restart stop finds
 * no live supervisor - that stop ended it and it removed its records - and
 * takes the ordinary path.
 *
 * A start whose proof no supervisor acknowledged is retried ONCE, when a
 * positive read says nothing is running (`afterUnacknowledgedStart`).
 */
export async function startHostServiceWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  origin: HostStartOrigin,
  controller: Pick<
    ServiceController,
    "start" | "status" | "hostStartAdoptionLabel"
  >,
  label: ServiceLabel,
): Promise<ServiceStartOutcome> {
  const supervisor = await findLiveServiceSupervisor(label.environment);
  if (supervisor !== null) {
    return {
      kind: "supervisor-relaunching",
      supervisorPid: supervisor.supervisorPid,
    };
  }
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  // Each call publishes a fresh proof: `runWithHostStartAdoption` mints a new
  // nonce at the spawn edge, and the lease cancels its own on the way out.
  const startOnce = (): Promise<void> =>
    withServiceMutationAuthority(verify, () =>
      runWithHostStartAdoption(
        capability,
        contenderOptions,
        origin,
        controller,
        label,
        async () => {
          await requireCliUpdateMutationCapability(
            capability,
            contenderOptions,
          );
          await controller.start(label);
        },
      ),
    );
  return startRetryingUnacknowledged(capability, controller, label, startOnce);
}

/**
 * `startOnce`, and once more when no supervisor acknowledged its proof and a
 * positive read says nothing is running (`afterUnacknowledgedStart`). Each
 * call of `startOnce` publishes its own proof.
 *
 * "No supervisor acknowledged" is `isUnacknowledgedSpawn`: the ack wait's own
 * timeout, or - Windows - the `/Run` whose spawn evidence never came, thrown
 * as the start's own failure after its lease waited the ack out in vain.
 *
 * Each start, the reads after a timed-out one, and each supervisor wait in
 * between is a bounded wait of its own, and reports as it begins: stacked,
 * they are the longest silence a restart had (bounded-wait-progress.ts).
 */
async function startRetryingUnacknowledged(
  capability: UpdateMutationCapability,
  controller: Pick<ServiceController, "status">,
  label: ServiceLabel,
  startOnce: () => Promise<void>,
): Promise<ServiceStartOutcome> {
  try {
    reportBoundedWait("starting the host service");
    await startOnce();
  } catch (error) {
    if (!isUnacknowledgedSpawn(error)) throw error;
    reportBoundedWait("checking whether the host service started");
    const after = await afterUnacknowledgedStart(capability, controller, label);
    switch (after.kind) {
      case "unknown":
        throw error;
      case "running":
        return { kind: "started" };
      case "supervisor-relaunching":
        return after;
      case "stopped":
        reportBoundedWait("starting the host service again");
        await startOnce();
        return { kind: "started" };
    }
  }
  return { kind: "started" };
}

type UnacknowledgedStartState =
  | { readonly kind: "running" }
  | { readonly kind: "supervisor-relaunching"; readonly supervisorPid: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "unknown" };

/**
 * What a start whose proof no supervisor acknowledged left behind, and so
 * whether to start once more.
 *
 * The race it exists for: a supervisor that parks under the lifecycle policy
 * consumes the proof one last time before it exits
 * (`admitSupervisorLifecycle`), and a start that published its proof AND
 * reached the service manager in the few milliseconds between that consume
 * and the exit was lost - the manager saw the service still running and
 * started nothing (`systemctl start` on an active unit, a plain `kickstart`,
 * `/Run` under IgnoreNew), and the parked supervisor exited without the
 * proof. Nothing is left running after that, so a second start - with a
 * fresh proof - is the one that brings the host up.
 *
 * Retried only on a POSITIVE read that nothing is running: the service is
 * registered, no host answers, no supervisor record names a live process, and
 * the host's pid record is absent or names a process that is provably gone.
 * That last read is the one every platform's `status` derives `running` from,
 * made here directly because a Desktop-owned macOS registration reports
 * `externally-managed` whether or not its host runs, and an unreadable record
 * is no evidence. Any read that fails keeps the timeout. A service another
 * start brought up meanwhile is not started again: a host answering its
 * recorded endpoint, or a live supervisor whose relaunch the caller waits for
 * exactly as it would before any start - when that relaunch is one the
 * standing record admits (`afterRefusedSupervisor` otherwise).
 */
async function afterUnacknowledgedStart(
  capability: UpdateMutationCapability,
  controller: Pick<ServiceController, "status">,
  label: ServiceLabel,
): Promise<UnacknowledgedStartState> {
  try {
    const { state } = await controller.status(label);
    if (state === "not-installed") return { kind: "unknown" };
    if ((await findLiveIncumbentHost(label.environment)) !== null) {
      return { kind: "running" };
    }
    const supervisor = await findLiveServiceSupervisor(label.environment);
    if (supervisor !== null) {
      const admitted = await supervisorRelaunchAdmitsStandingRecord(
        capability,
        () => readSupervisorRelaunchInstalledIdentity(label.environment),
      );
      if (!admitted) return await afterRefusedSupervisor(label);
      return {
        kind: "supervisor-relaunching",
        supervisorPid: supervisor.supervisorPid,
      };
    }
    return (await hostProcessProvablyGone(label))
      ? { kind: "stopped" }
      : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * A live supervisor whose next relaunch the standing record refuses (a
 * restart admitted over `downloading`, say, under `recovery-maintenance`):
 * leaving the host to it leaves the host down, because that relaunch exits
 * with no host. Wait for it to leave instead, then read again.
 *
 * Waited out UNDER this caller's lock, unlike `waitForSupervisorRelaunch`'s
 * other callers, and deliberately: this supervisor is not going to bring the
 * host back, so there is nothing to hold off. Its relaunch contends for this
 * lock and gives up as `busy`, which a service launch reports with a
 * NON-zero exit (`host-start.ts`, `SERVICE_RELAUNCH_BUSY_EXIT_CODE`), within
 * its backoff plus `SUPERVISOR_ADMISSION_WAIT_MS` - where released it would
 * be refused and exit 0. Once it is gone the start this caller retries
 * publishes a fresh proof, which the next supervisor consumes before it
 * contends. Capped at `MAX_SUPERVISOR_RELAUNCH_WAITS` waits; one that never
 * leaves keeps the timeout.
 */
async function afterRefusedSupervisor(
  label: ServiceLabel,
): Promise<UnacknowledgedStartState> {
  for (let wait = 0; wait < MAX_SUPERVISOR_RELAUNCH_WAITS; wait += 1) {
    reportBoundedWait("waiting for the host service's supervisor to exit");
    const settled = await waitForSupervisorRelaunch(
      label.environment,
      defaultSupervisorRelaunchWaitDeps,
    );
    if (settled.kind === "host-ready") return { kind: "running" };
    if (settled.kind === "supervisor-gone") {
      return (await hostProcessProvablyGone(label))
        ? { kind: "stopped" }
        : { kind: "unknown" };
    }
  }
  return { kind: "unknown" };
}

async function hostProcessProvablyGone(label: ServiceLabel): Promise<boolean> {
  const evidence = await readHostPidMetadataEvidence(label.environment);
  switch (evidence.kind) {
    case "absent":
      return true;
    case "unreadable":
      return false;
    case "read":
      return publishedHostProcessGone(evidence.metadata);
  }
}

/**
 * Final-actuator facade for the first half of a controlled restart.
 *
 * `onAuthorityVerified` runs once the mutation-capability check has passed
 * and immediately before the actuator is asked to stop the host - the last
 * point at which THIS facade can still prove nothing was touched. A caller
 * that keys "have I begun to disturb the host?" on this facade (the `host
 * update` activation arm's progress-marker rule) marks the boundary here
 * rather than around the call: a capability check that fails has touched
 * nothing, and a failure reported from before the boundary must be treated
 * as one. `null` when the caller keeps no such boundary.
 *
 * The boundary is the facade's, not the actuator's. Past it the controller
 * still runs checks of its own before its first mutating command: the stop
 * intent is announced first (`HOST_STOP_INTENT_UNWRITABLE` on `--force` or
 * win32 when the host home cannot be written), and every platform controller
 * re-verifies the same authority in front of EACH command it issues. A
 * refusal from either lands after the boundary and is reported as a
 * disruption even though the host is untouched. Both are narrow - the first
 * needs the host home unwritable, the second needs the authority lost in the
 * gap between two consecutive checks - and the caller's rule accepts them.
 */
export async function stopHostForRestartWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  controller: Pick<ServiceController, "stopForRestart">,
  label: ServiceLabel,
  options: StopServiceOptions,
  onAuthorityVerified: (() => void) | null,
): Promise<RestartStop> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  return withServiceMutationAuthority(verify, () => {
    if (onAuthorityVerified !== null) onAuthorityVerified();
    reportBoundedWait("stopping the host service for a restart");
    return controller.stopForRestart(label, options);
  });
}

/**
 * Final-actuator facade for the relaunch half of a controlled restart.
 *
 * A relaunch whose proof no supervisor acknowledged is relaunched once more,
 * exactly as a start is (`startRetryingUnacknowledged`): a plain
 * `systemctl start` or `kickstart` issued while a parking supervisor is still
 * exiting starts nothing. A live supervisor or an answering host found
 * instead is the relaunch this leg asked for.
 */
export async function relaunchHostAfterRestartWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  origin: HostStartOrigin,
  controller: Pick<
    ServiceController,
    "relaunchAfterRestart" | "status" | "hostStartAdoptionLabel"
  >,
  label: ServiceLabel,
  stopped: RestartStop,
): Promise<void> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  const relaunchOnce = (): Promise<void> =>
    withServiceMutationAuthority(verify, () =>
      runWithHostStartAdoption(
        capability,
        contenderOptions,
        origin,
        controller,
        label,
        async () => {
          await requireCliUpdateMutationCapability(
            capability,
            contenderOptions,
          );
          await controller.relaunchAfterRestart(label, stopped);
        },
      ),
    );
  await startRetryingUnacknowledged(
    capability,
    controller,
    label,
    relaunchOnce,
  );
}

// `origin` is the one field every start facade above threads through to the
// proof it publishes (`host/lifecycle-origin.ts`): a command's own
// `--lifecycle-origin` for a start it asks for, `maintenance` for the relaunch
// legs of `host update` and `host restart`. It never decides whether the
// supervisor runs - a grant always runs - only what `host status` reports.
async function runWithHostStartAdoption(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  origin: HostStartOrigin,
  controller: Pick<ServiceController, "hostStartAdoptionLabel">,
  label: ServiceLabel,
  start: () => Promise<void>,
): Promise<void> {
  // Resolving the effective service label and publishing the one-shot
  // adoption proof can both take long enough for a released or forged
  // capability to surface. This check covers the label read; the spawn edge
  // revalidates before and after publishing, so the service manager never
  // launches bytes selected by a stale caller after its outer authority scope
  // was established.
  await verifyServiceMutationAuthority();
  const serviceLabel = await controller.hostStartAdoptionLabel(label);
  // Published at the controller's first spawn edge, not here: see
  // `runWithLeaseAtServiceSpawnEdge`. A call that never reaches an edge
  // publishes no grant and waits for no child.
  await runWithLeaseAtServiceSpawnEdge(
    () =>
      publishHostStartAdoption(
        capability,
        contenderOptions,
        serviceLabel,
        origin,
      ),
    start,
  );
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

/**
 * Final-actuator facade for the supervisor's own lifecycle teardown
 * (`host/lifecycle-teardown.ts`): the lock it runs under and the platform
 * stop machinery it drives. The actuator re-proves the hold through the
 * `verify` it is handed before each destructive step.
 */
export function createLifecycleTeardownPlatform(): LifecycleTeardownPlatform {
  return {
    platform: process.platform,
    withLock: (environment, run) => {
      // ONE options value for acquisition and revalidation, as `host stop`
      // does. Its own admission: refused inside any active attempt, so the
      // teardown never interleaves with a swap, but admitted over a park the
      // next supervisor start can resume - judged with that start's own
      // install reader (`withCliLifecycleTeardownSegment`).
      const options: WithCliUpdateContenderOptions = {
        environment,
        reason: LIFECYCLE_TEARDOWN_OPERATION,
        waitMs: LIFECYCLE_TEARDOWN_LOCK_WAIT_MS,
        pollIntervalMs: 100,
        admission: LIFECYCLE_TEARDOWN_ADMISSION,
      };
      return withCliLifecycleTeardownSegment(options, (capability) =>
        run(() => requireCliUpdateMutationCapability(capability, options)),
      );
    },
    readPidMetadata: (environment) => readHostPidMetadata(environment),
    requestCooperativeShutdown: (environment, operation, intent) =>
      requestCooperativeShutdown(environment, operation, intent),
    forceStopPublishedHost: (environment, operation) =>
      forceStopHostProcessReporting(environment, operation, null),
    killHostTree: (environment, rootPid, verify) =>
      killSupervisedHostTree(environment, rootPid, verify, null, {
        now: epochMicrosNow,
      }),
    verifyPublishedInstance: (pid, startIdentity) =>
      getPublishedProcessIdentityVerdict(pid, startIdentity),
    removePidMetadataIfUnchanged: (environment, instance) =>
      removeHostPidMetadataIfUnchanged(environment, instance),
  };
}
