import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  hostHomeDir,
  hostInstallDir,
  hostStagingRoot,
  ensureHostHomeDir,
  ensureHostStagingRoot,
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
// If swap-stage fails, the previous install is untouched. If swap
// succeeds but the new host never reaches readiness, the new host
// stays installed (no rollback cache); Doctor surfaces the
// non-readiness so the operator can `host doctor` / `host install
// --from <known-good>`.
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

  // Track whether the staging dir has been renamed into the install
  // location. While `swapped === false` the staging dir is still
  // exclusively owned by this attempt and needs explicit cleanup on a
  // thrown extract/resolve/swap.
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
    await atomicSwap({
      environment: opts.environment,
      stagingDir: staging.stagingDir,
    });
    swapped = true;
    logger.info("Host install atomic swap completed", {
      environment: opts.environment,
      version: staging.version,
      replacedPreviousInstall: previous !== null,
    });

    const finalExecutablePath = executablePath.replace(
      staging.stagingDir,
      hostInstallDir(opts.environment),
    );

    const record: HostInstallRecord = {
      version: staging.version,
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
    return { record, previous };
  } finally {
    // Best-effort sweep of the per-attempt staging archive (if any). The
    // staging *directory* moved into the install dir on success - only
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

// Sweep `<target>.old-*` siblings left behind by atomicSwap if the CLI
// crashed between a successful rename-aside and the fire-and-forget
// `rm(trash)`. Called from `atomicSwap` on entry (so a repeated
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
}

async function atomicSwap(opts: AtomicSwapOptions): Promise<void> {
  const logger = createCliLogger(opts.environment);
  const target = hostInstallDir(opts.environment);
  const trash = `${target}.old-${Date.now()}`;
  await mkdir(hostHomeDir(opts.environment), { recursive: true });

  // Best-effort sweep of any stale `<target>.old-*` siblings before we
  // create another one. Doesn't block the swap on sweep success - if
  // the sweep fails we log via the surrounding flow's progress and
  // continue.
  await sweepOldTrash(target);

  const targetExists = await access(target).then(
    () => true,
    () => false,
  );
  logger.info("Host install atomic swap starting", {
    environment: opts.environment,
    targetExists,
  });
  if (targetExists) {
    // Move the existing install aside before renaming the new one in,
    // so the rename target is empty. We delete the trash copy after
    // the new install is in place - there is no rollback cache by
    // design.
    await renameWithRetry(target, trash);
  }
  try {
    await renameWithRetry(opts.stagingDir, target);
  } catch (cause) {
    logger.error(
      "Host install atomic swap failed",
      {
        environment: opts.environment,
        targetExists,
      },
      errorFromUnknown(cause),
    );
    // Restore the previous install if the rename of the new one fails.
    if (targetExists) {
      await rename(trash, target).catch(() => undefined);
    }
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: failed to swap staging dir into place: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { target, stagingDir: opts.stagingDir },
      exitCode: 1,
    });
  }
  if (targetExists) {
    await rm(trash, { recursive: true, force: true });
  }
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
