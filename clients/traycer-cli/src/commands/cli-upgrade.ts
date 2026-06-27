import {
  chmod,
  copyFile,
  mkdtemp,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashFileSha256 } from "../installer/sha256";
import { downloadToFile } from "../registry/fetch-resource";
import {
  currentCliPlatformKey,
  fetchCliVersions,
  resolveCliAsset,
} from "../registry/cli-versions";
import {
  clearPendingUpgrade,
  type CliInstallSource,
  type CliPendingUpgrade,
  PACKAGE_MANAGER_CLI_SOURCES,
  PACKAGE_MANAGER_UPGRADE_HINT,
  readCliManifest,
  updateCliManifest,
} from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import type { CommandFn, CommandResult } from "../runner/runner";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import {
  createCliLogger,
  errorFromUnknown,
  type ILogger,
} from "../logger";
import { withCliLock } from "../store/cli-lock";

// `traycer cli upgrade` - self-upgrade the installed CLI binary.
//
// Decision matrix based on the CLI install manifest's `source`:
//
//   desktop / manual                → self-replace the binary in place.
//                                     If the live binary is locked
//                                     (Windows supervisor running, or
//                                     POSIX EBUSY), stage the new
//                                     binary and record pendingUpgrade
//                                     so the next controlled service
//                                     restart finalises the swap.
//   homebrew / winget / scoop /
//   apt / rpm                       → refuse self-upgrade and tell the
//                                     user to run the package
//                                     manager's upgrade command. Do
//                                     NOT touch the package-manager-
//                                     owned binary.
//
// Pending-upgrade semantics:
//
//   * The first attempt always tries an atomic rename (verify → write
//     to a sibling temp path → rename over the live binary).
//   * If the rename fails with EBUSY/EPERM/EACCES (typical when a
//     long-running supervisor has the binary open on Windows), we
//     keep the staged binary, record it in `pendingUpgrade`, and exit
//     0 with a "staged" status. Future CLI invocations (or the
//     supervisor restart) finalise the swap.
//   * On success we update the manifest's top-level version/path and
//     clear any prior pendingUpgrade.

export interface CliUpgradeArgs {
  // When true, fetch the CLI manifest and report what would be done
  // without actually replacing or staging anything.
  readonly dryRun: boolean;
  // Optional override for the target version. Defaults to manifest.latest.
  readonly targetVersion: string | null;
}

const UPGRADE_HINT_FOR_SOURCE: Record<CliInstallSource, string> = {
  desktop: "Run 'traycer cli upgrade' (Desktop-owned).",
  manual: "Run 'traycer cli upgrade' (manual install).",
  // homebrew/winget/scoop/apt/rpm share the canonical package-manager hints.
  ...PACKAGE_MANAGER_UPGRADE_HINT,
};

export function buildCliUpgradeCommand(args: CliUpgradeArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("CLI upgrade command started", {
      environment: ctx.runtime.environment,
      dryRun: args.dryRun,
      hasTargetVersionOverride: args.targetVersion !== null,
    });
    return withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "cli-upgrade",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        const manifest = await readCliManifest(ctx.runtime.environment);
        if (manifest === null) {
          ctx.runtime.logger.warn("CLI upgrade refused because manifest is missing", {
            environment: ctx.runtime.environment,
          });
          throw cliError({
            code: CLI_ERROR_CODES.CLI_UPGRADE_NO_MANIFEST,
            message:
              "cli upgrade: no CLI install manifest found for this environment. " +
              "Run 'traycer cli re-anchor --binary-path <path> --installed-version <version>' " +
              "first so the upgrade flow knows where the installed binary lives.",
            details: { environment: ctx.runtime.environment },
            exitCode: 1,
          });
        }

        // Package-manager-owned CLIs must go through the package
        // manager. We refuse self-replace even with --force to honour
        // the ownership contract spelled out in the Tech Plan.
        if (PACKAGE_MANAGER_CLI_SOURCES.has(manifest.source)) {
          const hint = UPGRADE_HINT_FOR_SOURCE[manifest.source];
          ctx.runtime.logger.warn("CLI upgrade refused package-manager-owned install", {
            environment: ctx.runtime.environment,
            source: manifest.source,
            currentVersion: manifest.version,
          });
          throw cliError({
            code: CLI_ERROR_CODES.CLI_UPGRADE_PACKAGE_MANAGER_OWNED,
            message: `cli upgrade: CLI is installed via ${manifest.source}; self-upgrade is disabled to keep package-manager ownership intact. ${hint}`,
            details: {
              source: manifest.source,
              binaryPath: manifest.binaryPath,
              currentVersion: manifest.version,
              packageManagerHint: hint,
            },
            exitCode: 1,
          });
        }

        ctx.progress({
          stage: "resolve",
          message: "fetching CLI versions manifest",
          percent: null,
          bytes: null,
          totalBytes: null,
        });
        const versions = await fetchCliVersions();
        const targetVersion = args.targetVersion ?? versions.latest;
        ctx.runtime.logger.info("CLI upgrade target resolved", {
          environment: ctx.runtime.environment,
          currentVersion: manifest.version,
          targetVersion,
          source: manifest.source,
          latestVersion: versions.latest,
        });
        if (manifest.version === targetVersion) {
          ctx.runtime.logger.info("CLI upgrade no-op; already current", {
            environment: ctx.runtime.environment,
            version: targetVersion,
          });
          return {
            data: {
              status: "already-current",
              currentVersion: manifest.version,
              targetVersion,
              source: manifest.source,
              binaryPath: manifest.binaryPath,
            },
            human: `cli already at ${targetVersion} (no-op)`,
            exitCode: 0,
          };
        }

        const platformKey = currentCliPlatformKey();
        const asset = resolveCliAsset(versions, platformKey);
        if (args.dryRun) {
          ctx.runtime.logger.info("CLI upgrade dry-run completed", {
            environment: ctx.runtime.environment,
            currentVersion: manifest.version,
            targetVersion,
            platformKey,
          });
          return {
            data: {
              status: "dry-run",
              currentVersion: manifest.version,
              targetVersion,
              source: manifest.source,
              binaryPath: manifest.binaryPath,
              downloadUrl: asset.url,
            },
            human: `would upgrade cli ${manifest.version} → ${targetVersion} (source=${manifest.source}, url=${asset.url})`,
            exitCode: 0,
          };
        }

        // Download to a staging path next to the live binary so the
        // final rename stays on the same filesystem. We use the OS
        // tempdir if the install directory isn't writable (e.g. desktop
        // staged the CLI under a system path).
        const installDir = dirname(manifest.binaryPath);
        const installDirWritable = await directoryWritable(installDir);
        const stagingRoot = installDirWritable
          ? installDir
          : await mkdtemp(join(tmpdir(), "traycer-cli-upgrade-"));
        ctx.runtime.logger.info("CLI upgrade staging root selected", {
          environment: ctx.runtime.environment,
          installDirWritable,
          stagingInInstallDir: installDirWritable,
          platformKey,
        });
        const stagedBinaryPath = join(
          stagingRoot,
          `traycer-${targetVersion}-${platformKey}${binaryExtension()}`,
        );

        ctx.progress({
          stage: "download",
          message: `downloading cli ${targetVersion} for ${platformKey}`,
          percent: 0,
          bytes: 0,
          totalBytes: asset.sizeBytes,
        });
        try {
          await downloadToFile({
            url: asset.url,
            destPath: stagedBinaryPath,
            expectedSizeBytes: asset.sizeBytes,
            expectedSha256: asset.sha256,
            onProgress: ({ downloadedBytes, totalBytes }) =>
              ctx.progress({
                stage: "download",
                message: `downloading cli ${targetVersion}`,
                percent:
                  totalBytes > 0
                    ? Math.round((downloadedBytes / totalBytes) * 100)
                    : null,
                bytes: downloadedBytes,
                totalBytes,
              }),
            signal: null,
          });
        } catch (cause) {
          ctx.runtime.logger.error(
            "CLI upgrade download failed",
            {
              environment: ctx.runtime.environment,
              targetVersion,
              platformKey,
            },
            errorFromUnknown(cause),
          );
          if (cause instanceof Error && (cause as { code?: string }).code !== undefined) {
            throw cause;
          }
          throw cliError({
            code: CLI_ERROR_CODES.CLI_UPGRADE_DOWNLOAD_FAILED,
            message: `cli upgrade: download failed for ${asset.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
            details: { url: asset.url },
            exitCode: 1,
          });
        }

        // Make sure the staged binary is executable on POSIX.
        if (process.platform !== "win32") {
          await chmod(stagedBinaryPath, 0o755);
        }
        ctx.runtime.logger.info("CLI upgrade staged binary ready", {
          environment: ctx.runtime.environment,
          targetVersion,
          platformKey,
          sizeBytes: asset.sizeBytes,
        });

        ctx.progress({
          stage: "swap",
          message: "swapping live binary",
          percent: null,
          bytes: null,
          totalBytes: null,
        });
        const swap = await tryReplaceLiveBinary({
          environment: ctx.runtime.environment,
          stagedBinaryPath,
          livePath: manifest.binaryPath,
          expectedSha256: asset.sha256,
          logger: ctx.runtime.logger,
        });
        if (swap.status === "replaced") {
          await updateCliManifest(ctx.runtime.environment, {
            version: targetVersion,
            binaryPath: manifest.binaryPath,
            installedAt: new Date().toISOString(),
            pendingUpgrade: null,
          });
          ctx.runtime.logger.info("CLI upgrade replaced live binary", {
            environment: ctx.runtime.environment,
            previousVersion: manifest.version,
            currentVersion: targetVersion,
            source: manifest.source,
          });
          return {
            data: {
              status: "replaced",
              previousVersion: manifest.version,
              currentVersion: targetVersion,
              binaryPath: manifest.binaryPath,
              source: manifest.source,
            },
            human: `upgraded cli ${manifest.version} → ${targetVersion}`,
            exitCode: 0,
          };
        }
        // Locked - keep the staged binary and record pendingUpgrade.
        await updateCliManifest(ctx.runtime.environment, {
          pendingUpgrade: {
            version: targetVersion,
            stagedBinaryPath,
            stagedAt: new Date().toISOString(),
            reason: "binary-locked",
          },
        });
        ctx.runtime.logger.warn("CLI upgrade staged pending upgrade", {
          environment: ctx.runtime.environment,
          previousVersion: manifest.version,
          targetVersion,
          source: manifest.source,
          reason: "binary-locked",
        });
        return {
          data: {
            status: "pending-upgrade",
            previousVersion: manifest.version,
            stagedVersion: targetVersion,
            stagedBinaryPath,
            reason: "binary-locked",
            replaceError: swap.errorMessage,
          },
          human:
            `cli upgrade staged ${targetVersion} at ${stagedBinaryPath}; ` +
            `live binary at ${manifest.binaryPath} is locked (likely held by the host supervisor). ` +
            "Restart the host service ('traycer host restart') to finalise the swap.",
          exitCode: 0,
        };
      },
    );
  };
}

interface ReplaceResult {
  readonly status: "replaced" | "locked";
  readonly errorMessage: string | null;
}

async function tryReplaceLiveBinary(opts: {
  readonly environment: Environment;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  // Optional digest the live path is expected to hold after a
  // copy-based swap. The atomic-rename path inherits the digest of the
  // staged file (which was already verified during download), so this
  // re-hash is only meaningful on the EXDEV cross-volume fallback path
  // where the bytes were copied through `copyFile`. Pre-finalize
  // helper callers that don't have the asset manifest in scope may pass
  // `null` to skip the check - the rename path doesn't touch bytes.
  readonly expectedSha256: string | null;
  readonly logger: ILogger;
}): Promise<ReplaceResult> {
  // On Windows the rename will fail with EBUSY/EPERM if the live binary
  // is mapped into a running process. We catch those, treat them as
  // "locked", and leave the staged binary in place for the supervisor
  // to pick up on next restart. POSIX rename succeeds even if the file
  // is open, but EACCES from a read-only filesystem still indicates
  // "we can't swap, keep it staged".
  try {
    opts.logger.info("CLI upgrade attempting live binary replacement", {
      environment: opts.environment,
      expectedSha256: opts.expectedSha256 !== null,
    });
    await rename(opts.stagedBinaryPath, opts.livePath);
    opts.logger.info("CLI upgrade live binary replacement succeeded", {
      environment: opts.environment,
      strategy: "rename",
    });
    return { status: "replaced", errorMessage: null };
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : null;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ETXTBSY") {
      opts.logger.warn("CLI upgrade live binary is locked", {
        environment: opts.environment,
        errorCode: code,
      });
      return {
        status: "locked",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    // POSIX cross-device rename: fall back to copy + unlink so the
    // operator's intent (replace the binary) still completes when the
    // staging dir isn't on the same volume.
    if (code === "EXDEV") {
      opts.logger.info("CLI upgrade falling back to cross-device copy", {
        environment: opts.environment,
        expectedSha256: opts.expectedSha256 !== null,
      });
      try {
        await copyFile(opts.stagedBinaryPath, opts.livePath);
        // Re-verify the destination digest. A partial-write or a hostile
        // local actor between the staged-binary's verified write and the
        // cross-volume copy would otherwise install corrupt bytes - the
        // rename path is byte-for-byte safe but copyFile is not.
        if (opts.expectedSha256 !== null) {
          const actual = await hashFileSha256(opts.livePath);
          if (actual !== opts.expectedSha256) {
            opts.logger.error(
              "CLI upgrade post-copy hash mismatch",
              {
                environment: opts.environment,
              },
              null,
            );
            try {
              await unlink(opts.livePath);
            } catch {
              // Best-effort cleanup of the corrupt copy.
            }
            throw cliError({
              code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
              message: `cli upgrade: post-copy hash mismatch (expected ${opts.expectedSha256}, got ${actual})`,
              details: {
                livePath: opts.livePath,
                stagedBinaryPath: opts.stagedBinaryPath,
                expectedSha256: opts.expectedSha256,
                actualSha256: actual,
              },
              exitCode: 1,
            });
          }
        }
        try {
          await unlink(opts.stagedBinaryPath);
        } catch (unlinkErr) {
          opts.logger.warn("CLI upgrade failed to remove staged copy after fallback", {
            environment: opts.environment,
            errorName: errorFromUnknown(unlinkErr).name,
            errorMessage: errorFromUnknown(unlinkErr).message,
          });
          // Staged copy is harmless if it lingers.
        }
        opts.logger.info("CLI upgrade live binary replacement succeeded", {
          environment: opts.environment,
          strategy: "copy",
        });
        return { status: "replaced", errorMessage: null };
      } catch (copyErr) {
        if (copyErr instanceof CliError) throw copyErr;
        opts.logger.error(
          "CLI upgrade cross-device copy failed",
          {
            environment: opts.environment,
          },
          errorFromUnknown(copyErr),
        );
        throw cliError({
          code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
          message: `cli upgrade: cross-device fallback copy failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
          details: { livePath: opts.livePath, stagedBinaryPath: opts.stagedBinaryPath },
          exitCode: 1,
        });
      }
    }
    opts.logger.error(
      "CLI upgrade live binary replacement failed",
      {
        environment: opts.environment,
        errorCode: code ?? "unknown",
      },
      errorFromUnknown(err),
    );
    throw cliError({
      code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
      message: `cli upgrade: replace failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { livePath: opts.livePath, stagedBinaryPath: opts.stagedBinaryPath },
      exitCode: 1,
    });
  }
}

async function directoryWritable(dirPath: string): Promise<boolean> {
  const probe = join(dirPath, `.traycer-upgrade-probe-${process.pid}`);
  try {
    await writeFile(probe, "");
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

function binaryExtension(): string {
  return process.platform === "win32" ? ".exe" : "";
}

// Probe whether a pending-upgrade can now be finalised - invoked by
// future CLI bootstrap paths and Doctor checks. Exported so the
// Desktop bridge can call it via NDJSON without subprocessing twice.
export async function pendingUpgradeFinalisable(opts: {
  readonly stagedBinaryPath: string;
}): Promise<boolean> {
  try {
    const s = await stat(opts.stagedBinaryPath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

export type FinalizePendingCliUpgradeOutcome =
  | { readonly status: "no-pending" }
  | { readonly status: "no-manifest" }
  | {
      readonly status: "staged-binary-missing";
      readonly stagedBinaryPath: string;
    }
  | {
      readonly status: "still-locked";
      readonly stagedBinaryPath: string;
      readonly livePath: string;
      readonly errorMessage: string;
    }
  | {
      readonly status: "finalised";
      readonly previousVersion: string;
      readonly version: string;
      readonly binaryPath: string;
    };

// Attempt to complete a previously-staged CLI upgrade. The expected
// caller is a controlled supervisor restart that has just stopped the
// host service (which releases the CLI binary lock on Windows). If
// the staged binary is still present and the live binary can be
// replaced, the swap happens here and `pendingUpgrade` is cleared.
//
// This is intentionally idempotent and tolerant of "nothing to do"
// states: callers can invoke it on every restart without checking
// readiness first, and Doctor uses the same function to surface the
// "still locked" diagnostic without re-running the upgrade download.
export async function finalizePendingCliUpgrade(opts: {
  readonly environment: Environment;
}): Promise<FinalizePendingCliUpgradeOutcome> {
  const logger = createCliLogger(opts.environment);
  logger.info("CLI pending upgrade finalization started", {
    environment: opts.environment,
  });
  const manifest = await readCliManifest(opts.environment);
  if (manifest === null) {
    logger.info("CLI pending upgrade finalization skipped; no manifest", {
      environment: opts.environment,
    });
    return { status: "no-manifest" };
  }
  const pending = manifest.pendingUpgrade;
  if (pending === null) {
    logger.info("CLI pending upgrade finalization skipped; no pending upgrade", {
      environment: opts.environment,
      currentVersion: manifest.version,
      source: manifest.source,
    });
    return { status: "no-pending" };
  }
  if (
    !(await pendingUpgradeFinalisable({
      stagedBinaryPath: pending.stagedBinaryPath,
    }))
  ) {
    logger.warn("CLI pending upgrade staged binary missing", {
      environment: opts.environment,
      currentVersion: manifest.version,
      pendingVersion: pending.version,
      reason: pending.reason,
    });
    return {
      status: "staged-binary-missing",
      stagedBinaryPath: pending.stagedBinaryPath,
    };
  }
  const swap = await tryReplaceLiveBinary({
    environment: opts.environment,
    stagedBinaryPath: pending.stagedBinaryPath,
    livePath: manifest.binaryPath,
    // The manifest doesn't preserve the asset digest after `cli upgrade`
    // clears `pendingUpgrade`, so the helper finalize path doesn't
    // re-hash. The staged-binary digest was verified at download time;
    // the rename path is byte-for-byte safe, and an EXDEV fallback in
    // the helper is rare (staging dir is sibling to the live binary).
    expectedSha256: null,
    logger,
  });
  if (swap.status === "locked") {
    logger.warn("CLI pending upgrade still locked", {
      environment: opts.environment,
      currentVersion: manifest.version,
      pendingVersion: pending.version,
    });
    return {
      status: "still-locked",
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
      errorMessage: swap.errorMessage ?? "binary still held by another process",
    };
  }
  const installedAt = new Date().toISOString();
  await clearPendingUpgrade(opts.environment, {
    version: pending.version,
    binaryPath: manifest.binaryPath,
    installedAt,
  });
  logger.info("CLI pending upgrade finalized", {
    environment: opts.environment,
    previousVersion: manifest.version,
    version: pending.version,
  });
  return {
    status: "finalised",
    previousVersion: manifest.version,
    version: pending.version,
    binaryPath: manifest.binaryPath,
  };
}

// Inspect manifest for an outstanding pending-upgrade without
// touching the live binary. Doctor uses this read-only path to render
// the pending-upgrade issue card.
export async function readPendingCliUpgrade(opts: {
  readonly environment: Environment;
}): Promise<{
  readonly pending: CliPendingUpgrade;
  readonly currentVersion: string;
  readonly binaryPath: string;
  readonly source: CliInstallSource;
} | null> {
  const logger = createCliLogger(opts.environment);
  const manifest = await readCliManifest(opts.environment);
  if (manifest === null || manifest.pendingUpgrade === null) {
    logger.debug("CLI pending upgrade read found nothing pending", {
      environment: opts.environment,
      hasManifest: manifest !== null,
    });
    return null;
  }
  logger.info("CLI pending upgrade read found pending upgrade", {
    environment: opts.environment,
    currentVersion: manifest.version,
    pendingVersion: manifest.pendingUpgrade.version,
    source: manifest.source,
    reason: manifest.pendingUpgrade.reason,
  });
  return {
    pending: manifest.pendingUpgrade,
    currentVersion: manifest.version,
    binaryPath: manifest.binaryPath,
    source: manifest.source,
  };
}
