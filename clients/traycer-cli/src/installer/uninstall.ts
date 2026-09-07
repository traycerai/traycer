import { rm } from "node:fs/promises";
import {
  deleteHostInstallRecord,
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { rotateHostLogForPurgeWithVerifier } from "../host/host-log-rotation";
import {
  hostInstallDir,
  hostPidMetadataPath,
  hostStagedDir,
} from "../store/paths";
import { legacyMutationVerifier } from "./aside-dirs";
import { sweepOldTrash } from "./install";

// Uninstall the installed host directory for a single environment.
// Always removes the install dir + record, AND the staged dir alongside it (Tech Plan, "host uninstall ... removes staged/ alongside install/") - a staged-but-not-yet-applied update has nothing left to apply to once the host it was staged against is gone.
export interface UninstallHostOptions {
  readonly environment: Environment;
  readonly purgeChannelRuntime: boolean;
  /** Every destructive edge receives an explicit verifier. Legacy callers use the named `legacyMutationVerifier`, never a nullable omission. */
  readonly verifyMutationCapability: () => Promise<void>;
}

export interface UninstallHostResult {
  readonly removedRecord: HostInstallRecord | null;
  readonly removedInstallDir: boolean;
  readonly removedStagedDir: boolean;
  readonly purgedRuntime: boolean;
}

export async function removeHostPidMetadataForPurge(
  environment: Environment,
  logger: ILogger,
  remove: (path: string, options: { readonly force: true }) => Promise<void>,
): Promise<void> {
  return await removeHostPidMetadataForPurgeWithVerifier(
    environment,
    logger,
    remove,
    legacyMutationVerifier,
  );
}

export async function removeHostPidMetadataForPurgeWithVerifier(
  environment: Environment,
  logger: ILogger,
  remove: (path: string, options: { readonly force: true }) => Promise<void>,
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  // A lock/capability failure is an authority failure, not a best-effort
  // metadata cleanup error. Leave it visible to stop the remaining purge.
  await verifyMutationCapability();
  try {
    await remove(hostPidMetadataPath(environment), { force: true });
  } catch (err) {
    logger.warn("Host uninstall failed to remove pid metadata", {
      environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
  }
}

export async function uninstallHost(
  opts: UninstallHostOptions,
): Promise<UninstallHostResult> {
  const verify = opts.verifyMutationCapability;
  const logger = createCliLogger(opts.environment);
  logger.info("Host uninstall started", {
    environment: opts.environment,
    purgeChannelRuntime: opts.purgeChannelRuntime,
  });
  const previous = await readHostInstallRecord(opts.environment);
  logger.debug("Host uninstall read install record", {
    environment: opts.environment,
    hadInstallRecord: previous !== null,
  });
  let removedInstallDir = false;
  await verify();
  try {
    await rm(hostInstallDir(opts.environment), {
      recursive: true,
      force: true,
    });
    removedInstallDir = true;
  } catch (err) {
    logger.warn("Host uninstall failed to remove install directory", {
      environment: opts.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    removedInstallDir = false;
  }
  await verify();
  await deleteHostInstallRecord(opts.environment);
  logger.info("Host uninstall deleted install record", {
    environment: opts.environment,
    removedInstallDir,
  });
  // Sweep any stale `<installDir>.old-*` siblings the atomic swap left
  // behind after a crash. Best-effort; never blocks the uninstall.
  await sweepOldTrash(
    hostInstallDir(opts.environment),
    "install.json",
    logger,
    verify,
  );

  // A staged update has nothing left to apply to once the host it was staged against is gone - remove `staged/` (and its own `.old-*` litter, the identical trash convention `install/` uses, keyed by its own `staged.json` sidecar) alongside `install/` rather than leaving it to be silently swept by the next install/apply's reconcile pass.
  let removedStagedDir = false;
  await verify();
  try {
    await rm(hostStagedDir(opts.environment), {
      recursive: true,
      force: true,
    });
    removedStagedDir = true;
  } catch (err) {
    logger.warn("Host uninstall failed to remove staged directory", {
      environment: opts.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    removedStagedDir = false;
  }
  await sweepOldTrash(
    hostStagedDir(opts.environment),
    "staged.json",
    logger,
    verify,
  );

  let purgedRuntime = false;
  if (opts.purgeChannelRuntime) {
    // Clear pid metadata + log + any other environment-scoped runtime state.
    // We don't blow away ~/.traycer/host/ wholesale because the dev environment's install lives under it.
    await removeHostPidMetadataForPurgeWithVerifier(
      opts.environment,
      logger,
      rm,
      verify,
    );
    const rotated = await rotateHostLogForPurgeWithVerifier(
      opts.environment,
      verify,
    );
    purgedRuntime = true;
    logger.warn("Host uninstall purged runtime files", {
      environment: opts.environment,
      rotatedLog: rotated === "rotated",
    });
  }

  logger.info("Host uninstall completed", {
    environment: opts.environment,
    removedInstallDir,
    removedStagedDir,
    purgedRuntime,
    hadInstallRecord: previous !== null,
  });
  return {
    removedRecord: previous,
    removedInstallDir,
    removedStagedDir,
    purgedRuntime,
  };
}
