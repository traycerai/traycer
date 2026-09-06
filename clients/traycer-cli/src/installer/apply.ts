import { join } from "node:path";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { HostStartAdoptionPublisher } from "../host/host-start-adoption";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { readHostStagedRecord } from "../manifest/host-staged";
import { hostStagedDir } from "../store/paths";
import { assertHostNotBusy } from "../host/busy-check";
import type { ServiceState } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { reconcileHostStageWithAttempt } from "./stage-reconcile";
import {
  commitInstallFromSource,
  currentInstallPlatform,
  type InstallPhaseHooks,
} from "./install";

// `host apply` core - Host Update Layer Redesign Tech Plan, "New/changed
// commands" > `host apply`. Promotes the single-slot staged tree over the
// current install: no download, no extraction - the stage was already
// verified by `host download`. The stop -> swap -> start tail is
// `commitInstallFromSource` (installer/install.ts), shared with
// `installHost`.
//
// Concurrency: like `installHost`, this assumes the caller already holds
// the environment's `cli-lock` (see `commands/host-apply.ts`) - reconcile,
// the record reads, the no-op/busy checks, and the commit all run inside
// ONE lock span, per the Tech Plan's "the final idle decision happens
// inside an acquired lock immediately before the disruptive step".

export interface ApplyHostOptions {
  readonly environment: Environment;
  // Desktop receives this from its off-lane registry eligibility pass. The
  // value is checked after reconcile, while the caller holds cli-lock.
  // Null means "no fingerprint pin" - callers state that explicitly.
  readonly expectedStageFingerprint: string | null;
  /**
   * The version the caller resolved and CONFIRMED before it waited for the
   * lock - `host update --version X` from a Settings click that validated
   * X's catalog entry against this host's CLI floor and asked the user
   * about X. The stage is shared and the wait is unlocked: a `host
   * download Y` promoted in between leaves Y where X was, and the
   * fingerprint pin above is `null` on that path. Committing Y would
   * install a version nobody confirmed and no floor was checked for. A
   * differing stage is `stage-version-mismatch`, decided before the busy
   * gate and before `onWillCommitStaged`, so nothing is announced or
   * disturbed for it. `null` for an implicit "latest": a newer stage
   * another promoter left is then the better answer to the same request.
   * Compared as a string, not through `compareHostVersions`: both sides
   * are the catalog entry's own `version` (the staged record copies it,
   * the caller resolved it), so this pins the ARTIFACT - build metadata
   * included - not the release it belongs to.
   */
  readonly expectedStagedVersion: string | null;
  // Skips the busy check. Does NOT affect `--no-service`'s own busy-check
  // skip below - the two flags are independent knobs with the same effect
  // on this one gate.
  readonly force: boolean;
  // Internal/hidden (desktop-owned packaged-macOS path): skips the busy
  // check AND the service stop/start lifecycle entirely (a non-disruptive
  // POSIX swap). Rejected on Windows, where the service stop is load-
  // bearing for releasing file handles the rename needs.
  readonly noService: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
  /** See `commitInstallFromSource` for the final-actuator contract. */
  readonly verifyMutationCapability: () => Promise<void>;
  /**
   * Published immediately before a lifecycle-controlled OS service launch.
   * A parent contender supplies this one-shot supervisor adoption proof so
   * `host start` does not deadlock trying to reacquire the same outer lock.
   */
  readonly publishHostStartAdoption?: HostStartAdoptionPublisher;
  /**
   * Called once this function has committed to the disruptive half: after
   * reconcile has settled what is staged (it deletes stale stages and
   * restores an aside left by a crashed promoter, so what the caller read
   * before this call is not what is applied), after the no-op and
   * fingerprint decisions, and after the busy gate where one runs (`force`
   * and `noService` skip it) - with the version of the stage about to be
   * committed. `host update` takes ownership of its progress marker here; a
   * no-op, a fingerprint or version mismatch and a busy refusal never reach
   * it, so nothing is announced for work that does not happen. `null` for
   * a caller with nothing to announce (`host apply`).
   */
  readonly onWillCommitStaged:
    | ((stagedVersion: string) => Promise<void>)
    | null;
  /**
   * The disruption boundary: runs once the commit's pre-stop (or, when the
   * lifecycle decides not to stop, pre-swap) mutation-capability check has
   * passed and immediately before that actuator - the first point at which
   * this call can have disturbed the running host. A failure BEFORE it (a
   * status probe that throws, a refused authority, a busy refusal) left the
   * host as it was; `host update` uses that to restore a progress marker it
   * took over instead of stamping its own failure over another updater's
   * live record. Reported by the actuators
   * (`CreateServiceInstallLifecycleOptions.onWillStopHost`,
   * `CommitInstallFromSourceOptions.onWillSwap`), never inferred from the
   * `service-stop` / `swap` progress lines, which precede those checks.
   * `null` for a caller not tracking it.
   */
  readonly onWillDisruptHost: (() => void) | null;
  /**
   * The two swap barriers, threaded into the lifecycle this function builds
   * internally so a caller reaches them without duplicating the apply path
   * or its contender wrapper (`host/update-mutation.ts`).
   *
   * They sit BESIDE `onWillCommitStaged` and `onWillDisruptHost`, not in
   * place of either, and they answer a different question. The first two are
   * ANNOUNCEMENTS aimed at the progress marker - "work is about to start",
   * "the host may now be disturbed" - and neither may fail the apply. These
   * two are RECORD ADVANCES: `hooks.beforeSwapCommit` runs after the
   * cooperative stop SUCCEEDED and before the swap, `hooks.afterSwap` after
   * it, and each is a durable write the attempt executor must land before
   * the next irreversible step.
   *
   * Ordering, for the four in one place: `onWillCommitStaged` before the
   * lifecycle exists (so before the cooperative stop), `onWillDisruptHost`
   * at the pre-stop/pre-swap capability check, `hooks.beforeSwapCommit`
   * after the stop succeeded, `hooks.afterSwap` after the swap. A stop
   * denial therefore reaches the first two and neither of the last two.
   * `--no-service` builds no lifecycle at all and reaches neither barrier.
   * Callers driving no attempt record pass `NO_INSTALL_PHASE_HOOKS`.
   */
  readonly hooks: InstallPhaseHooks;
}

// The facts `createServiceInstallLifecycle` observed around the swap -
// mirrors the same family of facts `host ensure`'s `serviceLifecycle`
// payload already reports (Tech Plan: "Attested generation in results"),
// so a caller (the controller, or `host update`'s legacy-projection
// compat boundary) can attribute readiness without re-deriving it.
// `postSwapError` stays a sibling on `ApplyHostOutcome` itself, not
// nested here, matching this function's existing no-rollback contract.
export interface ApplyServiceLifecycleFacts {
  readonly priorServiceState: ServiceState;
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
}

export type ApplyHostOutcome =
  | {
      // The ONLY reachable no-op path: reconcile (this function's own
      // first step) already deletes a `comparable staged <= installed`
      // stage via its own "stale-or-equal-version" deletion rule before
      // this function ever reads it - so a distinct "not newer" no-op
      // branch here would be unreachable dead code, not a second real
      // outcome. See stage-reconcile.ts's `evaluateStageForDeletion`.
      readonly outcome: "no-op";
      readonly installedVersion: string;
    }
  | {
      readonly outcome: "applied";
      readonly record: HostInstallRecord;
      readonly previous: HostInstallRecord | null;
      // False whenever `--no-service` was set (no start was even
      // attempted) or the post-swap start/restart failed. True means the
      // start was REQUESTED and the request was accepted - NOT that the host
      // is serving: `launchctl kickstart` returns as soon as launchd accepts,
      // so an unspawnable job answers success. Nothing here probes health;
      // `host update` does, and `host status` answers it directly.
      readonly runningActivated: boolean;
      // The attested, committed canonical install-generation fingerprint -
      // read from the record this call itself just wrote, never a later
      // disk re-read, so callers never race a subsequent mutation.
      readonly installGeneration: string;
      // `null` iff `--no-service` skipped the lifecycle entirely - apply
      // has no service facts to report, not a synthesized "not-installed"
      // guess.
      readonly serviceLifecycle: ApplyServiceLifecycleFacts | null;
      // Non-null iff the post-swap start/restart threw. Per the Tech
      // Plan's no-rollback contract, this is a WARNING alongside a
      // successful "applied" outcome, never a thrown error - "installed,
      // not converged", never "update ready".
      readonly postSwapError: string | null;
    }
  | {
      readonly outcome: "stage-fingerprint-mismatch";
      readonly installedVersion: string;
      readonly expectedStageFingerprint: string | null;
      readonly actualStageFingerprint: string | null;
    }
  | {
      // The stage holds a version other than the one the caller confirmed
      // (`expectedStagedVersion`). Nothing was consumed, announced or
      // disturbed; the stage is left for its promoter.
      readonly outcome: "stage-version-mismatch";
      readonly installedVersion: string;
      readonly expectedStagedVersion: string;
      readonly actualStagedVersion: string;
    };

export async function applyHost(
  opts: ApplyHostOptions,
): Promise<ApplyHostOutcome> {
  const logger = createCliLogger(opts.environment);

  if (opts.noService && currentInstallPlatform() === "win32") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host apply: --no-service is not supported on Windows",
      details: { environment: opts.environment },
      exitCode: 1,
    });
  }

  await reconcileHostStageWithAttempt(
    opts.environment,
    opts.verifyMutationCapability,
  );

  const installed = await readHostInstallRecord(opts.environment);
  if (installed === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host apply: no host installed for environment=${opts.environment}; run 'traycer host install' first`,
      details: { environment: opts.environment },
      exitCode: 1,
    });
  }

  // Reconcile above already applies the Version Identity policy for us:
  // its own "stale-or-equal-version" deletion rule removes a `comparable
  // staged <= installed` stage before this read ever sees it, and its
  // orphan rule guarantees a surviving stage never outlives its install
  // record. So if a stage is still here, it's already either incomparable
  // to `installed` (proceeds - D6 parity) or strictly newer - there is no
  // separate "staged but not newer" case left to check.
  const staged = await readHostStagedRecord(opts.environment);
  const expectedStageFingerprint = opts.expectedStageFingerprint;
  if (
    expectedStageFingerprint !== null &&
    (staged === null || staged.stageId !== expectedStageFingerprint)
  ) {
    logger.info("Host apply rejected a replaced staged handoff", {
      environment: opts.environment,
      expectedStageFingerprint,
      actualStageFingerprint: staged?.stageId ?? null,
    });
    return {
      outcome: "stage-fingerprint-mismatch",
      installedVersion: installed.version,
      expectedStageFingerprint,
      actualStageFingerprint: staged?.stageId ?? null,
    };
  }
  if (staged === null) {
    logger.info("Host apply found nothing staged", {
      environment: opts.environment,
    });
    return { outcome: "no-op", installedVersion: installed.version };
  }
  if (
    opts.expectedStagedVersion !== null &&
    staged.version !== opts.expectedStagedVersion
  ) {
    logger.info(
      "Host apply rejected a stage naming a version other than the one requested",
      {
        environment: opts.environment,
        expectedStagedVersion: opts.expectedStagedVersion,
        actualStagedVersion: staged.version,
      },
    );
    return {
      outcome: "stage-version-mismatch",
      installedVersion: installed.version,
      expectedStagedVersion: opts.expectedStagedVersion,
      actualStagedVersion: staged.version,
    };
  }

  if (!opts.noService && !opts.force) {
    await assertHostNotBusy(opts.environment);
  }
  if (opts.onWillCommitStaged !== null) {
    await opts.onWillCommitStaged(staged.version);
  }

  // `bootstrap: null` - apply is strictly an update over an existing,
  // already-registered install (guaranteed by the `HOST_NOT_INSTALLED`
  // check above), never a first registration; mirrors `host update`'s
  // existing lifecycle construction.
  const lifecycleHandle = opts.noService
    ? null
    : createServiceInstallLifecycle({
        environment: opts.environment,
        bootstrap: null,
        // Threaded through to the pre-swap stop, not just the busy
        // pre-check above: without it, a busy Desktop-managed host still
        // denied the cooperative shutdown claim and `--force` aborted
        // anyway.
        force: opts.force,
        onWillStopHost: opts.onWillDisruptHost,
        hooks: opts.hooks,
      });
  if (lifecycleHandle !== null && opts.publishHostStartAdoption !== undefined) {
    lifecycleHandle.lifecycle.setHostStartAdoptionPublisher?.(
      opts.publishHostStartAdoption,
    );
  }

  const stagedDir = hostStagedDir(opts.environment);
  const { record, previous } = await commitInstallFromSource({
    environment: opts.environment,
    sourceDir: stagedDir,
    executablePath: join(stagedDir, staged.executablePath),
    version: staged.version,
    runtimeVersion: staged.runtimeVersion,
    source: staged.source,
    archiveSha256: staged.archiveSha256,
    signatureVerifiedAt: staged.signatureVerifiedAt,
    signatureKeyId: staged.signatureKeyId,
    sizeBytes: staged.sizeBytes,
    onProgress: opts.onProgress,
    lifecycle: lifecycleHandle?.lifecycle ?? null,
    onCommitted: () => {},
    verifyMutationCapability: opts.verifyMutationCapability,
    onWillSwap: opts.onWillDisruptHost,
  });

  // `createServiceInstallLifecycle`'s `afterSwap` already swallows its own
  // start/restart/register failures into `state.postSwapError` rather than
  // throwing (see service/install-lifecycle.ts) - that existing swallow-
  // into-field behavior IS this function's no-rollback contract; no
  // separate try/catch needed here.
  const postSwapError = lifecycleHandle?.state.postSwapError ?? null;
  const runningActivated =
    lifecycleHandle !== null &&
    postSwapError === null &&
    lifecycleHandle.state.postSwapAction !== "none";
  const serviceLifecycle: ApplyServiceLifecycleFacts | null =
    lifecycleHandle === null
      ? null
      : {
          priorServiceState: lifecycleHandle.state.priorState,
          stoppedBeforeSwap: lifecycleHandle.state.stoppedBeforeSwap,
          postSwapAction: lifecycleHandle.state.postSwapAction,
        };

  const installGeneration = encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });

  logger.info("Host apply completed", {
    environment: opts.environment,
    version: record.version,
    previousVersion: previous?.version ?? null,
    runningActivated,
    hasPostSwapError: postSwapError !== null,
  });

  return {
    outcome: "applied",
    record,
    previous,
    runningActivated,
    installGeneration,
    serviceLifecycle,
    postSwapError,
  };
}
