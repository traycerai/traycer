import {
  chmod,
  copyFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hashFileSha256 } from "../installer/sha256";
import { downloadToFile } from "../registry/fetch-resource";
import {
  cliAssetVersion,
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
import { stageWellKnownCliBinary } from "../store/well-known-cli";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
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
//
// Target-version contract (audit CLI-013):
//
//   The rolling feed publishes ONE build's platform assets. There is no
//   per-version asset map, so no historical version is resolvable. The
//   version stamped into the manifest is therefore always the feed's
//   own `version` - the one its `platforms` map describes - and
//   `--target` is a GUARD, not a selector: it asserts which build the
//   caller expected and fails when the feed no longer serves it. That
//   keeps installed bytes and recorded version inseparable; the
//   previous behaviour downloaded the feed's build and recorded the
//   caller's arbitrary string.

export interface CliUpgradeArgs {
  // When true, fetch the CLI manifest and report what would be done
  // without actually replacing or staging anything.
  readonly dryRun: boolean;
  // Optional assertion that the feed still serves this exact version.
  // Not a selector - see the target-version contract above. `null`
  // accepts whatever the feed currently publishes.
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
          ctx.runtime.logger.warn(
            "CLI upgrade refused because manifest is missing",
            {
              environment: ctx.runtime.environment,
            },
          );
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
          ctx.runtime.logger.warn(
            "CLI upgrade refused package-manager-owned install",
            {
              environment: ctx.runtime.environment,
              source: manifest.source,
              currentVersion: manifest.version,
            },
          );
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
          workUnits: null,
        });
        const versions = await fetchCliVersions();
        // The feed's own `version`, never `latest` and never the
        // caller's string: this is the only version whose bytes we can
        // actually resolve, so it is the only one we may install or
        // record. See the target-version contract at the top of the file.
        const targetVersion = cliAssetVersion(versions);
        if (
          args.targetVersion !== null &&
          !sameCliVersion(args.targetVersion, targetVersion)
        ) {
          ctx.runtime.logger.warn("CLI upgrade refused unavailable target", {
            environment: ctx.runtime.environment,
            currentVersion: manifest.version,
            requestedVersion: args.targetVersion,
            feedVersion: targetVersion,
          });
          throw cliError({
            code: CLI_ERROR_CODES.CLI_UPGRADE_TARGET_UNAVAILABLE,
            message:
              `cli upgrade: --target ${args.targetVersion} is not available. ` +
              `The CLI release feed publishes assets for exactly one build (${targetVersion}) ` +
              "and cannot resolve historical versions. Re-run without --target to install " +
              `${targetVersion}, or install the version you want by hand and record it with ` +
              "'traycer cli re-anchor --binary-path <path> --installed-version <version>'.",
            details: {
              requestedVersion: args.targetVersion,
              feedVersion: targetVersion,
              feedLatest: versions.latest,
              currentVersion: manifest.version,
            },
            exitCode: 1,
          });
        }
        ctx.runtime.logger.info("CLI upgrade target resolved", {
          environment: ctx.runtime.environment,
          currentVersion: manifest.version,
          targetVersion,
          source: manifest.source,
          latestVersion: versions.latest,
          targetAsserted: args.targetVersion !== null,
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
              // Emitted so callers (and the end-to-end test the audit
              // asks for) can tie the reported version to the exact
              // bytes it names, rather than trusting the number alone.
              downloadSha256: asset.sha256,
            },
            human: `would upgrade cli ${manifest.version} → ${targetVersion} (source=${manifest.source}, url=${asset.url})`,
            exitCode: 0,
          };
        }

        // Staging goes NEXT TO the live binary so publication is a
        // same-filesystem rename. An unwritable install directory is
        // therefore fatal, and fatal HERE - before the download - rather
        // than after it: publishing atomically means creating a file in
        // that directory, so a directory we cannot create files in has no
        // successful path left. The old code staged into the OS tempdir
        // instead, which only deferred the problem to a cross-device
        // publication that fails the same way, having first downloaded
        // (and then leaked) a full executable per attempt.
        const installDir = dirname(manifest.binaryPath);
        if (!(await directoryWritable(installDir))) {
          ctx.runtime.logger.warn(
            "CLI upgrade refused unwritable install dir",
            {
              environment: ctx.runtime.environment,
              targetVersion,
              platformKey,
            },
          );
          throw cliError({
            code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
            message:
              `cli upgrade: ${installDir} is not writable, so the new binary cannot be published ` +
              `next to ${manifest.binaryPath} and swapped in atomically. Nothing was downloaded and ` +
              `the live binary is untouched. Make ${installDir} writable and re-run, or install the ` +
              "new binary by hand and record it with " +
              "'traycer cli re-anchor --binary-path <path> --installed-version <version>'.",
            details: {
              livePath: manifest.binaryPath,
              installDir,
              targetVersion,
            },
            exitCode: 1,
          });
        }
        ctx.runtime.logger.info("CLI upgrade staging root selected", {
          environment: ctx.runtime.environment,
          platformKey,
        });
        const stagedBinaryPath = resolveStagingPath({
          installDir,
          targetVersion,
          platformKey,
          livePath: manifest.binaryPath,
        });

        ctx.progress({
          stage: "download",
          message: `downloading cli ${targetVersion} for ${platformKey}`,
          percent: 0,
          bytes: 0,
          totalBytes: asset.sizeBytes,
          workUnits: null,
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
                workUnits: null,
              }),
            onHeartbeat: (heartbeat) =>
              ctx.progress({
                stage: `registry-cli-${heartbeat.phase}`,
                message:
                  heartbeat.phase === "watchdog"
                    ? "CLI download stalled; retrying"
                    : `CLI download ${heartbeat.phase} ${heartbeat.attempt}`,
                percent: null,
                // Attempt counters are not a transfer measurement. Feeding
                // them to the byte fields made the progress bar redraw as
                // "1 of 200" on every retry; all three stay null so the
                // renderer holds the last real download values.
                bytes: null,
                totalBytes: null,
                workUnits: null,
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
          if (
            cause instanceof Error &&
            (cause as { code?: string }).code !== undefined
          ) {
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
          workUnits: null,
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
  // The release digest, when the caller has one in scope. The
  // same-volume rename path moves the already-verified staged file
  // byte-for-byte and never consults it; it matters on the EXDEV path,
  // where the bytes go through `copyFile`. Callers without it (the
  // deferred finalize path, whose persisted `pendingUpgrade` record
  // carries no digest) pass `null` and get the staged file's own digest
  // instead - see `publishAcrossFilesystems`, which never publishes
  // unverified bytes either way.
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
    await refreshWellKnownSlot(opts.environment, opts.livePath, opts.logger);
    return { status: "replaced", errorMessage: null };
  } catch (err) {
    const code = errnoCodeOf(err);
    if (isBinaryLockedCode(code)) {
      opts.logger.warn("CLI upgrade live binary is locked", {
        environment: opts.environment,
        errorCode: code,
      });
      return {
        status: "locked",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    // POSIX cross-device rename: the staged bytes are on another
    // volume, so they have to be copied. Publication still goes through
    // a destination-side temp + rename - see publishAcrossFilesystems.
    if (code === "EXDEV") {
      opts.logger.info("CLI upgrade falling back to cross-device publication", {
        environment: opts.environment,
        expectedSha256: opts.expectedSha256 !== null,
      });
      return publishAcrossFilesystems(opts);
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
      details: {
        livePath: opts.livePath,
        stagedBinaryPath: opts.stagedBinaryPath,
      },
      exitCode: 1,
    });
  }
}

// Cross-filesystem publication of the staged binary (audit CLI-014).
//
// `rename` refused with EXDEV, so the bytes genuinely have to be copied.
// They are never copied INTO the live path: an interrupted process, a
// full disk, or a short write there leaves the user holding a truncated
// executable, and the previous implementation's digest check then
// unlinked the live path outright - turning a corrupt CLI into no CLI.
//
// Instead the copy lands on a sibling temp file on the DESTINATION
// filesystem, is verified there, and is published with the same atomic
// rename the same-volume path uses. That is also what "retain/recover
// the previous binary" reduces to once publication is atomic: every
// failure mode before the rename leaves the previous binary
// byte-for-byte intact, so there is no window in which it is gone and
// nothing to restore from.
//
// `cli upgrade` no longer reaches this: it stages beside the live binary
// and refuses outright when that directory is unwritable, so its rename
// is same-volume by construction. What still reaches it is the deferred
// finalize path holding a `pendingUpgrade` an OLDER CLI staged in the OS
// tempdir - which is exactly the compatibility case this must keep
// handling, and the one whose record carries no release digest.
async function publishAcrossFilesystems(opts: {
  readonly environment: Environment;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly expectedSha256: string | null;
  readonly logger: ILogger;
}): Promise<ReplaceResult> {
  const liveDir = dirname(opts.livePath);
  // Distinct from the `.download` staging file `resolveStagingPath` builds:
  // this one is per-attempt and is always removed, on success or failure.
  const publishPath = join(
    liveDir,
    `.${basename(opts.livePath)}.traycer-upgrade-${process.pid}-${Math.random()
      .toString(16)
      .slice(2, 8)}.tmp`,
  );
  try {
    // What the published copy must hash to. Prefer the release digest;
    // when the caller has none - the deferred finalize path, whose
    // persisted `pendingUpgrade` record carries no digest - fall back to
    // the staged file's own digest, read here, immediately before the
    // copy. That is strictly weaker: it proves the published bytes equal
    // the staged bytes, NOT that the staged bytes are still the release.
    // Authenticating a staged file that was tampered with between
    // download and finalize needs the digest persisted alongside
    // `pendingUpgrade`, which is a `@traycer/protocol` schema change.
    // But it does close the gap that matters here - copyFile is not
    // byte-for-byte safe, so an unverified cross-volume copy could
    // publish a short or corrupt file over a working CLI and report
    // success. There is now no publication path that skips verification.
    const expectedPublishedSha256 =
      opts.expectedSha256 ??
      (await hashFileSha256(opts.stagedBinaryPath, null));
    await copyFile(opts.stagedBinaryPath, publishPath);
    // The staged binary already carries the executable bit on POSIX, but
    // it is set on the staged path, not inherited by a fresh copy under
    // every umask - stamp it on the file that is actually published.
    if (process.platform !== "win32") {
      await chmod(publishPath, 0o755);
    }
    const actual = await hashFileSha256(publishPath, null);
    if (actual !== expectedPublishedSha256) {
      opts.logger.error(
        "CLI upgrade cross-device copy hash mismatch",
        {
          environment: opts.environment,
          digestSource: opts.expectedSha256 !== null ? "release" : "staged",
        },
        null,
      );
      await safeUnlink(publishPath, opts.environment, opts.logger);
      throw cliError({
        code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
        message:
          `cli upgrade: cross-device copy hash mismatch (expected ${expectedPublishedSha256}, got ${actual}); ` +
          `the live binary at ${opts.livePath} was left untouched`,
        details: {
          livePath: opts.livePath,
          stagedBinaryPath: opts.stagedBinaryPath,
          publishPath,
          expectedSha256: expectedPublishedSha256,
          actualSha256: actual,
          digestSource: opts.expectedSha256 !== null ? "release" : "staged",
        },
        exitCode: 1,
      });
    }
  } catch (prepareErr) {
    if (prepareErr instanceof CliError) throw prepareErr;
    await safeUnlink(publishPath, opts.environment, opts.logger);
    const prepareCode = errnoCodeOf(prepareErr);
    opts.logger.error(
      "CLI upgrade cross-device copy failed",
      {
        environment: opts.environment,
        errorCode: prepareCode ?? "unknown",
      },
      errorFromUnknown(prepareErr),
    );
    // The common cause is an install directory the user cannot write
    // to - which is also why staging landed on another volume in the
    // first place. There is no atomic publication without creating a
    // file next to the live binary, so say what to fix rather than
    // streaming bytes over the live path the way the old fallback did.
    throw cliError({
      code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
      message:
        `cli upgrade: could not stage the new binary next to ${opts.livePath} ` +
        `(${prepareCode ?? "unknown error"}: ${prepareErr instanceof Error ? prepareErr.message : String(prepareErr)}). ` +
        `The live binary was left untouched. Make ${liveDir} writable and re-run, or install the new ` +
        "binary by hand and record it with 'traycer cli re-anchor --binary-path <path> --installed-version <version>'.",
      details: {
        livePath: opts.livePath,
        liveDir,
        stagedBinaryPath: opts.stagedBinaryPath,
        publishPath,
        errorCode: prepareCode,
      },
      exitCode: 1,
    });
  }

  try {
    await rename(publishPath, opts.livePath);
  } catch (publishErr) {
    const publishCode = errnoCodeOf(publishErr);
    await safeUnlink(publishPath, opts.environment, opts.logger);
    if (isBinaryLockedCode(publishCode)) {
      // Same contract as the same-volume path: a held binary is a
      // deferrable state, not a failure. The staged binary is still
      // where the caller left it, so `pendingUpgrade` stays finalisable.
      opts.logger.warn("CLI upgrade live binary is locked", {
        environment: opts.environment,
        errorCode: publishCode,
        strategy: "cross-device",
      });
      return {
        status: "locked",
        errorMessage:
          publishErr instanceof Error ? publishErr.message : String(publishErr),
      };
    }
    opts.logger.error(
      "CLI upgrade cross-device publication failed",
      {
        environment: opts.environment,
        errorCode: publishCode ?? "unknown",
      },
      errorFromUnknown(publishErr),
    );
    throw cliError({
      code: CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED,
      message:
        `cli upgrade: cross-device publication failed: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}; ` +
        `the live binary at ${opts.livePath} was left untouched`,
      details: {
        livePath: opts.livePath,
        stagedBinaryPath: opts.stagedBinaryPath,
        publishPath,
      },
      exitCode: 1,
    });
  }

  // Published. The staged copy is now redundant; a lingering one is
  // harmless, so its removal stays best-effort.
  await safeUnlink(opts.stagedBinaryPath, opts.environment, opts.logger);
  opts.logger.info("CLI upgrade live binary replacement succeeded", {
    environment: opts.environment,
    strategy: "cross-device-publish",
  });
  await refreshWellKnownSlot(opts.environment, opts.livePath, opts.logger);
  return { status: "replaced", errorMessage: null };
}

// Where the download lands, guaranteed NOT to be the live binary.
//
// `downloadToFile` treats its destination as a RESUMABLE PARTIAL: it
// reads the existing size to resume from, and discards or truncates it
// on a restart. Pointed at the live executable that is not a download,
// it is destruction - resuming "from" a working CLI's bytes yields a
// corrupt file, and a restart deletes it outright, before any digest is
// ever checked.
//
// The old name (`traycer-<version>-<platform>`) could collide: it is
// exactly the shape a re-anchored manual install may already have, and
// `cli re-anchor` records the version it is told rather than the one in
// the filename, so `manifest.version != targetVersion` while
// `basename(binaryPath) == <staging template>` is reachable. The leading
// dot plus the explicit alias check below take the collision from
// "unlikely" to "not reachable by naming", within the limit stated on
// `pathsMayAlias`.
function resolveStagingPath(opts: {
  readonly installDir: string;
  readonly targetVersion: string;
  readonly platformKey: string;
  readonly livePath: string;
}): string {
  const candidate = join(
    opts.installDir,
    `.traycer-upgrade-${opts.targetVersion}-${opts.platformKey}.download${binaryExtension()}`,
  );
  // Deterministic on purpose - a retry reuses one staging file instead of
  // littering the install directory. `.staged` only ever applies to a
  // live path pathological enough to be named like the staging file, and
  // cannot itself collide, since one path cannot equal both spellings.
  //
  // NOTE for anyone asserting on this directory's contents: two unrelated
  // temp families live here and both carry `.traycer-upgrade-`. THIS one
  // ends in `.download` and is deliberately LEFT BEHIND after a failure
  // so the next attempt reuses it. The other ends in `.tmp` (see
  // `publishAcrossFilesystems`) and is always cleaned up. Match on the
  // suffix, never on the shared prefix.
  return pathsMayAlias(candidate, opts.livePath)
    ? `${candidate}.staged`
    : candidate;
}

// Whether two paths might name the SAME file, for the purpose of refusing
// to stage onto the live binary.
//
// A plain string comparison is not enough: Windows filesystems are
// case-insensitive (and macOS is by default), so a re-anchored live
// binary differing from the staging name only in letter case IS that
// file, while `===` says otherwise - and the cost of getting it wrong is
// `downloadToFile` resuming from or truncating the working CLI. Either an
// exact or a case-folded match counts as an alias: a needless `.staged`
// suffix on a case-sensitive filesystem is harmless, a missed alias is
// not.
//
// LIMIT, stated rather than implied: this catches naming and casing, NOT
// every filesystem alias. Symlinks, hardlinks and Windows 8.3 short names
// can still make two spellings the same file and are not detected here.
function pathsMayAlias(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return ra === rb || ra.toLowerCase() === rb.toLowerCase();
}

// Codes that mean "the live binary is held open / not replaceable right
// now" rather than "the upgrade is broken". Callers turn these into a
// retained `pendingUpgrade` instead of an error.
function isBinaryLockedCode(code: string | null): boolean {
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "ETXTBSY"
  );
}

function errnoCodeOf(err: unknown): string | null {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : null;
}

async function safeUnlink(
  path: string,
  environment: Environment,
  logger: ILogger,
): Promise<void> {
  try {
    await unlink(path);
  } catch (unlinkErr) {
    if (errnoCodeOf(unlinkErr) === "ENOENT") return;
    logger.warn("CLI upgrade failed to remove temporary file", {
      environment,
      errorName: errorFromUnknown(unlinkErr).name,
      errorMessage: errorFromUnknown(unlinkErr).message,
    });
  }
}

// Loose equality for a user-supplied `--target` assertion against the
// feed's version. Only surface noise is normalised (whitespace, a
// leading `v`) - `--target 1.2` never matches `1.2.0`, because the point
// of the flag is to assert an EXACT build.
function sameCliVersion(a: string, b: string): boolean {
  return normalizeCliVersion(a) === normalizeCliVersion(b);
}

function normalizeCliVersion(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("v") || trimmed.startsWith("V")
    ? trimmed.slice(1)
    : trimmed;
}

// Live CLI bytes just changed at `livePath`; refresh the well-known slot
// so it keeps serving the current binary. The slot is a byte COPY (see
// `stageWellKnownCliBinary` for why it is not a symlink), so every writer
// of live CLI bytes must re-stage it - a stale copy is what the host
// daemon would keep shelling for doctor / update. Best-effort like every
// other slot write: a failure leaves the previous slot contents serving,
// which is the accepted stale-but-functional worst case.
async function refreshWellKnownSlot(
  environment: Environment,
  livePath: string,
  logger: ILogger,
): Promise<void> {
  const staged = await stageWellKnownCliBinary({
    environment,
    binaryPath: livePath,
  });
  if (staged.staged === "failed") {
    logger.warn("CLI upgrade well-known slot refresh failed", {
      environment,
      errorName: staged.errorName,
      errorMessage: staged.errorMessage,
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
      readonly stagedVersion: string;
      readonly stagedBinaryPath: string;
      readonly livePath: string;
    }
  | {
      readonly status: "still-locked";
      readonly stagedBinaryPath: string;
      readonly livePath: string;
      readonly errorMessage: string;
    }
  // Publication genuinely failed (full disk, unwritable install dir,
  // digest mismatch on a cross-filesystem copy). Reported rather than
  // thrown: `host restart` stops the service BEFORE calling this and
  // relaunches only after it returns, so throwing here would leave the
  // host down because a bolt-on CLI self-upgrade failed. The live binary
  // is untouched and `pendingUpgrade` is retained either way.
  | {
      readonly status: "publish-failed";
      readonly stagedBinaryPath: string;
      readonly livePath: string;
      readonly errorMessage: string;
    }
  | {
      readonly status: "manifest-update-failed";
      readonly previousVersion: string;
      readonly version: string;
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
    logger.info(
      "CLI pending upgrade finalization skipped; no pending upgrade",
      {
        environment: opts.environment,
        currentVersion: manifest.version,
        source: manifest.source,
      },
    );
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
      stagedVersion: pending.version,
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
    };
  }
  // A publication failure must not escape as an exception - see the
  // `publish-failed` variant for why the restart path cannot survive one.
  let swap: ReplaceResult;
  try {
    swap = await tryReplaceLiveBinary({
      environment: opts.environment,
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
      // The persisted `pendingUpgrade` record carries no release digest,
      // so this path pins the copy to the staged file's own digest
      // instead - see `publishAcrossFilesystems`.
      expectedSha256: null,
      logger,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      "CLI pending upgrade publication failed",
      {
        environment: opts.environment,
        currentVersion: manifest.version,
        pendingVersion: pending.version,
      },
      errorFromUnknown(err),
    );
    return {
      status: "publish-failed",
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
      errorMessage,
    };
  }
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
  try {
    await clearPendingUpgrade(opts.environment, {
      version: pending.version,
      binaryPath: manifest.binaryPath,
      installedAt,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      "CLI pending upgrade binary replaced but manifest update failed",
      {
        environment: opts.environment,
        previousVersion: manifest.version,
        version: pending.version,
        livePath: manifest.binaryPath,
      },
      errorFromUnknown(err),
    );
    return {
      status: "manifest-update-failed",
      previousVersion: manifest.version,
      version: pending.version,
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
      errorMessage,
    };
  }
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
