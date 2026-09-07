import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, open, rm, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errnoCode } from "./errno-code";
import { SqliteRowBudgetError } from "./sqlite-columns";

/**
 * Never the live file: the browser holds it open, often with an uncheckpointed WAL, and on Windows with a share mode that refuses a second opener.
 * Three files copied one after another are one snapshot only if the browser held still in between: a checkpoint after the main file was copied resets the live WAL before its turn.
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
      database = new DatabaseSync(snapshotPath);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    try {
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

/** Called before a new snapshot is taken, so a crash on Windows - where the copy cannot be unlinked while open - leaks a plaintext jar only until the next import. */
export async function sweepSqliteSnapshots(
  snapshotRoot: string,
): Promise<void> {
  await rm(snapshotRoot, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/** One file copy of at most `maxBytes` - it may read ONE byte past that, and answers with the bytes it copied, so a caller learns the source ran over from the answer rather than from. */
export type SqliteFileCopy = (
  from: string,
  to: string,
  maxBytes: number,
) => Promise<number>;

export async function copySqliteFileBounded(
  from: string,
  to: string,
  maxBytes: number,
): Promise<number> {
  const handle = await open(from, constants.O_RDONLY | constants.O_NONBLOCK);
  let source: ReadStream;
  try {
    if (!(await handle.stat()).isFile()) {
      throw new SqliteNotRegularFileError();
    }
    // `end` is inclusive: the stream reads bytes 0..maxBytes, one past the
    // budget, and stops there whatever the file's length. The stream owns
    // the handle from here and closes it when it ends.
    source = handle.createReadStream({ end: maxBytes, autoClose: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await pipeline(source, createWriteStream(to, { mode: 0o600 }));
  return source.bytesRead;
}

export class SqliteNotRegularFileError extends Error {
  constructor() {
    super("sqlite snapshot source is not a regular file");
    this.name = "SqliteNotRegularFileError";
  }
}

/** What one attempt may still copy; shared by the main file and its siblings. */
interface CopyBudget {
  remaining: number;
}

export const SQLITE_SNAPSHOT_COPY_ATTEMPTS = 3;

const SQLITE_SIBLING_SUFFIXES = ["", "-wal", "-shm"] as const;

export async function copySqliteFiles(
  sourcePath: string,
  snapshotPath: string,
  platform: NodeJS.Platform,
  copy: SqliteFileCopy,
): Promise<SqliteSnapshotFailure | null> {
  for (let attempt = 0; attempt < SQLITE_SNAPSHOT_COPY_ATTEMPTS; attempt += 1) {
    // A main file that cannot be stat'ed is left to the copy to classify (`missing`, `permission`); a sibling that cannot be counts as absent.
    if ((await sourceBytes(sourcePath)) > MAX_SQLITE_SNAPSHOT_BYTES) {
      return "too-large";
    }
    const before = await sourceSignature(sourcePath);
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
  // A missing WAL or shm is the common case: the browser checkpointed and removed them, or never wrote them.
  // The copy of a sibling that is missing NOW is unlinked, so a retry after a checkpoint cannot pair this attempt's main file with the previous attempt's frames.
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
  // A FIFO, a device or a directory where a database file should be: not a
  // database this reader can read, and said with the closed reason the
  // caller already has for that.
  if (error instanceof SqliteNotRegularFileError) return "unreadable";
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
