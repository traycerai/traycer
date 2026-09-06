import { access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import type { Environment } from "../runner/environment";
import { createCliLogger, type ILogger } from "../logger";
import type { ProgressInfo } from "../runner/output";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
  releaseDownloadSlot,
  releaseDownloadSlotOwnership,
  type HostPlatformAsset,
  type HostVersionEntry,
  type HostVersionsManifest,
  type RegistryClient,
} from "../registry";
import { readHostInstallRecord } from "../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  readHostStagedRecord,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../manifest/host-staged";
import {
  ensureHostHomeDirForStaged,
  hostHomeDir,
  hostStagedDir,
} from "../store/paths";
import { createOwnedTempDir } from "../store/owned-temp";
import {
  withCliAttemptMutation,
  withCliUpdateExecutionSegment,
  requireCliUpdateMutationCapability,
} from "../host/update-contender";
import {
  readUpdateAttemptRecord,
  type HostUpdateAttemptIdentity,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  currentInstallArch,
  currentInstallPlatform,
  stageVerifiedSource,
} from "./install";
import { hashFileSha256 } from "./sha256";
import { invalidateAsideDir } from "./aside-dirs";
import { renameWithRetry } from "./rename-retry";
import {
  purgeHostStage,
  reconcileHostStageWithAttempt,
} from "./stage-reconcile";

// `host download` - the CLI's half of the two-phase split (Host Update
// Layer Redesign Tech Plan, "CLI: two-phase split with a staged store").
// Download+verify+extract runs with NO `cli-lock` held (no busy check
// either - the running host is never touched); only the brief
// eligibility-check-and-promote sections take the lock.

export interface DownloadAndStageHostOptions {
  readonly environment: Environment;
  // `null` requests the manifest's `latest` pointer. A concrete string is
  // an explicit version request - `host download <v>` without
  // `--automatic` replaces any existing stage (see `ShortCircuitReason`/
  // promotion policy below).
  readonly versionRequest: string | null;
  // The hidden `--automatic` contract: additionally refuses to stage when
  // the installed version is incomparable (a `local-*` pin). Explicit
  // invocations (this flag false) proceed regardless.
  readonly automatic: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
  // Test seam so unit tests can inject a fake `RegistryTransport` without
  // monkey-patching the module. `null` uses the real default client.
  readonly registryClient: RegistryClient | null;
  /**
   * Awaited once, AFTER the phase-1 short-circuit decision has said a transfer
   * is needed and BEFORE the first byte is requested. Never fires on
   * `installed-up-to-date`, `already-staged`, the automatic incomparable
   * refusal, or a manifest/version failure - every one of those returns or
   * throws above the call.
   *
   * Exists so `host update` can publish its coarse `updating` marker at the
   * moment the work becomes visible to the user, rather than after a
   * multi-minute transfer has already finished. `host download` passes
   * `null`: it has no marker to write, and a hook that did nothing would only
   * invite the next reader to wonder what it was for.
   */
  readonly onWillDownload: ((targetVersion: string) => Promise<void>) | null;
  /**
   * See `StageVerifiedSourceOptions.beforeExtract` - the same barrier, on
   * the other staging path. Awaited after `downloadAndVerify` has RESOLVED
   * (sha256 in the transport, minisign in the registry client) and before
   * the first archive entry is written, so a caller marking "the bytes are
   * verified, the tree is not built yet" marks it once whichever path ran.
   *
   * Unlike `onWillDownload` this is not nullable: it fires on exactly one
   * path (a transfer that reached extraction), and every caller that tracks
   * no attempt passes a no-op.
   */
  readonly beforeExtract: () => Promise<void>;
  /**
   * The attempt this run is itself executing, or `null` when it executes
   * none. The promote-time guard below yields to ANY nonterminal attempt
   * record; a run that IS that attempt would otherwise refuse to promote its
   * own staged bytes. A record whose `attemptId` matches AND whose target is
   * the candidate version is this run's own work and is not a yield;
   * anything else - another attempt, or the same id pointed at a different
   * version - yields exactly as it does today (Plan D6).
   */
  readonly ownAttempt: HostUpdateAttemptIdentity | null;
}

export type HostDownloadShortCircuitReason =
  | "installed-up-to-date"
  | "already-staged"
  | "automatic-refused-incomparable-installed";

export type HostDownloadDiscardReason =
  | "install-record-vanished"
  // A slower "latest" download lost a reverse-completion race: a newer
  // (or equal) stage was already promoted by the time this one reached
  // phase 3.
  | "not-strictly-newer"
  // An explicit version request's target is not newer than the fresh,
  // locked-read installed version (comparable case only - see
  // "automatic-refused-incomparable-installed" for the incomparable case).
  | "not-newer-than-installed"
  // `--automatic` re-refuses an incomparable installed version at promote
  // time too, not just in phase 1 - the installed version can change
  // during the unlocked transfer window. Mirrors the phase-1 short-circuit
  // reason of the same name; the two are distinguished by `outcome`.
  | "automatic-refused-incomparable-installed";

export type HostDownloadOutcome =
  | {
      readonly outcome: "short-circuit";
      readonly reason: HostDownloadShortCircuitReason;
      readonly targetVersion: string;
      readonly installedVersion: string;
      readonly stagedVersion: string | null;
    }
  | {
      readonly outcome: "discarded";
      readonly reason: HostDownloadDiscardReason;
      readonly targetVersion: string;
    }
  | {
      readonly outcome: "promoted";
      readonly stagedVersion: string;
      readonly installedVersion: string;
    };

export type HostDownloadPromotionDecision =
  | { readonly kind: "promote" }
  | { readonly kind: "discard"; readonly reason: HostDownloadDiscardReason };

/** Pure promote-time policy, evaluated from records freshly read under the lock. */
export function decideHostDownloadPromotion(input: {
  readonly candidateVersion: string;
  readonly installedVersion: string;
  readonly stagedVersion: string | null;
  readonly stagedStageId: string | null;
  readonly explicitVersionRequested: boolean;
  readonly automatic: boolean;
}): HostDownloadPromotionDecision {
  const installedComparison = compareHostVersions(
    input.candidateVersion,
    input.installedVersion,
  );
  const passesInstalledMonotonicity = installedComparison.comparable
    ? installedComparison.ordering === "greater"
    : !input.automatic;
  const strictlyNewerThanStaged =
    input.explicitVersionRequested ||
    input.stagedVersion === null ||
    input.stagedStageId === null ||
    isStrictlyNewerHostVersion(input.candidateVersion, input.stagedVersion);

  if (passesInstalledMonotonicity && strictlyNewerThanStaged) {
    return { kind: "promote" };
  }
  return {
    kind: "discard",
    reason: !passesInstalledMonotonicity
      ? installedComparison.comparable
        ? "not-newer-than-installed"
        : "automatic-refused-incomparable-installed"
      : "not-strictly-newer",
  };
}

function progressStage(
  onProgress: (info: ProgressInfo) => void,
  stage: string,
  message: string,
): void {
  onProgress({
    stage,
    message,
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
}

// Yank-heal: a staged version that is no longer a valid, non-yanked
// manifest entry is discarded - "the desktop-scheduled yank-heal" that
// must run even when no download follows this invocation.
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discardIneligibleStagedVersion(
  environment: Environment,
  manifest: HostVersionsManifest,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  const staged = await readHostStagedRecord(environment);
  if (staged === null) return;
  const entry = manifest.versions.find((v) => v.version === staged.version);
  const ineligible = entry === undefined || entry.yanked;
  if (!ineligible) return;
  // This runs under the caller's short promote/precheck lock. Do not delete
  // only canonical `staged/`: normal reconcile would restore a valid
  // `staged.old-*` aside and resurrect this withdrawn artifact.
  await purgeHostStage(environment, null, verifyMutationCapability);
  logger.info("Host download discarded an ineligible staged version", {
    environment,
    version: staged.version,
    reason: entry === undefined ? "absent" : "yanked",
  });
}

async function replaceStagedDir(
  environment: Environment,
  tempDir: string,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  await ensureHostHomeDirForStaged(environment);
  const target = hostStagedDir(environment);
  const aside = `${target}.old-${Date.now()}`;
  const targetExists = await pathExists(target);
  if (targetExists) {
    await verifyMutationCapability();
    await renameWithRetry(target, aside, verifyMutationCapability);
  }
  await verifyMutationCapability();
  await renameWithRetry(tempDir, target, verifyMutationCapability);
  if (targetExists) {
    // Layered invalidation (rename to a `.dead-*` sibling, else unlink
    // just the sidecar, else a full recursive removal) so a partial
    // failure can never leave a fully intact, restorable aside behind -
    // shared with `stage-reconcile.ts`'s own pure-litter cleanup, which
    // creates and discards asides via the identical explicit-replace
    // shape.
    await verifyMutationCapability();
    await invalidateAsideDir(
      target,
      aside,
      "staged.json",
      logger,
      verifyMutationCapability,
    );
  }
}

// The one shape every stage-maintenance leg shares. Named once so a changed
// admission literal or wait policy cannot drift between the three copies the
// inline types used to be.
//
// `admission` is the ONE widened field: `host download` and the legacy
// `host update` stage under `stage-maintenance`, while the attempt executor
// stages the very bytes of the attempt it holds and passes its own
// `attempt-executor` admission down (Plan D6, CLI wiring "Installer entry").
// Nothing else about the leg differs - same reasons, same wait policy - so
// widening the literal rather than forking the shape keeps the two callers
// provably on one code path.
export interface StageMaintenanceContenderOptions {
  readonly environment: Environment;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly admission: "stage-maintenance" | "attempt-executor";
}

/** The stage-promotion actuator; capability is checked at the rename edge. */
async function replaceStagedDirWithAttempt(
  capability: UpdateMutationCapability,
  contenderOptions: StageMaintenanceContenderOptions,
  environment: Environment,
  tempDir: string,
  logger: ILogger,
): Promise<void> {
  const verifyMutationCapability = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  await replaceStagedDir(
    environment,
    tempDir,
    logger,
    verifyMutationCapability,
  );
}

// Phase 0 - brief lock, zero network: fail fast with HOST_NOT_INSTALLED
// before any WAN call, so an uninstalled host + an unreachable registry
// reports the correct, actionable error instead of a misleading
// REGISTRY_UNAVAILABLE. Superseded by phase 1's own locked re-read
// immediately below - state can still change in the gap before the
// manifest fetch completes, so phase 1's read remains the authoritative
// decision snapshot; this is purely a fast-fail precondition.
async function ensureHostInstalledPrecondition(
  environment: Environment,
  capability: UpdateMutationCapability,
  contenderOptions: StageMaintenanceContenderOptions,
): Promise<void> {
  await withCliAttemptMutation(capability, contenderOptions, async () => {
    await reconcileHostStageWithAttempt(environment, () =>
      requireCliUpdateMutationCapability(capability, contenderOptions),
    );
    const installed = await readHostInstallRecord(environment);
    if (installed === null) {
      throw cliError({
        code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
        message: `host download: no host installed for environment=${environment}; run 'traycer host install' first`,
        details: { environment },
        exitCode: 1,
      });
    }
  });
}

export async function downloadAndStageHost(
  opts: DownloadAndStageHostOptions,
): Promise<HostDownloadOutcome> {
  const contenderOptions = {
    environment: opts.environment,
    reason: "host-download",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "stage-maintenance" as const,
  };
  return withCliUpdateExecutionSegment(contenderOptions, (capability) =>
    downloadAndStageHostInSegment(opts, capability, contenderOptions),
  );
}

// The whole stage under a capability the CALLER already holds. Exported for
// the attempt executor, which owns its segment for the length of the run and
// cannot let this function open a second one: `downloadAndStageHost` above is
// the same body with the segment wrapped around it, and is what every caller
// that owns no capability of its own uses.
//
// Kept BELOW that wrapper on purpose - the source-order fence in
// `clients/shared/__tests__/host-update-contender-architecture.test.ts`
// reads this file as text and requires `withCliUpdateExecutionSegment(` to
// precede both this function's name and `downloadAndVerify(`. Hoisting the
// definition above the wrapper reddens it.
export async function downloadAndStageHostInSegment(
  opts: DownloadAndStageHostOptions,
  capability: UpdateMutationCapability,
  contenderOptions: StageMaintenanceContenderOptions,
): Promise<HostDownloadOutcome> {
  const logger = createCliLogger(opts.environment);

  await ensureHostInstalledPrecondition(opts.environment, capability, {
    ...contenderOptions,
    reason: "host-download-precondition",
  });

  const client =
    opts.registryClient ??
    (await createDefaultRegistryClient(opts.environment, opts.onProgress));
  progressStage(opts.onProgress, "resolve", "resolving host manifest");
  const manifest = await client.fetchManifest();
  const requestedLatest = opts.versionRequest === null;
  const targetVersion = requestedLatest ? manifest.latest : opts.versionRequest;
  // The registry side of the version domain must always be valid SemVer
  // (incomparability is a policy reserved for the INSTALLED side only -
  // see the Tech Plan's "Version identity" section). A malformed
  // manifest.latest or a garbled explicit request would otherwise read as
  // "incomparable" everywhere it's compared against `installed.version`,
  // silently defeating short-circuiting and, worse, letting a bad version
  // get staged and wedge stage-reconcile's convergence. Fail closed here,
  // before any lock or network transfer.
  if (!isValidHostVersion(targetVersion)) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host download: registry target version '${targetVersion}' is not valid SemVer`,
      details: { environment: opts.environment, targetVersion },
      exitCode: 1,
    });
  }

  // Phase 1 - brief lock: locked install re-read + yank-heal + short-
  // circuit evaluation. Runs even when no download follows. The install
  // record is read HERE, under the lock, rather than before it - a
  // pre-lock read can be stale by the time the short-circuit decision
  // actually runs (another command could install/uninstall/update in the
  // gap), and every phase-1 decision (missing-record, short-circuits,
  // automatic incomparable refusal) must be judged against the same
  // consistent snapshot.
  const preDownload = await withCliAttemptMutation(
    capability,
    { ...contenderOptions, reason: "host-download-precheck" },
    async () => {
      const verifyMutationCapability = (): Promise<void> =>
        requireCliUpdateMutationCapability(capability, {
          ...contenderOptions,
          reason: "host-download-precheck",
        });
      await reconcileHostStageWithAttempt(
        opts.environment,
        verifyMutationCapability,
      );
      const installed = await readHostInstallRecord(opts.environment);
      if (installed === null) {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
          message: `host download: no host installed for environment=${opts.environment}; run 'traycer host install' first`,
          details: { environment: opts.environment },
          exitCode: 1,
        });
      }
      await discardIneligibleStagedVersion(
        opts.environment,
        manifest,
        logger,
        verifyMutationCapability,
      );
      const stagedAfterYankHeal = await readHostStagedRecord(opts.environment);
      const installedVsTarget = compareHostVersions(
        installed.version,
        targetVersion,
      );
      const installedAtOrAboveTarget =
        installedVsTarget.comparable && installedVsTarget.ordering !== "less";
      // "Up to date" for an EXPLICIT request is the request's own string
      // and nothing else. A record the comparator puts at or above the
      // request by ANOTHER string - strictly newer (`--version 1.2.0` over
      // an installed 2.0.0), or another build of the same release
      // (`2.0.0+bar` over a requested `2.0.0+foo`: the comparator ignores
      // build metadata) - is not the artifact the caller named. Reporting
      // it as up to date handed `host update` a no-op, exit 0, with the
      // requested artifact never delivered: a request that delivered
      // nothing does not report success, the rule the promote gate and the
      // version binding under the activation lock already apply to the same
      // fact. Refused HERE, before `onWillDownload` and any transfer, with
      // the code that fact carries everywhere else and its remedy. An
      // implicit "latest" keeps the at-or-above reading: the registry's
      // release is installed, in a build the promote gate would not
      // replace.
      //
      // Thrown from INSIDE the lock closure rather than returned as one
      // more `shortCircuit`: the short-circuit arms are outcomes this
      // function reports to a caller that then decides what to do, and
      // there is nothing to decide here. It also keeps the refusal on the
      // same side of the lock as the reads it is derived from.
      if (
        !requestedLatest &&
        installedAtOrAboveTarget &&
        installed.version !== targetVersion
      ) {
        const relation =
          installedVsTarget.ordering === "greater"
            ? `newer than the requested ${targetVersion}`
            : `another build of the same release as the requested ${targetVersion}`;
        throw cliError({
          code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
          message: `host download: the installed host is ${installed.version}, ${relation}; nothing was transferred. Run 'traycer host status' to see what is installed, or pass --allow-downgrade to 'traycer host update' to install ${targetVersion} over it`,
          details: {
            environment: opts.environment,
            targetVersion,
            installedVersion: installed.version,
          },
          exitCode: 1,
        });
      }
      const alreadyStagedAtTarget =
        stagedAfterYankHeal !== null &&
        stagedAfterYankHeal.stageId !== null &&
        stagedAfterYankHeal.version === targetVersion;
      // Snapshot both taken under this same lock acquisition - the
      // short-circuit return below must report exactly what was true at
      // decision time, not a second, unlocked re-read after the lock has
      // already been released (which could observe a different state).
      const installedVersion = installed.version;
      const stagedVersion = stagedAfterYankHeal?.version ?? null;
      if (installedAtOrAboveTarget) {
        return {
          shortCircuit: "installed-up-to-date" as const,
          installedVersion,
          stagedVersion,
        };
      }
      if (alreadyStagedAtTarget) {
        return {
          shortCircuit: "already-staged" as const,
          installedVersion,
          stagedVersion,
        };
      }
      if (opts.automatic && !installedVsTarget.comparable) {
        return {
          shortCircuit: "automatic-refused-incomparable-installed" as const,
          installedVersion,
          stagedVersion,
        };
      }
      return { shortCircuit: null, installedVersion, stagedVersion };
    },
  );
  if (preDownload.shortCircuit !== null) {
    logger.info("Host download short-circuited before any transfer", {
      environment: opts.environment,
      targetVersion,
      reason: preDownload.shortCircuit,
    });
    return {
      outcome: "short-circuit",
      reason: preDownload.shortCircuit,
      targetVersion,
      installedVersion: preDownload.installedVersion,
      stagedVersion: preDownload.stagedVersion,
    };
  }

  // The transfer is now certain. Told BEFORE `resolveAsset`, not merely before
  // the byte stream: the asset lookup is itself a network call to the
  // registry, and "the update has started" is true from here on.
  if (opts.onWillDownload !== null) {
    await opts.onWillDownload(targetVersion);
  }

  // Phase 2 - no lock: download, verify, extract into an owner-tokened
  // temp. The registry client owns the network+verify chain end to end
  // (fetch-resource.ts's size cap, sha256, minisign, pinned keyId) - not
  // forked here.
  const platformKey = currentHostPlatformKey();
  const { entry, asset } = await client.resolveAsset(
    targetVersion,
    platformKey,
  );
  progressStage(
    opts.onProgress,
    "download",
    `downloading host ${entry.version}`,
  );
  const verified = await client.downloadAndVerify(entry, asset, (progress) => {
    const percent =
      progress.totalBytes > 0
        ? Math.round((progress.downloadedBytes / progress.totalBytes) * 100)
        : null;
    opts.onProgress({
      stage: "download",
      message: `downloading host ${entry.version}`,
      percent,
      bytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
      workUnits: null,
    });
  });

  let ownedPath: string | null = null;
  let ownedConsumed = false;
  // Whether the promote phase ran to a decision. Only then is the archive
  // finished with; anything that THROWS out of the block below (a failed
  // extract, a missing executable in the tree, a `cli-lock` wait that times
  // out) leaves a downloaded, sha256- and signature-verified archive that a
  // retry can reuse as-is. See the `finally`.
  let archiveConsumed = false;
  try {
    const owned = await createOwnedTempDir(opts.environment, "dl-");
    ownedPath = owned.path;
    // `const` alias so the closures below (captured by `withCliLock`)
    // keep the narrowed `string` type instead of the outer `let`'s
    // `string | null`.
    const tempPath = owned.path;
    // The verified-bytes barrier and the extraction itself, shared with
    // `stageHostInstallSource`'s private-source path so the two cannot
    // drift. The temp dir is created HERE and not inside it: the two paths
    // own their temps in different cleanup scopes (this one's `finally`
    // below, the other one's `catch`).
    const { executablePath, runtimeVersion } = await stageVerifiedSource({
      environment: opts.environment,
      archivePath: verified.archivePath,
      targetDir: tempPath,
      version: entry.version,
      extractMessage: `extracting host ${entry.version}`,
      onProgress: opts.onProgress,
      beforeExtract: opts.beforeExtract,
    });
    // The archive digest proves the fetched source.  Recovery also needs the
    // digest of the exact executable extracted from that verified archive,
    // so a stable but replaced staged file cannot be mistaken for a resumable
    // target generation.
    const executableSha256 = await hashFileSha256(executablePath, null);
    const stagedRecord: HostStagedRecord = {
      schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
      stageId: randomUUID(),
      version: entry.version,
      runtimeVersion,
      archiveSha256: verified.archiveSha256,
      sizeBytes: asset.sizeBytes,
      source: { kind: "registry", value: entry.version },
      signatureKeyId: verified.signatureKeyId,
      signatureVerifiedAt: verified.signatureVerifiedAt,
      executablePath: relative(tempPath, executablePath),
      platform: currentInstallPlatform(),
      arch: currentInstallArch(),
      executableSha256,
    };
    await requireCliUpdateMutationCapability(capability, {
      ...contenderOptions,
      reason: "host-download-stage-record",
    });
    await writeHostStagedRecordAt(tempPath, stagedRecord);

    // Phase 3 - brief lock: reconcile, re-read, re-check the install
    // record still exists, and promote only per the intent policy.
    const outcome = await withCliAttemptMutation(
      capability,
      { ...contenderOptions, reason: "host-download-promote" },
      async () => {
        // Re-evaluate the attempt predicate inside the SAME cli-lock section
        // that owns reconcile and promotion. The outer stage-maintenance
        // admission normally excludes an already-active attempt, but it is a
        // pre-transfer observation and cannot substitute for the fresh
        // promote-time guard. In particular, a parked activation releases
        // cli-lock while its staged bytes remain identity-bound to that
        // attempt; neither background/latest nor an explicit version request
        // may replace that slot underneath it.
        const attempt = await readUpdateAttemptRecord(
          hostHomeDir(opts.environment),
        );
        // This run's OWN attempt is not a competitor to yield to: the guard
        // exists to stop a background/explicit download replacing bytes
        // another attempt is bound to, and the executor promoting the stage
        // it is itself downloading is precisely the case that is not that.
        // The target must match too - the same attempt pointed at a
        // different version has moved on from these bytes, and the record's
        // generation/sequence deliberately do NOT participate: the record
        // advances (downloading ticks, phase writes) throughout the very
        // transfer that leads here, so a positional match would fail on
        // every real run. Identity is the attempt id.
        const attemptIsOwn =
          opts.ownAttempt !== null &&
          attempt.kind === "valid" &&
          attempt.value.attemptId === opts.ownAttempt.attemptId &&
          attempt.value.targetVersion === stagedRecord.version;
        if (
          attempt.kind === "valid" &&
          attempt.value.execution !== "terminal" &&
          !attemptIsOwn
        ) {
          logger.info(
            "Host download yielded before promotion to an active update attempt",
            {
              environment: opts.environment,
              candidateVersion: stagedRecord.version,
              attemptId: attempt.value.attemptId,
              attemptTargetVersion: attempt.value.targetVersion,
              phase: attempt.value.phase,
              explicitVersionRequested: !requestedLatest,
            },
          );
          throw cliError({
            code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
            message:
              "a host update attempt is in progress; the downloaded host was not promoted over its staged bytes",
            details: {
              reason: "host-download-promote",
              disposition: "yield",
              attemptId: attempt.value.attemptId,
              phase: attempt.value.phase,
              targetVersion: attempt.value.targetVersion,
              candidateVersion: stagedRecord.version,
            },
            exitCode: 75,
          });
        }
        if (attempt.kind !== "absent" && attempt.kind !== "valid") {
          throw cliError({
            code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
            message:
              "host update attempt state cannot be verified; refusing to replace staged host bytes",
            details: {
              reason: "host-download-promote",
              recordKind: attempt.kind,
            },
            exitCode: 1,
          });
        }

        await reconcileHostStageWithAttempt(opts.environment, () =>
          requireCliUpdateMutationCapability(capability, {
            ...contenderOptions,
            reason: "host-download-promote",
          }),
        );
        const freshInstalled = await readHostInstallRecord(opts.environment);
        if (freshInstalled === null) {
          // A download finishing after an uninstall must not resurrect a
          // stage - discard, no promotion.
          await requireCliUpdateMutationCapability(capability, {
            ...contenderOptions,
            reason: "host-download-discard",
          });
          await rm(tempPath, { recursive: true, force: true });
          ownedConsumed = true;
          logger.warn(
            "Host download discarded a completed download - the install record vanished",
            { environment: opts.environment, version: stagedRecord.version },
          );
          return {
            outcome: "discarded",
            reason: "install-record-vanished",
            targetVersion,
          } satisfies HostDownloadOutcome;
        }

        const explicitVersionRequested = !requestedLatest;
        // Installed-monotonicity, re-evaluated against this fresh locked
        // read (the installed version can change during the unlocked
        // transfer window - phase 1's decision is not enough on its own).
        // `--automatic` refuses an incomparable installed version here
        // too, not just in phase 1: a comparable install at phase-1 time
        // could have been replaced by an incomparable (local-*) one by
        // now. Non-automatic (explicit OR latest) waives the incomparable
        // case - moving a local build onto the registry track is the
        // user's stated intent (D6 parity).
        // An explicit version request always replaces any existing stage
        // (the settled exception is replace-any-STAGE, not
        // ignore-installed) - the staged-monotonicity check below only
        // applies to the latest/automatic path, where a slower "latest"
        // download must not regress a faster one that already promoted.
        const freshStaged = explicitVersionRequested
          ? null
          : await readHostStagedRecord(opts.environment);
        const promotionDecision = decideHostDownloadPromotion({
          candidateVersion: stagedRecord.version,
          installedVersion: freshInstalled.version,
          stagedVersion: freshStaged?.version ?? null,
          stagedStageId: freshStaged?.stageId ?? null,
          explicitVersionRequested,
          automatic: opts.automatic,
        });

        if (promotionDecision.kind === "promote") {
          progressStage(
            opts.onProgress,
            "promote",
            `staging host ${stagedRecord.version}`,
          );
          await replaceStagedDirWithAttempt(
            capability,
            { ...contenderOptions, reason: "host-download-promote" },
            opts.environment,
            tempPath,
            logger,
          );
          ownedConsumed = true;
          return {
            outcome: "promoted",
            stagedVersion: stagedRecord.version,
            installedVersion: freshInstalled.version,
          } satisfies HostDownloadOutcome;
        }

        // This deliberate-discard edge is still a mutation of the
        // capability-bound staging tree. Do not let a long download's holder
        // loss turn its final cleanup into an unadmitted delete.
        await requireCliUpdateMutationCapability(capability, {
          ...contenderOptions,
          reason: "host-download-discard",
        });
        await rm(tempPath, { recursive: true, force: true });
        ownedConsumed = true;
        const reason = promotionDecision.reason;
        logger.info(
          "Host download discarded a completed download at promote time",
          {
            environment: opts.environment,
            version: stagedRecord.version,
            reason,
          },
        );
        return {
          outcome: "discarded",
          reason,
          targetVersion,
        } satisfies HostDownloadOutcome;
      },
    );
    // Reached only by a normal return from the promote phase - promoted, or
    // deliberately discarded because the install record vanished or the
    // version is not newer. Either way this download is over and the archive
    // will not be wanted again.
    archiveConsumed = true;
    return outcome;
  } finally {
    // Verification stays outside the best-effort I/O catches — an unadmitted
    // delete must never run — but a capability loss inside this `finally`
    // must not THROW either: it would replace the primary outcome (the
    // promote-time error the caller classifies, or a completed promotion)
    // with E_CLI_LOCK_BUSY. Losing the capability skips the destructive
    // edge and leaves the leftovers to the next admitted run's sweep.
    const cleanupAdmitted = async (reason: string): Promise<boolean> => {
      try {
        await requireCliUpdateMutationCapability(capability, {
          ...contenderOptions,
          reason,
        });
        return true;
      } catch {
        return false;
      }
    };
    if (ownedPath !== null && !ownedConsumed) {
      if (await cleanupAdmitted("host-download-temp-cleanup")) {
        await rm(ownedPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    // The verified archive is not auto-cleaned on success (by contract -
    // see registry/client.ts's `downloadAndVerify`): the caller owns
    // releasing it once it has extracted what it needs. Whichever release
    // runs, it must never be a plain `rm(dirname(...))` - that directory is
    // now the SHARED download cache, not a private per-invocation temp.
    if (archiveConsumed) {
      // Drop the archive AND the claim on it.
      if (await cleanupAdmitted("host-download-archive-release")) {
        await releaseDownloadSlot(opts.environment, verified.archivePath).catch(
          () => undefined,
        );
      }
    } else if (await cleanupAdmitted("host-download-archive-release")) {
      // Something between the transfer and the promote decision threw. These
      // bytes already cleared sha256 AND minisign, so re-downloading them
      // could not produce anything different - it would just spend another
      // ~800MB over the same throttled link this work exists for, only to
      // hit the same local failure. Drop the claim and leave them: the next
      // run's `acquireDownloadSlot` spares this version's slot from the
      // sweep and resumes it over a single 416 round-trip.
      await releaseDownloadSlotOwnership(
        opts.environment,
        verified.archivePath,
      ).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// The advisory plan (Plan D1, CLI wiring "The advisory plan, by intent")
// ---------------------------------------------------------------------------
//
// Everything the transfer above decides from READS, split out as a function
// that only reads. It takes no lock, writes nothing, reconciles nothing and
// promotes nothing: it exists so a caller can shape its work BEFORE it
// contends for the attempt lock, and so the facts it saw can be compared
// with a re-read under that lock. The authority for every decision remains
// the locked re-read inside the transfer (and, for the executor, inside its
// selector) - a plan is a proposal, and a plan that disagrees with the
// locked reading loses.
//
// It is intent-shaped because the intents differ in what they are ALLOWED to
// touch, not merely in what they need: an `activate` run must complete with
// the registry unreachable (there is nothing to fetch - the bytes are already
// installed), so its request variant carries no version to resolve and this
// function structurally cannot reach the network on it.

export type HostUpdatePlanRequest =
  | {
      // Fresh work: resolve the registry and decide what kind of arm this is.
      readonly intent: "install";
      // `null` requests the manifest's `latest` pointer.
      readonly versionRequest: string | null;
      // `--allow-downgrade`. Only ever consulted here, on an EXPLICIT version
      // request below the installed one - exactly the legacy command's rule
      // (`prepareHostUpdate`'s guard). A resumed park's downgrade consent is
      // the record's own claim, decided under the lock, never re-derived
      // from these arguments.
      readonly allowDowngrade: boolean;
    }
  | {
      // Local evidence only. No version, therefore no registry, therefore no
      // way for an unreachable registry to fail an activation.
      readonly intent: "activate";
    }
  | {
      // Resuming a park at a target the record already fixed.
      readonly intent: "continue";
      readonly targetVersion: string;
      // True only for a `resume-apply` park with no stage - the downgrade
      // re-download (Plan D14). Every other park resumes from bytes that are
      // already on disk and needs no registry at all.
      readonly needsTransfer: boolean;
    };

/**
 * What the plan observed about the local install and stage. Carried by every
 * variant so the caller can hand the same facts to a claim baseline and then
 * compare them with a re-read under the lock.
 */
export interface HostUpdatePlanIdentity {
  readonly installedVersion: string;
  /**
   * `encodeInstallGeneration` over the install record - the SAME encoder
   * `commitHostInstallSource` and `applyHost` stamp their results with, so a
   * baseline taken from a plan and a generation attested by a commit are
   * byte-comparable strings rather than two spellings of one idea.
   */
  readonly installGeneration: string;
  /** The install record's own runtime stamp, the installed half of a debt. */
  readonly installedRuntimeVersion: string | null;
  readonly stagedVersion: string | null;
  /** The staged record's `stageId`; `null` when nothing is staged. */
  readonly stageFingerprint: string | null;
}

/**
 * The advisory outcome. Every variant but `not-installed` carries the
 * identity facts.
 *
 * The RUNNING half of an activation debt is deliberately absent: reading the
 * live host is the activation reading's job, and it belongs to the caller
 * that owns the run (it pairs `activate` - or an `install` plan that turned
 * out to have nothing to fetch - with that reading to decide a debt). This
 * function stays on the installer side of that line, where the registry and
 * the two on-disk records are, and never reaches into the running host.
 */
export type HostUpdatePlan =
  | {
      // No install record at all. Reported, not thrown: the plan decides
      // nothing, and the caller's own locked read is what refuses.
      readonly kind: "not-installed";
    }
  | {
      // Installed at or above the target with no downgrade consent - the
      // legacy `installed-up-to-date` short-circuit, made explicit.
      readonly kind: "no-op";
      readonly targetVersion: string;
      readonly identity: HostUpdatePlanIdentity;
    }
  | {
      readonly kind: "upgrade";
      readonly targetVersion: string;
      readonly entry: HostVersionEntry;
      readonly asset: HostPlatformAsset;
      readonly identity: HostUpdatePlanIdentity;
    }
  | {
      // The target is already staged and promotable - no transfer needed.
      readonly kind: "already-staged";
      readonly targetVersion: string;
      readonly identity: HostUpdatePlanIdentity;
    }
  | {
      // An explicit `--allow-downgrade` below the installed version. Staged
      // privately by `stageHostInstallSource`, never through the shared
      // stage, which reconcile would sweep as stale.
      readonly kind: "downgrade";
      readonly targetVersion: string;
      readonly identity: HostUpdatePlanIdentity;
    }
  | {
      // The `activate` intent: nothing to fetch, nothing to stage.
      readonly kind: "activate";
      readonly identity: HostUpdatePlanIdentity;
    }
  | {
      // A resumed park. `entry`/`asset` are non-null only for the downgrade
      // re-download.
      readonly kind: "resume";
      readonly targetVersion: string;
      readonly entry: HostVersionEntry | null;
      readonly asset: HostPlatformAsset | null;
      readonly identity: HostUpdatePlanIdentity;
    };

export interface ResolveUpdatePlanOptions {
  readonly environment: Environment;
  readonly request: HostUpdatePlanRequest;
  readonly onProgress: (info: ProgressInfo) => void;
  /** Same test seam as `DownloadAndStageHostOptions.registryClient`. */
  readonly registryClient: RegistryClient | null;
}

export async function resolveUpdatePlan(
  opts: ResolveUpdatePlanOptions,
): Promise<HostUpdatePlan> {
  const installed = await readHostInstallRecord(opts.environment);
  if (installed === null) return { kind: "not-installed" };
  const staged = await readHostStagedRecord(opts.environment);
  const identity: HostUpdatePlanIdentity = {
    installedVersion: installed.version,
    installGeneration: encodeInstallGeneration({
      installId: installed.installId,
      installedAt: installed.installedAt,
      archiveSha256: installed.archiveSha256,
      version: installed.version,
    }),
    installedRuntimeVersion: installed.runtimeVersion,
    stagedVersion: staged?.version ?? null,
    stageFingerprint: staged?.stageId ?? null,
  };

  const request = opts.request;
  if (request.intent === "activate") return { kind: "activate", identity };

  if (request.intent === "continue") {
    if (!request.needsTransfer) {
      return {
        kind: "resume",
        targetVersion: request.targetVersion,
        entry: null,
        asset: null,
        identity,
      };
    }
    const resolved = await resolvePlanAsset(opts, request.targetVersion);
    return {
      kind: "resume",
      targetVersion: resolved.entry.version,
      entry: resolved.entry,
      asset: resolved.asset,
      identity,
    };
  }

  const client = await planRegistryClient(opts);
  progressStage(opts.onProgress, "resolve", "resolving host manifest");
  const manifest = await client.fetchManifest();
  const targetVersion = request.versionRequest ?? manifest.latest;
  // Same fail-closed rule as the transfer's: the registry side of the version
  // domain must be valid SemVer, or every comparison against the installed
  // version silently reads as "incomparable".
  if (!isValidHostVersion(targetVersion)) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host update: registry target version '${targetVersion}' is not valid SemVer`,
      details: { environment: opts.environment, targetVersion },
      exitCode: 1,
    });
  }

  const installedVsTarget = compareHostVersions(
    installed.version,
    targetVersion,
  );
  const installedAtOrAboveTarget =
    installedVsTarget.comparable && installedVsTarget.ordering !== "less";
  if (installedAtOrAboveTarget) {
    // Identity is the STRING. `installedAtOrAboveTarget` is a COMPARATOR
    // reading, and the comparator orders `2.0.0+bar` and `2.0.0+foo` equal:
    // at-or-above by a different string is a different artifact, not the
    // one the caller named. An implicit `latest` keeps the comparator
    // reading - the registry's release is installed, in a build nothing
    // here would replace - so this is gated on an EXPLICIT request.
    const explicitOtherArtifact =
      request.versionRequest !== null && installed.version !== targetVersion;
    // The downgrade exception is `install`-intent only and needs BOTH an
    // explicit version request and the flag - a bare `host update
    // --allow-downgrade` resolving `latest` below the installed version is
    // still up to date, exactly as the legacy command reads it. It covers
    // BOTH shapes the shared monotonic stage refuses: a target below the
    // record, and another build of the record's release.
    if (request.allowDowngrade && explicitOtherArtifact) {
      return { kind: "downgrade", targetVersion, identity };
    }
    // Refused, not a no-op. A no-op here exits 0 with the requested
    // artifact never delivered, and no surface ever says so - the exact
    // "a request for X answered `already at Y`" this whole binding exists
    // to prevent. It is thrown at PLAN time, before the executor segment
    // opens: no attempt record exists yet and no marker has been
    // published, so this refusal creates nothing and has nothing to
    // withdraw. The same fact discovered LATER - under a lock, against a
    // record this run already claimed - is the arms' business, and there
    // it supersedes the record and withdraws the marker.
    if (explicitOtherArtifact) {
      const relation =
        installedVsTarget.ordering === "greater"
          ? `newer than the requested ${targetVersion}`
          : `another build of the same release as the requested ${targetVersion}`;
      throw cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
        message: `host update: the installed host is ${installed.version}, ${relation}; nothing was transferred. Run 'traycer host status' to see what is installed, or pass --allow-downgrade to install ${targetVersion} over it`,
        details: {
          environment: opts.environment,
          targetVersion,
          installedVersion: installed.version,
        },
        exitCode: 1,
      });
    }
    return { kind: "no-op", targetVersion, identity };
  }
  if (
    identity.stageFingerprint !== null &&
    identity.stagedVersion === targetVersion
  ) {
    return { kind: "already-staged", targetVersion, identity };
  }
  const resolved = await resolvePlanAsset(opts, targetVersion);
  return {
    kind: "upgrade",
    targetVersion: resolved.entry.version,
    entry: resolved.entry,
    asset: resolved.asset,
    identity,
  };
}

// Asset resolution is also where the client floor is enforced
// (`registry/client.ts`'s `resolveAsset`), so "manifest, asset, floor" is one
// call, not three.
async function resolvePlanAsset(
  opts: ResolveUpdatePlanOptions,
  versionRequest: string,
): Promise<{
  readonly entry: HostVersionEntry;
  readonly asset: HostPlatformAsset;
}> {
  const client = await planRegistryClient(opts);
  const platformKey = currentHostPlatformKey();
  progressStage(
    opts.onProgress,
    "resolve",
    `resolving host ${versionRequest} for ${platformKey}`,
  );
  return client.resolveAsset(versionRequest, platformKey);
}

async function planRegistryClient(
  opts: ResolveUpdatePlanOptions,
): Promise<RegistryClient> {
  return (
    opts.registryClient ??
    (await createDefaultRegistryClient(opts.environment, opts.onProgress))
  );
}
