import {
  credentialProvisionForResult,
  formatCredentialProvisionNote,
  maybeProvisionCredential,
} from "../host/install-auth";
import { platform as osPlatform, uptime } from "node:os";
import {
  finalizePendingCliUpgrade,
  pendingUpgradeFinalisable,
  type FinalizePendingCliUpgradeOutcome,
} from "./cli-upgrade";
import { writePostFinalizeMarkerFile } from "./cli-finalize-upgrade";
import {
  readCliManifest,
  type CliPendingUpgrade,
} from "../manifest/cli-manifest";
import { assertHostNotBusy } from "../host/busy-check";
import {
  attestInstallRuntime,
  type AttestedInstallRuntime,
} from "../host/attested-install-runtime";
import { refuseForegroundHostRun } from "../host/foreground-host-run";
import { refuseUnlessRestartTarget } from "../host/restart-target-guard";
import { noteStopTargetProgress, withStopTarget } from "../service/stop-target";
import { WINDOWS_RESTORE_UNCONFIRMED } from "../service/windows-task-restoration";
import type { HostStartOrigin } from "../host/lifecycle-origin";
import { CLI_ERROR_CODES, cliError, type CliErrorCode } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceJobIdFor,
  serviceLabelFor,
  type RestartStop,
  type ServiceController,
  type ServiceLabel,
} from "../service";
import {
  admitWindowsCliPublication,
  publicWindowsCliDiagnostic,
} from "../upgrade/windows-cli-publication";
import { wouldDowngradeCli } from "../upgrade/downgrade-floor";
import {
  windowsCliEntryImage,
  windowsCliEntryImageMatches,
} from "../store/windows-cli-entry-image";
import { withCliUpdateContenderContext } from "../host/update-contender";
import {
  relaunchHostAfterRestartWithAttempt,
  stopHostServiceWithAttempt,
  stopHostForRestartWithAttempt,
} from "../host/update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { RestartTargetHost } from "@traycer-clients/shared/host-lock/restart-target";
import {
  describeNonterminalRecordRecovery,
  parkedActivationRelaunchable,
} from "../host/parked-activation-relaunch";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { newCliPostFinalizeReceiptPath } from "../store/paths";
import {
  connectWindowsRestartControl,
  defaultHelperArmWaitDeps,
  defaultSpawnImpl,
  defaultWriteImpl,
  reconcilePostFinalizeMarker,
  scheduleFinalizationHelper,
  type HelperArmWaitDeps,
  type ReconcileOutcome,
  type ScheduleHelperResult,
  type SpawnImpl,
  type WriteImpl,
  HELPER_ARM_WAIT_MS,
} from "../upgrade/finalize-helper";

// `traycer host restart` - kicks the OS service so the supervisor
// re-spawns the host. The supervisor itself re-reads the install
// record at spawn time, so this is also how a freshly-installed
// host gets picked up after `host install` if the service was
// already running on the previous binary.
//
// Restart is also the moment we get to finalise a pending CLI upgrade.
// `traycer cli upgrade` stages the new binary and records
// `pendingUpgrade` when the live binary is locked (Windows: the
// supervisor process holds the CLI .exe open; cross-platform:
// read-only install dir). Between `stop` and `start` the supervisor's
// lock is released, so we attempt the staged-binary swap in that
// window and then start the service back on the new binary.
//
// On Windows the *current CLI process* (the one running this command)
// is itself executing from the live `.exe`, so even after the
// supervisor releases its lock, renameSync still fails with EBUSY.
// For that case we hand off to a helper that waits for the CLI process
// to exit and then attempts the swap asynchronously. Once armed, the helper
// owns the service relaunch. See upgrade/finalize-helper.ts.
//
// A failed in-process finalize is non-fatal: the service is still
// started, the pending state remains visible in Doctor, and the next
// restart (or the helper) retries the swap.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal restart must not enter another actor's
// apply/install/activation critical section and stop/kill the process
// it just started - the whole marker-reconcile -> stop -> finalize ->
// start sequence runs inside ONE lock acquisition.
//
// `--if-idle` (hidden, internal - the CLI-owned activation mode): after
// acquiring the lock, probe `assertHostNotBusy` before the disruptive
// step; busy -> `E_HOST_BUSY`, the lock releases with nothing touched.
// The only step between the probe and `controller.stop()` is
// `reconcilePostFinalizeMarker`'s local file read - not the network or
// long-running work the TOCTOU-floor principle guards against - so the
// probe runs immediately before this call rather than being threaded
// into `restartWithPendingCliUpgradeFinalize` itself. Plain `host
// restart` (no `--if-idle`) skips the probe entirely, keeping today's
// unconditional semantics for explicit user restarts.
// `--force` (user-facing): skip the cooperative shutdown claim and kill the
// host process before relaunching. The user explicitly accepted losing
// running sessions and in-flight agent work; see `host stop --force` for the
// mechanics. Mutually exclusive with `--if-idle` - one flag widens the busy
// gate, the other removes it, and a command carrying both has no coherent
// intent.
// `--defer-if-parked` (hidden, internal - the Desktop force-restart path):
// when the canonical recovery classification says `stop-only`, do NOT stop the
// service; refuse and report, leaving a running host running.
//
// ## Why this is a flag on THIS command rather than a check by the caller
//
// The classification and the action it authorizes must happen under ONE
// acquisition of the contender lock. Desktop previously read the attempt record
// itself, decided the record was not an active continuation, and only then
// shelled this command - a snapshot, not a condition on the restart. A new
// contender can park `preparing/activate` in the window between that read and
// this command taking the lock, so the caller's "safe to restart" verdict was
// already stale when it was acted on: the CLI would then classify the NEW
// record as `stop-only`, stop the service, and report `restarted:false`,
// leaving the host down with a continuation on disk. That is the stranding the
// Desktop check existed to prevent, produced by the check itself.
//
// Deciding here closes the window by construction, because
// `contenderContext.recoveryAction` is computed from the record under the same
// lock that guards the stop/restart below. It also removes the second copy of
// the policy: which phases are recoverable is `recoveryActionFor`'s call in
// shared, and no caller re-derives it.
//
// ## A desktop request over a terminal-started host
//
// A host started by `traycer host start` in a terminal (a `foreground` run) is
// not the service's, and the app never tears it down: Linked governs the
// service-run host only. A DESKTOP-origin restart - plain, `--if-idle` or
// `--force` - is refused `E_HOST_NOT_SERVICE_RUN` first inside the lock,
// before the busy probe, the stop, the finalize or the relaunch
// (`refuseForegroundHostRun`, shared with `host stop` and
// `host free-port-and-restart`). A terminal restart is unchanged.
//
// ## A restart bound to one host process
//
// `--expect-host-pid` with `--expect-host-start-identity` (hidden, internal -
// Desktop's force restart of a host that stopped answering): the person
// confirmed killing THAT process, and the confirmation is checked in Desktop
// before this command is spawned - which is before this command waits up to
// 30s for the lock. Another actor can publish a healthy replacement in that
// wait, so the binding is checked again here, inside the lock and before
// anything else (`refuseUnlessRestartTarget`), and once more at every
// actuator edge of the stop itself (`withStopTarget`): a host the supervisor
// admitted before this command took the lock can publish after that first
// check, and the stop's unit-scoped signals would reach it.
export interface HostRestartArgs {
  readonly ifIdle: boolean;
  readonly force: boolean;
  readonly deferIfParked: boolean;
  /** The one host process this restart may stop, or null for whichever runs. */
  readonly expectedHost: RestartTargetHost | null;
  /** Who asked: `desktop` for every restart the app issues. */
  readonly lifecycleOrigin: HostStartOrigin;
}

export function buildHostRestartCommand(args: HostRestartArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Validated INSIDE the CommandFn so the runner catches it (CliError →
    // NDJSON error envelope) - same reason as host install's flag check.
    if (args.ifIdle && args.force) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host restart: --if-idle and --force are mutually exclusive; pass one or the other",
        details: null,
        exitCode: 1,
      });
    }
    const label = serviceLabelFor(ctx.runtime.environment);
    const controller = createServiceController();
    const pendingTimeout = Promise.withResolvers<{
      readonly kind: "restarted";
      readonly jobId: string;
      readonly attestation: AttestedInstallRuntime;
      readonly result: RestartFinalizeResult;
    }>();
    let parentTimer: NodeJS.Timeout | undefined;
    const restart = withCliUpdateContenderContext(
      {
        environment: ctx.runtime.environment,
        reason: "host-restart",
        waitMs: 30_000,
        pollIntervalMs: 100,
        admission: "recovery-maintenance",
      },
      async (capability, _cliLock, contenderContext) => {
        if (args.lifecycleOrigin === "desktop") {
          await refuseForegroundHostRun(
            "host restart",
            ctx.runtime.environment,
            args.lifecycleOrigin,
          );
        }
        if (args.expectedHost !== null) {
          await refuseUnlessRestartTarget(
            "host restart",
            ctx.runtime.environment,
            args.expectedHost,
            null,
          );
        }
        if (args.ifIdle) {
          await assertHostNotBusy(ctx.runtime.environment);
        }
        const stopOnly = contenderContext.recoveryAction === "stop-only";
        // Compared for EVERY stop-only record, deferred ones included: the
        // guidance rendered below describes this record, and a deferred park
        // that matches the install must not be called stale (traycer#2208
        // review). `null` is an unreadable install record; it acts as "not
        // relaunchable" and reads as "unknown".
        const parkMatchesInstall = stopOnly
          ? await parkedActivationRelaunchable(
              ctx.runtime.environment,
              contenderContext.activeAttempt,
            )
          : false;
        // `--defer-if-parked` is decided BEFORE the match is acted on: that
        // caller (Desktop's force-restart) runs its own activation once this
        // command reports `deferred`, so a matching park must still defer
        // rather than be activated here behind its back.
        if (stopOnly && !args.deferIfParked && parkMatchesInstall === true) {
          // A matching park: fall through to the ordinary restart below, which
          // IS the activation restart the park is waiting for (see
          // `host/parked-activation-relaunch.ts` for why a park, and only a
          // park, may be continued this way).
        } else if (stopOnly) {
          // Classified from the record under the SAME lock acquisition that
          // guards the action below, so no contender can change the record
          // between the decision and its effect.
          if (args.deferIfParked) {
            // Refuse without touching the service. For a caller whose whole
            // purpose is "get this host running", stopping it is strictly
            // worse than doing nothing: a stop leaves the machine down AND
            // the continuation parked, which is the state the caller was
            // trying to escape. Doing nothing leaves a running host running
            // and a down host no worse, and the parked record stays for the
            // admitted activation flow either way.
            return {
              kind: "deferred-for-parked-activation" as const,
              jobId: await serviceJobIdFor(controller, label),
              record: contenderContext.activeAttempt,
              parkMatchesInstall,
              attestation: await attestInstallRuntime(ctx.runtime.environment),
            };
          }
          // An ACTIVE activate-continuation record (`applying`, or
          // `preparing/activate`) proves that bytes are placed and an
          // executor may still be mid-flight outside the lock (the
          // packaged-macOS executor releases between its spans). Relaunching
          // the generic supervisor here could activate those bytes outside
          // that continuation, so stop the current service safely and leave
          // the record for the admitted activation flow. A parked record that
          // does NOT match the installed bytes lands here too: the supervisor
          // would refuse that relaunch at spawn anyway, and a stop that says
          // so beats a "restart" that exits 0 having started nothing.
          await withStopTarget(
            "host restart",
            ctx.runtime.environment,
            args.expectedHost,
            () =>
              stopHostServiceWithAttempt(
                capability,
                {
                  environment: ctx.runtime.environment,
                  reason: "host-restart",
                  waitMs: 30_000,
                  pollIntervalMs: 100,
                  admission: "recovery-maintenance",
                },
                controller,
                label,
                { force: args.force },
                "unconditional",
              ),
          );
          return {
            kind: "stopped-for-parked-activation" as const,
            jobId: await serviceJobIdFor(controller, label),
            record: contenderContext.activeAttempt,
            parkMatchesInstall,
            attestation: await attestInstallRuntime(ctx.runtime.environment),
          };
        }
        const prepared: { attestation?: AttestedInstallRuntime } = {};
        const result = await restartWithPendingCliUpgradeFinalizeWithAttempt(
          {
            environment: ctx.runtime.environment,
            controller,
            label,
            parentPid: process.pid,
            platform: osPlatform(),
            spawnImpl: defaultSpawnImpl,
            writeImpl: defaultWriteImpl,
            armWait: defaultHelperArmWaitDeps,
            force: args.force,
            prepareWindowsStop: async () => {
              prepared.attestation = await attestInstallRuntime(
                ctx.runtime.environment,
              );
            },
            onWindowsStopped: (result) => {
              const attestation = prepared.attestation;
              if (attestation === undefined) return;
              // An unanswered cleanup, commit or lock release cannot keep the
              // initiating CLI alive while the detached owner waits to start.
              parentTimer = setTimeout(
                () =>
                  pendingTimeout.resolve({
                    kind: "restarted",
                    jobId: label.id,
                    attestation,
                    result: { ...result, serviceRestore: "restore-failed" },
                  }),
                HELPER_ARM_WAIT_MS,
              );
            },
          },
          capability,
          {
            environment: ctx.runtime.environment,
            reason: "host-restart",
            waitMs: 30_000,
            pollIntervalMs: 100,
            admission: "recovery-maintenance",
          },
          args.expectedHost,
        );
        return {
          kind: "restarted" as const,
          jobId:
            prepared.attestation === undefined
              ? await serviceJobIdFor(controller, label)
              : label.id,
          result,
          attestation:
            prepared.attestation ??
            (await attestInstallRuntime(ctx.runtime.environment)),
        };
      },
    );
    const locked = await Promise.race([
      restart,
      pendingTimeout.promise,
    ]).finally(() => clearTimeout(parentTimer));
    const restarted = locked.kind === "restarted";
    // A distinct fact from `restarted:false`. Both mean "no relaunch", but a
    // safe-stop STOPPED the service and this one deliberately did not touch
    // it, and a caller that cannot tell them apart cannot tell "your host is
    // now down" from "your host is still up, activation is pending".
    const deferredForParkedActivation =
      locked.kind === "deferred-for-parked-activation";
    // The record the stop-only classification was made from, and the install
    // comparison made against it under the same lock, so the guidance is about
    // THAT record: a deferred park may still match (Desktop activates it), a
    // stopped one did not (a matching one took the restart above), and an
    // active record is a different sentence again.
    const recovery =
      locked.kind === "restarted" || locked.record === null
        ? null
        : describeNonterminalRecordRecovery(
            locked.record,
            locked.parkMatchesInstall,
          );
    const credentialProvision =
      restarted &&
      locked.result.serviceRestore !== "restore-failed" &&
      !locked.result.helperArmed
        ? await maybeProvisionCredential(ctx, "start", null)
        : null;
    const note = formatCredentialProvisionNote(credentialProvision);
    const human = restarted
      ? humanForRestart(locked.jobId, locked.result)
      : deferredForParkedActivation
        ? `left service '${locked.jobId}' untouched because a packaged update is waiting for its explicit activation${recovery === null ? "" : `: ${recovery}`}`
        : `stopped service '${locked.jobId}' without relaunch because a packaged update is waiting for its explicit activation; the host is now down${recovery === null ? "" : `: ${recovery}`}`;
    return {
      data: {
        credentialProvision: credentialProvisionForResult(credentialProvision),
        restarted:
          restarted && locked.result.serviceRestore !== "restore-failed",
        deferredForParkedActivation,
        label: label.id,
        ...(restarted && osPlatform() === "win32"
          ? windowsRestartUpgradeResult(locked.result)
          : {
              cliUpgrade: restarted ? locked.result.finalize : null,
              helper: restarted ? locked.result.helper : null,
              markerReconcile: restarted ? locked.result.markerReconcile : null,
            }),
        installGeneration: locked.attestation.installGeneration,
        runtimeVersion: locked.attestation.runtimeVersion,
        runtimeWasNull: locked.attestation.runtimeWasNull,
      },
      human: note === null ? human : `${human}; ${note}`,
      exitCode:
        restarted && locked.result.serviceRestore === "restore-failed" ? 1 : 0,
    };
  };
}

interface RestartFinalizeArgs {
  readonly environment: import("../runner/environment").Environment;
  readonly controller: ServiceController;
  readonly label: ServiceLabel;
  readonly parentPid: number;
  readonly platform: NodeJS.Platform;
  readonly spawnImpl: SpawnImpl;
  readonly writeImpl: WriteImpl;
  readonly armWait: HelperArmWaitDeps;
  readonly force: boolean;
  readonly prepareWindowsStop?: () => Promise<void>;
  readonly onWindowsStopped?: (result: RestartFinalizeResult) => void;
}

export interface RestartFinalizeResult {
  readonly finalize: FinalizePendingCliUpgradeOutcome;
  // Set when this restart tried to hand the swap to a helper that runs
  // after the current CLI process exits, whether or not it armed.
  readonly helper: ScheduleHelperResult | null;
  // Set when a prior helper attempt left a marker the host-restart
  // command consumed at the top of this run.
  readonly markerReconcile: ReconcileOutcome | null;
  // The verified helper owns relaunch before a pending-upgrade route stops.
  readonly helperArmed: boolean;
  readonly serviceRestore: "restored" | "restore-failed" | null;
  readonly serviceRelaunchErrorCode?: CliErrorCode;
}

// Split out so tests can inject a controller stub + spawn/write stubs
// without monkey-patching the OS-level helpers.
export async function restartWithPendingCliUpgradeFinalize(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
): Promise<RestartFinalizeResult> {
  return restartWithActuators(args, actuators);
}

async function restartWithPendingCliUpgradeFinalizeWithAttempt(
  args: RestartFinalizeArgs,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  // Bound to the stop AND the relaunch (`service/stop-target.ts`): the
  // relaunch's `kickstart -k` / `systemctl restart` kills whatever the label
  // runs, and a host published before the relaunch's own launch returns is
  // not the restart's.
  expectedHost: RestartTargetHost | null,
): Promise<RestartFinalizeResult> {
  return withStopTarget("host restart", args.environment, expectedHost, () =>
    restartWithActuators(args, {
      stop: async (onWindowsStopped) => {
        const stopped = await stopHostForRestartWithAttempt(
          capability,
          contenderOptions,
          args.controller,
          args.label,
          {
            force: args.force,
            ...(onWindowsStopped === undefined ? {} : { onWindowsStopped }),
          },
          null,
        );
        noteStopTargetProgress("stop-ran");
        return stopped;
      },
      relaunch: (stopped) =>
        relaunchHostAfterRestartWithAttempt(
          capability,
          contenderOptions,
          // The restart's relaunch leg: `maintenance` whoever asked for the
          // restart, desktop or terminal (`host/lifecycle-origin.ts`).
          "maintenance",
          args.controller,
          args.label,
          stopped,
        ),
    }),
  );
}

export interface RestartActuators {
  stop(onWindowsStopped: (() => void) | undefined): Promise<RestartStop>;
  relaunch(stopped: RestartStop): Promise<void>;
  readonly connectWindowsRestart?: typeof connectWindowsRestartControl;
}

async function restartWithActuators(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
): Promise<RestartFinalizeResult> {
  // 1. Apply any marker from a prior helper attempt. This may clear
  //    pendingUpgrade if the helper succeeded on the last cycle.
  const markerReconcile = await reconcilePostFinalizeMarker({
    environment: args.environment,
  });

  if (args.platform === "win32") {
    const manifest = await readCliManifest(args.environment);
    const pending = manifest?.pendingUpgrade ?? null;
    if (manifest !== null && pending !== null) {
      const finalisable =
        (pending.allowDowngrade ||
          !wouldDowngradeCli({
            installedVersion: manifest.version,
            candidateVersion: pending.version,
          })) &&
        (await pendingUpgradeFinalisable(pending));
      const admitted = finalisable
        ? await admitWindowsCliPublication({
            label: args.label,
            stagedBinaryPath: pending.stagedBinaryPath,
            currentBinaryPath: manifest.binaryPath,
            candidate: {
              kind: "pending",
              version: pending.version,
              evidence: pending.windowsEvidence,
            },
          })
        : null;
      return restartWindowsWithPendingUpgrade(
        args,
        actuators,
        markerReconcile,
        { pending, binaryPath: manifest.binaryPath },
        admitted?.sha256 ?? null,
      );
    }
    const stopped = await actuators.stop(undefined);
    await actuators.relaunch(stopped);
    return {
      finalize: { status: manifest === null ? "no-manifest" : "no-pending" },
      helper: null,
      markerReconcile,
      helperArmed: false,
      serviceRestore: null,
    };
  }

  // `stopForRestart`, never `stop`: on a Desktop-managed machine a host whose
  // RPC endpoint is unreachable (or that outlived its own force-exit
  // watchdog) makes `stop` throw, and this command would exit before ever
  // relaunching - the exact broken-host state report 2 asked `host restart`
  // to repair. The restart half reports that as `forcedRecycle` instead, and
  // the relaunch below recycles the job rather than no-opping a kickstart
  // against a process that never left. A busy host still throws.
  const stopped = await actuators.stop(undefined);
  return restartAfterStop(args, actuators, stopped, markerReconcile);
}

async function restartWindowsWithPendingUpgrade(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
  markerReconcile: ReconcileOutcome,
  upgrade: {
    readonly pending: CliPendingUpgrade;
    readonly binaryPath: string;
  },
  stagedSha256: string | null,
): Promise<RestartFinalizeResult> {
  await args.prepareWindowsStop?.();
  const deadline = performance.now() + HELPER_ARM_WAIT_MS;
  const runner = windowsCliEntryImage();
  const arm = async (): Promise<ScheduleHelperResult | null> => {
    if (
      runner?.sha256 === null ||
      runner === null ||
      !(await windowsCliEntryImageMatches(runner.path)) ||
      performance.now() >= deadline
    )
      return null;
    return scheduleFinalizationHelper({
      environment: args.environment,
      stagedBinaryPath: upgrade.pending.stagedBinaryPath,
      stagedSha256,
      currentWindowsRunner: {
        path: runner.path,
        sha256: runner.sha256,
        legacyDetached: upgrade.pending.windowsEvidence === undefined,
      },
      livePath: upgrade.binaryPath,
      parentPid: args.parentPid,
      parentExitTimeoutSeconds: HELPER_ARM_WAIT_MS / 1000,
      platform: "win32",
      spawnImpl: args.spawnImpl,
      writeImpl: args.writeImpl,
      armWait: args.armWait,
      coordinateWindowsRestart: true,
    });
  };
  let timer: number | NodeJS.Timeout | undefined;
  const helper = await Promise.race([
    arm().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(resolve, HELPER_ARM_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const handoff = helper?.restartHandoff;
  if (
    helper === null ||
    handoff === undefined ||
    performance.now() >= deadline
  ) {
    throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
  }
  const result: RestartFinalizeResult = {
    finalize: {
      status: "still-locked",
      livePath: upgrade.binaryPath,
      stagedBinaryPath: upgrade.pending.stagedBinaryPath,
      handoff: {
        stagedBinaryPath: upgrade.pending.stagedBinaryPath,
        sha256: stagedSha256,
        windowsEvidence: upgrade.pending.windowsEvidence,
      },
      errorMessage: "The CLI upgrade is still pending.",
    },
    helper,
    markerReconcile,
    helperArmed: true,
    serviceRestore: null,
  };

  const connect =
    actuators.connectWindowsRestart ?? connectWindowsRestartControl;
  const control = await connect(handoff, deadline - performance.now()).catch(
    () => {
      throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
    },
  );
  let stopClock: number | null = null;
  const reportStopped = (): void => {
    if (stopClock !== null) return;
    stopClock = performance.now();
    control.stopped(Math.floor(uptime() * 1000));
    args.onWindowsStopped?.(result);
  };
  try {
    await control.begin();
  } catch {
    control.close();
    throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
  }
  try {
    await actuators.stop(reportStopped);
    reportStopped();
  } catch (error) {
    control.close();
    throw error;
  }
  // Commit admits only the optional swap. The helper already owns the start.
  const remaining =
    HELPER_ARM_WAIT_MS - (performance.now() - (stopClock ?? performance.now()));
  if (remaining <= 0) return { ...result, serviceRestore: "restore-failed" };
  const committed = await Promise.race([
    Promise.resolve()
      .then(() => args.writeImpl(handoff.commitPath, String(handoff.helperPid)))
      .then(
        () => true,
        () => false,
      ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
  return committed ? result : { ...result, serviceRestore: "restore-failed" };
}

async function restartAfterStop(
  args: RestartFinalizeArgs,
  actuators: RestartActuators,
  stop: RestartStop,
  markerReconcile: ReconcileOutcome,
): Promise<RestartFinalizeResult> {
  // 2. Try the in-process finalize. On POSIX this almost always works
  //    once the host supervisor releases the binary.
  const finalize = await finalizePendingCliUpgrade({
    environment: args.environment,
    platform: args.platform,
  });

  if (finalize.status === "manifest-update-failed") {
    let relaunchError: unknown = null;
    try {
      await actuators.relaunch(stop);
    } catch (error) {
      relaunchError = error;
    }
    let markerWriteError: unknown = null;
    try {
      await writePostFinalizeMarkerFile(
        newCliPostFinalizeReceiptPath(args.environment),
        {
          status: "swapped",
          attemptedAt: new Date().toISOString(),
          livePath: finalize.livePath,
          stagedBinaryPath: finalize.stagedBinaryPath,
          errorMessage: finalize.errorMessage,
          serviceStartError:
            relaunchError === null
              ? null
              : relaunchError instanceof Error
                ? relaunchError.message
                : String(relaunchError),
        },
      );
    } catch (error) {
      markerWriteError = error;
    }
    if (relaunchError !== null) throw relaunchError;
    if (markerWriteError !== null) throw markerWriteError;
  } else {
    await actuators.relaunch(stop);
  }
  return {
    finalize,
    helper: null,
    markerReconcile,
    helperArmed: false,
    serviceRestore: null,
  };
}

function windowsRestartUpgradeResult(result: RestartFinalizeResult) {
  const { finalize, helper, markerReconcile } = result;
  return {
    cliUpgrade: {
      status: finalize.status,
      ...("version" in finalize && { version: finalize.version }),
      ...("previousVersion" in finalize && {
        previousVersion: finalize.previousVersion,
      }),
      ...("installedVersion" in finalize && {
        installedVersion: finalize.installedVersion,
      }),
      ...("stagedVersion" in finalize && {
        stagedVersion: finalize.stagedVersion,
      }),
      ...("errorMessage" in finalize && {
        errorMessage: publicWindowsCliDiagnostic(
          finalize.errorMessage,
          "The CLI upgrade is still pending.",
        ),
      }),
    },
    helper:
      helper === null
        ? null
        : {
            status: helper.status,
            helperPid: helper.helperPid,
            errorMessage:
              helper.errorMessage === null
                ? null
                : publicWindowsCliDiagnostic(
                    helper.errorMessage,
                    "The CLI upgrade helper did not arm.",
                  ),
          },
    markerReconcile:
      markerReconcile === null
        ? null
        : {
            status: markerReconcile.status,
            ...("version" in markerReconcile && {
              version: markerReconcile.version,
            }),
            ...("previousVersion" in markerReconcile && {
              previousVersion: markerReconcile.previousVersion,
            }),
            ...("errorMessage" in markerReconcile && {
              errorMessage: publicWindowsCliDiagnostic(
                markerReconcile.errorMessage,
                "The prior CLI upgrade could not be confirmed.",
              ),
            }),
            ...("serviceStartError" in markerReconcile && {
              serviceStartError:
                markerReconcile.serviceStartError === null
                  ? null
                  : "The prior service start could not be confirmed.",
            }),
          },
    serviceRestore: result.serviceRestore,
    ...(result.serviceRelaunchErrorCode !== undefined && {
      serviceRelaunchErrorCode: result.serviceRelaunchErrorCode,
    }),
    ...(result.serviceRestore === "restore-failed" && {
      serviceRestoreError: WINDOWS_RESTORE_UNCONFIRMED,
    }),
  };
}

function humanForRestart(jobId: string, result: RestartFinalizeResult): string {
  if (osPlatform() === "win32") return humanForWindowsRestart(jobId, result);
  const base = `requested restart for service '${jobId}'`;
  const reconcilePrefix = describeMarkerReconcile(result.markerReconcile);
  if (result.helper !== null && result.helper.status === "armed") {
    return `${reconcilePrefix}${base}; cli upgrade live binary held by current CLI process - armed finalize helper (pid=${
      result.helper.helperPid ?? "?"
    }) completes the swap and starts the service after this process exits`;
  }
  if (result.helper !== null && result.helper.status === "failed") {
    return `${reconcilePrefix}${base}; cli upgrade helper did not arm (${result.helper.errorMessage}) - service relaunched, pending state retained`;
  }
  const outcome = result.finalize;
  switch (outcome.status) {
    case "finalised":
      return `${reconcilePrefix}${base}; finalised cli upgrade ${outcome.previousVersion} → ${outcome.version}`;
    case "still-locked":
      return `${reconcilePrefix}${base}; cli upgrade ${outcome.stagedBinaryPath} still locked (${outcome.errorMessage}) - pending state retained`;
    case "staged-binary-missing":
      return `${reconcilePrefix}${base}; cli upgrade staged binary for ${outcome.stagedVersion} missing at ${outcome.stagedBinaryPath} - re-run 'traycer cli upgrade'`;
    case "installed-newer":
      return `${reconcilePrefix}${base}; staged cli ${outcome.stagedVersion} was not installed because the cli is already at ${outcome.installedVersion} - live binary unchanged`;
    case "publish-failed":
      // The host was relaunched regardless - the restart the user asked
      // for is not forfeited because a staged CLI swap could not be
      // published. The live binary is untouched and pending state stands.
      return `${reconcilePrefix}${base}; cli upgrade could not publish ${outcome.stagedBinaryPath} over ${outcome.livePath} (${outcome.errorMessage}) - live binary unchanged, pending state retained`;
    case "manifest-update-failed":
      return `${reconcilePrefix}${base}; cli ${outcome.version} was installed, but the CLI manifest update failed (${outcome.errorMessage}) - service relaunched and pending state retained for reconciliation`;
    case "no-pending":
    case "no-manifest":
      return `${reconcilePrefix}${base}`;
  }
}

function humanForWindowsRestart(
  jobId: string,
  result: RestartFinalizeResult,
): string {
  const {
    cliUpgrade,
    helper,
    markerReconcile,
    serviceRelaunchErrorCode,
    serviceRestoreError,
  } = windowsRestartUpgradeResult(result);
  const relaunchFailure =
    serviceRelaunchErrorCode === undefined
      ? []
      : [`The original relaunch failed (${serviceRelaunchErrorCode}).`];
  if (serviceRestoreError !== undefined) {
    return [
      "The CLI upgrade is still pending.",
      ...relaunchFailure,
      serviceRestoreError,
    ].join(" ");
  }
  const prior: string[] = [];
  switch (markerReconcile?.status) {
    case "applied-swapped":
      prior.push("The prior CLI upgrade finished.");
      break;
    case "applied-swap-failed":
    case "marker-invalid":
      if (markerReconcile.errorMessage !== undefined) {
        prior.push(markerReconcile.errorMessage);
      }
      break;
    case "applied-parent-still-alive":
      prior.push("The prior helper timed out waiting for the CLI to exit.");
      break;
    case "stale-marker-discarded":
      prior.push("Discarded a stale CLI upgrade marker.");
  }
  if (markerReconcile?.serviceStartError) {
    prior.push(markerReconcile.serviceStartError);
  }
  const base = [
    ...prior,
    `Requested restart for service '${jobId}'.`,
    ...relaunchFailure,
  ];
  if (helper?.status === "armed") {
    base.push("The finalize helper will attempt the pending CLI upgrade.");
  } else if (helper?.status === "failed") {
    if (helper.errorMessage !== null) base.push(helper.errorMessage);
    base.push("The CLI upgrade is still pending.");
  } else {
    switch (cliUpgrade.status) {
      case "finalised":
        base.push("The CLI upgrade finished.");
        break;
      case "still-locked":
      case "publish-failed":
        if (cliUpgrade.errorMessage !== undefined) {
          base.push(cliUpgrade.errorMessage);
        }
        break;
      case "staged-binary-missing":
        base.push(
          "The staged CLI is missing. Retry with 'traycer cli upgrade'.",
        );
        break;
      case "installed-newer":
        base.push("The installed CLI is newer than the staged upgrade.");
        break;
      case "manifest-update-failed":
        base.push(
          "The CLI was installed. Its manifest update is pending reconciliation.",
        );
    }
  }
  return base.join(" ");
}

function describeMarkerReconcile(reconcile: ReconcileOutcome | null): string {
  if (reconcile === null) return "";
  switch (reconcile.status) {
    case "applied-swapped":
      return `prior helper finalised cli upgrade ${reconcile.previousVersion} → ${reconcile.version}; `;
    case "applied-swap-failed":
      // Surface the service-start failure when there was one: the marker
      // is gone after reconciliation, so this line is the last chance to
      // say why the host was left down rather than merely un-upgraded.
      return reconcile.serviceStartError !== null
        ? `prior helper swap failed (${reconcile.errorMessage}) and could not restart the service (${reconcile.serviceStartError}); `
        : `prior helper swap failed (${reconcile.errorMessage}); `;
    case "applied-parent-still-alive":
      return "prior helper timed out waiting for CLI exit; ";
    case "marker-invalid":
      return `prior helper marker invalid (${reconcile.errorMessage}); `;
    case "stale-marker-discarded":
      // Named explicitly rather than folded into silence: this is the one
      // outcome where a marker existed, looked successful, and was
      // deliberately NOT applied. Someone reading a restart that did not
      // finalise the upgrade they expected needs to see why.
      return `discarded a stale helper marker (marker staged=${reconcile.markerStagedBinaryPath} live=${reconcile.markerLivePath} at=${reconcile.markerAttemptedAt}; pending staged=${reconcile.pendingStagedBinaryPath} live=${reconcile.manifestBinaryPath} at=${reconcile.pendingStagedAt}); `;
    case "no-marker":
      return "";
  }
}
