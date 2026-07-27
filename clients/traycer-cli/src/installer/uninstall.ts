import { rm } from "node:fs/promises";
import {
  deleteHostInstallRecord,
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { rotateHostLogForPurge } from "../host/host-log-rotation";
import {
  hostInstallDir,
  hostPidMetadataPath,
  hostStagedDir,
} from "../store/paths";
import { sweepOldTrash } from "./install";

// Uninstall the installed host directory for a single environment. Always
// removes the install dir + record, AND the staged dir alongside it (Tech
// Plan, "host uninstall ... removes staged/ alongside install/") - a
// staged-but-not-yet-applied update has nothing left to apply to once the
// host it was staged against is gone. Both `host uninstall` and
// `host uninstall --all` route through this function, so both modes get
// the removal. Runtime state (pid metadata, log) is preserved unless
// `purgeChannelRuntime` is set. User data under ~/.traycer/ (chats,
// sqlite, snapshots, credentials, downloaded models + provider binaries)
// is NEVER removed - there is intentionally no "purge user data" path.
// The OS service registration is NOT touched here - the caller decides
// whether to follow up with a service-uninstall (the `--all` flag flow).
export interface UninstallHostOptions {
  readonly environment: Environment;
  readonly purgeChannelRuntime: boolean;
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
  await deleteHostInstallRecord(opts.environment);
  logger.info("Host uninstall deleted install record", {
    environment: opts.environment,
    removedInstallDir,
  });
  // Sweep any stale `<installDir>.old-*` siblings the atomic swap left
  // behind after a crash. Best-effort; never blocks the uninstall.
  await sweepOldTrash(hostInstallDir(opts.environment), "install.json", logger);

  // A staged update has nothing left to apply to once the host it was
  // staged against is gone - remove `staged/` (and its own `.old-*`
  // litter, the identical trash convention `install/` uses, keyed by its
  // own `staged.json` sidecar) alongside `install/` rather than leaving
  // it to be silently swept by the next install/apply's reconcile pass.
  let removedStagedDir = false;
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
  await sweepOldTrash(hostStagedDir(opts.environment), "staged.json", logger);

  let purgedRuntime = false;
  if (opts.purgeChannelRuntime) {
    // Clear pid metadata + log + any other environment-scoped runtime
    // state. We don't blow away ~/.traycer/host/ wholesale because
    // the dev environment's install lives under it.
    //
    // The log is ROTATED, not deleted. `make dev-desktop` runs
    // `host uninstall --all` on every Ctrl-C teardown, so deleting here meant
    // the session you most wanted to investigate was routinely gone before you
    // could read it. Rotating still clears the live log (a purge that leaves an
    // orphan behind is its own surprise) while keeping one generation, and it
    // cannot accumulate.
    await removeHostPidMetadataForPurge(opts.environment, logger, rm);
    const rotated = await rotateHostLogForPurge(opts.environment);
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
