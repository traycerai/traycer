import { access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";
import { platform as osPlatform } from "node:os";
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
import { ensureHostHomeDirForStaged, hostStagedDir } from "../store/paths";
import { createOwnedTempDir } from "../store/owned-temp";
import { withCliLock } from "../store/cli-lock";
import {
  currentInstallArch,
  currentInstallPlatform,
  readExtractedRuntimeVersion,
} from "./install";
import { extractHostSource, resolveHostExecutable } from "./extract";
import { invalidateAsideDir } from "./aside-dirs";
import { renameWithRetry } from "./rename-retry";
import { purgeHostStage, reconcileHostStage } from "./stage-reconcile";

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

function progressStage(
  onProgress: (info: ProgressInfo) => void,
  stage: string,
  message: string,
): void {
  onProgress({ stage, message, percent: null, bytes: null, totalBytes: null });
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
): Promise<void> {
  const staged = await readHostStagedRecord(environment);
  if (staged === null) return;
  const entry = manifest.versions.find((v) => v.version === staged.version);
  const ineligible = entry === undefined || entry.yanked;
  if (!ineligible) return;
  // This runs under the caller's short promote/precheck lock. Do not delete
  // only canonical `staged/`: normal reconcile would restore a valid
  // `staged.old-*` aside and resurrect this withdrawn artifact.
  await purgeHostStage(environment, null);
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
): Promise<void> {
  await ensureHostHomeDirForStaged(environment);
  const target = hostStagedDir(environment);
  const aside = `${target}.old-${Date.now()}`;
  const targetExists = await pathExists(target);
  if (targetExists) {
    await renameWithRetry(target, aside);
  }
  await renameWithRetry(tempDir, target);
  if (targetExists) {
    // Layered invalidation (rename to a `.dead-*` sibling, else unlink
    // just the sidecar, else a full recursive removal) so a partial
    // failure can never leave a fully intact, restorable aside behind -
    // shared with `stage-reconcile.ts`'s own pure-litter cleanup, which
    // creates and discards asides via the identical explicit-replace
    // shape.
    await invalidateAsideDir(target, aside, "staged.json", logger);
  }
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
): Promise<void> {
  await withCliLock(
    {
      environment,
      reason: "host-download-precondition",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      await reconcileHostStage(environment);
      const installed = await readHostInstallRecord(environment);
      if (installed === null) {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
          message: `host download: no host installed for environment=${environment}; run 'traycer host install latest' first`,
          details: { environment },
          exitCode: 1,
        });
      }
    },
  );
}

export async function downloadAndStageHost(
  opts: DownloadAndStageHostOptions,
): Promise<HostDownloadOutcome> {
  const logger = createCliLogger(opts.environment);

  await ensureHostInstalledPrecondition(opts.environment);

  const client =
    opts.registryClient ??
    (await createDefaultRegistryClient(opts.environment));
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
  const preDownload = await withCliLock(
    {
      environment: opts.environment,
      reason: "host-download-precheck",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      await reconcileHostStage(opts.environment);
      const installed = await readHostInstallRecord(opts.environment);
      if (installed === null) {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
          message: `host download: no host installed for environment=${opts.environment}; run 'traycer host install latest' first`,
          details: { environment: opts.environment },
          exitCode: 1,
        });
      }
      await discardIneligibleStagedVersion(opts.environment, manifest, logger);
      const stagedAfterYankHeal = await readHostStagedRecord(opts.environment);
      const installedVsTarget = compareHostVersions(
        installed.version,
        targetVersion,
      );
      const installedAtOrAboveTarget =
        installedVsTarget.comparable && installedVsTarget.ordering !== "less";
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
    });
  });

  let ownedPath: string | null = null;
  let ownedConsumed = false;
  try {
    progressStage(
      opts.onProgress,
      "extract",
      `extracting host ${entry.version}`,
    );
    const owned = await createOwnedTempDir(opts.environment, "dl-");
    ownedPath = owned.path;
    // `const` alias so the closures below (captured by `withCliLock`)
    // keep the narrowed `string` type instead of the outer `let`'s
    // `string | null`.
    const tempPath = owned.path;
    await extractHostSource({
      source: verified.archivePath,
      targetDir: tempPath,
    });
    const executablePath = await resolveHostExecutable(tempPath, osPlatform());
    const runtimeVersion = await readExtractedRuntimeVersion(
      dirname(executablePath),
    );
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
    };
    await writeHostStagedRecordAt(tempPath, stagedRecord);

    // Phase 3 - brief lock: reconcile, re-read, re-check the install
    // record still exists, and promote only per the intent policy.
    return await withCliLock(
      {
        environment: opts.environment,
        reason: "host-download-promote",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        await reconcileHostStage(opts.environment);
        const freshInstalled = await readHostInstallRecord(opts.environment);
        if (freshInstalled === null) {
          // A download finishing after an uninstall must not resurrect a
          // stage - discard, no promotion.
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
        const installedComparison = compareHostVersions(
          stagedRecord.version,
          freshInstalled.version,
        );
        // Installed-monotonicity, re-evaluated against this fresh locked
        // read (the installed version can change during the unlocked
        // transfer window - phase 1's decision is not enough on its own).
        // `--automatic` refuses an incomparable installed version here
        // too, not just in phase 1: a comparable install at phase-1 time
        // could have been replaced by an incomparable (local-*) one by
        // now. Non-automatic (explicit OR latest) waives the incomparable
        // case - moving a local build onto the registry track is the
        // user's stated intent (D6 parity).
        const passesInstalledMonotonicity = installedComparison.comparable
          ? installedComparison.ordering === "greater"
          : !opts.automatic;
        // An explicit version request always replaces any existing stage
        // (the settled exception is replace-any-STAGE, not
        // ignore-installed) - the staged-monotonicity check below only
        // applies to the latest/automatic path, where a slower "latest"
        // download must not regress a faster one that already promoted.
        const freshStaged = explicitVersionRequested
          ? null
          : await readHostStagedRecord(opts.environment);
        const strictlyNewerThanStaged =
          explicitVersionRequested ||
          freshStaged === null ||
          freshStaged.stageId === null ||
          isStrictlyNewerHostVersion(stagedRecord.version, freshStaged.version);

        if (passesInstalledMonotonicity && strictlyNewerThanStaged) {
          progressStage(
            opts.onProgress,
            "promote",
            `staging host ${stagedRecord.version}`,
          );
          await replaceStagedDir(opts.environment, tempPath, logger);
          ownedConsumed = true;
          return {
            outcome: "promoted",
            stagedVersion: stagedRecord.version,
            installedVersion: freshInstalled.version,
          } satisfies HostDownloadOutcome;
        }

        await rm(tempPath, { recursive: true, force: true });
        ownedConsumed = true;
        const reason: HostDownloadDiscardReason = !passesInstalledMonotonicity
          ? installedComparison.comparable
            ? "not-newer-than-installed"
            : "automatic-refused-incomparable-installed"
          : "not-strictly-newer";
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
  } finally {
    if (ownedPath !== null && !ownedConsumed) {
      await rm(ownedPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    // The registry client's own temp archive dir is not auto-cleaned on
    // success (by contract - see registry/client.ts's `downloadAndVerify`)
    // - the caller owns removing it. Remove the WHOLE directory
    // (`dirname(archivePath)`), not just the archive file: the directory
    // itself (an `mkdtemp`-created `traycer-host-dl-*` dir under the OS
    // tmpdir) is otherwise leaked on every successful download.
    await rm(dirname(verified.archivePath), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
