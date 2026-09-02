import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errnoCode } from "./errno-code";

/**
 * Reads a browser's SQLite cookie database through a private copy.
 *
 * Never the live file: the browser holds it open, often with an uncheckpointed
 * WAL, and on Windows with a share mode that refuses a second opener. The main
 * file and its `-wal` / `-shm` siblings are copied together so the copy sees
 * the same rows the browser does, including the ones only the WAL holds yet.
 *
 * The copy lives under the app's own `0700` directory, never the system temp
 * dir - a Firefox jar is plaintext, so for the length of the read this copy IS
 * the user's logins on disk. On POSIX the files are unlinked the moment the
 * first read has opened them, so they exist only as descriptors and a crash
 * mid-read leaves nothing behind; Windows cannot unlink an open file, so there
 * the directory is removed after close and swept by the next call.
 */

export type SqliteSnapshotFailure =
  | "missing"
  | "locked"
  | "permission"
  | "unreadable";

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
    } catch {
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

async function copySqliteFiles(
  sourcePath: string,
  snapshotPath: string,
  platform: NodeJS.Platform,
): Promise<SqliteSnapshotFailure | null> {
  const main = await copyOne(sourcePath, snapshotPath, platform);
  if (main !== null) return main;
  // A missing WAL or shm is the common case: the browser checkpointed and
  // removed them, or never wrote them. Only the main file is required.
  const wal = await copyOne(
    `${sourcePath}-wal`,
    `${snapshotPath}-wal`,
    platform,
  );
  if (wal !== null && wal !== "missing") return wal;
  const shm = await copyOne(
    `${sourcePath}-shm`,
    `${snapshotPath}-shm`,
    platform,
  );
  if (shm !== null && shm !== "missing") return shm;
  return null;
}

async function copyOne(
  from: string,
  to: string,
  platform: NodeJS.Platform,
): Promise<SqliteSnapshotFailure | null> {
  try {
    await copyFile(from, to);
    return null;
  } catch (error) {
    return classifyCopyFailure(error, platform);
  }
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
