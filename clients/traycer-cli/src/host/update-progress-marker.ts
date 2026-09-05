import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  ensureHostHomeDir,
  hostUpdateProgressMarkerPath,
} from "../store/paths";

// Cross-process handoff file `traycer host update` writes so the host
// daemon (which spawns the update detached and does NOT wait for it) can
// learn the outcome without polling process exit codes. Deliberately
// mirrored (by contract, not by import - this CLI lives in a separate
// repo/package graph from `traycer-host/`) at
// `traycer-host/src/paths.ts::hostHomeDir`, and shape-compatible with
// `packages/common/src/types/host/index.ts`'s `HostUpdateProgress` in the
// internal monorepo (also not importable from here for the same reason).
//
// Lifecycle:
//   - written with `state: "updating"` BEFORE `host update` touches
//     anything (stop/swap/restart).
//   - deleted on confirmed success (the daemon then falls back to normal
//     desiredVersion/appVersion-derived state once it observes the new
//     version via its own heartbeat).
//   - rewritten with `state: "failed"` + a short error string on confirmed
//     failure (health probe exhausted its budget, with or without a
//     rollback swap) and left in place until a fresh update attempt
//     supersedes it.
export type HostUpdateProgressState = "updating" | "failed";

export interface HostUpdateProgress {
  readonly state: HostUpdateProgressState;
  readonly error: string | null;
  readonly targetVersion: string;
  readonly updatedAt: string;
}

export async function writeUpdateProgressMarker(
  environment: Environment,
  progress: HostUpdateProgress,
): Promise<void> {
  const logger = createCliLogger(environment);
  await ensureHostHomeDir(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(progress, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, target);
  logger.info("Host update progress marker written", {
    environment,
    state: progress.state,
    targetVersion: progress.targetVersion,
    hasError: progress.error !== null,
  });
}

// Best-effort clear on confirmed success. Never throws - a failure to
// delete the marker just leaves a stale "updating" marker the daemon will
// eventually reconcile once it observes the new `appVersion`; it must not
// fail the otherwise-successful update command.
export async function deleteUpdateProgressMarker(
  environment: Environment,
): Promise<void> {
  const logger = createCliLogger(environment);
  try {
    await rm(hostUpdateProgressMarkerPath(environment), { force: true });
    logger.info("Host update progress marker cleared", { environment });
  } catch (err) {
    logger.warn("Host update progress marker clear failed", {
      environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
  }
}

export type ConditionalMarkerDelete = "cleared" | "changed" | "absent";

function sameProgress(a: HostUpdateProgress, b: HostUpdateProgress): boolean {
  return (
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error
  );
}

function errnoCode(err: unknown): string | null {
  return typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
    ? err.code
    : null;
}

/**
 * Delete the marker only if it still reads as `expected` - a compare-and-
 * delete that cannot erase a marker another writer landed in between.
 *
 * For a reconciliation that decided from a marker it READ - "this `failed`
 * is stale, the host is current" - rather than one it wrote. Another updater
 * can replace that marker with a live `updating` at any point, and deleting
 * that would erase the only progress signal the legacy path has, rendering
 * a real download → swap → restart as a quiet host. A read-then-unlink pair
 * leaves exactly that window open, and a lock does not close it because the
 * `updating` write precedes its writer's lock acquisition. So the primitive
 * is built from the atomic operations the filesystem does offer:
 *
 * 1. `rename(marker → scratch)` takes the CURRENT marker out of the live
 *    path atomically. Writers only ever `rename(tmp → marker)`, so from here
 *    on nothing they do can touch what we hold, and anything they land is a
 *    NEWER marker at the live path.
 * 2. Inspect the scratch. If it is the stale record we expected, unlink it:
 *    the live path is either empty or already holds a newer marker, and
 *    both are correct.
 * 3. If it is NOT what we expected, it is a live marker a writer landed
 *    between the caller's read and step 1, and it has to go back:
 *    `link(scratch → marker)` restores it atomically and fails with EEXIST
 *    if an even newer marker has landed since - in which case the newer one
 *    stands (last write wins, exactly as it does between two writers) and the
 *    scratch is dropped.
 *
 * The one observable cost is a window between steps 1 and 3 in which the
 * live path is momentarily empty; a reader polling in that instant sees "no
 * marker" for one poll. That is strictly better than the failure mode it
 * replaces, where the live marker was gone for the rest of the update.
 * Never throws (same rule as the other marker I/O).
 */
export async function deleteUpdateProgressMarkerIfUnchanged(
  environment: Environment,
  expected: HostUpdateProgress,
): Promise<ConditionalMarkerDelete> {
  const logger = createCliLogger(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const scratch = `${target}.reconcile-${process.pid}-${Date.now()}`;
  try {
    await rename(target, scratch);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return "absent";
    logger.warn("Host update progress marker conditional clear failed", {
      environment,
      step: "take",
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return "changed";
  }
  const current = await readMarkerFile(scratch, environment);
  if (current !== null && sameProgress(current, expected)) {
    await rm(scratch, { force: true });
    logger.info("Host update progress marker cleared (conditional)", {
      environment,
      state: expected.state,
    });
    return "cleared";
  }
  // Not ours to clear: give it back unless a newer marker has since landed.
  try {
    await link(scratch, target);
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") {
      // `link` is unavailable or refused for a reason other than a newer
      // marker; a plain rename is the last resort, accepting that it could
      // overwrite a marker landed in the last few microseconds.
      try {
        await rename(scratch, target);
      } catch (renameErr) {
        logger.warn("Host update progress marker conditional clear failed", {
          environment,
          step: "restore",
          errorName: errorFromUnknown(renameErr).name,
          errorMessage: errorFromUnknown(renameErr).message,
        });
      }
      logger.info(
        "Host update progress marker changed under a conditional clear",
        {
          environment,
          expectedState: expected.state,
          currentState: current?.state ?? null,
        },
      );
      return "changed";
    }
  }
  await rm(scratch, { force: true });
  logger.info("Host update progress marker changed under a conditional clear", {
    environment,
    expectedState: expected.state,
    currentState: current?.state ?? null,
  });
  return "changed";
}

// Read-only accessor for Doctor / tests. Returns `null` when absent or
// malformed (a malformed marker is treated the same as "no marker" - it is
// advisory UI state, not an authoritative record worth failing loudly on).
export async function readUpdateProgressMarker(
  environment: Environment,
): Promise<HostUpdateProgress | null> {
  return readMarkerFile(hostUpdateProgressMarkerPath(environment), environment);
}

async function readMarkerFile(
  path: string,
  environment: Environment,
): Promise<HostUpdateProgress | null> {
  const logger = createCliLogger(environment);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Host update progress marker JSON parse failed", {
      environment,
      errorName: errorFromUnknown(err).name,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    (obj.state !== "updating" && obj.state !== "failed") ||
    (obj.error !== null && typeof obj.error !== "string") ||
    typeof obj.targetVersion !== "string" ||
    typeof obj.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    state: obj.state,
    error: obj.error === null ? null : obj.error,
    targetVersion: obj.targetVersion,
    updatedAt: obj.updatedAt,
  };
}
