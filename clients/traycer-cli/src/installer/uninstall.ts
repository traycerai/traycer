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
  hostVersionsDir,
} from "../store/paths";
import {
  resolveInstallPointerTarget,
  sweepOldTrash,
  type InstallPointerTarget,
} from "./install";

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
    // `hostInstallDir` is a stable symlink/junction onto a versioned dir
    // under `hostVersionsDir` (or, on an unmigrated legacy machine, a
    // plain directory) - `rm` on a symlink only removes the link entry
    // itself, not the bytes it points at, so resolve the target first and
    // remove both. Uninstall also clears every OTHER retained version
    // (not just the active one, which normally keeps its immediately-
    // previous generation around as a rollback source) - there is no
    // "current"/"previous" distinction worth preserving once the whole
    // host is being removed.
    const target = hostInstallDir(opts.environment);
    const resolvedTarget = await resolveInstallDirTarget(target);
    await rm(target, { recursive: true, force: true });
    if (resolvedTarget !== null) {
      await rm(resolvedTarget, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    await rm(hostVersionsDir(opts.environment), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
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
  // Sweep any stale `<installDir>.old-*` siblings a pre-versioned-dir CLI's
  // atomic swap left behind after a crash. Best-effort; never blocks the
  // uninstall.
  await sweepOldTrash(hostInstallDir(opts.environment));

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
    purgedRuntime,
    hadInstallRecord: previous !== null,
  });
  return {
    removedRecord: previous,
    removedInstallDir,
    purgedRuntime,
  };
}

// Resolve the absolute versioned-dir path `target` (the `hostInstallDir`
// symlink/junction) currently points at, or `null` when `target` doesn't
// exist, is itself a plain directory (legacy, unmigrated layout - the
// `rm(target, ...)` above already removes those bytes directly, there is
// no separate resolved target to also remove), or couldn't be inspected at
// all - uninstall is best-effort, so any `lstat` failure here is treated the
// same as "nothing to resolve" rather than aborting the uninstall.
async function resolveInstallDirTarget(target: string): Promise<string | null> {
  const pointer = await resolveInstallPointerTarget(target).catch(
    (): InstallPointerTarget => ({ kind: "missing", resolved: null }),
  );
  return pointer.kind === "symlink" ? pointer.resolved : null;
}
