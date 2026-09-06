import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import { isProcessAlive } from "../store/cli-lock";
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
  /**
   * Identity of the process that wrote the record - what lets a conditional
   * clear or replace tell "the marker I wrote" from an identical-looking one
   * another updater wrote in the same millisecond. Additive: the host daemon
   * reads `state` and `error` only, and a marker written by an older CLI
   * reads back as `null`.
   */
  readonly writerId: string | null;
}

// One identity per process. Two `host update` invocations racing for the
// same target can write byte-identical `state`/`targetVersion`/`updatedAt`
// (millisecond clock), and content alone would then let the first to finish
// clear or fail-stamp the second's live marker - which the second could
// never clear, because the stamp no longer matches what IT wrote.
const PROGRESS_WRITER_ID = `${process.pid}-${randomBytes(6).toString("hex")}`;

/** A marker record stamped with the current time and this process's identity. */
export function progressRecord(fields: {
  readonly state: HostUpdateProgressState;
  readonly error: string | null;
  readonly targetVersion: string;
}): HostUpdateProgress {
  return {
    state: fields.state,
    error: fields.error,
    targetVersion: fields.targetVersion,
    updatedAt: new Date().toISOString(),
    writerId: PROGRESS_WRITER_ID,
  };
}

/**
 * The one UNCONDITIONAL write in this module: `rename` over whatever the
 * live path holds. No production path calls it any more - `host update`'s
 * pre-lock publish goes through `claimUpdateProgressMarkerBeforeLock` and
 * everything after it through the conditional primitives - and none should:
 * a blind write here is exactly what lets one updater bury another's live
 * marker. Kept for test fixtures that need to seed a marker file.
 */
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

// `failed` is an I/O failure after which the live path still holds what it
// held (the expected record is restored when a stamp cannot land; the one
// exception - neither the stamp nor the restore could land - is warned
// about by name). Callers never retry it - only `changed` (a record that
// moved) is worth a re-read.
export type ConditionalMarkerDelete =
  | "cleared"
  | "changed"
  | "absent"
  | "failed";
export type ConditionalMarkerReplace = "replaced" | "changed" | "failed";

/**
 * Identity of two marker records: every field, `writerId` included. Content
 * alone is not identity - two updaters racing for the same target can write
 * the same `state`, `targetVersion` and millisecond `updatedAt` - so the
 * writer's identity is what tells "mine" from "an identical one of theirs".
 * Two `null` writer ids (markers from an older CLI) compare equal on content,
 * which is the best that record can offer.
 */
export function sameProgress(
  a: HostUpdateProgress,
  b: HostUpdateProgress,
): boolean {
  return (
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error &&
    a.writerId === b.writerId
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
 * the host is current"), WROTE, or TOOK OVER under the contender lock (this
 * invocation's own `updating`, by the time the update finished). Another
 * updater can replace that marker with a
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
 * compare-and-swap behind `host update`'s failure stamp, its re-point and
 * takeover under the contender lock, and the restore of a taken-over record
 * when the run then does nothing.
 *
 * `host update` stamps `failed` over the `updating` IT wrote or took over,
 * and by then another updater may have landed its own `updating` at the
 * same path (its write precedes its lock wait, so holding the lock proves
 * nothing about the marker). Stamping over that would report the old failure
 * for the whole of the new update. A read-then-write pair only narrows that
 * window; this closes it with the same rename/link protocol the conditional
 * delete uses.
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
  if (outcome === "swapped") return "replaced";
  if (outcome === "failed") return "failed";
  return "changed";
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
 *
 * Leftovers are bounded and inert: a process killed mid-swap leaves at most
 * one `.reconcile-*` (and a stamp at most one `.tmp-*`) beside the marker,
 * and nothing reads those paths - the host daemon and this module read the
 * live path only. They are deliberately NOT swept here: a sweep keyed on age
 * or pid would be one more concurrent actor in a directory whose whole
 * difficulty is concurrent actors, for a few hundred bytes per crash.
 */
async function dropMarkerFile(
  environment: Environment,
  path: string,
  step: string,
): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (err) {
    createCliLogger(environment).warn(
      "Host update progress marker scratch cleanup failed",
      {
        environment,
        step,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      },
    );
  }
}

// `link(from → target)` lands `from` at the live path only if that path is
// empty; EEXIST means a newer marker is there and wins. A filesystem that
// refuses hard links falls back to an exclusive create (`wx`) of the same
// bytes - still create-if-absent, so a marker landed in between still wins
// with EEXIST. A plain rename is never the fallback: it would overwrite
// that marker and reopen exactly the race the conditional operations exist
// to close. The cost of the `wx` path is a non-atomic content write - a
// reader polling in that instant may see a partial file, which it parses as
// "no marker" for one poll. `landed` means `from` is now the live marker;
// `exists` means a marker was already there and won; `failed` means neither
// route could land it - two answers callers act on differently (a race is
// re-read, an I/O failure is not retried), so they are never collapsed.
type MarkerLanding = "landed" | "exists" | "failed";

async function landMarkerAtomically(
  environment: Environment,
  target: string,
  from: string,
  step: string,
): Promise<MarkerLanding> {
  try {
    await link(from, target);
    await dropMarkerFile(environment, from, `${step}-unlink-source`);
    return "landed";
  } catch (err) {
    if (errnoCode(err) === "EEXIST") {
      await dropMarkerFile(environment, from, `${step}-newer-exists`);
      return "exists";
    }
    try {
      const bytes = await readFile(from);
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      await dropMarkerFile(environment, from, `${step}-unlink-source`);
      return "landed";
    } catch (createErr) {
      if (errnoCode(createErr) === "EEXIST") {
        await dropMarkerFile(environment, from, `${step}-newer-exists`);
        return "exists";
      }
      // Neither route could land `from` (no hard links AND the create
      // failed - ENOSPC, EIO). `from` may be the only complete copy of
      // another updater's live marker, taken out of the live path in a
      // swap's step 1; deleting it here would erase that marker while
      // reporting `changed`. It is RETAINED and named in the log so an
      // operator can find it. For a stamp or a create the leftover is this
      // run's own staged record - harmless garbage next to the marker.
      createCliLogger(environment).warn(
        "Host update progress marker conditional swap failed - displaced file retained",
        {
          environment,
          step,
          retainedPath: from,
          errorName: errorFromUnknown(createErr).name,
          errorMessage: errorFromUnknown(createErr).message,
        },
      );
      return "failed";
    }
  }
}

// `writerId` is `<pid>-<hex>`; the pid half is what a reader on the same
// machine can check for liveness. The host daemon applies the same rule
// (`isStaleUpdateProgress`) when it decides whether an `updating` marker
// still describes a live update.
const WRITER_ID_PID = /^(\d+)-[0-9a-f]+$/;

/**
 * Whether the record's writer is a process that may still be acting on it.
 * Fail-open: a record with no writer id (an older CLI) or an unparseable
 * one is treated as live, the same reading the host daemon takes - a marker
 * that cannot be proven abandoned is not this reader's to replace.
 */
function progressWriterMayBeLive(record: HostUpdateProgress): boolean {
  if (record.writerId === null) return true;
  const match = WRITER_ID_PID.exec(record.writerId);
  if (match === null) return true;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return isProcessAlive(pid);
}

/**
 * The pre-lock publish: claim the live path for `next` WITHOUT overwriting
 * an update that may be in progress.
 *
 * `host update` publishes its `updating` before it waits for the contender
 * lock, so the transfer is visible remotely from its first byte. That write
 * used to be the one unconditional write on the path, and it could land over
 * the marker of the updater currently HOLDING the lock - mid-swap, mid-
 * restart - after which that updater's stamp and clear (CAS against its own
 * record) could never land, and this run's `failed` on a lost download
 * would stand over a live mutation as a terminal outcome. The rule is the
 * same one the lock-holder applies under the lock: nothing is overwritten
 * blind.
 *
 * - `published`: the path was empty and `next` is now there;
 * - `replaced-stale`: the path held a record no writer is acting on - a
 *   `failed` (its writer stamped and exited) or an `updating` whose writer
 *   process is gone - and `next` replaced it by compare-and-swap;
 * - `deferred`: the path holds another writer's live `updating`. Nothing
 *   was written; the caller runs without a marker of its own until it
 *   takes the marker over under the lock. Also the answer when concurrent
 *   writers kept winning the bounded retry - someone live is writing;
 * - `failed`: an I/O failure that landed nothing, reported by log.
 *
 * `displaced` is the record a `replaced-stale` claim replaced, returned so
 * the caller can put it back if it then does no disruptive work (a busy
 * park, a failure before the host is touched): a `failed` that was still
 * exactly true is not this run's to remove. Null for every other outcome.
 *
 * The liveness check is synchronous (`isProcessAlive`; on Windows a
 * `tasklist` spawn with a bounded timeout) and runs once per record read,
 * at most three times per claim. Never throws.
 */
export interface UpdateProgressMarkerClaim {
  readonly outcome: "published" | "replaced-stale" | "deferred" | "failed";
  readonly displaced: HostUpdateProgress | null;
}

export async function claimUpdateProgressMarkerBeforeLock(
  environment: Environment,
  next: HostUpdateProgress,
): Promise<UpdateProgressMarkerClaim> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const onDisk = await readUpdateProgressMarker(environment);
    if (onDisk === null) {
      const created = await createUpdateProgressMarkerIfAbsent(
        environment,
        next,
      );
      if (created === "created")
        return { outcome: "published", displaced: null };
      if (created === "failed") return { outcome: "failed", displaced: null };
      continue;
    }
    if (onDisk.state !== "failed" && progressWriterMayBeLive(onDisk)) {
      return { outcome: "deferred", displaced: null };
    }
    const replaced = await replaceUpdateProgressMarkerIfUnchanged(
      environment,
      onDisk,
      next,
    );
    if (replaced === "failed") return { outcome: "failed", displaced: null };
    if (replaced === "replaced") {
      createCliLogger(environment).info(
        "Host update progress marker replaced a record no writer is acting on",
        {
          environment,
          previousState: onDisk.state,
          previousTarget: onDisk.targetVersion,
          targetVersion: next.targetVersion,
        },
      );
      return { outcome: "replaced-stale", displaced: onDisk };
    }
  }
  return { outcome: "deferred", displaced: null };
}

/**
 * Create-if-absent: land `next` at the live path ONLY if no marker stands
 * there, through the same `link` / `wx` landing the conditional swap uses.
 * `"exists"` means a marker was there - possibly one that landed between the
 * caller's read and this call, which is exactly the write this exists to
 * refuse: a read-then-`rename` would have overwritten it. Never throws;
 * `"failed"` is an I/O failure that landed nothing, reported by log.
 */
export async function createUpdateProgressMarkerIfAbsent(
  environment: Environment,
  next: HostUpdateProgress,
): Promise<"created" | "exists" | "failed"> {
  const logger = createCliLogger(environment);
  try {
    await ensureHostHomeDir(environment);
    const target = hostUpdateProgressMarkerPath(environment);
    const staged = await stageMarkerFile(target, next);
    const landing = await landMarkerAtomically(
      environment,
      target,
      staged,
      "create",
    );
    if (landing !== "landed") return landing;
    logger.info("Host update progress marker created (conditional)", {
      environment,
      state: next.state,
      targetVersion: next.targetVersion,
      hasError: next.error !== null,
    });
    return "created";
  } catch (err) {
    logger.warn("Host update progress marker conditional create failed", {
      environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return "failed";
  }
}

async function swapMarkerIfUnchanged(
  environment: Environment,
  expected: HostUpdateProgress,
  next: HostUpdateProgress | null,
): Promise<"swapped" | "changed" | "absent" | "failed"> {
  const logger = createCliLogger(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const scratch = `${target}.reconcile-${process.pid}-${Date.now()}`;
  const dropFile = (path: string, step: string): Promise<void> =>
    dropMarkerFile(environment, path, step);
  const landAtomically = (from: string, step: string): Promise<MarkerLanding> =>
    landMarkerAtomically(environment, target, from, step);
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
    // Everything that can THROW happens before the live record is taken:
    // once `target` is in the scratch, a throw would leave the live path
    // empty under a `failed` that promises the opposite. From the take on,
    // every call below reports through its return value (the landing and
    // drop helpers catch internally).
    let staged: string | null = null;
    if (next !== null) {
      await ensureHostHomeDir(environment);
      staged = await stageMarkerFile(target, next);
    }
    const dropStaged = (): Promise<void> =>
      staged === null ? Promise.resolve() : dropFile(staged, "stamp-unused");
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
        await dropStaged();
        return "failed";
      }
      absent = true;
    }
    if (!absent) {
      const current = await readMarkerFile(scratch, environment);
      if (current === null || !sameProgress(current, expected)) {
        // Not ours: give it back unless a newer marker has since landed.
        await landAtomically(scratch, "restore");
        await dropStaged();
        return changed(current?.state ?? null);
      }
    }
    if (next === null) {
      if (absent) return "absent";
      await dropFile(scratch, "expected");
      logger.info("Host update progress marker cleared (conditional)", {
        environment,
        state: expected.state,
      });
      return "swapped";
    }
    if (absent || staged === null) {
      // An empty live path is NOT proof that nobody else is in flight: another
      // conditional swap may hold the current marker in its scratch at this
      // instant (its step 1), and a stamp landed here now would win its
      // restore's `link` with EEXIST - our stale failure standing over the
      // live marker it then drops. Absence is a changed marker as far as a
      // replace is concerned; the failure is still reported by exit code and
      // log, and the only marker it can lose is one that was already gone.
      // (`staged === null` cannot co-occur with `next !== null`; it is the
      // narrowing the type needs.)
      await dropStaged();
      return changed(null);
    }
    // The expected record is still held in the scratch while `next` lands,
    // so a landing that FAILS can put it back: `failed` then means "nothing
    // on the live path changed", which is what lets a caller keep trusting
    // the record it holds. It is dropped only once `next` is the live
    // marker. A landing that finds a marker already there (another writer's
    // create-if-absent, in the instant the path was empty) is a changed
    // marker: the restore is attempted for symmetry and loses to it.
    const landing = await landAtomically(staged, "stamp");
    if (landing !== "landed") {
      const restored = await landAtomically(scratch, "restore");
      if (landing === "exists") return changed(null);
      if (restored === "exists") return changed(null);
      if (restored === "failed") {
        logger.warn(
          "Host update progress marker conditional swap failed and could not restore the expected record - the live path is empty",
          { environment, step: "stamp-restore" },
        );
      }
      return "failed";
    }
    await dropFile(scratch, "expected");
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
    return "failed";
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
    // Absent on markers written before the field existed; carried through so
    // a conditional swap compares what was actually written.
    writerId: typeof obj.writerId === "string" ? obj.writerId : null,
  };
}
