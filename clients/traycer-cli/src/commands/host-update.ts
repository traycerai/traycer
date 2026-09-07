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
  claimUpdateProgressMarkerBeforeLock,
  type ConditionalMarkerDelete,
  type ConditionalMarkerReplace,
  createUpdateProgressMarkerIfAbsent,
  deleteUpdateProgressMarkerIfUnchanged,
  progressRecord,
  readUpdateProgressMarker,
  replaceUpdateProgressMarkerIfUnchanged,
  type HostUpdateProgress,
  sameProgress,
  updateProgressRecordHasProvenLiveWriter,
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
// version, or naming another build of its release, uses a private install
// source instead, with the same progress, mutation authority, busy checks,
// and post-swap health verification.
//
// Busy (D6): the stage is kept - `applyHost`'s busy check runs before it
// touches the stage - and this command re-throws `E_HOST_BUSY` with the
// staged version attached to `details`, rather than the generic
// `details: null` `assertHostNotBusy` throws on its own; the activation arm
// names a stage waiting beside the debt the same way. The downgrade arm's
// park carries `details: null`: its private stage is discarded by design. A busy exit is a
// PARK, not a failure: the run withdraws its own `updating` marker (or puts
// back the record it took over under the lock) and stamps no `failed` (see
// the catch below), because the refusal was the policy working and the
// surfaces derive "staged, waiting" / "installed, restart to finish" from
// the install and staged records instead.
//
// The `updating` marker is published from `onWillDownload` - after the
// short-circuit decision, before the first byte - so the whole transfer is
// visible as an update in progress and a transfer failure has a marker to
// stamp `failed` onto. The arms that do not go through that download stage
// (already staged, activation debt, and the explicit downgrade - which
// stages its own source under its own lock) publish it just before their
// apply half instead.
//
// SUCCESS CONTRACT: when an update is actually applied, exit 0 here means a
// host came back healthy after the swap. Two limits are deliberate and worth
// naming rather than overstating:
//   - an install already at the target whose RUNNING host is also at the
//     target short-circuits before the probe and re-checks nothing. When the
//     running host is NOT at the target (bytes committed by `host apply
//     --no-service` and never activated), this command owes the activation
//     and performs it - restart, marker, probe - see `readActivationState`.
//     The same debt can appear AFTER the lock wait: a stage this run
//     promoted and then found consumed by such an apply is re-derived and
//     activated the same way (see the staged arm) - for an explicit
//     request, only when the committed record IS the requested version
//     (`installedVersionMismatch`);
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

    // Remote Host Support T16: the daemon polls `update-progress.json` and
    // folds it into `host.status@1.1` / the drain gate, so an update that is
    // in flight (or that failed) is visible to a remote client that cannot
    // watch this process. Written the moment the work becomes certain and
    // terminated on every exit path below. Marker I/O is deliberately never
    // allowed to fail the update itself - a missing marker degrades the
    // remote progress readout, it must not break the local update.
    //
    // The marker THIS invocation wrote (or, under the lock, took over), kept
    // so every later write is conditional on it: marker writes happen before
    // their writer takes the contender lock, so by the time this command
    // reaches its stamp or clear another updater may have landed its own
    // `updating` at the same path, and an unconditional write would erase
    // that updater's only progress signal. Non-null only once a record of
    // this run's has actually landed - published before the lock, or taken
    // over / created under it - and null while the pre-lock claim deferred
    // to another writer's live marker or failed to land (warned about, not
    // retried). The version it names is the one a `failed` stamp has to
    // name too, which is why the re-point under the lock replaces the whole
    // record rather than one field.
    //
    // It is a CLAIM about the disk, not a fact: every write, the pre-lock
    // publish included, is conditional on what the path held. The one place
    // the claim is turned into a fact is `reassertMarkerUnderLock` below,
    // which runs under the contender lock and makes the path this run's
    // whatever it holds by then - by conditional replace or conditional
    // create, never by a blind write.
    const ownMarker: { current: HostUpdateProgress | null } = { current: null };
    // A LIVE writer's record that `reassertMarkerUnderLock` displaced when
    // it took the marker over, kept for one purpose: an exit that follows
    // the takeover WITHOUT this run having disturbed the host - a busy park
    // (the stop's cooperative stand-down claim can still be denied past the
    // busy gate) or a failure before the stop - puts it back, because that
    // writer's update is the one still in progress and removing its record
    // would hide the whole update until its own re-assert. Only a record
    // with a PROVEN live writer (`updateProgressRecordHasProvenLiveWriter`:
    // the pid is alive and, where the record carries the writer's creation
    // stamp, belongs to the process that wrote it) is retained here. Every
    // other record - a `failed`, an `updating` whose writer is dead (or
    // whose pid the OS recycled onto an unrelated process), or one whose
    // writer is UNKNOWN (no id, an unparseable id, a probe that could not
    // answer) - is replaced and GONE at the takeover. The pre-lock claim treats
    // the unknown-writer case the other way round (it DEFERS, fail-open,
    // since it holds no lock and may not stamp over a possibly-live
    // update); under the lock this run is the owner and a record it
    // cannot prove alive is not worth re-planting. Put back on a park such
    // a record re-plants a dead writer's
    // `updating` that nobody will ever clear (a host without dead-writer
    // suppression renders it for as long as the park lives) or paints an
    // earlier attempt's `failed` over the staged-wait park the GUI derives
    // from the records; put back on a failure it reports the earlier
    // attempt's cause, and target, over this run's own. The one thing a
    // dropped `failed` could still have told a reader - an earlier
    // attempt's post-swap probe miss, say - is carried by the records
    // the park is derived from: a park means the host is up and answering,
    // and the install record beside the running version is what the GUI
    // renders as activation debt or a staged wait. That loss is accepted
    // here, and the takeover logs the record's state and target. The
    // restore is not loss-free in one corner: a live writer that finished
    // while its record was displaced found the path changed, left it, and
    // exited, so the restored record has no writer left to clear it. The
    // host side suppresses an `updating` whose writer id names a dead pid,
    // which is what makes that corner the lesser harm - and why only a
    // record with a PROVEN live writer is retained at all: one with no
    // writer id (an older CLI) the host renders forever, and restoring it
    // would re-plant exactly that.
    const displacedMarker: { current: HostUpdateProgress | null } = {
      current: null,
    };
    // The record as the park and failure arms consume it: retained at the
    // takeover while its writer was proven live, and proven live STILL at
    // the moment of the restore - otherwise treated as no record at all.
    const liveDisplacedRecord = (
      record: HostUpdateProgress | null,
    ): HostUpdateProgress | null =>
      record !== null && updateProgressRecordHasProvenLiveWriter(record)
        ? record
        : null;
    // The version this run is working toward, as last announced to the
    // marker (pre-lock claim, or the re-point under the lock). Kept apart
    // from `ownMarker` because a run whose claim DEFERRED holds no record
    // and still has a target to name if it fails.
    const intendedTarget: { current: string | null } = { current: null };
    // The pre-lock publish. NOT a blind write: the path may hold the marker
    // of the updater currently holding the contender lock, mid-swap, and a
    // write over it would leave that updater's stamp and clear (CAS against
    // its own record) unable to land while this run's later `failed` on a
    // lost download stood over a live mutation as a terminal outcome. The
    // claim lands only into an empty path or over a record no writer is
    // acting on; a live writer's `updating` is left as it is and this run
    // proceeds with no marker of its own until it takes the marker over
    // under the lock (`reassertMarkerUnderLock`).
    const publishUpdating = async (targetVersion: string): Promise<void> => {
      intendedTarget.current = targetVersion;
      // Idempotent: a second call while this run's record is on disk would
      // read its own live `updating`, defer to itself and orphan the record.
      if (ownMarker.current !== null) return;
      const fresh = progressRecord({
        state: "updating",
        error: null,
        targetVersion,
      });
      const claim = await claimUpdateProgressMarkerBeforeLock(
        environment,
        fresh,
      );
      if (claim.outcome === "published" || claim.outcome === "replaced-stale") {
        // A stale record the claim replaced is not retained: see
        // `displacedMarker`.
        ownMarker.current = fresh;
        return;
      }
      ownMarker.current = null;
      if (claim.outcome === "deferred") {
        ctx.runtime.logger.info(
          "Host update left another updater's live progress marker in place; this run publishes its own once it holds the lock",
          { environment, targetVersion },
        );
        return;
      }
      // The marker layer warned about the I/O itself (and about a
      // displaced record it could not put back); this line is what the
      // CLI's own log shows for why the transfer is invisible until the
      // takeover under the lock. The update must not fail on its progress
      // signal.
      ctx.runtime.logger.warn(
        "Host update could not publish its progress marker before the lock; the transfer proceeds unannounced until this run holds the lock",
        { environment, targetVersion },
      );
    };
    // Under the contender lock, before the disruptive half, make the marker
    // THIS run's. The marker is published BEFORE this run waits for admission
    // (`onWillDownload`, or the no-transfer publish below), and the wait is
    // unbounded by anything this run controls: a second `host update` can
    // land its own `updating` over ours, do its work, and clear it while we
    // were still downloading. Reaching the apply with `ownMarker.current`
    // non-null then proves nothing about the disk - the swap and restart
    // would run with no marker at all, and the `failed` stamp (CAS against a
    // record that is long gone) could never land.
    //
    // THE RULE: the contender lock's holder owns the marker. Whatever the
    // path holds when this run is about to do the disruptive work is either
    // this run's own record (kept, re-pointed if the target moved under the
    // lock), a record of an updater that is NOT doing disruptive work right
    // now (it is waiting for this lock, or it released it and is probing out
    // of lock, or it died), or nothing. The middle case is taken OVER, not
    // deferred to: a prior updater's post-lock probe ends in a conditional
    // clear, and had this run kept swapping under that marker the clear
    // would have landed mid-swap and left the restart invisible, with this
    // run's own stamp CAS'd against a record no longer on disk. Every write
    // here is conditional on what was read (replace-if-unchanged,
    // create-if-absent), so a marker that lands between the read and the
    // write wins that round and is read again; nothing is ever overwritten
    // blind. The displaced updater's later stamp/clear are CAS'd against ITS
    // record and degrade to no-ops - correct, because the marker now
    // describes the update that is actually in progress. A displaced record
    // whose writer is live is retained in `displacedMarker` for the restore
    // a park or a pre-disruption failure performs; one no writer is acting
    // on is gone (see `displacedMarker`).
    //
    // WHEN it runs matters as much as what it does: every arm calls it only
    // once that arm has committed to the disruptive half - after the apply's
    // reconcile has settled what is staged, after the no-op decision, after
    // the busy gate. A run that takes the marker over and then does nothing
    // would end by clearing a record that was never about it (see
    // `displacedMarker` for the one park that can still follow).
    const reassertMarkerUnderLock = async (
      targetVersion: string,
    ): Promise<void> => {
      intendedTarget.current = targetVersion;
      // Bounded: each iteration either settles or observed a concurrent
      // write, and concurrent marker writers are the handful of updaters
      // racing one lock, not an unbounded stream. Only `changed` (a record
      // that moved) is re-read; a `failed` write (I/O, warned about by the
      // marker layer) is not retried - the update must not fail, or spin,
      // on its progress signal.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const own = ownMarker.current;
        const onDisk = await readUpdateProgressMarker(environment);
        const fresh = progressRecord({
          state: "updating",
          error: null,
          targetVersion,
        });
        if (onDisk !== null) {
          const isOwn = own !== null && sameProgress(onDisk, own);
          if (isOwn && onDisk.targetVersion === targetVersion) return;
          const replaced = await replaceUpdateProgressMarkerIfUnchanged(
            environment,
            onDisk,
            fresh,
          );
          if (replaced === "replaced") {
            ownMarker.current = fresh;
            if (!isOwn) {
              // Retained for the restore only on POSITIVE evidence of a
              // live writer (see `displacedMarker`): a record whose writer
              // cannot be proven alive is replaced and gone, whether its
              // writer is proven dead or simply unknown.
              const writerLive =
                updateProgressRecordHasProvenLiveWriter(onDisk);
              displacedMarker.current = writerLive ? onDisk : null;
              ctx.runtime.logger.info(
                writerLive
                  ? "Host update took over the progress marker under the lock - its writer is not doing disruptive work"
                  : "Host update replaced the progress marker under the lock - no writer is proven to be acting on it",
                {
                  environment,
                  targetVersion,
                  previousState: onDisk.state,
                  previousTarget: onDisk.targetVersion,
                  previousWriterId: onDisk.writerId,
                },
              );
            }
            return;
          }
          if (replaced === "failed") {
            // `ownMarker.current` still names what it named: the marker
            // layer either left the live path as it was or emptied it and
            // said so. A failure past this point is stamped with the
            // target this run INTENDED (`intendedTarget`), not the one the
            // surviving record names.
            ctx.runtime.logger.warn(
              "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
              {
                environment,
                targetVersion,
                markerTargetVersion: own?.targetVersion ?? null,
              },
            );
            return;
          }
          continue;
        }
        const created = await createUpdateProgressMarkerIfAbsent(
          environment,
          fresh,
        );
        if (created === "created") {
          ownMarker.current = fresh;
          return;
        }
        if (created === "failed") {
          ctx.runtime.logger.warn(
            "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
            { environment, targetVersion },
          );
          return;
        }
        // "exists": a marker landed between the read and the create; the
        // next iteration reads it and takes it over.
      }
      ctx.runtime.logger.warn(
        "Host update could not establish ownership of the progress marker under the lock; proceeding without re-asserting it",
        { environment, targetVersion },
      );
    };

    let preparation: HostUpdatePreparation;
    let needsApply = false;
    let needsActivate = false;
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
    // Likewise for the apply: `needsApply` is what the PRE-lock preparation
    // decided, `applyPerformed` is whether bytes were actually swapped under
    // the lock. They part when the stage is consumed by another actor while
    // this run waits (see the staged arm), and only the second is work worth
    // probing.
    let applyPerformed = false;
    // Whether the activation arm was entered at all, from either of its two
    // call sites (the pre-lock debt, or a stage consumed while waiting):
    // "attempted but not performed" is the debt another actor paid first.
    let activationAttempted = false;
    // Whether this run has begun to disturb the host: the stop before a swap
    // (or a swap with no service to stop), or the activation arm's stop. It
    // decides what a failure AFTER a takeover of a LIVE writer's marker
    // leaves behind. Before this point the host is exactly as the displaced
    // writer left it, so its record goes back (a `failed` stamped there
    // would stand over that writer's live update, which could never repair
    // it - its stamp and clear CAS against a record that is gone). From
    // this point on the host's state is this run's doing, and its `failed`
    // is the truth the next updater takes over in turn. The apply and
    // downgrade arms report it from their actuators - the lifecycle's
    // pre-swap stop once its mutation-capability check has passed
    // (`onWillStopHost`), or the swap itself when the lifecycle decided not
    // to stop (`onWillSwap`) - and the activation arm's stop reports it the
    // same way (`stopHostForRestartWithAttempt`'s `onAuthorityVerified`).
    // NEVER from the `service-stop` / `swap` progress lines: those precede
    // the status probe and the authority check, and a probe that throws or
    // a capability that is refused has touched nothing - marking the
    // boundary there would have such a failure stamp this run's `failed`
    // over a live writer's taken-over record, which that writer's later
    // clear could never land.
    let disruptionStarted = false;
    // A free function over the runner's method for the arms' `onProgress`;
    // it reports and infers nothing (the boundary is `markDisruptionStarted`).
    const reportProgress = (info: ProgressInfo): void => {
      ctx.progress(info);
    };
    // The one boundary, handed to every arm's actuator.
    const markDisruptionStarted = (): void => {
      disruptionStarted = true;
    };
    // Shared by the three arms that find the REQUESTED work already done by
    // another actor - a stage consumed under the lock, a downgrade whose
    // version is already installed, an explicit download discarded because
    // the record reached its version during the transfer: re-derive the
    // activation state out of lock (the debt-only rule, see
    // `ActivationReading`), hold every reading that names a record to the
    // request (`installedVersionMismatch`), and pay a debt through the same
    // activation arm, which re-reads under its own lock. `null` is "nothing
    // to activate": the caller reports the no-op.
    const activateCommittedByAnotherActor = async (
      requested: string | null,
      logLine: string,
    ): Promise<{
      readonly legacy: LegacyHostUpdateResult;
      readonly activated: boolean;
    } | null> => {
      const reading = await readActivationState(environment);
      if (reading.kind !== "no-install") {
        const changedHandoff = installedVersionMismatch(
          requested,
          reading.installedVersion,
        );
        if (changedHandoff !== null) throw changedHandoff;
      }
      if (reading.kind !== "debt") return null;
      activationAttempted = true;
      ctx.runtime.logger.info(logLine, {
        environment,
        installedVersion: reading.installedVersion,
        runningVersion: reading.runningVersion,
      });
      return activateInstalledAndProjectLegacy(
        environment,
        args.force,
        requested,
        reading.runningVersion,
        reassertMarkerUnderLock,
        markDisruptionStarted,
      );
    };
    // The preparation runs INSIDE the try whose catch owns the marker. The
    // marker is published from within it - `onWillDownload`, before the first
    // byte - so a transfer that rejects has a marker to stamp `failed` onto;
    // with the download outside the try, a network failure twenty seconds in
    // rendered as nothing at all, on every surface, while the exit code said
    // otherwise. A failure BEFORE the hook (manifest unreachable, invalid
    // target) never wrote a marker and stamps none: `ownMarker.current` is still
    // `null` and the error carries the report on its own.
    try {
      preparation = await prepareHostUpdate({
        environment,
        version: args.versionRequest ?? null,
        allowDowngrade: args.allowDowngrade,
        onProgress: reportProgress,
        onWillDownload: publishUpdating,
      });
      // An EXPLICIT `host update <version>` acts on the version its
      // decision resolved to and on nothing else - see
      // `installedVersionMismatch` for the arms this binds and what each
      // binds to. `null` for an implicit "latest".
      const requestedVersion =
        args.versionRequest === undefined || args.versionRequest === null
          ? null
          : preparation.kind === "downgrade"
            ? preparation.version
            : downloadTargetVersion(preparation.download);
      const installedUpToDate =
        preparation.kind === "staged" &&
        preparation.download.outcome === "short-circuit" &&
        preparation.download.reason === "installed-up-to-date";
      needsApply = !installedUpToDate;
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
      const debtRead =
        activationReading !== null && activationReading.kind === "debt"
          ? activationReading
          : null;
      // An EXPLICIT request owes the activation of ITS version and no other.
      // For an explicit request the installed-up-to-date short-circuit
      // fires only for a record that IS the request (the download refuses
      // any other record at or above it before a transfer), so the record
      // the debt read sees can name another version only if it MOVED since
      // that check - another actor's commit in the gap - and a record above
      // the request (2.0.0 after a request for 1.2.0) is not this run's to
      // restart onto - the caller
      // confirmed 1.2.0 and nothing else (`installedVersionMismatch`). That
      // record's debt is left, logged, to an implicit `host update` or a
      // `host restart`, and this run reports the no-op the short-circuit
      // always reported.
      const activationDebt =
        debtRead !== null &&
        (requestedVersion === null ||
          debtRead.installedVersion === requestedVersion)
          ? debtRead
          : null;
      if (debtRead !== null && activationDebt === null) {
        ctx.runtime.logger.info(
          "Host update leaves the install record's activation debt: the explicit request names another version",
          {
            environment,
            requestedVersion,
            installedVersion: debtRead.installedVersion,
            runningVersion: debtRead.runningVersion,
          },
        );
      }
      if (activationDebt !== null) {
        ctx.runtime.logger.info(
          "Host update found the install record differing from the running host; activating",
          {
            environment,
            installedVersion: activationDebt.installedVersion,
            runningVersion: activationDebt.runningVersion,
          },
        );
      }
      needsActivate = activationDebt !== null;
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
        await clearStaleFailedMarker(
          ctx.runtime.logger,
          environment,
          activationReading.installedVersion,
        );
      }

      // The arms that reached here WITHOUT a transfer - an already-staged
      // target, an activation debt, an explicit downgrade - publish now,
      // before the apply half touches the install. A transfer already
      // published from `onWillDownload`, and the version it named is the one
      // that was staged; a second claim here would replace this run's own
      // record with an identical-looking one and cost nothing but the
      // certainty of what `ownMarker.current` refers to. A transfer whose
      // claim DEFERRED (another writer's live marker stood there) has no
      // record and claims again here - the other update may have finished
      // during the download - under the same conditional rule.
      // An EXPLICIT request whose download was DISCARDED at promote time
      // (the installed version moved past it in the unlocked transfer
      // window, or the install record vanished) has nothing of its own to
      // apply. Going on to `applyHost` would either commit whatever stage
      // another promoter left - the version binding refuses that, but with
      // a sentence about a replaced stage that names the wrong cause - or
      // find nothing and report the "stage consumed" recovery. The discard
      // IS the answer; say it and stop - BEFORE the publish below, which
      // would announce work this run has already decided not to do. An
      // implicit "latest" discarded by a newer stage still applies that
      // stage.
      if (
        requestedVersion !== null &&
        preparation.kind === "staged" &&
        preparation.download.outcome === "discarded"
      ) {
        // `not-newer-than-installed` covers EQUAL: the record can BE the
        // request, committed by another actor during the transfer
        // (Desktop's converge). That is the request delivered, not
        // discarded - this run owes its activation exactly as it does for a
        // consumed stage (the staged arm below), and the same event at
        // every other timing already activates. Only a record at ANOTHER
        // version is the discard's answer.
        const committedByAnotherActor =
          preparation.download.reason === "not-newer-than-installed" &&
          (await readHostInstallRecord(environment))?.version ===
            requestedVersion;
        if (!committedByAnotherActor) {
          throw discardedExplicitRequestError(preparation.download);
        }
      }

      if (needsWork && ownMarker.current === null) {
        await publishUpdating(
          activationDebt !== null
            ? activationDebt.installedVersion
            : preparation.kind === "downgrade"
              ? preparation.version
              : downloadTargetVersion(preparation.download),
        );
      }

      if (activationDebt !== null) {
        activationAttempted = true;
        const activation = await activateInstalledAndProjectLegacy(
          environment,
          args.force,
          // The record equals the request at this point (the gate above);
          // under the lock the arm holds it to the request again, so a
          // record another actor committed during the wait is refused.
          requestedVersion,
          activationDebt.runningVersion,
          // The record is read again under the lock; the marker is made this
          // run's there, naming the version as read, and the stop follows.
          reassertMarkerUnderLock,
          markDisruptionStarted,
        );
        legacy = activation.legacy;
        activationPerformed = activation.activated;
      } else if (
        preparation.kind === "staged" &&
        preparation.download.outcome === "discarded" &&
        requestedVersion !== null
      ) {
        // The explicit request the transfer found already committed (see
        // the discard check above): nothing to apply, a debt to pay.
        const activation = await activateCommittedByAnotherActor(
          requestedVersion,
          "Host update found the requested version committed by another actor during its transfer; activating it",
        );
        legacy =
          activation === null
            ? projectNoOp(await requireInstalled(environment))
            : activation.legacy;
        activationPerformed = activation !== null && activation.activated;
      } else if (preparation.kind === "staged") {
        const apply = await applyAndProjectLegacy(
          environment,
          args.force,
          needsApply,
          reportProgress,
          // The marker names the version `applyHost` is committing, not the
          // one this run promoted before it waited - the shared stage
          // directory holds whatever the latest promoter left there, and
          // `applyHost` installs what its reconcile leaves.
          (stagedVersion) => reassertMarkerUnderLock(stagedVersion),
          markDisruptionStarted,
          // An EXPLICIT request is bound to the version it resolved to: the
          // caller (a Settings click, `--version X`) confirmed that version
          // and checked its floor, and a stage another promoter replaced in
          // the unlocked wait must not be committed under that confirmation.
          // An implicit "latest" takes whatever newer stage it finds.
          requestedVersion,
        );
        legacy = apply.legacy;
        applyPerformed = apply.applied;
        if (needsApply && !apply.applied) {
          // The stage this run promoted was gone by the time it held the
          // lock: another actor consumed it - Desktop's launch converge runs
          // `host apply --no-service`, which commits the bytes and restarts
          // nothing. `applyHost` reported the no-op it saw, and the debt that
          // this command checks BEFORE the lock (only on the up-to-date
          // short-circuit) was not there to be seen then. Treating this as
          // done would probe the still-healthy OLD process, clear the marker
          // and exit 0 over an install nobody activated. Re-derive the state
          // now, under the same rule the pre-lock check applies (only a
          // `debt` is a reason to act out of lock - see `ActivationReading`),
          // and run the same activation arm the debt path runs: it re-reads
          // under its own lock and is the plain no-op if the debt cleared
          // meanwhile.
          // The record the other actor committed is not necessarily the
          // version this run was asked for: Desktop's converge commits
          // whatever ITS stage held. An explicit request delivers only its
          // own version, on EVERY reading that names a record - held in
          // `activateCommittedByAnotherActor`, which also pays the debt.
          const activation = await activateCommittedByAnotherActor(
            requestedVersion,
            "Host update found its stage consumed by another actor without activation; activating the committed install",
          );
          if (activation !== null) {
            legacy = activation.legacy;
            activationPerformed = activation.activated;
          }
        }
      } else {
        const downgradeTarget = preparation.version;
        const downgrade = await installHostDowngrade({
          environment,
          version: downgradeTarget,
          force: args.force,
          onProgress: reportProgress,
          onBeforeCommit: () => reassertMarkerUnderLock(downgradeTarget),
          onWillDisruptHost: markDisruptionStarted,
        });
        // A park or a failure throws past this line.
        if (downgrade.outcome === "applied") {
          legacy = projectApplied(downgrade);
          applyPerformed = true;
        } else {
          // Another actor installed the requested version while this run
          // staged its private source (re-derived under the mutation lock;
          // the source is discarded). What remains is the question the
          // staged arm asks of a consumed stage - is the committed record
          // running? - held to the request on every reading that names a
          // record, and answered by the same activation arm.
          const activation = await activateCommittedByAnotherActor(
            downgradeTarget,
            "Host update found the requested version installed by another actor without activation; activating it",
          );
          legacy =
            activation === null
              ? projectNoOp(await requireInstalled(environment))
              : activation.legacy;
          activationPerformed = activation !== null && activation.activated;
        }
      }
    } catch (err) {
      if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
        // A PARK, not a failure. The host has work in progress and this run
        // declined to interrupt it - a policy decision that every busy gate
        // on this path makes BEFORE it touches the install (`applyHost`,
        // `installHostDowngrade`, the activation arm's `assertHostNotBusy`),
        // so nothing has changed except that a stage may now be waiting. A
        // `failed` stamp here rendered "Update failed: work in progress" in
        // red on every surface for a host that was doing exactly what it was
        // asked to; the GUI derives the truth - installed-but-not-running, or
        // staged-and-waiting - from the records, and the marker's job is only
        // to get out of the way. Withdrawn CONDITIONALLY, like the clear
        // below: a newer updater's marker is not this run's to remove. And
        // a LIVE writer's marker this run took over under the lock is put
        // BACK rather than removed: the park means this run did no
        // disruptive work after all, so that writer's `updating` is what
        // the path should hold. A stale record this run replaced is not put
        // back (see `displacedMarker`): the path is left empty, and the
        // GUI derives the park from the records.
        if (ownMarker.current !== null) {
          // Liveness is re-read HERE, not trusted from the takeover: the
          // displaced writer had the whole stop attempt to die in between,
          // and a park that restored its now-dead `updating` would re-plant
          // exactly the record the retain rule exists to drop.
          const displaced = liveDisplacedRecord(displacedMarker.current);
          if (displaced === null) {
            const withdrawn = await deleteUpdateProgressMarkerIfUnchanged(
              environment,
              ownMarker.current,
            );
            logConditionalMarkerOutcome(ctx.runtime.logger, environment, {
              outcome: withdrawn,
              done: "Host update parked - the host has work in progress; the progress marker was withdrawn",
              moved:
                "Host update parked - the host has work in progress; the progress marker was not withdrawn - another updater owns it now",
              gone: "Host update parked - the host has work in progress; found no progress marker to withdraw",
              failed:
                "Host update parked - the host has work in progress; its progress marker could not be withdrawn - the marker log names what the path holds now",
            });
          } else {
            const restored = await replaceUpdateProgressMarkerIfUnchanged(
              environment,
              ownMarker.current,
              displaced,
            );
            logConditionalMarkerOutcome(ctx.runtime.logger, environment, {
              outcome: restored,
              done: "Host update parked - the host has work in progress; the progress marker it took over was restored to its previous writer",
              moved:
                "Host update parked - the host has work in progress; the progress marker it took over was not restored - another updater owns it now",
              failed:
                "Host update parked - the host has work in progress; the progress marker it took over could not be restored - the marker log names what the path holds now",
            });
          }
        }
        throw err;
      }
      // A refusal because a NEWER host is installed than the version this
      // run was asked for - `E_HOST_UPDATE_NOT_NEWER`, from the promote-time
      // discard or from `installedVersionMismatch`'s newer arm (the
      // download's phase-1 refusal carries the same code, but arrives
      // before any target is announced, so no record of this run's exists
      // and none of the arms below runs) - is a
      // SUPERSEDED request, not a failure: another actor delivered
      // something newer and nothing was wrong. It is treated exactly like a
      // target observed running: this run's record is WITHDRAWN, never
      // stamped. A `failed` naming the announced version would stand over a
      // host that is, or is about to be, serving a newer one - and neither
      // stale-failed rule (this command's `clearStaleFailedMarker`, the
      // host's `isStaleUpdateProgress`) clears a `failed` whose target is
      // not the running version, so nothing but a later update that does
      // work would ever remove it. Any other refusal (an OLDER or
      // non-release record under an explicit request) names something that
      // did go wrong and is stamped as before.
      const superseded =
        err instanceof CliError &&
        err.code === CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER;
      if (ownMarker.current === null) {
        // No record of this run's on disk (the pre-lock claim deferred to
        // another writer's live marker, or no conditional write ever
        // landed). The failure is still this run's to report whenever it
        // announced a target: `markUpdateFailed` with no record lands the
        // `failed` by create-if-absent, into an EMPTY path only. While the
        // other writer's marker is still live that is the no-op it should
        // be - its update is the one in progress - but that writer may have
        // finished and cleared while this run was still downloading, and
        // a lost download then has nothing on the path to defer to. A run
        // that never announced a target (failed before `onWillDownload`)
        // has nothing to name and stamps nothing, as before.
        // ...unless the host is already RUNNING that target: the other
        // writer's update to the same version succeeded while this one was
        // still downloading (its reconcile consumed the shared stage, which
        // is the usual way this download fails), and "update to X failed"
        // over a host that is serving X reports a failure that did not
        // happen - persistently, since only a later no-work `host update`
        // reconciles a stale `failed`, and only a host with target-running
        // suppression hides it. Same observed-state rule as
        // `clearStaleFailedMarker`.
        if (
          intendedTarget.current !== null &&
          superseded &&
          !disruptionStarted
        ) {
          ctx.runtime.logger.info(
            "Host update did not stamp its refusal - a newer host than the target it announced is installed; nothing was wrong",
            { environment, targetVersion: intendedTarget.current },
          );
        } else if (
          intendedTarget.current !== null &&
          !(await targetObservedRunning(environment, intendedTarget.current))
        ) {
          await markUpdateFailed(
            ctx.runtime.logger,
            environment,
            intendedTarget.current,
            err instanceof Error ? err.message : String(err),
            null,
          );
        } else if (intendedTarget.current !== null) {
          ctx.runtime.logger.info(
            "Host update did not stamp its failure - the running host has been observed at the target it announced",
            { environment, targetVersion: intendedTarget.current },
          );
        }
      } else {
        // Liveness re-read here for the same reason as in the park arm.
        const displaced = liveDisplacedRecord(displacedMarker.current);
        if (displaced !== null && !disruptionStarted) {
          // Failed after taking a LIVE writer's marker over but before
          // touching the host (a lost mutation capability, a stop that
          // could not be issued): the host is as that writer left it, and
          // so is its marker. See `disruptionStarted`. Every other failure
          // with a record of this run's on disk - a lost download over a
          // stale record the claim replaced included - stamps this run's
          // own cause over its own record: a retry's second failure
          // reports the second failure, not the first.
          const restored = await replaceUpdateProgressMarkerIfUnchanged(
            environment,
            ownMarker.current,
            displaced,
          );
          logConditionalMarkerOutcome(ctx.runtime.logger, environment, {
            outcome: restored,
            done: "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
            moved:
              "Host update failed before disturbing the host; the progress marker it took over was not restored - another updater owns it now",
            failed:
              "Host update failed before disturbing the host; the progress marker it took over could not be restored - the marker log names what the path holds now",
          });
        } else if (
          !disruptionStarted &&
          (superseded ||
            (await targetObservedRunning(
              environment,
              // `intendedTarget` is set before any record of this run's
              // exists; the fallback is the type's null arm.
              intendedTarget.current ?? ownMarker.current.targetVersion,
            )))
        ) {
          // Same observed-state rule as the null arm above, reached with a
          // record of this run's own on disk: an actor that writes no
          // marker at all - `host apply --no-service`, Desktop's launch
          // converge - can commit and activate the very target this run
          // announced underneath its live `updating`, consuming the shared
          // stage its download then fails on. The record describes an
          // update another actor completed, so it is WITHDRAWN, not
          // stamped: "update to X failed" over a host serving X is the
          // false report the rule exists to withhold. Pre-disruption only:
          // past the stop, the host's state is this run's doing and its
          // failure is reported whatever the host now serves. A SUPERSEDED
          // request (see `superseded`) takes the same withdrawal.
          const withdrawn = await deleteUpdateProgressMarkerIfUnchanged(
            environment,
            ownMarker.current,
          );
          const lead = superseded
            ? "Host update stopped before disturbing the host - a newer host than the target it announced is installed"
            : "Host update failed before disturbing the host, and the running host has been observed at the target it announced";
          logConditionalMarkerOutcome(ctx.runtime.logger, environment, {
            outcome: withdrawn,
            done: `${lead}; the progress marker was withdrawn`,
            moved: `${lead}; the progress marker was not withdrawn - another updater owns it now`,
            gone: `${lead}; found no progress marker to withdraw`,
            failed: `${lead}; its progress marker could not be withdrawn - the marker log names what the path holds now`,
          });
        } else {
          // Stamped with the target this run was working toward. The two
          // differ when a re-point under the lock FAILED (I/O): the record
          // on disk still names the pre-lock target while the run went on
          // to commit the version `applyHost` reported, and "update to
          // <old> failed" would name a version this run never installed -
          // and neither string-equal stale-failed rule would then ever
          // retire it.
          await markUpdateFailed(
            ctx.runtime.logger,
            environment,
            // Same null arm as above: the intended target is always set
            // once a record of this run's is on disk.
            intendedTarget.current ?? ownMarker.current.targetVersion,
            err instanceof Error ? err.message : String(err),
            ownMarker.current,
          );
        }
      }
      throw err;
    }

    const workPerformed = applyPerformed || activationPerformed;
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
          ownMarker.current,
        );
        throw cliError({
          code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
          message: `host update: applied ${legacy.version} but the host did not become healthy: ${probe.detail}`,
          details: { environment, version: legacy.version },
          exitCode: 1,
        });
      }
    }
    if (ownMarker.current !== null) {
      // Written above whenever work was OWED, so it is cleared whenever it
      // was - including the activation debt that another actor paid while
      // this command waited, which leaves nothing to probe but a marker
      // that still says `updating`. Cleared CONDITIONALLY: the lock has been
      // released by now, and a third updater writes its `updating` before it
      // waits for that lock, so a marker that is no longer the one written
      // above belongs to someone whose update is still to come.
      const cleared = await deleteUpdateProgressMarkerIfUnchanged(
        environment,
        ownMarker.current,
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
      } else if (cleared === "failed") {
        // Warned about by the marker layer; named here so the CLI's own
        // log shows why an `updating` outlived a successful update.
        ctx.runtime.logger.info(
          "Host update could not clear its progress marker - the marker log names what the path holds now",
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
      activationClearedWhileWaiting:
        activationAttempted && !activationPerformed,
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
 * reading is named rather than collapsed to "debt or not", because the
 * places that consult it need different things from the non-debt cases:
 * OUT of the contender lock (before it, and again after a staged apply that
 * found its stage consumed), only `debt` is a reason to ACTIVATE (the other
 * readings are still consulted out of lock: `activated` for the
 * stale-failed clear and the observed-running withhold, and every reading
 * that names a record for an explicit request's binding); UNDER the
 * activation arm's lock, `debt` and `no-live-host` both are, while
 * `activated` is the reason NOT to.
 *
 * - `no-install`: nothing to activate (the caller throws later anyway);
 * - `no-live-host`: no pid metadata, or a record whose pid is gone - exited,
 *   or recycled onto an unrelated process. Before the lock this is left
 *   alone - a host that is DOWN is the service manager's problem, and
 *   `host start` re-resolves the install record on every spawn.
 *   Under the lock, after a debt was seen, it means the host this command
 *   was about to replace is gone, which is not the same as replaced;
 * - `foreign-runtime`: a running version that is not a release version,
 *   against a record with no runtime stamp. A dev build is not a host this
 *   command reasons about when all it has to compare it with is the catalog
 *   version. A record WITH a runtime stamp never reads this way: the stamp is
 *   whatever the archive reported about itself (a staging host's is
 *   `staging.<epoch>.<sha>`), and equality with it is the whole test;
 * - `activated`: the committed archive is what is running, carrying the
 *   record's catalog `version` so a caller can ask WHICH archive
 *   (`targetObservedRunning`; the other readers only ask whether);
 * - `debt`: the record and the process disagree.
 */
type ActivationReading =
  | { readonly kind: "no-install" }
  | { readonly kind: "no-live-host"; readonly installedVersion: string }
  | { readonly kind: "foreign-runtime"; readonly installedVersion: string }
  | { readonly kind: "activated"; readonly installedVersion: string }
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
 * catalog version - string identity there too; the comparator is consulted
 * only to exempt a record it cannot order (`local-*`), which stays activated
 * by policy.
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
  if (installed.runtimeVersion !== null) {
    // Runtime-stamp domain: equality decides, and the STAMPS are not
    // required to be SemVer. A staging host publishes
    // `staging.<epoch>.<sha>` and the record keeps that same stamp
    // (`readExtractedRuntimeVersion`), so a SemVer guard applied before this
    // comparison would classify every staging host as foreign and turn both
    // its activated and its indebted states into no-ops.
    return running.version === installed.runtimeVersion
      ? { kind: "activated", installedVersion: installed.version }
      : {
          kind: "debt",
          installedVersion: installed.version,
          runningVersion: running.version,
        };
  }
  // Catalog-version domain (a record with no runtime stamp yet): the
  // release-version policy applies. A running version that is not a release
  // version is not a host this command reasons about.
  if (!isValidHostVersion(running.version)) {
    return { kind: "foreign-runtime", installedVersion: installed.version };
  }
  // A release host publishes exactly its catalog version (the build stamps
  // `src/config.ts`'s version into the binary and into the archive's
  // `version.json` alike), so a registry record's string IS what an
  // activated host of that record publishes (an own-build record from
  // `host ensure` names the CLI's version and relies on its runtime stamp,
  // which its archive always carries): identity is the string here as in
  // the runtime-stamp domain, and another build of the same release
  // (`2.0.0+bar` running under a `2.0.0+foo` record) is debt - the committed
  // artifact is not the one serving. The comparator's build-metadata-blind
  // "equal" would read it as activated, and every consumer keyed on
  // `activated` - the debt gate, `targetObservedRunning`'s withdrawal, the
  // stale-failed clear - would then treat an artifact that never ran as
  // delivered. The comparator is kept for what it is for: a record it
  // cannot ORDER (`local-*`; the running version passed the SemVer guard
  // above) is not this command's debt to collect and stays activated by
  // policy.
  if (running.version === installed.version) {
    return { kind: "activated", installedVersion: installed.version };
  }
  const comparison = compareHostVersions(running.version, installed.version);
  if (!comparison.comparable) {
    return { kind: "activated", installedVersion: installed.version };
  }
  return {
    kind: "debt",
    installedVersion: installed.version,
    runningVersion: running.version,
  };
}

/**
 * Whether the running host has been OBSERVED serving `targetVersion`: the
 * install record names it and the live process is at the record
 * (`readActivationState` → `activated`, with its identity verdict). Used by
 * the failure path to withhold a `failed` for a target another updater has
 * since delivered. Never throws: a reading that cannot be taken is "not
 * observed", and the stamp lands - a failure that cannot be contradicted is
 * reported, not swallowed.
 *
 * "Names it" is STRING identity of the record with the target, the grain
 * the version binding uses (`installedVersionMismatch`) and the rule the
 * host's `isStaleUpdateProgress` applies to the same marker: `2.0.0+foo` is
 * another artifact than `2.0.0+bar`, and a run for one that finds the other
 * running was not delivered - its failure stands, whatever the catalog
 * comparator (build-metadata-blind, right for ORDERING) would call equal.
 * Another actor delivering the same registry artifact writes the same
 * string, so a real match is never defeated. The activation reading above
 * it keeps the comparator: running-vs-record is a runtime-stamp question,
 * record-vs-target is an artifact one.
 */
async function targetObservedRunning(
  environment: Environment,
  targetVersion: string,
): Promise<boolean> {
  try {
    const reading = await readActivationState(environment);
    return (
      reading.kind === "activated" && reading.installedVersion === targetVersion
    );
  } catch {
    return false;
  }
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
 *
 * "Contradicts" is the rule the host's `isStaleUpdateProgress` applies to
 * the same marker: a `failed` is stale when the version it names IS the one
 * now running - string identity, the artifact grain (see
 * `targetObservedRunning`). The host compares against the runtime version
 * it publishes, so a staging host's `staging.<epoch>.<sha>` never matches a
 * catalog target there; here the comparison is against the install record
 * the running host has been observed at, the domain the marker's target was
 * written in. A `failed` naming ANOTHER version - an attempt at 2.0.0 that
 * failed before the swap, read by a later `host update` while the registry
 * offers only 1.9.0, or an attempt at `2.0.0+foo` over a host that runs
 * `2.0.0+bar` - is a report the observed state does not contradict, and it
 * stays until a later run that does work replaces it (an implicit retry
 * over a record at or above it short-circuits; an explicit retry at that
 * target is refused before any transfer; neither touches the marker).
 */
async function clearStaleFailedMarker(
  logger: ILogger,
  environment: Environment,
  observedInstalledVersion: string,
): Promise<void> {
  const marker = await readUpdateProgressMarker(environment);
  if (marker === null || marker.state !== "failed") return;
  if (marker.targetVersion !== observedInstalledVersion) {
    logger.info(
      "Host update left the failed progress marker alone - it names a target the running host has not been observed at",
      {
        environment,
        failedTargetVersion: marker.targetVersion,
        observedInstalledVersion,
      },
    );
    return;
  }
  const outcome = await deleteUpdateProgressMarkerIfUnchanged(
    environment,
    marker,
  );
  if (outcome === "cleared") {
    logger.info(
      "Host update cleared a stale failed progress marker - the running host is at the installed version",
      { environment, staleTargetVersion: marker.targetVersion },
    );
  } else if (outcome === "failed") {
    logger.info(
      "Host update left the progress marker alone - the stale-failure clear could not be written",
      { environment, outcome },
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
 * The debt the caller detected is deliberately NOT a parameter (the
 * BINDING is - `expectedInstalledVersion` - the decision is not): it was
 * read outside the contender lock, and `host restart` shares that lock. Desktop's
 * parked-registration fallback runs exactly that command on exactly this
 * host, so a Settings click that arrives while it holds the lock would
 * otherwise wait its turn and then restart a host that had just come up on
 * the committed bytes - costing it its connections and reporting a
 * `rc.1 → rc.2` transition that the other actor performed. The debt is
 * re-derived under the lock and a cleared debt is the plain no-op - for an
 * explicit request too, when the record still names the request; a record
 * another actor moved to another version is refused above, activated or
 * not.
 *
 * `activated` tells the caller which of the two happened, because the two
 * need different aftercare (a health probe for a restart, none for a no-op).
 * `onInstalledVersionUnderLock` is called with the record's version as read
 * under the lock, after the busy gate and before anything is restarted, so
 * the caller can take ownership of the progress marker (and, for an
 * implicit request, re-point it if another actor installed a different
 * version in between - an explicit request was refused above before this
 * point) only once this arm has committed to restarting.
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
  /**
   * The install record version this activation is bound to (an explicit
   * request), or `null` (an implicit "latest" activates whatever record the
   * lock reveals). See `installedVersionMismatch`.
   */
  expectedInstalledVersion: string | null,
  lastSeenRunningVersion: string,
  onInstalledVersionUnderLock: (installedVersion: string) => Promise<void>,
  /**
   * Runs once the stop's mutation-capability check has passed and
   * immediately before the actuator stops the host: the first point at
   * which this arm can have disturbed it. See `disruptionStarted`.
   */
  onWillDisruptHost: () => void,
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
    // Decided first, on the record as read UNDER the lock, before the
    // activation reading, the busy gate and the marker takeover: an
    // explicit request restarts the host onto its own version or refuses.
    // A record another actor committed AND activated meanwhile is refused
    // too, not reported as "host already at Y" under a request for X - the
    // same fact at promote time is the discard refusal, and a request that
    // delivered nothing does not report success. The refusal is a
    // superseded request when the record is newer (`E_HOST_UPDATE_NOT_NEWER`),
    // which the catch WITHDRAWS rather than stamps - see `superseded`.
    const changedHandoff = installedVersionMismatch(
      expectedInstalledVersion,
      installed.version,
    );
    if (changedHandoff !== null) throw changedHandoff;
    const reading = await readActivationState(environment);
    if (reading.kind !== "debt" && reading.kind !== "no-live-host") {
      return { legacy: projectNoOp(installed), activated: false };
    }
    const previousVersion =
      reading.kind === "debt" ? reading.runningVersion : lastSeenRunningVersion;
    // Same gate `applyHost` runs before it touches anything: a host with
    // live work is not restarted under it unless the caller said `--force`.
    // A host that is gone has no work to protect, so the gate is not asked.
    if (!force && reading.kind === "debt") {
      try {
        await assertHostNotBusy(environment);
      } catch (err) {
        if (
          !(err instanceof CliError) ||
          err.code !== CLI_ERROR_CODES.HOST_BUSY
        ) {
          throw err;
        }
        // D6, as the apply arm reports it: a stage waiting beside the debt
        // (a `host download` this run did not consume) is named in the
        // park, read HERE under the same lock the busy decision was made
        // under. Nothing here touches the stage.
        const staged = await readHostStagedRecord(environment);
        throw cliError({
          code: CLI_ERROR_CODES.HOST_BUSY,
          message:
            staged === null
              ? err.message
              : `${err.message} Host ${staged.version} stays staged; it installs on the next update once the host is idle, or now with --force.`,
          details: { stagedVersion: staged?.version ?? null },
          exitCode: err.exitCode,
        });
      }
    }
    // After the gate (where one runs - a host that is gone is not asked),
    // not before: the caller takes the progress marker over here, and a park
    // must not follow a takeover for work never done. The stop below is the
    // only thing that can still park, and the caller's park path restores
    // a live writer's displaced record for that case; a stop refused by its
    // own capability check, before the actuator, is reported the same way
    // (`onWillDisruptHost` has not run).
    await onInstalledVersionUnderLock(installed.version);
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
      onWillDisruptHost,
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
  /** See `DownloadAndStageHostOptions.onWillDownload`; the downgrade arm never fires it. */
  readonly onWillDownload: (targetVersion: string) => Promise<void>;
}): Promise<HostUpdatePreparation> {
  if (input.allowDowngrade && input.version !== null) {
    const installed = await requireInstalled(input.environment);
    const comparison = compareHostVersions(input.version, installed.version);
    // Below the record, or ANOTHER BUILD of the record's release (the
    // comparator's "equal" over a different string - `2.0.0+foo` over an
    // installed `2.0.0+bar`): the shared stage would refuse both as not
    // newer, so both take the owned installer. The record's own string
    // falls through to the download's up-to-date short-circuit: delivered.
    // This read is out of lock, like the shared stage's own pre-lock
    // reads: a record another actor moves in the gap meets the shared
    // stage's phase-1 refusal, whose remedy names a flag this caller
    // already passed - a retry takes the owned installer. Accepted.
    if (
      comparison.comparable &&
      (comparison.ordering === "less" ||
        (comparison.ordering === "equal" &&
          input.version !== installed.version))
    ) {
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
      onWillDownload: input.onWillDownload,
    }),
  };
}

// The refusal for an explicit request whose completed download was discarded
// at promote time. Each reason is a fact the promoter established under its
// lock; the sentence names it rather than the apply's "another download
// replaced the stage", which is not what happened. `not-newer-than-installed`
// carries the code the downgrade gate uses for the same fact, so a caller
// keyed on it (Desktop's Settings click) can offer `--allow-downgrade`.
/**
 * An EXPLICIT `host update <version>` delivers the version it resolved to
 * and nothing else: the caller (a Settings click, `--version X`) confirmed
 * that version and the GUI checked the CLI floor for it, and no arm of this
 * command restarts the host onto another version under that confirmation.
 * An implicit "latest" is bound nowhere: it takes whatever newer state each
 * re-derivation reveals. The arms that can deliver a version, and what each
 * holds an explicit request to:
 *
 * | arm                                   | holds the request to                                              |
 * | ------------------------------------- | ----------------------------------------------------------------- |
 * | staged apply (`applyHost`)            | the staged record: `expectedStagedVersion` → `stage-version-mismatch` |
 * | download discarded at promote time    | nothing - refused outright (`discardedExplicitRequestError`), before the publish; unless the record IS the request (committed by another actor during the transfer), which is the request delivered and takes the recovery below |
 * | pre-lock debt (installed-up-to-date)  | the record the debt read sees: the request's own string enters the arm; any other record at or above an explicit request is refused by the download before a transfer (`E_HOST_UPDATE_NOT_NEWER`, remedy `--allow-downgrade`, which takes the downgrade arm), so a record ABOVE the request here is one that moved since - it keeps its debt, this run reports the no-op (never enters the arm) |
 * | consumed-stage recovery (apply no-op) | the re-derived record on EVERY reading that names one (`debt`, `activated`, `no-live-host`), before the log line and the arm |
 * | activation arm (every route)          | the record read UNDER the lock, before the activation reading, the busy gate and the takeover |
 * | downgrade (`installHostDowngrade`)    | its own download of `preparation.version`; a record another actor moved to that version under the lock is a no-op, re-derived here like a consumed stage |
 *
 * Identity is the STRING, the grain the apply binding uses: the request
 * resolved to a catalog version and the record names the catalog version
 * it committed, so the same artifact reads equal and `2.0.0+hotfix` is
 * another artifact. A record that is not a release version (`local-*`,
 * `host install --file`) is by construction not the requested one - it
 * cannot be compared, and it is exactly a record another actor wrote. A
 * record NEWER than the request is the fact the promote-time discard
 * reports as `E_HOST_UPDATE_NOT_NEWER`, so it carries that code and the
 * same remedies - and, like it, is a SUPERSEDED request the catch that
 * owns the marker withdraws rather than stamps (see `superseded` there);
 * any other mismatch is `E_UNEXPECTED`, a failure before any disruption
 * that the catch stamps over this run's own record, naming the version it
 * announced.
 */
function installedVersionMismatch(
  expectedInstalledVersion: string | null,
  installedVersion: string,
): CliError | null {
  if (
    expectedInstalledVersion === null ||
    installedVersion === expectedInstalledVersion
  ) {
    return null;
  }
  const comparison = compareHostVersions(
    installedVersion,
    expectedInstalledVersion,
  );
  const details = {
    expectedInstalledVersion,
    actualInstalledVersion: installedVersion,
  };
  if (comparison.comparable && comparison.ordering === "greater") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: `host update: the installed host is ${installedVersion}, newer than the ${expectedInstalledVersion} this run was updating to - another actor installed it meanwhile; nothing was restarted. Run 'traycer host status' to see what is installed and running, or pass --allow-downgrade to install ${expectedInstalledVersion} over it`,
      details,
      exitCode: 1,
    });
  }
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: `host update: the installed host is ${installedVersion}, not the ${expectedInstalledVersion} this run was updating to - another actor changed the install before it could be activated; nothing was restarted. Run the update again`,
    details,
    exitCode: 1,
  });
}

function discardedExplicitRequestError(
  outcome: Extract<HostDownloadOutcome, { readonly outcome: "discarded" }>,
): CliError {
  const target = outcome.targetVersion;
  switch (outcome.reason) {
    case "not-newer-than-installed":
      return cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
        message: `host update: ${target} was downloaded, but the installed host is no longer older than it - another update landed meanwhile; nothing was applied. Run 'traycer host status' to see what is installed, or pass --allow-downgrade to install ${target} over it`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "not-strictly-newer":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: a newer host was staged while ${target} downloaded; nothing was applied - run the update again to install what is staged`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "install-record-vanished":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: the install record vanished while ${target} downloaded; nothing was applied - run 'traycer host doctor'`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "automatic-refused-incomparable-installed":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: the installed host's version cannot be compared with ${target}; nothing was applied - run 'traycer host status' to see what is installed`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
  }
}

// Every `HostDownloadOutcome` branch names the version this invocation was
// working toward; `promoted` reports it as the staged version it just placed.
function downloadTargetVersion(outcome: HostDownloadOutcome): string {
  return outcome.outcome === "promoted"
    ? outcome.stagedVersion
    : outcome.targetVersion;
}

/**
 * One log line per conditional-marker outcome, so a withdrawal or restore
 * that did NOT happen is never reported as if it had: `cleared` /
 * `replaced` is the operation done; `changed` is a record that moved under
 * this run (another updater's, left alone); `absent` (a delete only) is a
 * path already empty, nothing left to report on; `failed` is an I/O
 * failure the marker layer already warned about - nothing of the intended
 * write landed, and what the path holds now (the record as it was, or an
 * empty path with the displaced record retained in a scratch) is in that
 * warning - named here so the CLI's own log shows why a marker outlived the
 * run that wrote it. All INFO: none of these fails the update, and the
 * marker layer owns the WARN. `replaceUpdateProgressMarkerIfUnchanged`
 * reports an empty path as `changed`, so a replace has no `gone` line: the
 * type makes that arm unwritable rather than a dead string.
 */
function logConditionalMarkerOutcome(
  logger: ILogger,
  environment: Environment,
  lines:
    | {
        readonly outcome: ConditionalMarkerDelete;
        readonly done: string;
        readonly moved: string;
        readonly gone: string;
        readonly failed: string;
      }
    | {
        readonly outcome: ConditionalMarkerReplace;
        readonly done: string;
        readonly moved: string;
        readonly failed: string;
      },
): void {
  const message =
    lines.outcome === "cleared" || lines.outcome === "replaced"
      ? lines.done
      : lines.outcome === "failed"
        ? lines.failed
        : lines.outcome === "absent"
          ? lines.gone
          : lines.moved;
  logger.info(message, { environment, outcome: lines.outcome });
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
 * does not get the stamp either (see `replaceUpdateProgressMarkerIfUnchanged`
 * for why an empty live path is not proof of an idle peer); the failure is
 * still reported by exit code and log. `ours` is `null` when this run has no
 * record of its own on disk - the pre-lock claim deferred to another
 * writer's live marker, or no conditional write ever landed - and the
 * failure is still this run's to report, so it lands by create-if-absent -
 * into a path that READS empty. Against another writer's live marker that
 * is the correct no-op; against the empty path that writer's clear left
 * behind, it is the only record of what went wrong. One residual race is
 * accepted and named - closed among writers that take the marker lock
 * (`underMarkerLock`), open only against a CLI from before it:
 * create-if-absent has no record to compare against, so it cannot tell an
 * empty path from the few milliseconds in which such a writer's
 * conditional swap holds ITS record in scratch (see
 * `replaceUpdateProgressMarkerIfUnchanged`, which maps that same "absent"
 * reading to `changed` for exactly this reason). A stamp that lands in that
 * window wins the other writer's `link` with EEXIST; its swap reports
 * `failed`, warned about by the marker layer, and this run's `failed`
 * stands until the next update supersedes it. The caller narrows the
 * window's cost by not stamping at all when the running host has been
 * observed at the very target this run announced (`targetObservedRunning`).
 * A stamp over a TAKEN-OVER record is right when it happens: this run did
 * the disruptive work, so its failure is the host's current state, and the
 * next updater takes the `failed` over in turn.
 */
async function markUpdateFailed(
  logger: ILogger,
  environment: Environment,
  targetVersion: string,
  error: string,
  ours: HostUpdateProgress | null,
): Promise<void> {
  const failed = progressRecord({ state: "failed", error, targetVersion });
  if (ours === null) {
    const created = await createUpdateProgressMarkerIfAbsent(
      environment,
      failed,
    );
    if (created !== "created") {
      logger.info(
        created === "exists"
          ? "Host update did not stamp its failure - the progress marker holds another record"
          : "Host update did not stamp its failure - the progress marker could not be written",
        { environment, targetVersion, outcome: created },
      );
    }
    return;
  }
  // One atomic compare-and-swap, not a read followed by a write: the other
  // updater's `updating` can land between those two, and the write would then
  // bury it under this failure for the whole of its update.
  const outcome = await replaceUpdateProgressMarkerIfUnchanged(
    environment,
    ours,
    failed,
  );
  if (outcome !== "replaced") {
    logger.info(
      outcome === "failed"
        ? "Host update did not stamp its failure - the progress marker could not be written"
        : "Host update did not stamp its failure - another updater owns the progress marker now",
      { environment, outcome },
    );
  }
}

async function applyAndProjectLegacy(
  environment: Environment,
  force: boolean,
  needsApply: boolean,
  onProgress: (info: ProgressInfo) => void,
  /**
   * `ApplyHostOptions.onWillCommitStaged`: runs inside `applyHost`, after
   * its reconcile has settled what is staged and after its busy gate, with
   * the version of the stage it is about to commit. A no-op never reaches
   * it; there is then no disruptive work to announce.
   */
  onWillCommitStaged: (stagedVersion: string) => Promise<void>,
  /** `ApplyHostOptions.onWillDisruptHost`: the actuator-reported boundary. */
  onWillDisruptHost: () => void,
  /** `ApplyHostOptions.expectedStagedVersion`: the confirmed version, or `null`. */
  expectedStagedVersion: string | null,
): Promise<{
  readonly legacy: LegacyHostUpdateResult;
  /** Whether bytes were swapped under the lock; a no-op is `false`. */
  readonly applied: boolean;
}> {
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
      return {
        legacy: projectNoOp(await requireInstalled(environment)),
        applied: false,
      };
    }
    let outcome: ApplyHostOutcome;
    try {
      outcome = await applyHostWithAttempt(capability, contenderOptions, {
        environment,
        force,
        noService: false,
        expectedStageFingerprint: null,
        expectedStagedVersion,
        onProgress,
        // What this run promoted before it waited is a pre-lock fact: the
        // shared stage may have been replaced (a later promoter, a parked
        // explicit `--version`), consumed, or reconciled away since, and a
        // read from HERE would still be on the wrong side of `applyHost`'s
        // own reconcile. `applyHost` reports the version it is committing
        // (and refuses one other than `expectedStagedVersion` when set).
        onWillCommitStaged,
        onWillDisruptHost,
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
          // The park, in words: the bytes are kept, and the two ways forward
          // are named. This message is what a person reads at the terminal
          // and in the host's log after a Settings click; the GUI derives the
          // same fact from the staged record rather than from this text.
          message:
            staged === null
              ? err.message
              : `${err.message} Host ${staged.version} stays staged; it installs on the next update once the host is idle, or now with --force.`,
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
      return {
        legacy: projectNoOp(await requireInstalled(environment)),
        applied: false,
      };
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
    if (outcome.outcome === "stage-version-mismatch") {
      // Nothing was consumed, announced or disturbed: the stage another
      // promoter left is theirs, and the version this run was asked for is
      // no longer staged. The caller re-runs its request; the marker this
      // run published for the requested version is stamped `failed` by the
      // catch that owns it, naming the version it announced.
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: the staged host is ${outcome.actualStagedVersion}, not the requested ${outcome.expectedStagedVersion}; another download replaced the stage before it could be applied - run the update again`,
        details: {
          expectedStagedVersion: outcome.expectedStagedVersion,
          actualStagedVersion: outcome.actualStagedVersion,
        },
        exitCode: 1,
      });
    }
    return { legacy: projectApplied(outcome), applied: true };
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
