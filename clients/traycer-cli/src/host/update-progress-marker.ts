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
  const tmp = await stageMarkerFile(target, progress);
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
export type ConditionalMarkerReplace = "replaced" | "changed";

/**
 * Field-wise identity of two marker records. A marker carries no writer id -
 * its shape is shared by contract with the host daemon's reader - so "the
 * marker I wrote" is decided by content, and `updatedAt` (millisecond ISO
 * time) is what tells two writers apart. Two updaters that land an identical
 * `updating` for the same target within the same millisecond are therefore
 * indistinguishable here, and either may clear the other's; the two records
 * say the same thing about the same update, so the survivor is correct.
 */
export function sameProgress(
  a: HostUpdateProgress,
  b: HostUpdateProgress,
): boolean {
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
 * Write `progress` to a private sibling of `target` and return its path. The
 * name is unique per writer: a shared `${target}.tmp` let two concurrent
 * writers overwrite each other's staging file, so one renamed the OTHER's
 * bytes into place and the other's rename failed on a file that had moved.
 */
async function stageMarkerFile(
  target: string,
  progress: HostUpdateProgress,
): Promise<string> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(progress, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmp;
}

/**
 * Delete the marker only if it still reads as `expected` - a compare-and-
 * delete that cannot erase a marker another writer landed in between.
 *
 * For a clear that decided from a marker it READ ("this `failed` is stale,
 * the host is current") or WROTE (this invocation's own `updating`, by the
 * time the update finished). Another updater can replace that marker with a
 * live `updating` at any point, and deleting that would erase the only
 * progress signal the legacy path has, rendering a real download → swap →
 * restart as a quiet host. A read-then-unlink pair leaves exactly that window
 * open, and a lock does not close it because the `updating` write precedes
 * its writer's lock acquisition. See `swapMarkerIfUnchanged` for how the
 * window is closed. Never throws (same rule as the other marker I/O).
 */
export async function deleteUpdateProgressMarkerIfUnchanged(
  environment: Environment,
  expected: HostUpdateProgress,
): Promise<ConditionalMarkerDelete> {
  const outcome = await swapMarkerIfUnchanged(environment, expected, null);
  return outcome === "swapped" ? "cleared" : outcome;
}

/**
 * Replace the marker with `next` only if it still reads as `expected` - the
 * failure stamp's compare-and-swap.
 *
 * `host update` stamps `failed` over the `updating` IT wrote, and by then
 * another updater may have landed its own `updating` at the same path (its
 * write precedes its lock wait, so holding the lock proves nothing about the
 * marker). Stamping over that would report the old failure for the whole of
 * the new update. A read-then-write pair only narrows that window; this
 * closes it with the same rename/link protocol the conditional delete uses.
 *
 * An ABSENT marker is `changed`, not a free slot: the live path is also empty
 * for the instant another conditional swap holds the current marker in its
 * scratch, and a stamp landed then would beat that swap's restore and stand
 * over the live marker it drops. The stamp therefore lands only over the
 * exact record it expected. Never throws.
 */
export async function replaceUpdateProgressMarkerIfUnchanged(
  environment: Environment,
  expected: HostUpdateProgress,
  next: HostUpdateProgress,
): Promise<ConditionalMarkerReplace> {
  const outcome = await swapMarkerIfUnchanged(environment, expected, next);
  return outcome === "changed" ? "changed" : "replaced";
}

/**
 * The compare-and-swap both conditional operations are built on, from the
 * atomic operations the filesystem does offer (writers only ever
 * `rename(tmp → marker)`, and this module is every writer):
 *
 * 1. `rename(marker → scratch)` takes the CURRENT marker out of the live path
 *    atomically. From here on nothing a writer does can touch what we hold,
 *    and anything it lands is a NEWER marker at the live path.
 * 2. Inspect the scratch. If it is NOT what we expected, it is a live marker a
 *    writer landed between the caller's read and step 1, and it goes back:
 *    `link(scratch → marker)` restores it atomically and fails with EEXIST if
 *    an even newer marker has landed since - in which case the newer one
 *    stands (last write wins, exactly as it does between two writers).
 * 3. If it IS what we expected, drop the scratch and, for a replace, land
 *    `next` the same way - `link(staged → marker)`, so a marker that arrived
 *    in the meantime wins over the stamp instead of being overwritten by it.
 *
 * The one observable cost is a window between steps 1 and 3 in which the live
 * path is momentarily empty; a reader polling in that instant sees "no
 * marker" for one poll. That is strictly better than the failure modes it
 * replaces, where a live marker was erased or overwritten for the rest of its
 * update. Every step is guarded: `rm` with `force` still rejects on EACCES /
 * EPERM / EBUSY, and this is advisory state that must never fail the update.
 * The outer catch is the contract; the inner ones choose the right outcome.
 */
async function swapMarkerIfUnchanged(
  environment: Environment,
  expected: HostUpdateProgress,
  next: HostUpdateProgress | null,
): Promise<"swapped" | "changed" | "absent"> {
  const logger = createCliLogger(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const scratch = `${target}.reconcile-${process.pid}-${Date.now()}`;
  const dropFile = async (path: string, step: string): Promise<void> => {
    try {
      await rm(path, { force: true });
    } catch (err) {
      logger.warn("Host update progress marker scratch cleanup failed", {
        environment,
        step,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    }
  };
  // `link(from → target)` lands `from` at the live path only if that path is
  // empty; EEXIST means a newer marker is there and wins. Any other failure
  // (a filesystem without hard links) falls back to a plain rename, accepting
  // that it could overwrite a marker landed in the last few microseconds.
  // Returns whether `from` is now the live marker.
  const landAtomically = async (
    from: string,
    step: string,
  ): Promise<boolean> => {
    try {
      await link(from, target);
      await dropFile(from, `${step}-unlink-source`);
      return true;
    } catch (err) {
      if (errnoCode(err) === "EEXIST") {
        await dropFile(from, `${step}-newer-exists`);
        return false;
      }
      try {
        await rename(from, target);
        return true;
      } catch (renameErr) {
        logger.warn("Host update progress marker conditional swap failed", {
          environment,
          step,
          errorName: errorFromUnknown(renameErr).name,
          errorMessage: errorFromUnknown(renameErr).message,
        });
        await dropFile(from, `${step}-rename-failed`);
        return false;
      }
    }
  };
  const changed = (currentState: HostUpdateProgressState | null): "changed" => {
    logger.info(
      "Host update progress marker changed under a conditional swap",
      {
        environment,
        expectedState: expected.state,
        currentState,
        operation: next === null ? "clear" : "replace",
      },
    );
    return "changed";
  };
  try {
    let absent = false;
    try {
      await rename(target, scratch);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        logger.warn("Host update progress marker conditional swap failed", {
          environment,
          step: "take",
          errorName: errorFromUnknown(err).name,
          errorMessage: errorFromUnknown(err).message,
        });
        return "changed";
      }
      absent = true;
    }
    if (!absent) {
      const current = await readMarkerFile(scratch, environment);
      if (current === null || !sameProgress(current, expected)) {
        // Not ours: give it back unless a newer marker has since landed.
        await landAtomically(scratch, "restore");
        return changed(current?.state ?? null);
      }
      await dropFile(scratch, "expected");
    }
    if (next === null) {
      if (absent) return "absent";
      logger.info("Host update progress marker cleared (conditional)", {
        environment,
        state: expected.state,
      });
      return "swapped";
    }
    if (absent) {
      // An empty live path is NOT proof that nobody else is in flight: another
      // conditional swap may hold the current marker in its scratch at this
      // instant (its step 1), and a stamp landed here now would win its
      // restore's `link` with EEXIST - our stale failure standing over the
      // live marker it then drops. Absence is a changed marker as far as a
      // replace is concerned; the failure is still reported by exit code and
      // log, and the only marker it can lose is one that was already gone.
      return changed(null);
    }
    await ensureHostHomeDir(environment);
    const staged = await stageMarkerFile(target, next);
    if (!(await landAtomically(staged, "stamp"))) {
      return changed(null);
    }
    logger.info("Host update progress marker replaced (conditional)", {
      environment,
      state: next.state,
      targetVersion: next.targetVersion,
      hasError: next.error !== null,
    });
    return "swapped";
  } catch (err) {
    // Belt for the braces above: no marker I/O may fail the update.
    logger.warn("Host update progress marker conditional swap failed", {
      environment,
      step: "unexpected",
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return "changed";
  }
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
