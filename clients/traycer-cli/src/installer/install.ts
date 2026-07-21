import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  type HostInstallArch,
  type HostInstallPlatform,
  type HostInstallRecord,
  type HostInstallSource,
  readHostInstallRecord,
  writeHostInstallRecordAt,
} from "../manifest/host-install";
import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
} from "../registry";
import type { ProgressInfo } from "../runner/output";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { createOwnedTempDir } from "../store/owned-temp";
import { hostHomeDir, hostInstallDir, ensureHostHomeDir } from "../store/paths";
import { extractHostSource, resolveHostExecutable } from "./extract";
import { hashFileSha256 } from "./sha256";
import {
  invalidateAsideDir,
  listAsideDirsNewestFirst,
  sweepDeadAsideDirs,
} from "./aside-dirs";
import { renameWithRetry } from "./rename-retry";
import { reconcileHostStage } from "./stage-reconcile";

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

// Convenience wrapper for callers that don't need the lock-scope split
// below (tests only) - stages and commits back-to-back with no gap
// between the two phases. `commands/host-install.ts` and `host/
// provision.ts` (ensure's install branch) call `stageHostInstallSource` /
// `commitHostInstallSource` directly instead, so only the commit phase
// runs under `cli-lock` (Tech Plan, "Lock-scope restructure").
export async function installHost(
  opts: InstallHostOptions,
): Promise<InstallHostResult> {
  const logger = createCliLogger(opts.environment);
  logger.info("Host install started", {
    environment: opts.environment,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    sourceKind: opts.source.kind,
    versionRequest:
      opts.source.kind === "registry"
        ? opts.source.versionRequest
        : "local-file",
    lifecycleEnabled: opts.lifecycle !== null,
    recordVersionOverride: opts.recordVersionOverride !== null,
  });

  const staged = await stageHostInstallSource({
    environment: opts.environment,
    source: opts.source,
    onProgress: opts.onProgress,
    recordVersionOverride: opts.recordVersionOverride,
  });
  const { record, previous } = await commitHostInstallSource({
    environment: opts.environment,
    staged,
    onProgress: opts.onProgress,
    lifecycle: opts.lifecycle,
  });
  logger.info("Host install completed", {
    environment: opts.environment,
    version: record.version,
    previousVersion: previous?.version ?? null,
  });
  return { record, previous };
}

export interface StagedHostInstallSource {
  readonly stagingDir: string;
  readonly archivePath: string;
  readonly archiveIsTemporary: boolean;
  // Absolute path, INSIDE `stagingDir`, to the resolved host executable.
  readonly executablePath: string;
  readonly version: string;
  readonly runtimeVersion: string | null;
  readonly source: HostInstallSource;
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
}

// Phase 1 (Tech Plan, "Lock-scope restructure"): download/verify/extract
// OUTSIDE the `cli-lock`, into an owner-tokened temp dir under the host
// staging root (`store/owned-temp.ts`) so a concurrent command's owned-
// temp sweep spares it for the duration of a potentially-long download.
// Callers commit the result under the lock via `commitHostInstallSource`,
// or discard it via `discardStagedHostInstallSource` if they decide not
// to commit (e.g. `host install --if-idle` found the host busy).
export async function stageHostInstallSource(
  opts: StageOptions,
): Promise<StagedHostInstallSource> {
  const logger = createCliLogger(opts.environment);
  await ensureHostHomeDir(opts.environment);
  const owned = await createOwnedTempDir(opts.environment, "install-");
  const stagingDir = owned.path;

  const staging =
    opts.source.kind === "local-file"
      ? await stageLocalFile({
          environment: opts.environment,
          sourcePath: opts.source.path,
          stagingDir,
          onProgress: opts.onProgress,
          recordVersion: opts.recordVersionOverride,
        })
      : await stageRegistry({
          environment: opts.environment,
          versionRequest: opts.source.versionRequest,
          stagingDir,
          onProgress: opts.onProgress,
        });
  logger.info("Host install staging completed", {
    environment: opts.environment,
    sourceKind: opts.source.kind,
    version: staging.version,
    archiveIsTemporary: staging.archiveIsTemporary,
    sizeBytes: staging.sizeBytes,
    hasArchiveSha256: staging.archiveSha256 !== null,
  });

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

    return {
      stagingDir: staging.stagingDir,
      archivePath: staging.archivePath,
      archiveIsTemporary: staging.archiveIsTemporary,
      executablePath,
      version: staging.version,
      runtimeVersion,
      source: staging.recordSource,
      archiveSha256: staging.archiveSha256,
      signatureVerifiedAt: staging.signatureVerifiedAt,
      signatureKeyId: staging.signatureKeyId,
      sizeBytes: staging.sizeBytes,
    };
  } catch (err) {
    // The owner-tokened temp (and its archive, if separate) is
    // exclusively ours until committed - a thrown extract/resolve must
    // not leak it. Mirrors `discardStagedHostInstallSource`'s cleanup
    // for the "staged but never committed" case.
    await cleanupStagingArtifacts(
      {
        environment: opts.environment,
        archivePath: staging.archivePath,
        archiveIsTemporary: staging.archiveIsTemporary,
        stagingDir: staging.stagingDir,
        swapped: false,
      },
      logger,
    );
    throw err;
  }
}

// Best-effort cleanup for a staged source the caller decided not to
// commit (e.g. `host install --if-idle` found the host busy immediately
// before the service stop - the Tech Plan requires the extracted temp
// scrubbed on that path). Never call this after `commitHostInstallSource`
// has run - it owns its own cleanup.
export async function discardStagedHostInstallSource(
  environment: Environment,
  staged: StagedHostInstallSource,
): Promise<void> {
  const logger = createCliLogger(environment);
  await cleanupStagingArtifacts(
    {
      environment,
      archivePath: staged.archivePath,
      archiveIsTemporary: staged.archiveIsTemporary,
      stagingDir: staged.stagingDir,
      swapped: false,
    },
    logger,
  );
}

export interface CommitHostInstallSourceOptions {
  readonly environment: Environment;
  readonly staged: StagedHostInstallSource;
  readonly onProgress: (info: ProgressInfo) => void;
  readonly lifecycle: InstallHostLifecycle | null;
}

export interface CommitHostInstallSourceResult {
  readonly record: HostInstallRecord;
  readonly previous: HostInstallRecord | null;
  // The attested, committed canonical install-generation fingerprint -
  // read from the record this call itself just wrote, never a later disk
  // re-read (Tech Plan, "Attested generation in results"), matching
  // `applyHost`'s identical contract.
  readonly installGeneration: string;
}

// Phase 2: assumes the caller already holds `cli-lock` (matches
// `commitInstallFromSource`'s existing contract - see `applyHost` for the
// same "core assumes caller holds lock" pattern). Reconciles BEFORE the
// commit (mirrors `applyHost`'s own pre-reconcile call) - `atomicSwap`'s
// entry sweep unconditionally invalidates any `install.old-*` trash before
// it renames the new tree in, and if `install/` itself is ALSO missing
// (a prior crash left neither a canonical install nor a yet-reconciled
// aside), that sweep would destroy the only recovery copy before the new
// rename even runs. Reconcile's step 1 (target-missing recovery) restores
// a missing `install/` from the newest valid `.old-*` FIRST, so the entry
// sweep only ever clears genuine litter. Then commits the pre-staged
// source tree and re-runs stage reconcile so an explicit install over a
// now-superseded `staged/` entry sweeps it (Tech Plan: "Install/ensure
// re-run reconcile after a successful commit").
export async function commitHostInstallSource(
  opts: CommitHostInstallSourceOptions,
): Promise<CommitHostInstallSourceResult> {
  const logger = createCliLogger(opts.environment);
  let swapped = false;
  try {
    await reconcileHostStage(opts.environment);
    const { record, previous } = await commitInstallFromSource({
      environment: opts.environment,
      sourceDir: opts.staged.stagingDir,
      executablePath: opts.staged.executablePath,
      version: opts.staged.version,
      runtimeVersion: opts.staged.runtimeVersion,
      source: opts.staged.source,
      archiveSha256: opts.staged.archiveSha256,
      signatureVerifiedAt: opts.staged.signatureVerifiedAt,
      signatureKeyId: opts.staged.signatureKeyId,
      sizeBytes: opts.staged.sizeBytes,
      onProgress: opts.onProgress,
      lifecycle: opts.lifecycle,
      onCommitted: () => {
        swapped = true;
      },
    });

    await reconcileHostStage(opts.environment);

    const installGeneration = encodeInstallGeneration({
      installId: record.installId,
      installedAt: record.installedAt,
      archiveSha256: record.archiveSha256,
      version: record.version,
    });

    logger.info("Host install commit completed", {
      environment: opts.environment,
      version: record.version,
      previousVersion: previous?.version ?? null,
    });
    return { record, previous, installGeneration };
  } finally {
    await cleanupStagingArtifacts(
      {
        environment: opts.environment,
        archivePath: opts.staged.archivePath,
        archiveIsTemporary: opts.staged.archiveIsTemporary,
        stagingDir: opts.staged.stagingDir,
        swapped,
      },
      logger,
    );
  }
}

// Shared by `stageHostInstallSource`'s own catch (a thrown
// extract/resolve), `discardStagedHostInstallSource` (caller decided not
// to commit), and `commitHostInstallSource` (its own finally). Best-effort
// sweep of the per-attempt staging archive (if any) - the staging
// *directory* moved into the install dir on a successful commit, so it's
// only cleaned up when `swapped` is false.
async function cleanupStagingArtifacts(
  opts: {
    readonly environment: Environment;
    readonly archivePath: string;
    readonly archiveIsTemporary: boolean;
    readonly stagingDir: string;
    readonly swapped: boolean;
  },
  logger: ILogger,
): Promise<void> {
  if (opts.archiveIsTemporary) {
    await rm(opts.archivePath, { force: true }).catch((err) => {
      logger.warn("Host install failed to remove temporary archive", {
        environment: opts.environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    });
  }
  if (!opts.swapped) {
    await rm(opts.stagingDir, { recursive: true, force: true }).catch((err) => {
      logger.warn("Host install failed to remove staging directory", {
        environment: opts.environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    });
  }
}

export interface CommitInstallFromSourceOptions {
  readonly environment: Environment;
  // A pre-staged tree ready to become `install/` wholesale - either a
  // freshly extracted+verified staging dir (`installHost`'s own flow) or a
  // promoted `staged/` tree (`host apply`, ticket 2's B1). Consumed by the
  // commit rename; the caller owns pre/post cleanup around this call, not
  // this function.
  readonly sourceDir: string;
  // Absolute path, INSIDE `sourceDir`, to the resolved host executable.
  readonly executablePath: string;
  readonly version: string;
  readonly runtimeVersion: string | null;
  readonly source: HostInstallSource;
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly onProgress: (info: ProgressInfo) => void;
  readonly lifecycle: InstallHostLifecycle | null;
  // Invoked the instant the atomic rename into `install/` completes, before
  // `lifecycle.afterSwap()` runs - lets a caller that owns its own
  // source-dir cleanup (`installHost`'s finally block) distinguish "bytes
  // are committed, a later step failed" from "never swapped, the source dir
  // still needs cleanup", without re-deriving that boundary itself.
  readonly onCommitted: () => void;
}

export interface CommitInstallFromSourceResult {
  readonly record: HostInstallRecord;
  readonly previous: HostInstallRecord | null;
}

// The reusable stop -> swap -> start tail: everything from "a verified,
// pre-staged source tree exists" through "the new install is committed and
// the service is running again". Shared between `installHost` (which stages
// and extracts its own source first) and `host apply`'s core (ticket 2's
// B1, which promotes the already-extracted `staged/` tree with no
// extraction step of its own).
//
// `install.json` is materialized INSIDE `sourceDir` before the commit
// rename below - the record then moves atomically WITH the bytes in one
// rename, instead of a separate post-swap write that could land bytes with
// no record on a crash in between (the on-disk state the reconcile
// "orphan"/target-missing rules are built to heal either side of, never a
// bytes-with-no-record gap).
export async function commitInstallFromSource(
  opts: CommitInstallFromSourceOptions,
): Promise<CommitInstallFromSourceResult> {
  const logger = createCliLogger(opts.environment);
  const previous = await readHostInstallRecord(opts.environment);

  const finalExecutablePath = opts.executablePath.replace(
    opts.sourceDir,
    hostInstallDir(opts.environment),
  );
  const record: HostInstallRecord = {
    installId: randomUUID(),
    version: opts.version,
    runtimeVersion: opts.runtimeVersion,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    installedAt: new Date().toISOString(),
    source: opts.source,
    archiveSha256: opts.archiveSha256,
    signatureVerifiedAt: opts.signatureVerifiedAt,
    signatureKeyId: opts.signatureKeyId,
    sizeBytes: opts.sizeBytes,
    executablePath: finalExecutablePath,
  };
  await writeHostInstallRecordAt(opts.sourceDir, record);
  logger.info("Host install record materialized in source tree", {
    environment: opts.environment,
    version: record.version,
    installId: record.installId,
  });

  // Stop the OS service immediately before the swap, never earlier:
  // verify-before-replace means we must not disturb the running host if
  // staging or verification would have failed.
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
      version: record.version,
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
    stagingDir: opts.sourceDir,
  });
  opts.onCommitted();
  logger.info("Host install atomic swap completed", {
    environment: opts.environment,
    version: record.version,
    replacedPreviousInstall: previous !== null,
  });

  // Post-swap start/restart. Per the Tech Plan, failures here do not roll
  // back the install: the new host stays in place and Doctor surfaces the
  // non-readiness. The hook is responsible for swallowing start errors if
  // it wants the caller to report success.
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

  return { record, previous };
}

// Sweep `<target>.old-*` siblings left behind by atomicSwap if the CLI
// crashed between a successful rename-aside and the fire-and-forget
// invalidation. Called from `atomicSwap` on entry (so a repeated
// install/update keeps the floor clean), from the uninstaller (for both
// `install/` and, with `staged.json`, `staged/`), and from
// `stage-reconcile.ts`. Layered invalidation (rename-to-`.dead-*` sibling
// -> sidecar-unlink -> recursive removal -> accept-and-log residual)
// shared with `stage-reconcile.ts`'s identical `staged.old-*` handling via
// `aside-dirs.ts` - see that module's doc comment for the failure-mode
// rationale (a single "unlink sidecar, then best-effort rm" pass could
// leave a fully intact, restorable aside behind if both steps failed on
// the same directory). `sidecarFilename` must match `target`'s own record
// file (`install.json` for `install/`, `staged.json` for `staged/`) -
// layer 2's unlink targets it by name, so the wrong name silently skips
// straight to layer 3 instead of actually invalidating the record. Best
// effort - a failed sweep never aborts the surrounding operation.
export async function sweepOldTrash(
  target: string,
  sidecarFilename: string,
  logger: ILogger,
): Promise<void> {
  const matches = await listAsideDirsNewestFirst(target, "old-");
  await Promise.all(
    matches.map((match) =>
      invalidateAsideDir(target, match, sidecarFilename, logger),
    ),
  );
  await sweepDeadAsideDirs(target);
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
  await sweepOldTrash(target, "install.json", logger);

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
    // Restore the previous install if the rename of the new one fails. The
    // same transient Windows lock that failed the swap can also fail the
    // restore, so it gets the same retry; if it still fails we log rather
    // than mask the swap error about to be thrown - but a silent failure
    // here would leave no install at all with nothing pointing at why.
    if (targetExists) {
      await renameWithRetry(trash, target).catch((restoreCause) => {
        logger.error(
          "Host install rollback failed - previous install left aside",
          { target, trash },
          errorFromUnknown(restoreCause),
        );
      });
    }
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: failed to swap staging dir into place: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { target, stagingDir: opts.stagingDir },
      exitCode: 1,
    });
  }
  if (targetExists) {
    // Layered invalidation (rename-to-`.dead-*` -> sidecar-unlink ->
    // recursive-rm -> accept-and-log), not a plain `rm`: mirrors
    // `download-stage.ts`'s `replaceStagedDir`, which creates and discards
    // asides via this identical explicit-replace shape. A bare `rm` that
    // failed on every retry (e.g. a lingering Windows handle) would leave
    // `trash` as a fully intact, restorable `install.old-*` copy -
    // exactly the residual `sweepOldTrash` above exists to heal, so a
    // failed deletion here must not be more recoverable than one caught by
    // the next sweep.
    await invalidateAsideDir(target, trash, "install.json", logger);
  }
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

// Exported so the stage reconcile helper can validate a staged/aside
// candidate's `platform`/`arch` against the CURRENT machine without
// duplicating this resolution.
export function currentInstallPlatform(): HostInstallPlatform {
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

export function currentInstallArch(): HostInstallArch {
  const arch = osArch();
  if (arch === "arm64" || arch === "x64") return arch;
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `host install: unsupported arch '${arch}' (expected arm64|x64)`,
    details: { arch },
    exitCode: 1,
  });
}
