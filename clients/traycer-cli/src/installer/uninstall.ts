import { rm } from "node:fs/promises";
import {
  deleteHostInstallRecord,
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  hostInstallDir,
  hostLogPath,
  hostPidMetadataPath,
} from "../store/paths";
import { sweepOldTrash } from "./install";

// Uninstall the installed host directory for a single environment. Always
// removes the install dir + record; runtime state (pid metadata, log)
// is preserved unless `purgeChannelRuntime` is set. User data under
// ~/.traycer/ (chats, sqlite, snapshots, credentials, downloaded models +
// provider binaries) is NEVER removed - there is intentionally no "purge user
// data" path. The OS service registration is NOT touched here - the caller
// decides whether to follow up with a service-uninstall (the `--all` flag flow).
export interface UninstallHostOptions {
  readonly environment: Environment;
  readonly purgeChannelRuntime: boolean;
}

export interface UninstallHostResult {
  readonly removedRecord: HostInstallRecord | null;
  readonly removedInstallDir: boolean;
  readonly purgedRuntime: boolean;
}

export async function uninstallHost(
  opts: UninstallHostOptions,
): Promise<UninstallHostResult> {
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
  try {
    await rm(hostInstallDir(opts.environment), { recursive: true, force: true });
    removedInstallDir = true;
  } catch (err) {
    logger.warn("Host uninstall failed to remove install directory", {
      environment: opts.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    removedInstallDir = false;
  }
  await deleteHostInstallRecord(opts.environment);
  logger.info("Host uninstall deleted install record", {
    environment: opts.environment,
    removedInstallDir,
  });
  // Sweep any stale `<installDir>.old-*` siblings the atomic swap left
  // behind after a crash. Best-effort; never blocks the uninstall.
  await sweepOldTrash(hostInstallDir(opts.environment));

  let purgedRuntime = false;
  if (opts.purgeChannelRuntime) {
    // Remove pid metadata + log + any other environment-scoped runtime
    // state. We don't blow away ~/.traycer/host/ wholesale because
    // the dev environment's install lives under it.
    await rm(hostPidMetadataPath(opts.environment), { force: true });
    await rm(hostLogPath(opts.environment), { force: true });
    purgedRuntime = true;
    logger.warn("Host uninstall purged runtime files", {
      environment: opts.environment,
    });
  }

  logger.info("Host uninstall completed", {
    environment: opts.environment,
    removedInstallDir,
    purgedRuntime,
    hadInstallRecord: previous !== null,
  });
  return {
    removedRecord: previous,
    removedInstallDir,
    purgedRuntime,
  };
}
