import {
  compareHostVersions,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { installHostDowngrade } from "./host-update-downgrade";
import type { ApplyHostOutcome } from "../installer/apply";
import {
  downloadAndStageHost,
  type HostDownloadOutcome,
} from "../installer/download-stage";
import {
  deleteUpdateProgressMarkerIfUnchanged,
  progressRecord,
  readUpdateProgressMarker,
  replaceUpdateProgressMarkerIfUnchanged,
  writeUpdateProgressMarker,
  type HostUpdateProgress,
} from "../host/update-progress-marker";
import { probeHostHealth } from "../service/health-probe";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { readHostStagedRecord } from "../manifest/host-staged";
import type { Environment } from "../runner/environment";
import type { ILogger } from "../logger";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { installDispatchAckStamper } from "../host/update-dispatch-ack";
import { hostHomeDir } from "../store/paths";
import {
  applyHostWithAttempt,
  relaunchHostAfterRestartWithAttempt,
  stopHostForRestartWithAttempt,
} from "../host/update-mutation";
import { readHostPidMetadata } from "../host/pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import { assertHostNotBusy } from "../host/busy-check";
import { createServiceController, serviceLabelFor } from "../service";

// Stage then apply. Network never runs under `cli-lock`. Exit 0 after an apply means the host came back healthy; Desktop still reads the flat legacy `data` shape.
export interface HostUpdateArgs {
  /** Explicit installs may downgrade; automatic update callers never opt in. */
  readonly allowDowngrade: boolean;
  readonly force: boolean;
  /** `null` stages the latest registry version; an explicit value is a pin. */
  readonly versionRequest?: string | null;
  /** Correlation nonce for the dispatch ACK (Ticket 07 §5.2.8), or `null` when this run was not dispatched by a host resolver waiting to name the attempt. A nonce, never a token: it grants nothing, so argv is a legitimate carrier for it. */
  readonly ackNonce: string | null;
}

export interface LegacyHostUpdateServiceLifecycle {
  readonly priorServiceState: "running" | "stopped" | "not-installed";
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
  readonly postSwapError: string | null;
}

export interface LegacyHostUpdateResult {
  readonly version: string;
  readonly installedAt: string;
  readonly executablePath: string;
  readonly source: HostInstallRecord["source"];
  readonly archiveSha256: string | null;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly previousVersion: string | null;
  readonly serviceLifecycle: LegacyHostUpdateServiceLifecycle;
}

// Matches `projectInstallResult`'s own fallback when `serviceLifecycle` is absent from the payload - used whenever this command's own operation took no service action (a genuine no-op) rather than hand-rolling an equivalent-but-distinct literal.
const NO_SERVICE_ACTION_LIFECYCLE: LegacyHostUpdateServiceLifecycle = {
  priorServiceState: "not-installed",
  stoppedBeforeSwap: false,
  postSwapAction: "none",
  postSwapError: null,
};

export function buildHostUpdateCommand(args: HostUpdateArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    ctx.runtime.logger.info("Host update command started", {
      environment,
      force: args.force,
    });

    // Ticket 07 §5.2.8.
    // FIRST, before `downloadAndStageHost` writes anything: a run dispatched with a nonce this build cannot honour has already lost the correlation its caller is waiting on, and discovering that after staging bytes would mean doing destructive work for a dispatch that can only ever report indeterminate.
    const dispatchAckAcknowledgement = installDispatchAckStamper(
      hostHomeDir(environment),
      args.ackNonce,
    );

    // Carried into the execution half. Referenced here so the installation is
    // a real dependency of the run rather than a value the compiler can drop.
    void dispatchAckAcknowledgement;

    const preparation = await prepareHostUpdate({
      environment,
      version: args.versionRequest ?? null,
      allowDowngrade: args.allowDowngrade,
      onProgress: (info) => ctx.progress(info),
    });
    const installedUpToDate =
      preparation.kind === "staged" &&
      preparation.download.outcome === "short-circuit" &&
      preparation.download.reason === "installed-up-to-date";
    const needsApply = !installedUpToDate;
    // "Installed" is a fact about `install.json`; "running" is a fact about the process.
    // The two disagree whenever the bytes were swapped by a caller that could not (or did not) restart the host - Desktop's launch reconcile runs `host apply --no-service` and then activates through SMAppService, and when that cycle parks the OLD host keeps serving on top of the NEW install record indefinitely.
    const activationReading = installedUpToDate
      ? await readActivationState(environment)
      : null;
    const activationDebt =
      activationReading !== null && activationReading.kind === "debt"
        ? activationReading
        : null;
    if (activationDebt !== null) {
      ctx.runtime.logger.info(
        "Host update found the install record ahead of the running host; activating",
        {
          environment,
          installedVersion: activationDebt.installedVersion,
          runningVersion: activationDebt.runningVersion,
        },
      );
    }
    const needsActivate = activationDebt !== null;
    const needsWork = needsApply || needsActivate;

    // A `failed` marker outlives the failure it reported: the post-swap health probe can time out on a host that finishes starting a moment later, and nothing on the legacy path ever revisits the file.
    // Every cannot clear it because a retry with nothing to do returns before the marker is touched.
    if (
      !needsWork &&
      activationReading !== null &&
      activationReading.kind === "activated"
    ) {
      await clearStaleFailedMarker(ctx.runtime.logger, environment);
    }

    // Remote Host Support T16: the daemon polls `update-progress.json` and folds it into `host.status@1.1` / the drain gate, so an update that is in flight (or that failed) is visible to a remote client that cannot watch this process.
    // Written BEFORE the apply half touches the install and terminated on every exit path below.
    const targetVersion =
      activationDebt !== null
        ? activationDebt.installedVersion
        : preparation.kind === "downgrade"
          ? preparation.version
          : downloadTargetVersion(preparation.download);
    // The marker THIS invocation wrote, kept so the clear at the end can be conditional on it: marker writes happen before their writer takes the contender lock, so by the time this command reaches its clear another updater may have landed its own `updating` at the same path, and an unconditional delete would erase that updater's only progress signal.
    let writtenMarker: HostUpdateProgress | null = null;
    if (needsWork) {
      writtenMarker = progressRecord({
        state: "updating",
        error: null,
        targetVersion,
      });
      await writeUpdateProgressMarkerSafely(
        ctx.runtime.logger,
        environment,
        writtenMarker,
      );
    }

    let legacy: LegacyHostUpdateResult;
    // What was decided BEFORE the lock is whether to enter the activation path; what happened UNDER it is a separate fact, because the debt can clear (another actor restarted the host) or the record can move (another actor installed) while this command waits for admission.
    // The health probe and the failed-marker stamp below belong to work that was actually performed: probing a host this command never touched, and stamping the no-op `failed` when that probe misses, would report a failure for an update that did not happen.
    let activationPerformed = false;
    // The version the progress marker names.
    // Written pre-lock from the record as it stood; re-pointed when the activation path finds the record moved under the lock, so a `failed` stamp names the version that was actually being activated.
    let markerTargetVersion = targetVersion;
    try {
      if (activationDebt !== null) {
        const activation = await activateInstalledAndProjectLegacy(
          environment,
          args.force,
          activationDebt.runningVersion,
          async (installedVersion) => {
            if (installedVersion === markerTargetVersion) return;
            const repointed = progressRecord({
              state: "updating",
              error: null,
              targetVersion: installedVersion,
            });
            // Ownership-aware like every other write after the first: a newer updater's pre-lock `updating` may already sit at the path, and an unconditional re-point would replace it with a record THIS run then clears at the end - leaving that updater's whole apply/restart without its progress signal.
            // The re-point lands only over this run's own marker, and `writtenMarker` follows what is actually on disk: if the swap reports the marker is no longer ours, it stays pointed at the old record, so the later stamp and clear (both conditional on it) leave the newer updater's marker alone.
            if (writtenMarker === null) {
              writtenMarker = repointed;
              markerTargetVersion = installedVersion;
              await writeUpdateProgressMarkerSafely(
                ctx.runtime.logger,
                environment,
                repointed,
              );
              return;
            }
            const outcome = await replaceUpdateProgressMarkerIfUnchanged(
              environment,
              writtenMarker,
              repointed,
            );
            if (outcome === "replaced") {
              writtenMarker = repointed;
              markerTargetVersion = installedVersion;
            } else {
              ctx.runtime.logger.info(
                "Host update did not re-point the progress marker - another updater owns it now",
                { environment, installedVersion },
              );
            }
          },
        );
        legacy = activation.legacy;
        activationPerformed = activation.activated;
      } else {
        legacy =
          preparation.kind === "staged"
            ? await applyAndProjectLegacy(
                environment,
                args.force,
                needsApply,
                (info) => ctx.progress(info),
              )
            : projectApplied(
                await installHostDowngrade({
                  environment,
                  version: preparation.version,
                  force: args.force,
                  onProgress: (info) => ctx.progress(info),
                }),
              );
      }
    } catch (err) {
      if (needsWork) {
        await markUpdateFailed(
          ctx.runtime.logger,
          environment,
          markerTargetVersion,
          err instanceof Error ? err.message : String(err),
          writtenMarker,
        );
      }
      throw err;
    }

    const workPerformed = needsApply || activationPerformed;
    if (workPerformed) {
      // Verify the host the swap just installed actually comes back before reporting success: a binary that commits cleanly but never listens is exactly the failure the marker exists to surface remotely.
      // NOTE: this does NOT roll back.
      const probe = await probeHostHealth({
        environment,
        checkProcessAlive: null,
        checkTcpReachable: null,
        totalBudgetMs: null,
        retryDelayMs: null,
      });
      if (!probe.healthy) {
        await markUpdateFailed(
          ctx.runtime.logger,
          environment,
          legacy.version,
          probe.detail,
          writtenMarker,
        );
        throw cliError({
          code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
          message: `host update: applied ${legacy.version} but the host did not become healthy: ${probe.detail}`,
          details: { environment, version: legacy.version },
          exitCode: 1,
        });
      }
    }
    if (writtenMarker !== null) {
      // Written above whenever work was OWED, so it is cleared whenever it was - including the activation debt that another actor paid while this command waited, which leaves nothing to probe but a marker that still says `updating`.
      // Cleared CONDITIONALLY: the lock has been released by now, and a third updater writes its `updating` before it waits for that lock, so a marker that is no longer the one written above belongs to someone whose update is still to come.
      const cleared = await deleteUpdateProgressMarkerIfUnchanged(
        environment,
        writtenMarker,
      );
      if (cleared === "changed") {
        ctx.runtime.logger.info(
          "Host update left the progress marker in place - another updater owns it now",
          { environment },
        );
      } else if (cleared === "absent") {
        // Either this run's own write never landed (already warned) or
        // something else removed it; nothing is left to report on.
        ctx.runtime.logger.info(
          "Host update found no progress marker to clear",
          { environment },
        );
      }
    }

    ctx.runtime.logger.info("Host update command completed", {
      environment,
      downloadOutcome:
        preparation.kind === "staged"
          ? preparation.download.outcome
          : "explicit-downgrade",
      version: legacy.version,
      changed: legacy.previousVersion !== legacy.version,
      activatedInstalled: activationPerformed,
      activationClearedWhileWaiting: needsActivate && !activationPerformed,
      hasPostSwapError: legacy.serviceLifecycle.postSwapError !== null,
    });
    return {
      data: legacy,
      human: humanSummary(legacy),
      exitCode: 0,
    };
  };
}

type HostUpdatePreparation =
  | { readonly kind: "downgrade"; readonly version: string }
  | { readonly kind: "staged"; readonly download: HostDownloadOutcome };

/** The install record and the live process disagree about the version. */
interface ActivationDebt {
  readonly kind: "debt";
  readonly installedVersion: string;
  readonly runningVersion: string;
}

/** Install record vs live process. Do not treat a healthy probe as proof of the applied version. */
type ActivationReading =
  | { readonly kind: "no-install" }
  | { readonly kind: "no-live-host"; readonly installedVersion: string }
  | { readonly kind: "foreign-runtime" }
  | { readonly kind: "activated" }
  | ActivationDebt;

/** Bytes committed but not serving still owe activation. Already-serving at target short-circuits. */
async function readActivationState(
  environment: Environment,
): Promise<ActivationReading> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) return { kind: "no-install" };
  const running = await readHostPidMetadata(environment);
  if (running === null) {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  // The published identity verdict, not bare pid liveness: a `pid.json` that survived a crash names a pid the OS may since have handed to an unrelated process, and `isProcessAlive` would call that occupant the host.
  // With a differing recorded version that reads as debt (and the busy gate then fails against a stale endpoint); with a matching one it reads as activated and would clear a `failed` marker over no host at all.
  const identity = await getPublishedProcessIdentityVerdict(
    running.pid,
    running.processStartIdentity,
  );
  if (identity === "dead" || identity === "mismatch") {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  if (installed.runtimeVersion !== null) {
    // Runtime-stamp domain: equality decides, and the STAMPS are not required to be SemVer.
    // A staging host publishes `staging.<epoch>.<sha>` and the record keeps that same stamp (`readExtractedRuntimeVersion`), so a SemVer guard applied before this comparison would classify every staging host as foreign and turn both its activated and its indebted states into no-ops.
    return running.version === installed.runtimeVersion
      ? { kind: "activated" }
      : {
          kind: "debt",
          installedVersion: installed.version,
          runningVersion: running.version,
        };
  }
  // Catalog-version domain (a record with no runtime stamp yet): the release-version policy applies.
  // A running version that is not a release version is not a host this command reasons about.
  if (!isValidHostVersion(running.version)) return { kind: "foreign-runtime" };
  const comparison = compareHostVersions(running.version, installed.version);
  if (!comparison.comparable || comparison.ordering === "equal") {
    return { kind: "activated" };
  }
  return {
    kind: "debt",
    installedVersion: installed.version,
    runningVersion: running.version,
  };
}

/** Remove a `failed` progress marker that the observed state contradicts. The delete is CONDITIONAL on the marker still being the `failed` record that was read: another updater racing this no-op can replace it with a live `updating` in between, and deleting that would erase the legacy path's only progress signal for the whole download → swap → restart. */
async function clearStaleFailedMarker(
  logger: ILogger,
  environment: Environment,
): Promise<void> {
  const marker = await readUpdateProgressMarker(environment);
  if (marker === null || marker.state !== "failed") return;
  const outcome = await deleteUpdateProgressMarkerIfUnchanged(
    environment,
    marker,
  );
  if (outcome === "cleared") {
    logger.info(
      "Host update cleared a stale failed progress marker - the running host is at the installed version",
      { environment, staleTargetVersion: marker.targetVersion },
    );
  } else {
    logger.info(
      "Host update left the progress marker alone - it changed under the stale-failure check",
      { environment, outcome },
    );
  }
}

/** Activation half of an already-committed update: stop, start, probe. Do not restage. */
async function activateInstalledAndProjectLegacy(
  environment: Environment,
  force: boolean,
  lastSeenRunningVersion: string,
  onInstalledVersionUnderLock: (installedVersion: string) => Promise<void>,
): Promise<{
  readonly legacy: LegacyHostUpdateResult;
  readonly activated: boolean;
}> {
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "host-update-activate",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "legacy-update-shadow",
  };
  return withCliUpdateContender(contenderOptions, async (capability) => {
    // Re-read under the lock: BOTH halves the debt was computed from may have moved while this command waited for admission - the record through another apply, the running version through another actor's restart.
    // Decided BEFORE the busy gate: a host that is already current owes nothing, so its live work is no reason to fail the command (and stamp a failed marker) - it is the no-op, busy or not.
    const installed = await requireInstalled(environment);
    const reading = await readActivationState(environment);
    if (reading.kind !== "debt" && reading.kind !== "no-live-host") {
      return { legacy: projectNoOp(installed), activated: false };
    }
    const previousVersion =
      reading.kind === "debt" ? reading.runningVersion : lastSeenRunningVersion;
    await onInstalledVersionUnderLock(installed.version);
    // Same gate `applyHost` runs before it touches anything: a host with live work is not restarted under it unless the caller said `--force`.
    // A host that is gone has no work to protect, so the gate is not asked.
    if (!force && reading.kind === "debt") {
      await assertHostNotBusy(environment);
    }
    // The stop → relaunch pair `host restart` drives, with `force` threaded into the stop half.
    // The busy gate above is only the pre-check: on a Desktop-managed macOS host the stop itself claims a cooperative stand-down that a busy host denies, so a `--force` that skipped the gate but not the claim would still fail to activate - in precisely the recovery case `host update --force` exists for.
    const controller = createServiceController();
    const label = serviceLabelFor(environment);
    const stopped = await stopHostForRestartWithAttempt(
      capability,
      contenderOptions,
      controller,
      label,
      { force },
    );
    await relaunchHostAfterRestartWithAttempt(
      capability,
      contenderOptions,
      controller,
      label,
      stopped,
    );
    return {
      legacy: {
        ...projectNoOp(installed),
        previousVersion,
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: false,
          postSwapAction: "restart",
          postSwapError: null,
        },
      },
      activated: true,
    };
  });
}

async function prepareHostUpdate(input: {
  readonly environment: Environment;
  readonly version: string | null;
  readonly allowDowngrade: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
}): Promise<HostUpdatePreparation> {
  if (input.allowDowngrade && input.version !== null) {
    const installed = await requireInstalled(input.environment);
    const comparison = compareHostVersions(input.version, installed.version);
    if (comparison.comparable && comparison.ordering === "less") {
      // Reconciliation deliberately deletes older shared stages. The explicit
      // install keeps its verified source private until the locked swap.
      return { kind: "downgrade", version: input.version };
    }
  }
  return {
    kind: "staged",
    download: await downloadAndStageHost({
      environment: input.environment,
      versionRequest: input.version,
      automatic: false,
      onProgress: input.onProgress,
      registryClient: null,
    }),
  };
}

// Every `HostDownloadOutcome` branch names the version this invocation was
// working toward; `promoted` reports it as the staged version it just placed.
function downloadTargetVersion(outcome: HostDownloadOutcome): string {
  return outcome.outcome === "promoted"
    ? outcome.stagedVersion
    : outcome.targetVersion;
}

async function writeUpdateProgressMarkerSafely(
  logger: ILogger,
  environment: Environment,
  progress: Parameters<typeof writeUpdateProgressMarker>[1],
): Promise<void> {
  try {
    await writeUpdateProgressMarker(environment, progress);
  } catch (err) {
    logger.warn("Host update failed to persist progress marker", {
      environment,
      state: progress.state,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

// Terminates the "updating" marker with the real cause so the daemon reports
// a failed update instead of an update that appears to still be running.
/** Stamp this invocation's failure - but only over ITS OWN marker. Marker writes precede their writer's lock acquisition, so by the time this command fails another updater may already have landed its `updating` at the same path. */
async function markUpdateFailed(
  logger: ILogger,
  environment: Environment,
  targetVersion: string,
  error: string,
  ours: HostUpdateProgress | null,
): Promise<void> {
  const failed = progressRecord({ state: "failed", error, targetVersion });
  if (ours === null) {
    await writeUpdateProgressMarkerSafely(logger, environment, failed);
    return;
  }
  // One atomic compare-and-swap, not a read followed by a write: the other updater's `updating` can land between those two, and the write would then bury it under this failure for the whole of its update.
  const outcome = await replaceUpdateProgressMarkerIfUnchanged(
    environment,
    ours,
    failed,
  );
  if (outcome !== "replaced") {
    logger.info(
      "Host update did not stamp its failure - another updater owns the progress marker now",
      { environment, outcome },
    );
  }
}

async function applyAndProjectLegacy(
  environment: Environment,
  force: boolean,
  needsApply: boolean,
  onProgress: (info: ProgressInfo) => void,
): Promise<LegacyHostUpdateResult> {
  // ONE options value for acquisition and revalidation: two literals that
  // must stay identical are how admission policies drift.
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "host-update-apply",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "legacy-update-shadow",
  };
  return withCliUpdateContender(contenderOptions, async (capability) => {
    if (!needsApply) {
      return projectNoOp(await requireInstalled(environment));
    }
    let outcome: ApplyHostOutcome;
    try {
      outcome = await applyHostWithAttempt(capability, contenderOptions, {
        environment,
        force,
        noService: false,
        expectedStageFingerprint: null,
        onProgress,
      });
    } catch (err) {
      if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
        // The stage was left intact by `applyHost`'s own busy check (it runs before any commit) - read it HERE, still inside the same lock span `applyHost`'s busy decision was made under (never re-acquired), so the reported version can't have changed out from under the decision the way a read after this call's own lock release could.
        // D6's "staged-version details in the error payload" contract needs this coherence, not just a value.
        const staged = await readHostStagedRecord(environment);
        throw cliError({
          code: CLI_ERROR_CODES.HOST_BUSY,
          message: err.message,
          details: { stagedVersion: staged?.version ?? null },
          exitCode: err.exitCode,
        });
      }
      throw err;
    }
    if (outcome.outcome === "no-op") {
      // Still holding the same lock `applyHost` itself ran under (it assumes the caller holds `cli-lock`, never re-acquires) - this re-read observes exactly the state `applyHost` had internal access to but didn't return, not a fresh race.
      return projectNoOp(await requireInstalled(environment));
    }
    if (outcome.outcome === "stage-fingerprint-mismatch") {
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: "host update: staged handoff changed unexpectedly",
        details: {
          expectedStageFingerprint: outcome.expectedStageFingerprint,
          actualStageFingerprint: outcome.actualStageFingerprint,
        },
        exitCode: 1,
      });
    }
    return projectApplied(outcome);
  });
}

async function requireInstalled(
  environment: Environment,
): Promise<HostInstallRecord> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host update: no host installed for environment=${environment}; run 'traycer host install' first`,
      details: { environment },
      exitCode: 1,
    });
  }
  return installed;
}

function projectNoOp(installed: HostInstallRecord): LegacyHostUpdateResult {
  return {
    version: installed.version,
    installedAt: installed.installedAt,
    executablePath: installed.executablePath,
    source: installed.source,
    archiveSha256: installed.archiveSha256,
    signatureKeyId: installed.signatureKeyId,
    sizeBytes: installed.sizeBytes,
    previousVersion: installed.version,
    serviceLifecycle: NO_SERVICE_ACTION_LIFECYCLE,
  };
}

function projectApplied(
  outcome: Extract<ApplyHostOutcome, { outcome: "applied" }>,
): LegacyHostUpdateResult {
  return {
    version: outcome.record.version,
    installedAt: outcome.record.installedAt,
    executablePath: outcome.record.executablePath,
    source: outcome.record.source,
    archiveSha256: outcome.record.archiveSha256,
    signatureKeyId: outcome.record.signatureKeyId,
    sizeBytes: outcome.record.sizeBytes,
    previousVersion: outcome.previous?.version ?? null,
    serviceLifecycle:
      outcome.serviceLifecycle === null
        ? NO_SERVICE_ACTION_LIFECYCLE
        : {
            ...outcome.serviceLifecycle,
            priorServiceState: toLegacyPriorServiceState(
              outcome.serviceLifecycle.priorServiceState,
            ),
            postSwapError: outcome.postSwapError,
          },
  };
}

// `LegacyHostUpdateServiceLifecycle` is a pinned, frozen wire shape (see the module doc comment) - it must not silently grow to track new `ServiceState` variants.
// `externally-managed` (macOS SMAppService-owned label, added after this shape was pinned) has no legacy equivalent; degrade it to `not-installed` exactly as Desktop's own `projectInstallResult` reader already degrades any `priorServiceState` value outside its own three-way union, so the projected wire value matches what an old-CLI payload would already read as.
function toLegacyPriorServiceState(
  state: "running" | "stopped" | "not-installed" | "externally-managed",
): "running" | "stopped" | "not-installed" {
  return state === "externally-managed" ? "not-installed" : state;
}

function humanSummary(legacy: LegacyHostUpdateResult): string {
  if (legacy.previousVersion === legacy.version) {
    return `host already at ${legacy.version} (no-op)`;
  }
  if (legacy.serviceLifecycle.postSwapError !== null) {
    return `updated host to ${legacy.version}; service did not converge: ${legacy.serviceLifecycle.postSwapError}`;
  }
  return `updated host ${legacy.previousVersion ?? "?"} → ${legacy.version}`;
}
