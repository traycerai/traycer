import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { arch as osArch, platform as osPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type HostInstallArch,
  type HostInstallPlatform,
  type HostInstallRecord,
  type HostInstallSource,
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../manifest/host-install";
import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
} from "../registry";
import type { ProgressInfo } from "../runner/output";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import {
  hostHomeDir,
  hostInstallDir,
  hostStagingRoot,
  hostVersionsDir,
  ensureHostHomeDir,
  ensureHostStagingRoot,
  ensureHostVersionsDir,
} from "../store/paths";
import { extractHostSource, resolveHostExecutable } from "./extract";
import { hashFileSha256 } from "./sha256";

// Host installer - verify-before-replace per the Tech Plan.
//
// Flow:
//   1. Resolve the source: registry version (NP-4) OR local file path.
//   2. Stage the archive into a sibling staging dir (same volume as the
//      install dir so the final swap is atomic).
//   3. Verify checksum + minisign signature (NP-4 fills the chain;
//      NP-2 does sha256 only, signature recorded as `local-file`).
//   4. Extract into the staging dir.
//   5. Resolve the executable.
//   6. Atomically swap the staging dir into place at <installDir>.
//   7. Write the install record.
//
// If swap-stage fails, the previous install is untouched. `<installDir>`
// (`hostInstallDir(environment)`) is a STABLE symlink (Windows: junction)
// onto exactly one child of `hostVersionsDir(environment)` - see
// `atomicSwap` below for the versioned-directory + atomic pointer-flip
// scheme that makes the swap crash-safe (no window where the pointer
// resolves to neither the old nor the new install). If swap succeeds but
// the new host never reaches readiness, the new host stays installed at
// this layer (no rollback cache HERE) - `commands/host-update.ts` is the
// caller that adds a post-swap health probe + rollback on top of this
// primitive; `host install` / `host ensure` callers that don't opt into
// that keep today's Tech-Plan-documented "no rollback" behaviour, with
// Doctor surfacing the non-readiness.
//
// Concurrency: callers must wrap this with `withCliLock` - see
// `commands/host-install.ts`.

export type InstallSourceArg =
  | { readonly kind: "registry"; readonly versionRequest: string }
  | { readonly kind: "local-file"; readonly path: string };

// Lifecycle hooks the installer fires around the atomic swap. Both
// hooks run while the per-environment CLI lock is still held, so callers
// can safely touch the OS service state without racing other CLI
// invocations.
//
//   - `beforeSwap` runs after staging+verify+extract succeed and the
//     host executable is resolved, but BEFORE the install dir is
//     replaced. Use this to stop the OS service so any executable /
//     file locks (Windows in particular) are released before the
//     rename. If `beforeSwap` throws, the existing install is left
//     untouched; verify-before-replace ordering is preserved.
//
//   - `afterSwap` runs after the install dir has been replaced and
//     the install record has been written. Use this to start /
//     restart the OS service. Per the Tech Plan, a failure here does
//     NOT trigger rollback - the new host stays installed and the
//     caller is expected to surface the failure (Doctor flags the
//     non-readiness). The hook should therefore swallow start errors
//     internally if it wants the install to report success; throwing
//     propagates the error to `installHost`'s caller.
export interface InstallHostLifecycle {
  readonly beforeSwap: () => Promise<void>;
  readonly afterSwap: () => Promise<void>;
}

export interface InstallHostOptions {
  readonly environment: Environment;
  readonly source: InstallSourceArg;
  readonly onProgress: (info: ProgressInfo) => void;
  // Pass `null` to skip lifecycle integration (e.g. tests or callers
  // that manage the OS service themselves).
  readonly lifecycle: InstallHostLifecycle | null;
  // The version string to record for a local-file install, overriding the
  // basename+timestamp `deriveLocalVersion` default. The bundled-host
  // callers (`host ensure`, auto-bootstrap) pass this build's
  // `config.version` so the install record carries a stable per-build
  // identity that the freshness check can compare. `null` keeps the derived
  // default (registry installs ignore it - they record the registry version).
  readonly recordVersionOverride: string | null;
}

export interface InstallHostResult {
  readonly record: HostInstallRecord;
  readonly previous: HostInstallRecord | null;
  // The versioned dir under `hostVersionsDir(environment)` that was active
  // immediately before this swap - `null` when there was nothing to roll
  // back to (first-ever install on this machine/environment). Callers that
  // want rollback-on-unhealthy semantics (`commands/host-update.ts`) pass
  // this straight to `rollbackToVersionedDir`; the bytes it points at are
  // guaranteed to still be on disk (this swap keeps exactly the
  // immediately-previous generation - see `atomicSwap`).
  readonly previousVersionedDir: string | null;
}

export async function installHost(
  opts: InstallHostOptions,
): Promise<InstallHostResult> {
  const logger = createCliLogger(opts.environment);
  const platform = currentInstallPlatform();
  const arch = currentInstallArch();
  const previous = await readHostInstallRecord(opts.environment);
  logger.info("Host install started", {
    environment: opts.environment,
    platform,
    arch,
    sourceKind: opts.source.kind,
    versionRequest:
      opts.source.kind === "registry"
        ? opts.source.versionRequest
        : "local-file",
    hasPreviousInstall: previous !== null,
    lifecycleEnabled: opts.lifecycle !== null,
    recordVersionOverride: opts.recordVersionOverride !== null,
  });

  await ensureHostHomeDir(opts.environment);
  await ensureHostStagingRoot(opts.environment);

  const staging = await stageInstall({
    environment: opts.environment,
    source: opts.source,
    onProgress: opts.onProgress,
    recordVersionOverride: opts.recordVersionOverride,
  });
  logger.info("Host install staging completed", {
    environment: opts.environment,
    sourceKind: opts.source.kind,
    version: staging.version,
    archiveIsTemporary: staging.archiveIsTemporary,
    sizeBytes: staging.sizeBytes,
    hasArchiveSha256: staging.archiveSha256 !== null,
  });

  // Track whether the staging dir has been renamed into a versioned dir.
  // While `swapped === false` the staging dir is still exclusively owned by
  // this attempt and needs explicit cleanup on a thrown extract/resolve/swap.
  let swapped = false;
  try {
    opts.onProgress({
      stage: "extract",
      message: `extracting host archive into ${staging.stagingDir}`,
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    await extractHostSource({
      source: staging.archivePath,
      targetDir: staging.stagingDir,
    });
    logger.info("Host install archive extracted", {
      environment: opts.environment,
      version: staging.version,
    });

    const executablePath = await resolveHostExecutable(
      staging.stagingDir,
      osPlatform(),
    );

    // The archive's own build stamp - the same value the running host will
    // publish in pid.json. The sidecar sits beside the executable (the
    // build emits it into the runtime dir root), so anchor the read there
    // rather than guessing the archive's top-level layout. Recorded
    // alongside (never instead of) the caller-derived `version` so the
    // record describes the bytes it actually installed even when the
    // installing CLI is an older build (see HostInstallRecord.runtimeVersion).
    const runtimeVersion = await readExtractedRuntimeVersion(
      dirname(executablePath),
    );
    logger.debug("Host install executable resolved", {
      environment: opts.environment,
      version: staging.version,
    });

    // Stop the OS service immediately before the swap, never earlier:
    // verify-before-replace means we must not disturb the running
    // host if staging or verification would have failed.
    if (opts.lifecycle !== null) {
      opts.onProgress({
        stage: "service-stop",
        message: "stopping service before replacing install directory",
        percent: null,
        bytes: null,
        totalBytes: null,
      });
      logger.info("Host install running lifecycle before swap", {
        environment: opts.environment,
        version: staging.version,
      });
      await opts.lifecycle.beforeSwap();
    }

    opts.onProgress({
      stage: "swap",
      message: "atomically replacing install directory",
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    const swapResult = await atomicSwap({
      environment: opts.environment,
      stagingDir: staging.stagingDir,
      version: staging.version,
      previousRecordVersion: previous?.version ?? null,
    });
    swapped = true;
    logger.info("Host install atomic swap completed", {
      environment: opts.environment,
      version: staging.version,
      replacedPreviousInstall: swapResult.previousVersionedDir !== null,
    });

    const finalExecutablePath = executablePath.replace(
      staging.stagingDir,
      hostInstallDir(opts.environment),
    );

    const record: HostInstallRecord = {
      version: staging.version,
      runtimeVersion,
      platform,
      arch,
      installedAt: new Date().toISOString(),
      source: staging.recordSource,
      archiveSha256: staging.archiveSha256,
      signatureVerifiedAt: staging.signatureVerifiedAt,
      signatureKeyId: staging.signatureKeyId,
      sizeBytes: staging.sizeBytes,
      executablePath: finalExecutablePath,
    };
    await writeHostInstallRecord(opts.environment, record);
    logger.info("Host install record written", {
      environment: opts.environment,
      version: record.version,
      sourceKind: record.source.kind,
      hasArchiveSha256: record.archiveSha256 !== null,
      sizeBytes: record.sizeBytes,
    });

    // Post-swap start/restart. Per the Tech Plan, failures here do
    // not roll back the install: the new host stays in place and
    // Doctor surfaces the non-readiness. The hook is responsible for
    // swallowing start errors if it wants `installHost` to report
    // success.
    if (opts.lifecycle !== null) {
      opts.onProgress({
        stage: "service-start",
        message: "starting service after replacing install directory",
        percent: null,
        bytes: null,
        totalBytes: null,
      });
      logger.info("Host install running lifecycle after swap", {
        environment: opts.environment,
        version: record.version,
      });
      await opts.lifecycle.afterSwap();
    }

    logger.info("Host install completed", {
      environment: opts.environment,
      version: record.version,
      previousVersion: previous?.version ?? null,
    });
    return {
      record,
      previous,
      previousVersionedDir: swapResult.previousVersionedDir,
    };
  } finally {
    // Best-effort sweep of the per-attempt staging archive (if any). The
    // staging *directory* moved into a versioned dir on success - only
    // clean up the leftover archive copy and (on a thrown attempt) the
    // staging dir that never made it through `atomicSwap`.
    if (staging.archiveIsTemporary) {
      await rm(staging.archivePath, { force: true }).catch((err) => {
        logger.warn("Host install failed to remove temporary archive", {
          environment: opts.environment,
          errorName: errorFromUnknown(err).name,
          errorMessage: errorFromUnknown(err).message,
        });
      });
    }
    if (!swapped) {
      await rm(staging.stagingDir, { recursive: true, force: true }).catch(
        (err) => {
          logger.warn("Host install failed to remove staging directory", {
            environment: opts.environment,
            errorName: errorFromUnknown(err).name,
            errorMessage: errorFromUnknown(err).message,
          });
        },
      );
      logger.warn("Host install cleaned up unswapped staging attempt", {
        environment: opts.environment,
        version: staging.version,
      });
    }
  }
}

// Sweep `<target>.old-*` siblings left behind by a PRE-versioned-dir CLI's
// `atomicSwap` (the old two-step "move old aside, move new in" scheme) if it
// crashed between a successful rename-aside and the fire-and-forget
// `rm(trash)`. Kept as a best-effort backward-compat cleanup - the current
// `atomicSwap` no longer creates `.old-*` siblings itself (it never moves
// the previous install "aside": the previous versioned dir simply stays
// where it already lives under `hostVersionsDir`, referenced by nothing
// once the pointer flips). Called from `atomicSwap` on entry (so a repeated
// install/update keeps the floor clean) and from the uninstaller. Best
// effort - a failed sweep never aborts the surrounding operation.
export async function sweepOldTrash(target: string): Promise<void> {
  const parent = dirname(target);
  const prefix = `${basename(target)}.old-`;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  const matches = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name));
  await Promise.all(
    matches.map((path) =>
      rm(path, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

// Sweep `<target>.new-*` siblings left behind by a crash between creating
// the temp symlink/junction in `flipHostInstallPointer` and the rename that
// promotes it onto `target`. Harmless if left (just a small dangling link,
// never the multi-file install payload) but swept best-effort on every
// flip attempt to keep the floor clean, mirroring `sweepOldTrash`.
async function sweepStaleLinkAttempts(target: string): Promise<void> {
  const parent = dirname(target);
  const prefix = `${basename(target)}.new-`;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  const matches = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name));
  await Promise.all(
    matches.map((path) =>
      rm(path, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

interface StageResult {
  readonly archivePath: string;
  readonly archiveIsTemporary: boolean;
  readonly stagingDir: string;
  readonly version: string;
  readonly sizeBytes: number;
  // Null for local directory installs - there is no archive to hash.
  // Registry installs always set this to the 64-char hex digest.
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string;
  readonly signatureKeyId: string;
  readonly recordSource: HostInstallSource;
}

interface StageOptions {
  readonly environment: Environment;
  readonly source: InstallSourceArg;
  readonly onProgress: (info: ProgressInfo) => void;
  readonly recordVersionOverride: string | null;
}

async function stageInstall(opts: StageOptions): Promise<StageResult> {
  const logger = createCliLogger(opts.environment);
  const stagingRoot = hostStagingRoot(opts.environment);
  const stagingDir = await mkdtemp(join(stagingRoot, "stage-"));
  logger.debug("Host install staging directory created", {
    environment: opts.environment,
    sourceKind: opts.source.kind,
  });
  if (opts.source.kind === "local-file") {
    return stageLocalFile({
      environment: opts.environment,
      sourcePath: opts.source.path,
      stagingDir,
      onProgress: opts.onProgress,
      recordVersion: opts.recordVersionOverride,
    });
  }
  // Registry-driven install. The client streams the archive into a
  // temp directory under the OS tmpdir, verifies sha256 + minisign,
  // and returns the verified archive path; the staging+extract step
  // below then unpacks it into the per-environment staging dir before the
  // atomic swap.
  return stageRegistry({
    environment: opts.environment,
    versionRequest: opts.source.versionRequest,
    stagingDir,
    onProgress: opts.onProgress,
  });
}

interface StageLocalOptions {
  readonly environment: Environment;
  readonly sourcePath: string;
  readonly stagingDir: string;
  readonly onProgress: (info: ProgressInfo) => void;
  // Overrides `deriveLocalVersion` when set (the bundled-host callers pass
  // this build's `config.version`); `null` keeps the derived default.
  readonly recordVersion: string | null;
}

async function stageLocalFile(opts: StageLocalOptions): Promise<StageResult> {
  const logger = createCliLogger(opts.environment);
  let sourceStat: Stats;
  try {
    sourceStat = await stat(opts.sourcePath);
  } catch (err) {
    logger.warn("Host install local source missing", {
      environment: opts.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    throw cliError({
      code: CLI_ERROR_CODES.HOST_SOURCE_MISSING,
      message: `host install: source path does not exist: ${opts.sourcePath}`,
      details: { sourcePath: opts.sourcePath },
      exitCode: 1,
    });
  }
  // For directories we have no archive to hash - record null so the
  // manifest doesn't carry a faux `dir:<path>` sentinel that would fail
  // the registry-flavoured `^[a-f0-9]{64}$` regex if a strict consumer
  // ever runs against it. Local-file installs are advisory anyway; the
  // install record reader allows null on this field.
  let archiveSha256: string | null;
  let sizeBytes: number;
  if (sourceStat.isDirectory()) {
    archiveSha256 = null;
    sizeBytes = 0;
    logger.info("Host install staging local directory source", {
      environment: opts.environment,
      recordVersionOverride: opts.recordVersion !== null,
    });
  } else {
    opts.onProgress({
      stage: "verify",
      message: `hashing ${opts.sourcePath}`,
      percent: null,
      bytes: null,
      totalBytes: sourceStat.size,
    });
    archiveSha256 = await hashFileSha256(opts.sourcePath);
    sizeBytes = sourceStat.size;
    logger.info("Host install hashed local archive source", {
      environment: opts.environment,
      sizeBytes,
      recordVersionOverride: opts.recordVersion !== null,
    });
  }
  const version = opts.recordVersion ?? deriveLocalVersion(opts.sourcePath);
  return {
    archivePath: opts.sourcePath,
    archiveIsTemporary: false,
    stagingDir: opts.stagingDir,
    version,
    sizeBytes,
    archiveSha256,
    // Local-file installs aren't signed; record a sentinel so consumers
    // can distinguish them from registry installs.
    signatureVerifiedAt: new Date().toISOString(),
    signatureKeyId: "local-file:unsigned",
    recordSource: { kind: "local-file", value: opts.sourcePath },
  };
}

interface StageRegistryOptions {
  readonly environment: Environment;
  readonly versionRequest: string;
  readonly stagingDir: string;
  readonly onProgress: (info: ProgressInfo) => void;
}

async function stageRegistry(opts: StageRegistryOptions): Promise<StageResult> {
  const logger = createCliLogger(opts.environment);
  const client = await createDefaultRegistryClient(opts.environment);
  const platformKey = currentHostPlatformKey();
  logger.info("Host install resolving registry asset", {
    environment: opts.environment,
    versionRequest: opts.versionRequest,
    platformKey,
  });
  opts.onProgress({
    stage: "resolve",
    message: `resolving host ${opts.versionRequest} for ${platformKey}`,
    percent: null,
    bytes: null,
    totalBytes: null,
  });
  const { entry, asset } = await client.resolveAsset(
    opts.versionRequest,
    platformKey,
  );
  logger.info("Host install registry asset resolved", {
    environment: opts.environment,
    version: entry.version,
    platformKey,
    sizeBytes: asset.sizeBytes,
  });
  opts.onProgress({
    stage: "download",
    message: `downloading host ${entry.version}`,
    percent: 0,
    bytes: 0,
    totalBytes: asset.sizeBytes,
  });
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
  logger.info("Host install registry archive verified", {
    environment: opts.environment,
    version: entry.version,
    sizeBytes: asset.sizeBytes,
  });
  return {
    archivePath: verified.archivePath,
    archiveIsTemporary: true,
    stagingDir: opts.stagingDir,
    version: entry.version,
    sizeBytes: asset.sizeBytes,
    archiveSha256: verified.archiveSha256,
    signatureVerifiedAt: verified.signatureVerifiedAt,
    signatureKeyId: verified.signatureKeyId,
    recordSource: { kind: "registry", value: entry.version },
  };
}

// Windows releases a terminated process's directory/file handles
// asynchronously, so a rename issued right after the OS service stop
// (which force-kills the host tree) can still observe EBUSY/EPERM for a
// brief window even though the host is already dead. Retry a few times with
// a short backoff (~2.5s total). POSIX renames don't raise these codes, so
// this is a no-op there.
const RENAME_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delaysMs = [50, 100, 200, 400, 800, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : "";
      if (attempt >= delaysMs.length || !RENAME_RETRY_CODES.has(code)) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

interface AtomicSwapOptions {
  readonly environment: Environment;
  readonly stagingDir: string;
  readonly version: string;
  // The pre-swap install record's version (if any), used to synthesize a
  // readable name when migrating a legacy plain-directory install dir into
  // a versioned dir (see `migrateLegacyLayoutIfNeeded`). `null` when there
  // was no prior record (first-ever install, or a legacy dir with a
  // missing/corrupt record - the latter would already have thrown earlier
  // in `installHost` via `readHostInstallRecord`, so in practice `null`
  // here means "no prior install").
  readonly previousRecordVersion: string | null;
}

export interface AtomicSwapResult {
  // Absolute path of the versioned dir `hostInstallDir` pointed at
  // immediately before this swap - `null` for a first-ever install/on a
  // machine with nothing at `hostInstallDir` yet.
  readonly previousVersionedDir: string | null;
}

// Versioned-directory + atomic-pointer-flip swap. Replaces the historical
// two-step "move old aside, move new in" scheme (two `rename()` calls with
// an unsafe gap between them where `hostInstallDir` resolved to nothing at
// all) with:
//
//   (a) `promoteStagingToVersionedDir` - rename the staging dir into a
//       FRESH, uniquely-named path under `hostVersionsDir(environment)`.
//       The target never exists yet, so this is always a safe rename (no
//       `ENOTEMPTY`, no partial state - either it lands fully or the
//       rename call itself throws and nothing changed).
//   (b) `flipHostInstallPointer` - atomically flip `hostInstallDir` to
//       point at that fresh versioned dir: create the symlink/junction at
//       a temp SIBLING path, then a single `rename()` onto
//       `hostInstallDir` - which atomically replaces whatever was there
//       (an existing symlink, junction, or nothing at all) in one syscall.
//
// At every point in time `hostInstallDir` therefore resolves to either the
// fully-old or fully-new versioned dir, never a missing/partial one. A
// crash between (a) and (b) leaves `hostInstallDir` resolving to the OLD
// version (the new bytes sit inert under `hostVersionsDir`, cleaned up on
// the next successful swap's sweep or left for a future retry to reuse the
// pointer flip). A crash after (b) has already landed leaves it resolving
// to the NEW version. There is no code path where a completed
// `atomicSwap()` - or a crash at any single point within it - leaves
// `hostInstallDir` resolving to neither.
//
// The previous versioned dir is deliberately NOT deleted here (unlike the
// old scheme's `rm(trash)`) - it is the rollback source
// `commands/host-update.ts` needs after a failed post-update health probe.
// Anything OLDER than the immediately-previous generation is swept.
async function atomicSwap(opts: AtomicSwapOptions): Promise<AtomicSwapResult> {
  const logger = createCliLogger(opts.environment);
  const target = hostInstallDir(opts.environment);
  const versionsDir = hostVersionsDir(opts.environment);
  await ensureHostHomeDir(opts.environment);
  await ensureHostVersionsDir(opts.environment);

  // Backward-compat sweep of `.old-*` siblings a pre-this-feature CLI's
  // two-step swap may have left behind after a crash.
  await sweepOldTrash(target);

  const previousVersionedDir = await migrateLegacyLayoutIfNeeded({
    environment: opts.environment,
    target,
    versionsDir,
    previousRecordVersion: opts.previousRecordVersion,
    logger,
  });
  logger.info("Host install atomic swap starting", {
    environment: opts.environment,
    hasPreviousVersionedDir: previousVersionedDir !== null,
  });

  let freshVersionedDir: string;
  try {
    freshVersionedDir = await promoteStagingToVersionedDir(
      opts.environment,
      opts.stagingDir,
      opts.version,
    );
  } catch (cause) {
    logger.error(
      "Host install failed to move staged install into versions dir",
      { environment: opts.environment },
      errorFromUnknown(cause),
    );
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: failed to move staged install into place: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { stagingDir: opts.stagingDir },
      exitCode: 1,
    });
  }

  try {
    await flipHostInstallPointer(opts.environment, freshVersionedDir);
  } catch (cause) {
    // The flip never landed - the fresh versioned dir is orphaned (nothing
    // points at it) and `hostInstallDir` still resolves to whatever it
    // resolved to before this call. Best-effort clean up the orphan so a
    // retry doesn't accumulate dead directories; the caller's thrown
    // error is `flipHostInstallPointer`'s own `HOST_INSTALL_FAILED`.
    await rm(freshVersionedDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw cause;
  }

  logger.info("Host install atomic swap completed", {
    environment: opts.environment,
    activeVersionedDir: freshVersionedDir,
    previousVersionedDir,
  });

  // Keep exactly the immediately-previous versioned dir (rollback source);
  // sweep anything older. Best-effort - never blocks a completed swap.
  await sweepStaleVersionedDirs(versionsDir, [
    freshVersionedDir,
    previousVersionedDir,
  ]);

  return { previousVersionedDir };
}

// Step (a) in isolation - exported so tests can simulate "crashed between
// (a) and (b)" by calling this directly and asserting `hostInstallDir`
// still resolves to the OLD version (via `readActiveVersionedDir`) before
// ever calling `flipHostInstallPointer`.
export async function promoteStagingToVersionedDir(
  environment: Environment,
  stagingDir: string,
  version: string,
): Promise<string> {
  await ensureHostVersionsDir(environment);
  const freshVersionedDir = join(
    hostVersionsDir(environment),
    uniqueVersionedDirName(version),
  );
  await rename(stagingDir, freshVersionedDir);
  return freshVersionedDir;
}

// Step (b) in isolation - the atomic pointer-flip primitive shared by
// `atomicSwap` and `rollbackToVersionedDir`. Exported so tests can call it
// directly to assert the post-flip state, and so a caller that already has
// a versioned dir in hand (rollback) can reuse the exact same mechanism a
// forward swap uses.
export async function flipHostInstallPointer(
  environment: Environment,
  versionedDir: string,
): Promise<void> {
  const target = hostInstallDir(environment);
  await ensureHostHomeDir(environment);
  await sweepStaleLinkAttempts(target);
  const tmpLinkPath = `${target}.new-${randomSuffix()}`;
  await symlinkCompat(versionedDir, tmpLinkPath);
  // On win32 the pointer is a directory junction. Unlike POSIX `rename()`,
  // which atomically replaces an existing symlink in one syscall, Windows
  // `MoveFileEx` cannot replace an existing junction (it fails EPERM), so
  // every second-and-later swap would fail. Remove ONLY the existing junction
  // reparse point first: a non-recursive `rmdir` drops the reparse point and
  // leaves the linked versioned dir's bytes intact. Never `rm(..,{recursive})`
  // here - that would follow the junction and delete the actual install. This
  // reintroduces a tiny non-atomic gap (the pointer is briefly absent), but the
  // versioned dir survives, so recovery is just a re-flip.
  // NOTE: junction/MoveFileEx semantics can't be exercised on macOS/Linux CI -
  // this path must be smoke-tested on a real Windows box.
  if (hostInstallSymlinkType(osPlatform()) === "junction") {
    const existing = await lstat(target).catch(() => null);
    if (existing !== null && existing.isSymbolicLink()) {
      await rmdir(target);
    }
  }
  try {
    // This runs right after the OS service stop - see `renameWithRetry`
    // for why the pointer-flip rename needs the retry too.
    await renameWithRetry(tmpLinkPath, target);
  } catch (cause) {
    await rm(tmpLinkPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: failed to flip install dir pointer to ${versionedDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { target, versionedDir },
      exitCode: 1,
    });
  }
}

// Rollback = flip the pointer back at a versioned dir that is still fully
// on disk, untouched (the immediately-previous generation `atomicSwap`
// deliberately keeps). Reuses the exact same atomic pointer-flip primitive
// a forward swap uses - there is no separate "restore" code path to keep
// in sync.
export async function rollbackToVersionedDir(
  environment: Environment,
  previousVersionedDir: string,
): Promise<void> {
  const logger = createCliLogger(environment);
  await flipHostInstallPointer(environment, previousVersionedDir);
  logger.warn("Host install rolled back install dir pointer", {
    environment,
    previousVersionedDir,
  });
}

export type InstallPointerKind = "missing" | "symlink" | "directory" | "other";

export interface InstallPointerTarget {
  readonly kind: InstallPointerKind;
  // Resolved absolute path the symlink/junction points at when
  // `kind === "symlink"`; `null` otherwise.
  readonly resolved: string | null;
}

// Inspect (via `lstat`, never following into a directory's contents) what
// `target` currently is on disk: missing, a symlink/junction (resolved to
// its absolute target), a plain directory (the legacy pre-versioned-dir
// layout), or some other unexpected entry. Shared by `readActiveVersionedDir`
// and `migrateLegacyLayoutIfNeeded` below, and by `uninstall.ts`'s
// `resolveInstallDirTarget`, so the lstat/isSymbolicLink/readlink/absolute-
// path-resolve dance lives in exactly one place instead of three.
export async function resolveInstallPointerTarget(
  target: string,
): Promise<InstallPointerTarget> {
  let linkStat: Stats;
  try {
    linkStat = await lstat(target);
  } catch (err) {
    if (isEnoentError(err)) return { kind: "missing", resolved: null };
    throw err;
  }
  if (linkStat.isSymbolicLink()) {
    return {
      kind: "symlink",
      resolved: resolveSymlinkTarget(target, await readlink(target)),
    };
  }
  return {
    kind: linkStat.isDirectory() ? "directory" : "other",
    resolved: null,
  };
}

// Resolve what `hostInstallDir(environment)` currently points at:
//   - `null` when nothing exists there yet (first-ever install).
//   - the resolved absolute symlink/junction target on the (post-
//     migration) versioned-dir layout.
//   - `hostInstallDir(environment)` itself when it is still a legacy plain
//     directory (pre-migration) - the dir itself IS the active install in
//     that case, there is no separate versioned-dir target to report.
// Exported for tests (assert pre-/post-flip pointer state) and available
// for any future caller that wants a read-only view of the active
// versioned dir without triggering the migration side effect.
export async function readActiveVersionedDir(
  environment: Environment,
): Promise<string | null> {
  const target = hostInstallDir(environment);
  const pointer = await resolveInstallPointerTarget(target);
  if (pointer.kind === "missing") return null;
  if (pointer.kind === "symlink") return pointer.resolved;
  return target;
}

interface MigrateLegacyLayoutOptions {
  readonly environment: Environment;
  readonly target: string;
  readonly versionsDir: string;
  readonly previousRecordVersion: string | null;
  readonly logger: ILogger;
}

// Backward-compat sweep: a machine that installed the host before this
// versioned-dir scheme shipped has a plain DIRECTORY at `hostInstallDir`,
// not a symlink. Detect that case and migrate it in place - rename the
// existing directory under `hostVersionsDir` (so its bytes are preserved
// byte-for-byte, and it becomes a legitimate rollback source for the
// update this call is already in the middle of) rather than crashing or
// silently orphaning it. A subsequent call (once already migrated) just
// reads the existing symlink's target - the migration only ever runs once
// per machine/environment.
//
// Returns the resolved "previous versioned dir" either way - the freshly
// migrated dir on a legacy machine, the existing symlink's target on an
// already-migrated one, or `null` when there was nothing at `target` yet.
async function migrateLegacyLayoutIfNeeded(
  opts: MigrateLegacyLayoutOptions,
): Promise<string | null> {
  const pointer = await resolveInstallPointerTarget(opts.target);
  if (pointer.kind === "missing") return null;
  if (pointer.kind === "symlink") return pointer.resolved;
  if (pointer.kind !== "directory") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: unexpected non-directory entry at install dir path ${opts.target}; refusing to overwrite`,
      details: { target: opts.target },
      exitCode: 1,
    });
  }
  const migratedDir = join(
    opts.versionsDir,
    uniqueVersionedDirName(`${opts.previousRecordVersion ?? "legacy"}-legacy`),
  );
  await rename(opts.target, migratedDir);
  opts.logger.info(
    "Host install migrated legacy plain-directory layout into a versioned dir",
    { environment: opts.environment, migratedDir },
  );
  return migratedDir;
}

function resolveSymlinkTarget(linkPath: string, rawTarget: string): string {
  return isAbsolute(rawTarget)
    ? rawTarget
    : resolve(dirname(linkPath), rawTarget);
}

// Best-effort: remove every versioned dir under `versionsDir` except the
// ones in `keep` (the freshly-active dir and the immediately-previous
// generation). Never blocks a completed swap - a failed sweep just leaves
// an extra directory on disk for the next successful swap to catch.
async function sweepStaleVersionedDirs(
  versionsDir: string,
  keep: ReadonlyArray<string | null>,
): Promise<void> {
  const keepSet = new Set(keep.filter((p): p is string => p !== null));
  let names: string[];
  try {
    names = await readdir(versionsDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .map((name) => join(versionsDir, name))
      .filter((path) => !keepSet.has(path))
      .map((path) =>
        rm(path, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

function uniqueVersionedDirName(version: string): string {
  return `${sanitizeVersionForDirName(version)}-${randomSuffix()}`;
}

function sanitizeVersionForDirName(version: string): string {
  const sanitized = version.replace(/[^A-Za-z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

// Windows directory junctions (unlike regular symlinks) don't require
// admin/Developer Mode, so we use them for the install-dir pointer on
// win32; POSIX platforms ignore the `type` argument entirely, so "dir" is
// just documentation there. Exported as a pure function so the platform
// decision is unit-testable without touching the filesystem.
export function hostInstallSymlinkType(
  platform: NodeJS.Platform,
): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

async function symlinkCompat(
  targetDir: string,
  linkPath: string,
): Promise<void> {
  await symlink(targetDir, linkPath, hostInstallSymlinkType(osPlatform()));
}

function isEnoentError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    Reflect.get(err, "code") === "ENOENT"
  );
}

// Reads the `version.json` sidecar the host build emits into the archive
// root (traycer-host/scripts/build-host-sea.cjs, writeRuntimeVersionJson).
// Absent or malformed (archives predating the sidecar, hand-rolled trees)
// degrades to null - the record then simply carries no runtime stamp.
export async function readExtractedRuntimeVersion(
  extractedDir: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(extractedDir, "version.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // fall through
  }
  return null;
}

function deriveLocalVersion(sourcePath: string): string {
  // For local-file installs we don't have an authoritative version
  // string; embed the basename + timestamp so the install record can
  // still be distinguished from a previous local install. Real
  // semver comes back once the host publishes pid metadata.
  const base = sourcePath.replace(/.*[\\/]/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `local-${base}-${stamp}`;
}

function currentInstallPlatform(): HostInstallPlatform {
  const platform = osPlatform();
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `host install: unsupported platform '${platform}'`,
    details: { platform },
    exitCode: 1,
  });
}

function currentInstallArch(): HostInstallArch {
  const arch = osArch();
  if (arch === "arm64" || arch === "x64") return arch;
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `host install: unsupported arch '${arch}' (expected arm64|x64)`,
    details: { arch },
    exitCode: 1,
  });
}
