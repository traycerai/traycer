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
  readUpdateProgressMarker,
  sameProgress,
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

// `traycer host update [--version X] [--force]` - the composite (Host Update Layer
// Redesign Tech Plan, "New/changed commands" > `host update`, D6): stage
// whatever `latest` requires (reusing an existing stage, explicit-
// incomparable policy - a `local-*` install proceeds), then promote it.
// `downloadAndStageHost` runs its OWN brief lock spans internally (no
// network transfer ever runs under `cli-lock` - plan rule 1); only the
// apply half below acquires the lock, matching `host apply`'s own
// contract that the caller holds it across reconcile/read/no-op/busy/
// commit. An explicit `--release X --allow-downgrade` below the installed
// version uses a private install source instead, with the same progress,
// mutation authority, busy checks, and post-swap health verification.
//
// Busy (D6): the stage is kept - `applyHost`'s busy check runs before it
// touches the stage - and this command re-throws `E_HOST_BUSY` with the
// staged version attached to `details`, rather than the generic
// `details: null` `assertHostNotBusy` throws on its own.
//
// SUCCESS CONTRACT: when an update is actually applied, exit 0 here means a
// host came back healthy after the swap. Two limits are deliberate and worth
// naming rather than overstating:
//   - an install already at the target whose RUNNING host is also at the
//     target short-circuits before the probe and re-checks nothing. When the
//     running host is NOT at the target (bytes committed by `host apply
//     --no-service` and never activated), this command owes the activation
//     and performs it - restart, marker, probe - see `readActivationState`;
//   - `probeHostHealth` asks "is the recorded pid alive and its port
//     accepting?" - it does not compare versions. On the Desktop-managed macOS
//     degraded path a surviving OLD host can answer it, so a healthy probe is
//     not by itself proof that the applied bytes are the ones serving.
//     `traycer host status` reports the running version.
// A version-comparing probe was tried and backed out: pid.json's version can
// lag a restart, so it turned successful updates into failures - a worse
// outcome than the narrower claim.
// The post-apply `probeHostHealth` below is what earns the claim when it runs,
// and a host that committed cleanly but never came back exits non-zero with
// `E_HOST_UPDATE_HEALTH_CHECK_FAILED` (no rollback - see the note at the
// probe). This is deliberately stronger than `host apply`'s exit 0, which
// promises only that the bytes committed; `commands/host-apply.ts` records
// why the low-level primitive must keep reporting "applied but not
// converged" as a successful, inspectable outcome instead of an error.
//
// Legacy wire-contract compat: Desktop's `host-management-ipc.ts` runs
// `host update`'s stdout through `projectInstallResult`, which reads a
// *flat* legacy shape off `data` (`version`, `installedAt`,
// `executablePath`, `source`, `archiveSha256`, `signatureKeyId`,
// `sizeBytes`, `previousVersion`, `serviceLifecycle`) and silently
// degrades every field to a fallback ("", 0, "none") if the shape
// changes - Desktop bundles a version-matched CLI (D7), so "this CLI +
// Desktop's not-yet-rewired handler" is a real shipped pairing, not a
// hypothetical (D6's rejected-alternative note: "breaks the existing
// `HostInstallResult` projection mid-migration"). `host apply` is a
// brand-new command with no such consumer and is free to use
// `ApplyHostOutcome` directly (see `commands/host-apply.ts`); this
// compat boundary is scoped to `host update` alone - remove only when
// Desktop's `host update` invocation is deleted (post ticket-4 cleanup).
export interface HostUpdateArgs {
  /** Explicit installs may downgrade; automatic update callers never opt in. */
  readonly allowDowngrade: boolean;
  readonly force: boolean;
  /** `null` stages the latest registry version; an explicit value is a pin. */
  readonly versionRequest?: string | null;
  /**
   * Correlation nonce for the dispatch ACK (Ticket 07 §5.2.8), or `null` when
   * this run was not dispatched by a host resolver waiting to name the attempt.
   *
   * A nonce, never a token: it grants nothing, so argv is a legitimate carrier
   * for it. The child stamps it into the sibling ACK file at durable-claim
   * time, and the resolver accepts an ACK only when the nonce matches one it
   * minted for a child it spawned.
   *
   * Consumed at the schema-v2 executor's acknowledgement seam. That junction is
   * the CUTOVER: today `host update` runs the legacy path, whose contender
   * admission is `legacy-update-shadow` and which creates no schema-v2 attempt
   * to acknowledge, so a nonce passed now is carried and not stamped. That is
   * the same darkness the resolver's wait ships with, and the two flip together.
   */
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

// Matches `projectInstallResult`'s own fallback when `serviceLifecycle`
// is absent from the payload - used whenever this command's own
// operation took no service action (a genuine no-op) rather than
// hand-rolling an equivalent-but-distinct literal.
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

    // Ticket 07 §5.2.8. FIRST, before `downloadAndStageHost` writes anything:
    // a run dispatched with a nonce this build cannot honour has already lost
    // the correlation its caller is waiting on, and discovering that after
    // staging bytes would mean doing destructive work for a dispatch that can
    // only ever report indeterminate.
    //
    // The returned callback is the executor segment's `acknowledge` hook, so
    // the stamp lands after the claim is durable rather than beside it.
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
    // "Installed" is a fact about `install.json`; "running" is a fact about
    // the process. The two disagree whenever the bytes were swapped by a
    // caller that could not (or did not) restart the host - Desktop's launch
    // reconcile runs `host apply --no-service` and then activates through
    // SMAppService, and when that cycle parks the OLD host keeps serving on
    // top of the NEW install record indefinitely. This command then answered
    // "installed-up-to-date" to a Settings click made precisely BECAUSE the
    // live version was behind, exited 0 having changed nothing, and the GUI
    // toasted "Updating…" over a host that never moved. Activation debt is
    // therefore an update this command owes, not a no-op it may report.
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

    // A `failed` marker outlives the failure it reported: the post-swap
    // health probe can time out on a host that finishes starting a moment
    // later, and nothing on the legacy path ever revisits the file. Every
    // @1.3 host then renders that stale failure indefinitely, and a retry
    // cannot clear it because a retry with nothing to do returns before the
    // marker is touched. So the no-work path reconciles it here - and ONLY
    // when the running host has been OBSERVED at the installed version. A
    // host that is down, or a dev build, leaves the marker alone: for those
    // the failure may still be exactly true.
    if (
      !needsWork &&
      activationReading !== null &&
      activationReading.kind === "activated"
    ) {
      await clearStaleFailedMarker(ctx.runtime.logger, environment);
    }

    // Remote Host Support T16: the daemon polls `update-progress.json` and
    // folds it into `host.status@1.1` / the drain gate, so an update that is
    // in flight (or that failed) is visible to a remote client that cannot
    // watch this process. Written BEFORE the apply half touches the install
    // and terminated on every exit path below. Marker I/O is deliberately
    // never allowed to fail the update itself - a missing marker degrades
    // the remote progress readout, it must not break the local update.
    const targetVersion =
      activationDebt !== null
        ? activationDebt.installedVersion
        : preparation.kind === "downgrade"
          ? preparation.version
          : downloadTargetVersion(preparation.download);
    // The marker THIS invocation wrote, kept so the clear at the end can be
    // conditional on it: marker writes happen before their writer takes the
    // contender lock, so by the time this command reaches its clear another
    // updater may have landed its own `updating` at the same path, and an
    // unconditional delete would erase that updater's only progress signal.
    let writtenMarker: HostUpdateProgress | null = null;
    if (needsWork) {
      writtenMarker = {
        state: "updating",
        error: null,
        targetVersion,
        updatedAt: new Date().toISOString(),
      };
      await writeUpdateProgressMarkerSafely(
        ctx.runtime.logger,
        environment,
        writtenMarker,
      );
    }

    let legacy: LegacyHostUpdateResult;
    // What was decided BEFORE the lock is whether to enter the activation
    // path; what happened UNDER it is a separate fact, because the debt can
    // clear (another actor restarted the host) or the record can move
    // (another actor installed) while this command waits for admission. The
    // health probe and the failed-marker stamp below belong to work that was
    // actually performed: probing a host this command never touched, and
    // stamping the no-op `failed` when that probe misses, would report a
    // failure for an update that did not happen.
    let activationPerformed = false;
    // The version the progress marker names. Written pre-lock from the
    // record as it stood; re-pointed when the activation path finds the
    // record moved under the lock, so a `failed` stamp names the version
    // that was actually being activated.
    let markerTargetVersion = targetVersion;
    try {
      if (activationDebt !== null) {
        const activation = await activateInstalledAndProjectLegacy(
          environment,
          args.force,
          activationDebt.runningVersion,
          async (installedVersion) => {
            if (installedVersion === markerTargetVersion) return;
            markerTargetVersion = installedVersion;
            writtenMarker = {
              state: "updating",
              error: null,
              targetVersion: installedVersion,
              updatedAt: new Date().toISOString(),
            };
            await writeUpdateProgressMarkerSafely(
              ctx.runtime.logger,
              environment,
              writtenMarker,
            );
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
      // Verify the host the swap just installed actually comes back before
      // reporting success: a binary that commits cleanly but never listens
      // is exactly the failure the marker exists to surface remotely.
      //
      // NOTE: this does NOT roll back. `applyHost` documents an explicit
      // no-rollback contract for the staged layer, so a failed probe is
      // reported (marker + E_HOST_UPDATE_HEALTH_CHECK_FAILED) and left for
      // an operator/next apply rather than silently reverted here.
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
      // Written above whenever work was OWED, so it is cleared whenever it
      // was - including the activation debt that another actor paid while
      // this command waited, which leaves nothing to probe but a marker
      // that still says `updating`. Cleared CONDITIONALLY: the lock has been
      // released by now, and a third updater writes its `updating` before it
      // waits for that lock, so a marker that is no longer the one written
      // above belongs to someone whose update is still to come.
      const cleared = await deleteUpdateProgressMarkerIfUnchanged(
        environment,
        writtenMarker,
      );
      if (cleared !== "cleared") {
        ctx.runtime.logger.info(
          "Host update left the progress marker in place - another updater owns it now",
          { environment, outcome: cleared },
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

/**
 * What the install record and the live process say about each other. Every
 * reading is named rather than collapsed to "debt or not", because the two
 * places that consult it need different things from the non-debt cases:
 * before the lock, only `debt` is a reason to act; under the lock, `debt`
 * and `no-live-host` both are, while `activated` is the reason NOT to.
 *
 * - `no-install`: nothing to activate (the caller throws later anyway);
 * - `no-live-host`: no pid metadata, or a pid that is not alive. Before the
 *   lock this is left alone - a host that is DOWN is the service manager's
 *   problem, and `host start` re-resolves the install record on every spawn.
 *   Under the lock, after a debt was seen, it means the host this command
 *   was about to replace is gone, which is not the same as replaced;
 * - `foreign-runtime`: a running version that is not a release version. A
 *   `local-*` dev build is not a host this command reasons about, whatever
 *   the record says;
 * - `activated`: the committed archive is what is running;
 * - `debt`: the record and the process disagree.
 */
type ActivationReading =
  | { readonly kind: "no-install" }
  | { readonly kind: "no-live-host"; readonly installedVersion: string }
  | { readonly kind: "foreign-runtime" }
  | { readonly kind: "activated" }
  | ActivationDebt;

/**
 * Read the activation state of the committed install.
 *
 * "Match" is decided in the RUNTIME identity domain when the record has one.
 * `pid.json` publishes the version the host binary reports about itself,
 * and the install record keeps that same stamp as `runtimeVersion` (read
 * from the extracted archive, or stamped after its first run) precisely
 * because it can differ from the catalog `version` the caller asked for -
 * an older CLI installing a newer archive, a build whose self-reported
 * version carries a suffix the manifest does not. Ordering those two
 * domains by SemVer would skip a needed restart when they happen to read
 * equal, or restart a correctly activated host on every run when they do
 * not; equality of runtime stamps is the test Desktop uses, and it is the
 * one used here. Only a record with no runtime stamp yet falls back to the
 * catalog version, compared with the same comparator the update decision
 * itself uses (comparable and unequal).
 *
 * The comparison is on VERSION rather than on install generation because
 * `pid.json` publishes the version and nothing finer; a swap to the same
 * version (re-install of identical bytes) is invisible here, and restarting
 * for it would be gratuitous.
 *
 * Either direction of inequality is debt. A downgrade that was committed but
 * never activated leaves the running host AHEAD of the record, and the record
 * is what the operator asked for.
 */
async function readActivationState(
  environment: Environment,
): Promise<ActivationReading> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) return { kind: "no-install" };
  const running = await readHostPidMetadata(environment);
  if (running === null) {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  // The published identity verdict, not bare pid liveness: a `pid.json` that
  // survived a crash names a pid the OS may since have handed to an unrelated
  // process, and `isProcessAlive` would call that occupant the host. With a
  // differing recorded version that reads as debt (and the busy gate then
  // fails against a stale endpoint); with a matching one it reads as
  // activated and would clear a `failed` marker over no host at all. The
  // verdict compares the process start stamp `pid.json` published and
  // reports `mismatch` for exactly that impostor. `indeterminate` (a record
  // that predates the stamp, or a failed OS probe) keeps the host, the same
  // fail-open reading every other consumer of the verdict takes.
  const identity = await getPublishedProcessIdentityVerdict(
    running.pid,
    running.processStartIdentity,
  );
  if (identity === "dead" || identity === "mismatch") {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  if (!isValidHostVersion(running.version)) return { kind: "foreign-runtime" };
  if (installed.runtimeVersion !== null) {
    if (running.version === installed.runtimeVersion) {
      return { kind: "activated" };
    }
  } else {
    const comparison = compareHostVersions(running.version, installed.version);
    if (!comparison.comparable || comparison.ordering === "equal") {
      return { kind: "activated" };
    }
  }
  return {
    kind: "debt",
    installedVersion: installed.version,
    runningVersion: running.version,
  };
}

/**
 * Remove a `failed` progress marker that the observed state contradicts.
 *
 * The delete is CONDITIONAL on the marker still being the `failed` record
 * that was read: another updater racing this no-op can replace it with a
 * live `updating` in between, and deleting that would erase the legacy
 * path's only progress signal for the whole download → swap → restart. A
 * lock would not close the window (the `updating` write precedes its
 * writer's lock acquisition), so the marker module re-reads and compares
 * immediately before the unlink. Marker I/O never fails the command (same
 * rule as the writes).
 */
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

/**
 * The activation half of an update whose bytes are already committed: stop
 * the running host and relaunch it from the install record, under the same
 * busy gate and the same contender admission a full apply runs under.
 *
 * `controller.restart` is the SAME actuator `host restart` uses, so a
 * Desktop-managed macOS agent is restarted cooperatively (claim → commit →
 * kickstart) rather than by a `launchctl` the CLI does not own - and the
 * supervisor it relaunches re-resolves the install record on spawn, which is
 * what turns "committed" into "running".
 *
 * Projected as an UPDATE, not a no-op: `previousVersion` is the version that
 * was serving, so the human summary and Desktop's legacy projection both say
 * `rc.1 → rc.2`, which is what actually happened from the operator's seat.
 *
 * The debt the caller detected is deliberately NOT a parameter: it was read
 * outside the contender lock, and `host restart` shares that lock. Desktop's
 * parked-registration fallback runs exactly that command on exactly this
 * host, so a Settings click that arrives while it holds the lock would
 * otherwise wait its turn and then restart a host that had just come up on
 * the committed bytes - costing it its connections and reporting a
 * `rc.1 → rc.2` transition that the other actor performed. The debt is
 * re-derived under the lock and a cleared debt is the plain no-op.
 *
 * `activated` tells the caller which of the two happened, because the two
 * need different aftercare (a health probe for a restart, none for a no-op).
 * `onInstalledVersionUnderLock` is called with the record's version as read
 * under the lock, before anything is restarted, so the caller can re-point a
 * progress marker it wrote from the pre-lock record if another actor
 * installed a different version in between.
 *
 * A debt is CLEARED only by observing the running host at the installed
 * version. A host that is simply gone under the lock - it exited, crashed,
 * or is mid-relaunch and has not republished `pid.json` - is not cleared
 * debt: reporting the no-op there would skip the health probe, delete the
 * marker and exit 0 over a host that may never come back. That case is
 * relaunched through the same stop → relaunch pair (the stop half treats an
 * absent host as a recycle, not an error), so the caller's probe verifies
 * that the committed bytes are actually serving. `lastSeenRunningVersion`
 * is what was serving when the debt was detected, and is the best available
 * fact about "before" for that report.
 */
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
    // Re-read under the lock: BOTH halves the debt was computed from may have
    // moved while this command waited for admission - the record through
    // another apply, the running version through another actor's restart.
    // Decided BEFORE the busy gate: a host that is already current owes
    // nothing, so its live work is no reason to fail the command (and stamp
    // a failed marker) - it is the no-op, busy or not.
    const installed = await requireInstalled(environment);
    const reading = await readActivationState(environment);
    if (reading.kind !== "debt" && reading.kind !== "no-live-host") {
      return { legacy: projectNoOp(installed), activated: false };
    }
    const previousVersion =
      reading.kind === "debt" ? reading.runningVersion : lastSeenRunningVersion;
    await onInstalledVersionUnderLock(installed.version);
    // Same gate `applyHost` runs before it touches anything: a host with
    // live work is not restarted under it unless the caller said `--force`.
    // A host that is gone has no work to protect, so the gate is not asked.
    if (!force && reading.kind === "debt") {
      await assertHostNotBusy(environment);
    }
    // The stop → relaunch pair `host restart` drives, with `force` threaded
    // into the stop half. The busy gate above is only the pre-check: on a
    // Desktop-managed macOS host the stop itself claims a cooperative
    // stand-down that a busy host denies, so a `--force` that skipped the
    // gate but not the claim would still fail to activate - in precisely
    // the recovery case `host update --force` exists for. `stopForRestart`
    // also reports an unreachable host as a forced recycle instead of
    // throwing, so the relaunch below repairs it rather than aborting.
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
/**
 * Stamp this invocation's failure - but only over ITS OWN marker.
 *
 * Marker writes precede their writer's lock acquisition, so by the time
 * this command fails another updater may already have landed its `updating`
 * at the same path. That updater's run is the one whose outcome now matters;
 * stamping `failed` over its live marker would hide its progress for the
 * whole update and report a failure that is not about it. An absent marker
 * means nobody else is in flight, so the stamp still lands. `ours` is `null`
 * only when this run never wrote a marker, in which case there is nothing to
 * compare against and the stamp lands too.
 */
async function markUpdateFailed(
  logger: ILogger,
  environment: Environment,
  targetVersion: string,
  error: string,
  ours: HostUpdateProgress | null,
): Promise<void> {
  const current = await readUpdateProgressMarker(environment);
  if (current !== null && ours !== null && !sameProgress(current, ours)) {
    logger.info(
      "Host update did not stamp its failure - another updater owns the progress marker now",
      { environment, currentState: current.state },
    );
    return;
  }
  await writeUpdateProgressMarkerSafely(logger, environment, {
    state: "failed",
    error,
    targetVersion,
    updatedAt: new Date().toISOString(),
  });
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
        // The stage was left intact by `applyHost`'s own busy check (it
        // runs before any commit) - read it HERE, still inside the same
        // lock span `applyHost`'s busy decision was made under (never
        // re-acquired), so the reported version can't have changed out
        // from under the decision the way a read after this call's own
        // lock release could. D6's "staged-version details in the error
        // payload" contract needs this coherence, not just a value.
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
      // Still holding the same lock `applyHost` itself ran under
      // (it assumes the caller holds `cli-lock`, never re-acquires)
      // - this re-read observes exactly the state `applyHost` had
      // internal access to but didn't return, not a fresh race.
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

// `LegacyHostUpdateServiceLifecycle` is a pinned, frozen wire shape (see
// the module doc comment) - it must not silently grow to track new
// `ServiceState` variants. `externally-managed` (macOS SMAppService-owned
// label, added after this shape was pinned) has no legacy equivalent;
// degrade it to `not-installed` exactly as Desktop's own
// `projectInstallResult` reader already degrades any `priorServiceState`
// value outside its own three-way union, so the projected wire value
// matches what an old-CLI payload would already read as.
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
