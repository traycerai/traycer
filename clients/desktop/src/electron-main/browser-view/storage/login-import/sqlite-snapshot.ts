import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errnoCode } from "./errno-code";
import { SqliteRowBudgetError } from "./sqlite-columns";

/**
 * Reads a browser's SQLite cookie database through a private copy.
 *
 * Never the live file: the browser holds it open, often with an uncheckpointed
 * WAL, and on Windows with a share mode that refuses a second opener. The main
 * file and its `-wal` / `-shm` siblings are copied together so the copy sees
 * the same rows the browser does, including the ones only the WAL holds yet.
 *
 * Three files copied one after another are one snapshot only if the browser
 * held still in between: a checkpoint after the main file was copied resets
 * the live WAL before its turn, and the copy then pairs a pre-checkpoint main
 * file with post-checkpoint frames - or none - and silently lacks the newest
 * rows. SQLite's own backup API would need the live file opened, which the
 * browsers' exclusive locking refuses; so the copy is taken with the source's
 * size and mtime read before and after, retried while they moved, and given
 * up as `locked` when they never stopped - the answer that tells the user to
 * quit the browser, which is what a jar being written that continuously
 * needs.
 *
 * The copy lives under the app's own `0700` directory, never the system temp
 * dir - a Firefox jar is plaintext, so for the length of the read this copy IS
 * the user's logins on disk. On POSIX the files are unlinked the moment the
 * first read has opened them, so they exist only as descriptors and a crash
 * mid-read leaves nothing behind; Windows cannot unlink an open file, so there
 * the directory is removed after close and swept by the next call.
 *
 * BOUNDED before it is copied and before it is read. A browser's cookie
 * database is megabytes - every browser caps its jar at a few thousand
 * cookies - but the path is a file on the user's disk, and a corrupt or
 * runaway one (a WAL that never checkpointed) could be gigabytes: copied
 * whole it would fill the disk, and materialised whole (`.all()`, in main)
 * it would take the process with it. So the main file and its WAL together
 * must be under {@link MAX_SQLITE_SNAPSHOT_BYTES} at every copy attempt, and
 * the reader refuses a table past {@link SqliteRowBudgetError}'s budget
 * before it selects a row; either answers `too-large`.
 */

/**
 * The most bytes of cookie database - the main file plus its WAL - one
 * snapshot copies. A real jar is single-digit megabytes (Chromium keeps at
 * most a few thousand cookies, Firefox likewise); the headroom is for a
 * database whose free pages or WAL have grown, never for one that holds
 * more logins than a browser can.
 */
export const MAX_SQLITE_SNAPSHOT_BYTES = 256 * 1024 * 1024;

export type SqliteSnapshotFailure =
  | "missing"
  | "locked"
  | "permission"
  | "unreadable"
  | "too-large";

export type SqliteSnapshotResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SqliteSnapshotFailure };

export interface SqliteSnapshotOptions {
  readonly sourcePath: string;
  /** Created `0700` if missing; every snapshot gets its own subdirectory. */
  readonly snapshotRoot: string;
  readonly platform: NodeJS.Platform;
}

const SNAPSHOT_FILE_NAME = "cookies.sqlite";

export async function withSqliteSnapshot<T>(
  options: SqliteSnapshotOptions,
  read: (database: DatabaseSync) => T,
): Promise<SqliteSnapshotResult<T>> {
  const directory = join(options.snapshotRoot, randomUUID());
  const snapshotPath = join(directory, SNAPSHOT_FILE_NAME);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const copied = await copySqliteFiles(
      options.sourcePath,
      snapshotPath,
      options.platform,
      copySqliteFileBounded,
    );
    if (copied !== null) return { ok: false, reason: copied };
    let database: DatabaseSync;
    try {
      // Read-write on purpose, although only SELECTs follow: the copy is
      // private, and a read-only handle on a WAL-mode file has its own rules
      // (it needs the shm to exist or the directory to be writable) that a
      // normal open simply does not have.
      database = new DatabaseSync(snapshotPath);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    try {
      // A read that touches a page - `SELECT 1` touches none - is what makes
      // the pager take its shared lock, notice the `-wal` beside the file and
      // open it, and map the shm. From then on the connection holds both by
      // descriptor, so unlinking the names afterwards costs no WAL row; the
      // chromium/firefox suites read an uncheckpointed row through this path.
      database.prepare("SELECT count(*) FROM sqlite_master").get();
      if (options.platform !== "win32") {
        await unlinkQuietly(snapshotPath);
        await unlinkQuietly(`${snapshotPath}-wal`);
        await unlinkQuietly(`${snapshotPath}-shm`);
      }
      return { ok: true, value: read(database) };
    } catch (error) {
      // The reader's own refusal of a table past its row budget, told apart
      // from a database it could not read at all.
      if (error instanceof SqliteRowBudgetError) {
        return { ok: false, reason: "too-large" };
      }
      return { ok: false, reason: "unreadable" };
    } finally {
      database.close();
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Removes every snapshot a previous run may have left behind. Called before a
 * new snapshot is taken, so a crash on Windows - where the copy cannot be
 * unlinked while open - leaks a plaintext jar only until the next import.
 */
export async function sweepSqliteSnapshots(
  snapshotRoot: string,
): Promise<void> {
  await rm(snapshotRoot, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/**
 * One file copy of at most `maxBytes` - it may read ONE byte past that, and
 * answers with the bytes it copied, so a caller learns the source ran over
 * from the answer rather than from a copy it had to finish first. Throws the
 * file system's own error for a source that is missing or refused.
 * {@link copySqliteFileBounded} in production; a hooked one in the suite.
 */
export type SqliteFileCopy = (
  from: string,
  to: string,
  maxBytes: number,
) => Promise<number>;

/**
 * A streamed copy rather than `copyFile`: the pre-copy size check reads the
 * source at one instant, and a source still being written can grow between
 * that instant and the copy. `copyFile` would follow it to wherever it ends
 * up; a read stream with `end` set asks the kernel for at most `maxBytes + 1`
 * bytes however far the file has grown, so the snapshot on disk can never be
 * larger than the budget plus one byte, and that one byte is the signal.
 */
export async function copySqliteFileBounded(
  from: string,
  to: string,
  maxBytes: number,
): Promise<number> {
  // `end` is inclusive: the stream reads bytes 0..maxBytes, one past the
  // budget, and stops there whatever the file's length.
  const source = createReadStream(from, { end: maxBytes });
  await pipeline(source, createWriteStream(to, { mode: 0o600 }));
  return source.bytesRead;
}

/** What one attempt may still copy; shared by the main file and its siblings. */
interface CopyBudget {
  remaining: number;
}

/**
 * How many times the three-file copy is taken before a source that moved
 * under every one of them is reported as `locked`. Each copy is a few
 * milliseconds; a jar written more often than that is being written
 * continuously.
 */
export const SQLITE_SNAPSHOT_COPY_ATTEMPTS = 3;

const SQLITE_SIBLING_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Copies the database and its `-wal` / `-shm` siblings, and accepts the copy
 * only when the source's size and mtime read the same before and after all
 * three - the signal that no checkpoint or write landed between them.
 * Exported for the suite, which hooks `copy` to move the source mid-copy.
 */
export async function copySqliteFiles(
  sourcePath: string,
  snapshotPath: string,
  platform: NodeJS.Platform,
  copy: SqliteFileCopy,
): Promise<SqliteSnapshotFailure | null> {
  for (let attempt = 0; attempt < SQLITE_SNAPSHOT_COPY_ATTEMPTS; attempt += 1) {
    // Refused by size BEFORE a byte is copied, and on every attempt, since a
    // source that grew past the bound between two is the retry's to catch.
    // A main file that cannot be stat'ed is left to the copy to classify
    // (`missing`, `permission`); a sibling that cannot be counts as absent.
    if ((await sourceBytes(sourcePath)) > MAX_SQLITE_SNAPSHOT_BYTES) {
      return "too-large";
    }
    const before = await sourceSignature(sourcePath);
    // And DURING the copy, under one budget for the three files: the check
    // above read the sizes at an instant, and a source written between that
    // instant and its copy is copied only up to what the budget has left.
    // Per attempt, since a retry starts a fresh snapshot.
    const failure = await copySqliteFilesOnce(
      sourcePath,
      snapshotPath,
      platform,
      copy,
      { remaining: MAX_SQLITE_SNAPSHOT_BYTES },
    );
    if (failure !== null) return failure;
    if ((await sourceSignature(sourcePath)) === before) return null;
  }
  return "locked";
}

async function copySqliteFilesOnce(
  sourcePath: string,
  snapshotPath: string,
  platform: NodeJS.Platform,
  copy: SqliteFileCopy,
  budget: CopyBudget,
): Promise<SqliteSnapshotFailure | null> {
  const main = await copyOne(sourcePath, snapshotPath, platform, copy, budget);
  if (main !== null) return main;
  // A missing WAL or shm is the common case: the browser checkpointed and
  // removed them, or never wrote them. Only the main file is required. The
  // copy of a sibling that is missing NOW is unlinked, so a retry after a
  // checkpoint cannot pair this attempt's main file with the previous
  // attempt's frames.
  for (const suffix of SQLITE_SIBLING_SUFFIXES.slice(1)) {
    const sibling = await copyOne(
      `${sourcePath}${suffix}`,
      `${snapshotPath}${suffix}`,
      platform,
      copy,
      budget,
    );
    if (sibling === "missing") await unlinkQuietly(`${snapshotPath}${suffix}`);
    else if (sibling !== null) return sibling;
  }
  return null;
}

/**
 * Size and mtime of the main file and both siblings, as one string. A
 * sibling that is not there is part of the signature too: a WAL that
 * appeared or was removed mid-copy is exactly a checkpoint.
 */
async function sourceSignature(sourcePath: string): Promise<string> {
  const parts: string[] = [];
  for (const suffix of SQLITE_SIBLING_SUFFIXES) {
    try {
      const info = await stat(`${sourcePath}${suffix}`);
      parts.push(`${info.size}:${info.mtimeMs}`);
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("|");
}

/**
 * The bytes a copy would take: the main file plus its WAL. The shm is a
 * fixed-size index and is left out; a file that is not there weighs nothing.
 */
async function sourceBytes(sourcePath: string): Promise<number> {
  let total = 0;
  for (const suffix of ["", "-wal"] as const) {
    try {
      total += (await stat(`${sourcePath}${suffix}`)).size;
    } catch {
      // Absent, or unreadable: the copy answers for it either way.
    }
  }
  return total;
}

async function copyOne(
  from: string,
  to: string,
  platform: NodeJS.Platform,
  copy: SqliteFileCopy,
  budget: CopyBudget,
): Promise<SqliteSnapshotFailure | null> {
  let copied: number;
  try {
    copied = await copy(from, to, budget.remaining);
  } catch (error) {
    return classifyCopyFailure(error, platform);
  }
  // One byte past what was left is the copy reporting the source ran over
  // the bound; the partial file it wrote goes with the snapshot directory,
  // which the caller removes whatever the outcome.
  if (copied > budget.remaining) return "too-large";
  budget.remaining -= copied;
  return null;
}

export function classifyCopyFailure(
  error: unknown,
  platform: NodeJS.Platform,
): SqliteSnapshotFailure {
  const code = errnoCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  // Windows reports a file another process holds with a denying share mode
  // as EBUSY or EPERM; the same codes on POSIX are a permissions problem.
  if (code === "EBUSY") return "locked";
  if (code === "EPERM") return platform === "win32" ? "locked" : "permission";
  if (code === "EACCES") return "permission";
  return "unreadable";
}

async function unlinkQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
