import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import { probeProcessLiveness } from "../store/process-identity";
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

// `failed` is an I/O failure after which nothing of `next` landed. The live
// path USUALLY still holds what it held (a record taken into the scratch is
// put back when the stamp cannot land); the exception - the take succeeded
// and neither route could land the restore - leaves the live path empty
// with the displaced bytes retained in a named `.reconcile-*` scratch and
// warned about by name, or, when the marker directory itself is gone,
// with nothing retained (warned about without a path). Callers never retry
// it - only `changed` (a record that moved) is worth a re-read.
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
 * A per-file suffix unique across processes (pid) AND within one process
 * (time plus random): two swaps in one millisecond of one command - a
 * failed restore retains its scratch, and the next swap must not rename
 * over it - get distinct names, the same way two concurrent stagers do.
 */
function markerScratchSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
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
  const tmp = `${target}.tmp-${markerScratchSuffix()}`;
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
  const outcome = await swapMarkerIfUnchanged(
    environment,
    { kind: "record", record: expected },
    null,
  );
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
  const outcome = await swapMarkerIfUnchanged(
    environment,
    { kind: "record", record: expected },
    next,
  );
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
// `failed-nothing-retained`: the file to land was gone (or its directory
// was), so no scratch survives for a caller to name.
type MarkerLanding = "landed" | "exists" | "failed" | "failed-nothing-retained";

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
      if (errnoCode(createErr) === "ENOENT") {
        // `from` is gone (or the marker directory is) - nothing to retain,
        // so neither this warning nor the caller's may name a retained
        // path. Neither route landed anything; the distinct value is what
        // keeps the callers' "retained at <path>" lines honest.
        createCliLogger(environment).warn(
          "Host update progress marker conditional swap failed - the file to land is gone, nothing was retained",
          {
            environment,
            step,
            path: from,
            errorName: errorFromUnknown(createErr).name,
            errorMessage: errorFromUnknown(createErr).message,
          },
        );
        return "failed-nothing-retained";
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
 * What is known about the record's writer: `live` is positive evidence (a
 * parseable pid the OS reports alive), `dead` is positive evidence of the
 * opposite, and `unknown` is everything the probe cannot settle - no writer
 * id (an older CLI), an id in another shape, or a probe that failed
 * (`tasklist` missing on Windows). The two predicates below read this from
 * opposite sides: what cannot be proven abandoned is not replaced outside
 * the lock, and what cannot be proven live is not put back.
 */
function writerLiveness(
  record: HostUpdateProgress,
): "live" | "dead" | "unknown" {
  if (record.writerId === null) return "unknown";
  const match = WRITER_ID_PID.exec(record.writerId);
  if (match === null) return "unknown";
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  const verdict = probeProcessLiveness(pid);
  if (verdict === "alive") return "live";
  if (verdict === "dead") return "dead";
  return "unknown";
}

/**
 * Whether some writer MAY still be acting on the record: an `updating`
 * whose writer is not proven dead (fail-open, the same reading the host
 * daemon takes for a parseable id). A `failed` has no writer by
 * construction - its writer stamped it and exited - whatever its `writerId`
 * says. This is the predicate behind the pre-lock claim: it replaces a
 * record without a live writer and defers to one that may have. A record no
 * writer is acting on is replaced and gone, exactly as the blind publish
 * once treated it: putting it back would re-plant a dead writer's
 * `updating` that no one will ever clear, or an earlier attempt's `failed`
 * over the newer attempt's own outcome.
 */
export function updateProgressRecordHasLiveWriter(
  record: HostUpdateProgress,
): boolean {
  return record.state !== "failed" && writerLiveness(record) !== "dead";
}

/**
 * Whether a writer is PROVEN to be acting on the record: an `updating`
 * whose pid the OS reports alive. The takeover under the lock retains a
 * displaced record for the restore a busy park or a pre-disruption failure
 * performs only on this evidence. The fail-open reading is wrong there: a
 * record with no writer id is one the host daemon renders FOREVER (its
 * dead-writer suppression needs a pid to check), so restoring it re-plants
 * a marker no one will clear, and a record whose probe failed is one whose
 * writer, if any, re-asserts its own marker under the lock anyway.
 */
export function updateProgressRecordHasProvenLiveWriter(
  record: HostUpdateProgress,
): boolean {
  return record.state !== "failed" && writerLiveness(record) === "live";
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
 * - `replaced-stale`: the path held a record no writer is acting on
 *   (`updateProgressRecordHasLiveWriter` false - a `failed`, or an
 *   `updating` whose writer process is gone) and `next` replaced it by
 *   compare-and-swap. The replaced record is gone, not kept for a later
 *   restore: see `updateProgressRecordHasLiveWriter` for why putting it
 *   back would be worse than the blind publish it replaces;
 * - `deferred`: the path holds another writer's live `updating`. Nothing
 *   was written; the caller runs without a marker of its own until it
 *   takes the marker over under the lock. Also the answer when concurrent
 *   writers kept winning the bounded retry - someone live is writing - and
 *   for a file this CLI cannot read or does not recognise as a record
 *   (`MarkerRead`: a foreign shape, an unreadable file), which is left
 *   standing;
 * - `failed`: an I/O failure after which nothing of `next` landed. The
 *   record it was replacing may have been displaced into a retained
 *   scratch when neither restore route could land (`ConditionalMarker*`,
 *   warned about by name); the caller does not hold a record of its own
 *   either way.
 *
 * The liveness check is synchronous (`probeProcessLiveness`; on Windows a
 * `tasklist` spawn with a bounded timeout) and runs once per record read:
 * at most three times per claim call. Per `host update` that is at most
 * eight - the claim can run twice (a claim that deferred at
 * `onWillDownload` claims again before the work), the takeover under the
 * lock reads once (only on the iteration that replaces), and the restore a
 * park or a pre-disruption failure performs reads once. Never throws.
 */
export interface UpdateProgressMarkerClaim {
  readonly outcome: "published" | "replaced-stale" | "deferred" | "failed";
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
      if (created === "created") return { outcome: "published" };
      if (created === "failed") return { outcome: "failed" };
      continue;
    }
    if (updateProgressRecordHasLiveWriter(onDisk)) {
      return { outcome: "deferred" };
    }
    const replaced = await replaceUpdateProgressMarkerIfUnchanged(
      environment,
      onDisk,
      next,
    );
    if (replaced === "failed") return { outcome: "failed" };
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
      return { outcome: "replaced-stale" };
    }
  }
  return { outcome: "deferred" };
}

/**
 * Create-if-absent: land `next` at the live path ONLY if no marker stands
 * there, through the same `link` / `wx` landing the conditional swap uses.
 * `"exists"` means a RECORD was there - possibly one that landed between the
 * caller's read and this call, which is exactly the write this exists to
 * refuse: a read-then-`rename` would have overwritten it. Never throws;
 * `"failed"` is an I/O failure that landed nothing, reported by log.
 *
 * A file that is there but is not a record (see `MarkerRead`) is NOT
 * `exists`: the claim and the reassert answer `exists` by re-reading
 * (`markUpdateFailed` logs once and stops), and a re-read answers "no
 * marker", so the pair would loop and give up - with the
 * malformed file standing over every later update too. Such a file is
 * replaced through the conditional swap, keyed on its exact bytes, so a
 * record another writer lands in the meantime still wins. The residual is
 * the `wx` fallback's own non-atomic write: on a filesystem without hard
 * links, another updater's partial marker read in the instant of its write
 * looks malformed, and if its bytes have not moved by the swap's compare it
 * is replaced - one lost marker for that updater, in a window the size of
 * one small write, and only where `link` is unavailable.
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
    if (landing === "failed") return "failed";
    if (landing === "exists") {
      const standing = await readMarkerState(target, environment);
      if (standing.kind === "unrecognised") {
        logger.warn(
          "Host update progress marker has a shape this CLI does not read - leaving it in place",
          { environment },
        );
        return "exists";
      }
      if (standing.kind === "unreadable") {
        // Already warned about by the read, with the errno. Nothing can be
        // compared, so nothing is replaced: the caller re-reads, finds "no
        // marker" and its bounded loop gives up with its own warning.
        return "exists";
      }
      if (standing.kind !== "malformed") return "exists";
      logger.warn(
        "Host update progress marker is not a record - replacing the malformed file",
        { environment, length: standing.raw.length },
      );
      const swapped = await swapMarkerIfUnchanged(
        environment,
        { kind: "malformed", raw: standing.raw },
        next,
      );
      if (swapped === "failed") return "failed";
      // `changed` / `absent`: the file moved under us - a record landed, or
      // the malformed bytes changed. The caller re-reads, as for `exists`.
      if (swapped !== "swapped") return "exists";
      logger.info(
        "Host update progress marker created over a malformed file (conditional)",
        {
          environment,
          state: next.state,
          targetVersion: next.targetVersion,
        },
      );
      return "created";
    }
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

/**
 * What a conditional swap expects to find in its scratch: the exact record a
 * caller read, or the exact malformed bytes `createUpdateProgressMarkerIfAbsent`
 * found standing where a record should be.
 */
type SwapExpectation =
  | { readonly kind: "record"; readonly record: HostUpdateProgress }
  | { readonly kind: "malformed"; readonly raw: string };

async function swapMarkerIfUnchanged(
  environment: Environment,
  expected: SwapExpectation,
  next: HostUpdateProgress | null,
): Promise<"swapped" | "changed" | "absent" | "failed"> {
  const logger = createCliLogger(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const scratch = `${target}.reconcile-${markerScratchSuffix()}`;
  const dropFile = (path: string, step: string): Promise<void> =>
    dropMarkerFile(environment, path, step);
  const landAtomically = (from: string, step: string): Promise<MarkerLanding> =>
    landMarkerAtomically(environment, target, from, step);
  const changed = (currentState: HostUpdateProgressState | null): "changed" => {
    logger.info(
      "Host update progress marker changed under a conditional swap",
      {
        environment,
        expectedState:
          expected.kind === "record" ? expected.record.state : "malformed",
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
      const current = await readMarkerState(scratch, environment);
      // A malformed expectation matches the SAME bytes only: a file that
      // parses now, or malformed bytes that differ, is someone else's
      // marker (or their write completing) and goes back.
      const matches =
        expected.kind === "record"
          ? current.kind === "record" &&
            sameProgress(current.record, expected.record)
          : current.kind === "malformed" && current.raw === expected.raw;
      if (!matches) {
        // Not ours: give it back unless a newer marker has since landed. A
        // restore that lands, or loses to a newer marker, is a `changed`
        // marker the caller re-reads. One that neither route could land is
        // NOT: the live path is empty and the other writer's record sits
        // in the retained scratch, which no "another updater owns it now"
        // line may claim. That is `failed`, named here so the CLI's log
        // says where the bytes went.
        const restored = await landAtomically(scratch, "restore");
        await dropStaged();
        if (restored === "failed") {
          logger.warn(
            "Host update progress marker conditional swap could not restore the record it found - the live path is empty",
            { environment, step: "restore-other", retainedPath: scratch },
          );
          return "failed";
        }
        if (restored === "failed-nothing-retained") {
          logger.warn(
            "Host update progress marker conditional swap could not restore the record it found - the live path is empty and nothing was retained",
            { environment, step: "restore-other" },
          );
          return "failed";
        }
        return changed(current.kind === "record" ? current.record.state : null);
      }
    }
    if (next === null) {
      if (absent) return "absent";
      await dropFile(scratch, "expected");
      logger.info("Host update progress marker cleared (conditional)", {
        environment,
        state: expected.kind === "record" ? expected.record.state : "malformed",
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
    // of `next` landed", and when the restore lands too, "nothing on the
    // live path changed" - what lets a caller keep trusting the record it
    // holds. When the restore ALSO fails the live path is empty and the
    // record is retained in the scratch, warned about by name below. It is
    // dropped only once `next` is the live marker. A landing that finds a
    // marker already there (another writer's create-if-absent, in the
    // instant the path was empty) is a changed marker: the restore is
    // attempted for symmetry and loses to it.
    const landing = await landAtomically(staged, "stamp");
    if (landing !== "landed") {
      const restored = await landAtomically(scratch, "restore");
      if (landing === "exists") return changed(null);
      if (restored === "exists") return changed(null);
      if (restored === "failed") {
        logger.warn(
          "Host update progress marker conditional swap failed and could not restore the expected record - the live path is empty",
          { environment, step: "stamp-restore", retainedPath: scratch },
        );
      }
      if (restored === "failed-nothing-retained") {
        logger.warn(
          "Host update progress marker conditional swap failed and could not restore the expected record - the live path is empty and nothing was retained",
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

// Read-only accessor for Doctor / tests. Returns `null` when absent,
// unreadable, malformed or unrecognised (anything that is not a record is
// treated the same as "no marker" - it is advisory UI state, not an
// authoritative record worth failing loudly on). WRITERS do not collapse
// these: see `MarkerRead` and the malformed arm of
// `createUpdateProgressMarkerIfAbsent`.
export async function readUpdateProgressMarker(
  environment: Environment,
): Promise<HostUpdateProgress | null> {
  return readMarkerFile(hostUpdateProgressMarkerPath(environment), environment);
}

/**
 * What stands at a marker path, with "there is a file but it is not a
 * record" kept apart from "there is no file". Readers collapse the two (a
 * malformed marker is no marker as far as UI state goes), but a WRITER must
 * not: a create-if-absent lands only on an empty path, so a malformed file -
 * a crash between the `wx` fallback's open and its write, a truncated disk -
 * would answer every later create with `exists` while every read answered
 * "nothing there", and each update would run without its marker until
 * someone deleted the file by hand. `createUpdateProgressMarkerIfAbsent`
 * replaces such a file conditionally on its exact bytes.
 *
 * `malformed` is bytes that do not parse to a JSON object - what a crash
 * mid-write leaves (invalid JSON, or a scalar). `unrecognised` is a JSON
 * object (an array included) this CLI does not read as a record: another
 * writer's shape, most likely a NEWER CLI's marker with a state this one
 * predates. That is a foreign record, not garbage - its writer's liveness
 * cannot be honoured because its `writerId` cannot be trusted to mean what
 * ours does - so a writer treats it as `exists` and never replaces it: the
 * takeover under the lock loops on it and gives up too, exactly as
 * before. `unreadable` is a
 * file that is there but cannot be read (EACCES on a marker a `sudo` run
 * left root-owned, EISDIR): nothing can be compared, so nothing is
 * replaced, and it too is `exists` to a writer - warned about with its
 * errno by the read, then by the caller's bounded loop giving up.
 */
type MarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "malformed"; readonly raw: string }
  | { readonly kind: "unrecognised" }
  | { readonly kind: "record"; readonly record: HostUpdateProgress };

async function readMarkerState(
  path: string,
  environment: Environment,
): Promise<MarkerRead> {
  const logger = createCliLogger(environment);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // ENOENT is the ordinary answer. Anything else (EACCES, EISDIR) is a
    // file this module can neither read nor compare: `unreadable`, kept
    // apart from `absent` so a create-if-absent does not answer it with a
    // replacement, and named in the log with its errno.
    if (errnoCode(err) === "ENOENT") return { kind: "absent" };
    logger.warn("Host update progress marker could not be read", {
      environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Host update progress marker JSON parse failed", {
      environment,
      errorName: errorFromUnknown(err).name,
    });
    return { kind: "malformed", raw };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "malformed", raw };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    (obj.state !== "updating" && obj.state !== "failed") ||
    (obj.error !== null && typeof obj.error !== "string") ||
    typeof obj.targetVersion !== "string" ||
    typeof obj.updatedAt !== "string"
  ) {
    return { kind: "unrecognised" };
  }
  return {
    kind: "record",
    record: {
      state: obj.state,
      error: obj.error === null ? null : obj.error,
      targetVersion: obj.targetVersion,
      updatedAt: obj.updatedAt,
      // Absent on markers written before the field existed; carried through
      // so a conditional swap compares what was actually written.
      writerId: typeof obj.writerId === "string" ? obj.writerId : null,
    },
  };
}

async function readMarkerFile(
  path: string,
  environment: Environment,
): Promise<HostUpdateProgress | null> {
  const read = await readMarkerState(path, environment);
  return read.kind === "record" ? read.record : null;
}
