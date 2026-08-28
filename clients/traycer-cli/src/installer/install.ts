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
  releaseDownloadSlot,
  releaseDownloadSlotOwnership,
} from "../registry";
import type { ProgressInfo } from "../runner/output";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { createOwnedTempDir } from "../store/owned-temp";
import { hostHomeDir, hostInstallDir, ensureHostHomeDir } from "../store/paths";
import { extractHostSource, resolveHostExecutable } from "./extract";
import { preserveLegacyProviders } from "./legacy-providers";
import { createExtractHeartbeat } from "./extract-heartbeat";
import { hashFileSha256 } from "./sha256";
import type { HostStartAdoptionPublisher } from "../host/host-start-adoption";
import {
  invalidateAsideDir,
  legacyMutationVerifier,
  listAsideDirsNewestFirst,
  sweepDeadAsideDirs,
} from "./aside-dirs";
import { isRetryableRenameCode, renameWithRetryPlan } from "./rename-retry";
import {
  reconcileHostStage,
  reconcileHostStageWithAttempt,
} from "./stage-reconcile";

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
//
//   - `swapLockRecovery` is the Windows-only escalation seam for the swap
//     renames themselves. `beforeSwap`'s service stop kills every host
//     process the slot scan can SEE (exe path / command line under the
//     install dir), but a process merely holding a handle inside it - an
//     orphaned child with its CWD there, an AV scanner - is invisible to
//     that scan and fails the rename with EBUSY. `killLingeringProcesses`
//     re-runs the kill between rename attempts; `describeLockHolders` runs
//     after the retries are exhausted so the error can name the processes
//     still matching the slot instead of a bare EBUSY. `null` on platforms
//     whose renames don't contend with open handles (POSIX) and for
//     callers that manage the OS service themselves.
export interface InstallHostLifecycle {
  readonly beforeSwap: () => Promise<void>;
  readonly afterSwap: () => Promise<void>;
  readonly swapLockRecovery: SwapLockRecovery | null;
  /**
   * The contender facade supplies its live-capability verifier immediately
   * before this lifecycle is used. Lifecycle implementations call it at
   * their own raw service actuators, not merely at the surrounding swap.
   */
  readonly setMutationVerifier?: (
    verifyMutationCapability: () => Promise<void>,
  ) => void;
  /**
   * A contender-aware caller publishes this immediately before lifecycle
   * code asks an OS manager to launch `host start`. It avoids the parent
   * attempt holder and its service-launched supervisor reacquiring each
   * other’s non-reentrant lock.
   */
  readonly setHostStartAdoptionPublisher?: (
    publishHostStartAdoption: HostStartAdoptionPublisher,
  ) => void;
}

// A process the platform's slot scan still associates with the install
// after the swap rename kept failing - the diagnostic payload for the
// EBUSY error. `name`/`executablePath` are null when the scan could not
// read them (access-denied on another user's process, for instance).
export interface SwapLockHolderProcess {
  readonly pid: number;
  readonly name: string | null;
  readonly executablePath: string | null;
}

export interface SwapLockRecovery {
  readonly killLingeringProcesses: () => Promise<void>;
  readonly describeLockHolders: () => Promise<readonly SwapLockHolderProcess[]>;
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
    verifyMutationCapability: legacyMutationVerifier,
  });
  const { record, previous } = await commitHostInstallSource({
    environment: opts.environment,
    staged,
    onProgress: opts.onProgress,
    lifecycle: opts.lifecycle,
    verifyMutationCapability: legacyMutationVerifier,
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
  await opts.verifyMutationCapability();
  await ensureHostHomeDir(opts.environment);
  await opts.verifyMutationCapability();
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
    await opts.verifyMutationCapability();
    opts.onProgress({
      stage: "extract",
      message: `extracting host archive into ${staging.stagingDir}`,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    await extractHostSource({
      source: staging.archivePath,
      targetDir: staging.stagingDir,
      onEntry: createExtractHeartbeat({
        environment: opts.environment,
        archivePath: staging.archivePath,
        version: staging.version,
        onProgress: opts.onProgress,
      }),
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
    // for the "staged but never committed" case. The archive itself is
    // NOT consumed: extraction is exactly what failed, so a retry needs
    // these same verified bytes.
    await cleanupStagingArtifacts(
      {
        environment: opts.environment,
        archivePath: staging.archivePath,
        archiveIsTemporary: staging.archiveIsTemporary,
        stagingDir: staging.stagingDir,
        swapped: false,
        archiveConsumed: false,
        verifyMutationCapability: opts.verifyMutationCapability,
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
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  const logger = createCliLogger(environment);
  await cleanupStagingArtifacts(
    {
      environment,
      archivePath: staged.archivePath,
      archiveIsTemporary: staged.archiveIsTemporary,
      stagingDir: staged.stagingDir,
      swapped: false,
      // Declining to commit is not consuming: `--if-idle` finding the host
      // busy is a retry-later, and that retry re-stages from the archive.
      archiveConsumed: false,
      verifyMutationCapability,
    },
    logger,
  );
}

export interface CommitHostInstallSourceOptions {
  readonly environment: Environment;
  readonly staged: StagedHostInstallSource;
  readonly onProgress: (info: ProgressInfo) => void;
  readonly lifecycle: InstallHostLifecycle | null;
  /**
   * Invoked at each irreversible edge. Legacy/internal callers must pass
   * the explicitly named `legacyMutationVerifier`; an omitted or nullable
   * verifier would make an unguarded mutation indistinguishable from an
   * authority-checked one.
   */
  readonly verifyMutationCapability: () => Promise<void>;
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
    await reconcileHostStageWithAttempt(
      opts.environment,
      opts.verifyMutationCapability,
    );
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
      verifyMutationCapability: opts.verifyMutationCapability,
      onCommitted: () => {
        swapped = true;
      },
    });

    await reconcileHostStageWithAttempt(
      opts.environment,
      opts.verifyMutationCapability,
    );

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
        // The swap is the moment the archive's contents become the install,
        // so it is also the moment the archive stops being worth keeping. A
        // commit that threw before it leaves a retry to re-stage.
        archiveConsumed: swapped,
        verifyMutationCapability: opts.verifyMutationCapability,
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
    // Whether this install is finished with the archive. False on every
    // path that could still be retried - see the two release calls below.
    readonly archiveConsumed: boolean;
    readonly verifyMutationCapability: () => Promise<void>;
  },
  logger: ILogger,
): Promise<void> {
  if (opts.archiveIsTemporary) {
    // Neither branch may be a bare `rm`: a registry-downloaded archive
    // lives in the shared download cache and carries an ownership claim
    // that has to come off with it (registry/download-cache.ts).
    const release = opts.archiveConsumed
      ? // Installed, so the archive has done its job - drop it and the claim.
        releaseDownloadSlot
      : // Staging failed, or the caller chose not to commit. The bytes are
        // already sha256- and minisign-verified, and a retry re-runs
        // extraction against this same archive, so discarding them here
        // forces a fresh ~800MB transfer that cannot yield anything
        // different. Drop only the claim and let the next run resume it.
        releaseDownloadSlotOwnership;
    // The verifier gates the destructive edge but must not THROW out of this
    // cleanup: it runs from `finally` blocks, where a capability loss would
    // replace the primary commit error (or a success) and abort the steps
    // after it. Sequential await-then-actuate inside one catch keeps the
    // edge admitted-or-skipped while the primary outcome survives (and keeps
    // the verifier→actuator domination visible to the architecture scan).
    try {
      await opts.verifyMutationCapability();
      await release(opts.environment, opts.archivePath);
    } catch (err) {
      logger.warn("Host install failed to release temporary archive", {
        environment: opts.environment,
        archiveConsumed: opts.archiveConsumed,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    }
  }
  if (!opts.swapped) {
    try {
      await opts.verifyMutationCapability();
      await rm(opts.stagingDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn("Host install failed to remove staging directory", {
        environment: opts.environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    }
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
  /** See `CommitHostInstallSourceOptions.verifyMutationCapability`. */
  readonly verifyMutationCapability: () => Promise<void>;
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
  const verifyMutationCapability = opts.verifyMutationCapability;
  if (
    opts.lifecycle !== null &&
    opts.lifecycle.setMutationVerifier !== undefined
  ) {
    opts.lifecycle.setMutationVerifier(verifyMutationCapability);
  }
  const previous = await readHostInstallRecord(opts.environment);

  const finalExecutablePath = opts.executablePath.replace(
    opts.sourceDir,
    hostInstallDir(opts.environment),
  );
  // This is distinct from `archiveSha256`: recovery needs an attestation of
  // the exact executable that will move into `install/`, not merely the
  // signed archive from which the source tree was extracted.  The record is
  // written inside that same source tree before the atomic swap, binding the
  // digest and bytes to one promoted generation.
  const executableSha256 = await hashFileSha256(opts.executablePath, null);
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
    executableSha256,
  };
  await verifyMutationCapability();
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
    await verifyMutationCapability();
    opts.onProgress({
      stage: "service-stop",
      message: "stopping service before replacing install directory",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
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
    workUnits: null,
  });
  await verifyMutationCapability();
  await atomicSwap({
    environment: opts.environment,
    stagingDir: opts.sourceDir,
    swapLockRecovery:
      opts.lifecycle === null ? null : opts.lifecycle.swapLockRecovery,
    verifyMutationCapability,
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
    await verifyMutationCapability();
    opts.onProgress({
      stage: "service-start",
      message: "starting service after replacing install directory",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
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
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  const matches = await listAsideDirsNewestFirst(target, "old-");
  for (const match of matches) {
    await verifyMutationCapability();
    await invalidateAsideDir(
      target,
      match,
      sidecarFilename,
      logger,
      verifyMutationCapability,
    );
  }
  await verifyMutationCapability();
  await sweepDeadAsideDirs(target, verifyMutationCapability);
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
  /** Required before every staging-tree creation or cleanup edge. */
  readonly verifyMutationCapability: () => Promise<void>;
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
      workUnits: null,
    });
    // Report the position as it hashes. `bytes`/`totalBytes` are a REAL measured
    // position, so this stage needs no `workUnits` - a synthetic counter would be
    // discarding an available truth for a proxy. Throttling is left to the
    // consumer: the desktop coalesces progress into one lane and the renderer
    // reads the latest value, so an event per chunk costs a merge rather than a
    // render.
    archiveSha256 = await hashFileSha256(opts.sourcePath, (bytesHashed) => {
      opts.onProgress({
        stage: "verify",
        message: `hashing ${opts.sourcePath}`,
        percent: null,
        bytes: bytesHashed,
        totalBytes: sourceStat.size,
        workUnits: null,
      });
    });
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
  const client = await createDefaultRegistryClient(
    opts.environment,
    opts.onProgress,
  );
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
    workUnits: null,
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
    workUnits: null,
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
      workUnits: null,
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

// Both recovery calls are best-effort by construction: a broken scan or
// kill must never mask the rename failure it was trying to explain or fix.
function swapLockRetryHook(
  recovery: SwapLockRecovery | null,
  logger: ILogger,
): (() => Promise<void>) | null {
  if (recovery === null) return null;
  return async () => {
    try {
      await recovery.killLingeringProcesses();
    } catch (err) {
      // The retry primitive verifies again immediately before it invokes this
      // hook. Do not subsequently turn a capability failure thrown by a
      // recovery implementation into a harmless warning: that would let the
      // next retry proceed as though its authority were still intact.
      if (
        err instanceof CliError &&
        err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY
      ) {
        throw err;
      }
      logger.warn("Host install swap-lock re-kill failed", {
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    }
  };
}

function isLostMutationAuthority(cause: unknown): cause is CliError {
  return (
    cause instanceof CliError && cause.code === CLI_ERROR_CODES.CLI_LOCK_BUSY
  );
}

async function collectSwapLockHolders(
  recovery: SwapLockRecovery | null,
  logger: ILogger,
): Promise<readonly SwapLockHolderProcess[]> {
  if (recovery === null) return [];
  try {
    return await recovery.describeLockHolders();
  } catch (err) {
    logger.warn("Host install swap-lock holder scan failed", {
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return [];
  }
}

// The logger's `LogValue` requires an index signature interfaces don't
// carry - re-shape each holder as an anonymous literal for the log fields.
function logLockHolder(holder: SwapLockHolderProcess): {
  readonly pid: number;
  readonly name: string | null;
  readonly executablePath: string | null;
} {
  return {
    pid: holder.pid,
    name: holder.name,
    executablePath: holder.executablePath,
  };
}

// The diagnostic tail appended to the swap failure's message. Named
// holders when the slot scan matched something; otherwise, for a
// lock-class failure on a platform that HAS the scan (Windows), an
// actionable fallback - a CWD-only orphan, an AV/indexer scan, or an open
// Explorer/terminal window holds the directory without its exe or command
// line ever mentioning it, so the scan legitimately comes back empty and
// "retry" alone cannot clear it. A non-lock code (say a genuine EIO) gets
// no suffix: claiming "another program is holding it" there would send
// the user chasing a locker that does not exist.
function swapLockFailureSuffix(
  cause: unknown,
  holders: readonly SwapLockHolderProcess[],
  recovery: SwapLockRecovery | null,
): string {
  if (holders.length > 0) {
    const rendered = holders
      .map((holder) => {
        const name = holder.name === null ? "" : ` (${holder.name})`;
        const exe =
          holder.executablePath === null ? "" : ` at ${holder.executablePath}`;
        return `pid ${holder.pid}${name}${exe}`;
      })
      .join(", ");
    return `; processes still holding the install directory: ${rendered}`;
  }
  if (recovery === null) return "";
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  if (!isRetryableRenameCode(code)) return "";
  return (
    "; no Traycer process matches the install directory - another program" +
    " is holding it open (an antivirus or indexer scan, a terminal or" +
    " Explorer window inside it, or an orphaned child process whose" +
    " working directory is inside it). Close it or restart Windows, then" +
    " retry the update"
  );
}

interface AtomicSwapOptions {
  readonly environment: Environment;
  readonly stagingDir: string;
  readonly swapLockRecovery: SwapLockRecovery | null;
  /** Revalidated immediately before every irreversible swap edge. */
  readonly verifyMutationCapability: () => Promise<void>;
}

// The swap renames get a far longer runway than `renameWithRetry`'s
// default ~2.5s: the field failure this heals is a Windows EBUSY from a
// handle the pre-swap kill couldn't see (an orphaned child with its CWD in
// the install dir, an AV scan of the just-killed executable), and those
// outlast a 2.5s window while resolving well inside ~25s once the
// between-attempt re-kill lands. POSIX renames never raise the retryable
// codes, so the schedule costs nothing there. Exported for the schedule
// contract pin in install.test.ts - production reads it only through
// `swapRenameDelays()` below.
export const SWAP_RENAME_DELAYS_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000, 8000, 8000,
];

// Wall-clock ceiling for one swap rename INCLUDING its re-kill hooks. The
// schedule above sums to ~24s of sleeps, but each Windows re-kill pass can
// legitimately spend a 10s WMI scan plus a 30s taskkill on a degraded
// machine - seven such passes would keep the service down and the
// environment cli-lock held for ~5 minutes. Healthy re-kills run in a
// couple of seconds, so this ceiling never truncates the schedule where
// the retries can actually work; it only stops the pathological machines
// from wedging every other host mutation while they fail.
export const SWAP_RENAME_MAX_TOTAL_MS = 120_000;

// The exhausted-retries paths are untestable at production timing (a full
// EBUSY exhaustion sleeps the whole ~24s schedule), so tests inject a
// short schedule here. Mirrors `setWindowsTaskInstallDepsForTests`'s
// shape. Never set in production.
let swapRenameDelaysOverride: readonly number[] | null = null;
export function setSwapRenameDelaysForTests(
  delays: readonly number[] | null,
): void {
  swapRenameDelaysOverride = delays;
}

function swapRenameDelays(): readonly number[] {
  return swapRenameDelaysOverride ?? SWAP_RENAME_DELAYS_MS;
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
  await sweepOldTrash(
    target,
    "install.json",
    logger,
    opts.verifyMutationCapability,
  );

  const swapRenamePlan = {
    delaysMs: swapRenameDelays(),
    onRetry: swapLockRetryHook(opts.swapLockRecovery, logger),
    maxTotalMs: SWAP_RENAME_MAX_TOTAL_MS,
    verifyBeforeAttempt: opts.verifyMutationCapability,
  };

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
    try {
      await renameWithRetryPlan(target, trash, swapRenamePlan);
    } catch (cause) {
      if (isLostMutationAuthority(cause)) throw cause;
      // Nothing has moved: the previous install is intact, only the update
      // is blocked. Wrap the raw fs error (historically surfaced verbatim
      // as "EBUSY: resource busy or locked, rename ...") and name the
      // processes still holding the install dir so the report identifies
      // the culprit instead of a bare errno.
      const holders = await collectSwapLockHolders(
        opts.swapLockRecovery,
        logger,
      );
      logger.error(
        "Host install failed to move the previous install aside",
        {
          environment: opts.environment,
          target,
          trash,
          holders: holders.map(logLockHolder),
        },
        errorFromUnknown(cause),
      );
      throw cliError({
        code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
        message: `host install: failed to move the previous install aside: ${cause instanceof Error ? cause.message : String(cause)}${swapLockFailureSuffix(cause, holders, opts.swapLockRecovery)}`,
        details: { target, trash, lockHolders: holders },
        exitCode: 1,
      });
    }
  }
  try {
    await renameWithRetryPlan(opts.stagingDir, target, swapRenamePlan);
  } catch (cause) {
    const holders = await collectSwapLockHolders(opts.swapLockRecovery, logger);
    logger.error(
      "Host install atomic swap failed",
      {
        environment: opts.environment,
        targetExists,
        holders: holders.map(logLockHolder),
      },
      errorFromUnknown(cause),
    );
    // Restore the previous install if the rename of the new one fails. The
    // same transient Windows lock that failed the swap can also fail the
    // restore, so it gets the same bounded retry plan. The restore is still
    // an install-tree rename, however: every one of its attempts validates
    // the live capability. If authority has been lost we intentionally leave
    // the exact old tree in `trash` and surface the authority failure rather
    // than performing an unverified rollback. The next admitted repair can
    // inspect/recover that explicitly named pre-swap tree; it cannot mistake
    // a stale actor's restore for authorised forward progress.
    if (targetExists) {
      try {
        await renameWithRetryPlan(trash, target, {
          delaysMs: swapRenameDelays(),
          // Compensation may restore the previous bytes, never kill another
          // process as part of a stale forward transaction.
          onRetry: null,
          maxTotalMs: SWAP_RENAME_MAX_TOTAL_MS,
          verifyBeforeAttempt: opts.verifyMutationCapability,
        });
      } catch (restoreCause) {
        // The `holders` in the enclosing scope were collected right after
        // the SWAP-IN failure, before this restore ever ran its own
        // retries/re-kills - they don't necessarily describe who (if
        // anyone) still holds `target` now that the restore has also
        // exhausted. Re-scan so this, the worst failure in the file (no
        // `install/` at all), gets a diagnosis of its own rather than a
        // stale one.
        const restoreHolders = await collectSwapLockHolders(
          opts.swapLockRecovery,
          logger,
        );
        logger.error(
          "Host install rollback failed - previous install left aside",
          { target, trash, holders: restoreHolders.map(logLockHolder) },
          errorFromUnknown(restoreCause),
        );
        if (isLostMutationAuthority(restoreCause)) throw restoreCause;
      }
    }
    if (isLostMutationAuthority(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: failed to swap staging dir into place: ${cause instanceof Error ? cause.message : String(cause)}${swapLockFailureSuffix(cause, holders, opts.swapLockRecovery)}`,
      details: { target, stagingDir: opts.stagingDir, lockHolders: holders },
      exitCode: 1,
    });
  }
  if (targetExists) {
    // Carry the outgoing install's bundled provider packs into the new
    // install BEFORE the old dir is invalidated - a slim host archive ships
    // no coding-agent CLIs, and these bytes are what keeps every provider
    // runnable until its registry pack downloads (see legacy-providers.ts).
    // Provider carryover is best-effort for a pack that cannot move, but it
    // is still a post-swap canonical-tree mutation. Thread the live verifier
    // through so authority loss stops the composite rather than being logged
    // as a tolerable provider-pack failure.
    await preserveLegacyProviders(
      trash,
      target,
      logger,
      opts.verifyMutationCapability,
    );
    // Layered invalidation (rename-to-`.dead-*` -> sidecar-unlink ->
    // recursive-rm -> accept-and-log), not a plain `rm`: mirrors
    // `download-stage.ts`'s `replaceStagedDir`, which creates and discards
    // asides via this identical explicit-replace shape. A bare `rm` that
    // failed on every retry (e.g. a lingering Windows handle) would leave
    // `trash` as a fully intact, restorable `install.old-*` copy -
    // exactly the residual `sweepOldTrash` above exists to heal, so a
    // failed deletion here must not be more recoverable than one caught by
    // the next sweep.
    await opts.verifyMutationCapability();
    await invalidateAsideDir(
      target,
      trash,
      "install.json",
      logger,
      opts.verifyMutationCapability,
    );
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
