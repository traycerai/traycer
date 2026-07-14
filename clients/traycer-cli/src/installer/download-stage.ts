import { access, rm } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { platform as osPlatform } from "node:os";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
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
  renameWithRetry,
} from "./install";
import { extractHostSource, resolveHostExecutable } from "./extract";
import { reconcileHostStage } from "./stage-reconcile";

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
  "install-record-vanished" | "not-strictly-newer";

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
  await rm(hostStagedDir(environment), { recursive: true, force: true });
  logger.info("Host download discarded an ineligible staged version", {
    environment,
    version: staged.version,
    reason: entry === undefined ? "absent" : "yanked",
  });
}

async function replaceStagedDir(
  environment: Environment,
  tempDir: string,
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
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function downloadAndStageHost(
  opts: DownloadAndStageHostOptions,
): Promise<HostDownloadOutcome> {
  const logger = createCliLogger(opts.environment);

  const installed = await readHostInstallRecord(opts.environment);
  if (installed === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host download: no host installed for environment=${opts.environment}; run 'traycer host install latest' first`,
      details: { environment: opts.environment },
      exitCode: 1,
    });
  }

  const client =
    opts.registryClient ??
    (await createDefaultRegistryClient(opts.environment));
  progressStage(opts.onProgress, "resolve", "resolving host manifest");
  const manifest = await client.fetchManifest();
  const requestedLatest = opts.versionRequest === null;
  const targetVersion = requestedLatest ? manifest.latest : opts.versionRequest;

  // Phase 1 - brief lock: yank-heal + short-circuit evaluation. Runs even
  // when no download follows.
  const preDownload = await withCliLock(
    {
      environment: opts.environment,
      reason: "host-download-precheck",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      await reconcileHostStage(opts.environment);
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
        stagedAfterYankHeal.version === targetVersion;
      if (installedAtOrAboveTarget) {
        return { shortCircuit: "installed-up-to-date" as const };
      }
      if (alreadyStagedAtTarget) {
        return { shortCircuit: "already-staged" as const };
      }
      if (opts.automatic && !installedVsTarget.comparable) {
        return {
          shortCircuit: "automatic-refused-incomparable-installed" as const,
        };
      }
      return {
        shortCircuit: null,
        stagedVersion: stagedAfterYankHeal?.version ?? null,
      };
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
      installedVersion: installed.version,
      stagedVersion:
        (await readHostStagedRecord(opts.environment))?.version ?? null,
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
        if (explicitVersionRequested) {
          progressStage(
            opts.onProgress,
            "promote",
            `staging host ${stagedRecord.version}`,
          );
          await replaceStagedDir(opts.environment, tempPath);
          ownedConsumed = true;
          return {
            outcome: "promoted",
            stagedVersion: stagedRecord.version,
            installedVersion: freshInstalled.version,
          } satisfies HostDownloadOutcome;
        }
        const freshStaged = await readHostStagedRecord(opts.environment);
        // An incomparable installed version never blocks a non-automatic
        // download - moving a local build onto the registry track is the
        // user's stated intent (D6 parity; `--automatic` already refused
        // this back in phase 1, so reaching here with an incomparable
        // installed version only happens for a non-automatic call).
        // Monotonicity vs the staged version - always registry SemVer -
        // still holds regardless.
        const installedComparison = compareHostVersions(
          stagedRecord.version,
          freshInstalled.version,
        );
        const passesInstalledMonotonicity = installedComparison.comparable
          ? installedComparison.ordering === "greater"
          : true;
        const strictlyNewerThanStaged =
          freshStaged === null ||
          isStrictlyNewerHostVersion(stagedRecord.version, freshStaged.version);
        if (passesInstalledMonotonicity && strictlyNewerThanStaged) {
          progressStage(
            opts.onProgress,
            "promote",
            `staging host ${stagedRecord.version}`,
          );
          await replaceStagedDir(opts.environment, tempPath);
          ownedConsumed = true;
          return {
            outcome: "promoted",
            stagedVersion: stagedRecord.version,
            installedVersion: freshInstalled.version,
          } satisfies HostDownloadOutcome;
        }
        // Reverse-completion: an older download finishing after a newer
        // promote (or an equally/more current stage) discards itself.
        await rm(tempPath, { recursive: true, force: true });
        ownedConsumed = true;
        logger.info(
          "Host download discarded a completed download that is no longer strictly newer",
          { environment: opts.environment, version: stagedRecord.version },
        );
        return {
          outcome: "discarded",
          reason: "not-strictly-newer",
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
    // success (by contract - see registry/client.ts); the archive FILE
    // itself is removed here, matching `installHost`'s existing cleanup
    // of `staging.archiveIsTemporary`. The now-empty OS-tmpdir directory
    // it lived in is left behind, same as the existing install flow.
    await rm(verified.archivePath, { force: true }).catch(() => undefined);
  }
}
