import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRowBudgetError } from "../sqlite-columns";
import {
  classifyCopyFailure,
  copySqliteFileBounded,
  copySqliteFiles,
  MAX_SQLITE_SNAPSHOT_BYTES,
  SQLITE_SNAPSHOT_COPY_ATTEMPTS,
  SqliteNotRegularFileError,
  sweepSqliteSnapshots,
  withSqliteSnapshot,
  type SqliteFileCopy,
} from "../sqlite-snapshot";

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeSnapshotRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-root-"));
  dirsToClean.push(dir);
  return dir;
}

async function makeRealSqliteFile(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
  db.close();
  return path;
}

describe("withSqliteSnapshot - success", () => {
  it("reads a real sqlite file through a private snapshot copy", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    const result = await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      (database) => database.prepare("SELECT v FROM t").all(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.value).toEqual([{ v: "hello" }]);
  });

  it("removes the per-call snapshot directory in a finally, even when the reader throws", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    // A throw from the caller-supplied reader is caught by the inner
    // try/catch around `read(database)` and reported as `{ ok: false,
    // reason: "unreadable" }` - it never becomes a rejected promise. The
    // finally block that removes the per-call directory has to run on this
    // path exactly as it does on every other failure path.
    const result = await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      () => {
        throw new Error("reader blew up");
      },
    );

    expect(result).toEqual({ ok: false, reason: "unreadable" });
    const remaining = await readdir(snapshotRoot);
    expect(remaining).toEqual([]);
  });

  it("maps a thrown SqliteRowBudgetError from the reader to reason 'too-large', not the generic 'unreadable'", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    const result = await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      () => {
        throw new SqliteRowBudgetError("t");
      },
    );

    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("removes the per-call snapshot directory on the success path too", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      (database) => database.prepare("SELECT 1").get(),
    );

    const remaining = await readdir(snapshotRoot);
    expect(remaining).toEqual([]);
  });
});

describe("withSqliteSnapshot - copy failure classification, end to end", () => {
  it("classifies a missing source file as 'missing'", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "does-not-exist.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    const result = await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      (database) => database.prepare("SELECT 1").get(),
    );

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("classifies an unreadable (permission-denied) source file as 'permission' on posix", async () => {
    if (process.platform === "win32") return;
    if (process.getuid !== undefined && process.getuid() === 0) {
      // A root process bypasses filesystem permission bits entirely, so the
      // fixture cannot produce EACCES; skip rather than assert a false negative.
      return;
    }
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "unreadable.sqlite");
    await writeFile(sourcePath, "not really sqlite, permissions matter first");
    await chmod(sourcePath, 0o000);
    const snapshotRoot = await makeSnapshotRoot();

    try {
      const result = await withSqliteSnapshot(
        { sourcePath, snapshotRoot, platform: process.platform },
        (database) => database.prepare("SELECT 1").get(),
      );

      expect(result).toEqual({ ok: false, reason: "permission" });
    } finally {
      // Restore permissions so the fixture cleans up in afterEach.
      await chmod(sourcePath, 0o600);
    }
  });

  it("does not fail the copy over a missing -wal/-shm sibling - only the main file is required", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    // A plain (non-WAL) sqlite file has no -wal/-shm siblings at all.
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const snapshotRoot = await makeSnapshotRoot();

    const result = await withSqliteSnapshot(
      { sourcePath, snapshotRoot, platform: process.platform },
      (database) => database.prepare("SELECT v FROM t").all(),
    );

    expect(result).toEqual({ ok: true, value: [{ v: "hello" }] });
  });
});

/**
 * EBUSY/EPERM-on-non-win32/unmapped-errno are Windows share-mode signals or
 * synthetic errno strings that the real filesystem on this host cannot be
 * made to produce for `copyFile` (see the two end-to-end cases above for the
 * codes that ARE portably reproducible: ENOENT and EACCES). `classifyCopyFailure`
 * is exported from `sqlite-snapshot.ts` for exactly this reason - a test-only
 * seam so these cases exercise the real classification function directly with
 * real `Error` objects shaped like Node's errno errors, rather than a
 * reimplementation of its logic.
 */
describe("classifyCopyFailure - codes not portably reproducible end to end", () => {
  it("classifies EBUSY as 'locked' regardless of platform", () => {
    const ebusy = Object.assign(new Error("busy"), { code: "EBUSY" });
    expect(classifyCopyFailure(ebusy, "darwin")).toBe("locked");
    expect(classifyCopyFailure(ebusy, "win32")).toBe("locked");
  });

  it("classifies EPERM as 'locked' on win32 but 'permission' elsewhere", () => {
    const eperm = Object.assign(new Error("perm"), { code: "EPERM" });
    expect(classifyCopyFailure(eperm, "win32")).toBe("locked");
    expect(classifyCopyFailure(eperm, "darwin")).toBe("permission");
  });

  it("classifies ENOENT and ENOTDIR as 'missing'", () => {
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    const enotdir = Object.assign(new Error("not a dir"), { code: "ENOTDIR" });
    expect(classifyCopyFailure(enoent, "darwin")).toBe("missing");
    expect(classifyCopyFailure(enotdir, "darwin")).toBe("missing");
  });

  it("classifies EACCES as 'permission'", () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(classifyCopyFailure(eacces, "darwin")).toBe("permission");
  });

  it("classifies an unrecognized errno as 'unreadable'", () => {
    const weird = Object.assign(new Error("weird"), { code: "EWEIRD" });
    expect(classifyCopyFailure(weird, "darwin")).toBe("unreadable");
  });

  it("classifies a non-errno-shaped error as 'unreadable'", () => {
    expect(classifyCopyFailure(new Error("no code here"), "darwin")).toBe(
      "unreadable",
    );
    expect(classifyCopyFailure("not even an error", "darwin")).toBe(
      "unreadable",
    );
  });

  it("classifies SqliteNotRegularFileError as 'unreadable' regardless of platform", () => {
    expect(classifyCopyFailure(new SqliteNotRegularFileError(), "darwin")).toBe(
      "unreadable",
    );
    expect(classifyCopyFailure(new SqliteNotRegularFileError(), "win32")).toBe(
      "unreadable",
    );
  });
});

describe("sweepSqliteSnapshots", () => {
  it("removes leftover snapshot directories from a previous crashed run", async () => {
    const snapshotRoot = await makeSnapshotRoot();
    const leftoverDir = join(snapshotRoot, randomUUID());
    await mkdir(leftoverDir, { recursive: true });
    await writeFile(
      join(leftoverDir, "cookies.sqlite"),
      "leftover plaintext jar",
    );

    await sweepSqliteSnapshots(snapshotRoot);

    await expect(readdir(snapshotRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is a no-op (never throws) when the snapshot root does not exist", async () => {
    const missingRoot = join(
      tmpdir(),
      `sqlite-snapshot-root-missing-${randomUUID()}`,
    );

    await expect(sweepSqliteSnapshots(missingRoot)).resolves.toBeUndefined();
  });
});

describe("copySqliteFiles - retry against a moving source", () => {
  async function realSourceMain(dir: string): Promise<string> {
    const path = join(dir, "cookies.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
    db.close();
    return path;
  }

  // Pins: a source that moves only during the FIRST attempt succeeds on the
  // retry, and the copy on disk matches the source's FINAL (post-move) size.
  it("retries once and succeeds when the source moves only during the first attempt", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await realSourceMain(sourceDir);
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    let mainCopyCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      const copied = await copySqliteFileBounded(from, to, maxBytes);
      if (from === sourcePath) {
        mainCopyCount += 1;
        if (mainCopyCount === 1) {
          // The source "moves" right after the first attempt copies it -
          // exactly the signal `copySqliteFiles` retries on.
          await appendFile(sourcePath, "extra-bytes-after-first-copy");
        }
      }
      return copied;
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBeNull();
    expect(mainCopyCount).toBe(2);
    const [sourceStat, snapshotStat] = await Promise.all([
      stat(sourcePath),
      stat(snapshotPath),
    ]);
    expect(snapshotStat.size).toBe(sourceStat.size);
  });

  // Pins: a source that never holds still is reported "locked" after exactly
  // SQLITE_SNAPSHOT_COPY_ATTEMPTS main-file copies, not fewer and not more.
  it("returns 'locked' when the source keeps moving on every attempt", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await realSourceMain(sourceDir);
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    let mainCopyCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      const copied = await copySqliteFileBounded(from, to, maxBytes);
      if (from === sourcePath) {
        mainCopyCount += 1;
        await appendFile(sourcePath, `extra-bytes-${mainCopyCount}`);
      }
      return copied;
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBe("locked");
    expect(mainCopyCount).toBe(SQLITE_SNAPSHOT_COPY_ATTEMPTS);
  });

  // Pins: a -wal sibling copied on one attempt that the source no longer has
  // on the next attempt is unlinked from the snapshot directory, not left
  // there paired with a newer main file.
  it("does not leave a stale -wal copy in the snapshot when the source's WAL disappears between attempts", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await realSourceMain(sourceDir);
    await writeFile(`${sourcePath}-wal`, "wal-bytes");
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    // Overall call order within one attempt is [main, -wal, -shm]; the -shm
    // copy fails "missing" on its own (no hook needed). After the SECOND
    // call (the -wal copy of attempt 1, which lands on disk because the WAL
    // still exists at that point), simulate a checkpoint: the WAL disappears
    // and the main file's size changes, so the retry loop notices and starts
    // a second attempt - on which the -wal copy now fails "missing" and the
    // attempt-1 copy is unlinked.
    let callCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      callCount += 1;
      const thisCall = callCount;
      const copied = await copySqliteFileBounded(from, to, maxBytes);
      if (thisCall === 2) {
        await unlink(`${sourcePath}-wal`);
        await appendFile(sourcePath, "checkpointed-bytes");
      }
      return copied;
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBeNull();
    await expect(stat(`${snapshotPath}-wal`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("copySqliteFiles - too-large refusal by size alone, before any byte is copied", () => {
  // Uses fs.promises.truncate to grow a sparse file to the target size
  // instantly, rather than writing MAX_SQLITE_SNAPSHOT_BYTES real bytes.
  it("refuses when the main file alone exceeds MAX_SQLITE_SNAPSHOT_BYTES, with no -wal present", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "cookies.sqlite");
    await writeFile(sourcePath, "");
    await truncate(sourcePath, MAX_SQLITE_SNAPSHOT_BYTES + 1);
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    let copyCallCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      copyCallCount += 1;
      return copySqliteFileBounded(from, to, maxBytes);
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBe("too-large");
    expect(copyCallCount).toBe(0);
  });

  it("refuses when neither file is over the bound alone but the main file plus the -wal sibling is", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "cookies.sqlite");
    await writeFile(sourcePath, "small main file");
    await writeFile(`${sourcePath}-wal`, "");
    // EXACTLY the bound, so a per-file check would pass it: only the sum
    // with the non-empty main file is what is over.
    await truncate(`${sourcePath}-wal`, MAX_SQLITE_SNAPSHOT_BYTES);
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    let copyCallCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      copyCallCount += 1;
      return copySqliteFileBounded(from, to, maxBytes);
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBe("too-large");
    expect(copyCallCount).toBe(0);
  });
});

describe("copySqliteFiles - TOCTOU: a source that grows AFTER the pre-check but DURING the copy", () => {
  // The pre-check reads the source's size at an instant, before any byte is
  // copied. A source that grows between that instant and the copy itself -
  // the exact gap `copySqliteFileBounded`'s bounded read stream exists to
  // close - must still be caught, on the SAME attempt, with no retry.
  it("fails 'too-large' on the attempt that catches the mid-copy growth, with no retry", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "cookies.sqlite");
    // Small enough to pass the pre-check.
    await writeFile(sourcePath, "small main file");
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    let copyCallCount = 0;
    const copy: SqliteFileCopy = async (from, to, maxBytes) => {
      copyCallCount += 1;
      if (copyCallCount === 1) {
        // Grows the SOURCE, not the copy - a sparse truncate is instant, so
        // this is not writing MAX_SQLITE_SNAPSHOT_BYTES real bytes.
        await truncate(sourcePath, MAX_SQLITE_SNAPSHOT_BYTES + 1);
      }
      return copySqliteFileBounded(from, to, maxBytes);
    };

    const result = await copySqliteFiles(
      sourcePath,
      snapshotPath,
      process.platform,
      copy,
    );

    expect(result).toBe("too-large");
    // The main file's own copy caught the growth: no retry, and no sibling
    // copy was attempted either.
    expect(copyCallCount).toBe(1);
    const snapshotStat = await stat(snapshotPath);
    expect(snapshotStat.size).toBeLessThanOrEqual(
      MAX_SQLITE_SNAPSHOT_BYTES + 1,
    );
  });
});

describe("copySqliteFileBounded", () => {
  it("copies at most maxBytes + 1 bytes and answers the bytes it copied", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = join(sourceDir, "ten-bytes.bin");
    await writeFile(sourcePath, "0123456789");
    const destDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(destDir);

    const boundedPath = join(destDir, "bounded.bin");
    const boundedCopied = await copySqliteFileBounded(
      sourcePath,
      boundedPath,
      4,
    );
    expect(boundedCopied).toBe(5);
    expect((await stat(boundedPath)).size).toBe(5);

    const wholePath = join(destDir, "whole.bin");
    const wholeCopied = await copySqliteFileBounded(sourcePath, wholePath, 100);
    expect(wholeCopied).toBe(10);
    expect((await stat(wholePath)).size).toBe(10);
  });

  it("rejects with an ENOENT-coded error for a missing source", async () => {
    const destDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(destDir);

    await expect(
      copySqliteFileBounded(
        join(destDir, "does-not-exist.bin"),
        join(destDir, "out.bin"),
        100,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects with SqliteNotRegularFileError when `from` is a directory", async () => {
    if (process.platform === "win32") {
      // A directory open throws EISDIR on Windows instead of succeeding and
      // failing the later isFile() check - a different code path entirely.
      return;
    }
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const dirAsFrom = join(sourceDir, "not-a-file");
    await mkdir(dirAsFrom);
    const destDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(destDir);

    await expect(
      copySqliteFileBounded(dirAsFrom, join(destDir, "out.bin"), 100),
    ).rejects.toBeInstanceOf(SqliteNotRegularFileError);
  });
});

describe("copySqliteFiles - a FIFO sibling is classified 'unreadable' promptly, never hangs", () => {
  it("answers 'unreadable' when the -wal sibling is a FIFO", async () => {
    if (process.platform === "win32") {
      // No FIFOs on Windows; mkfifo is not available there either.
      return;
    }
    const sourceDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-source-"));
    dirsToClean.push(sourceDir);
    const sourcePath = await makeRealSqliteFile(sourceDir, "cookies.sqlite");
    const walPath = `${sourcePath}-wal`;
    execFileSync("mkfifo", [walPath]);
    const snapshotDir = await mkdtemp(join(tmpdir(), "sqlite-snapshot-dest-"));
    dirsToClean.push(snapshotDir);
    const snapshotPath = join(snapshotDir, "cookies.sqlite");

    const copy: SqliteFileCopy = (from, to, maxBytes) =>
      copySqliteFileBounded(from, to, maxBytes);

    const timerHolder: { current: NodeJS.Timeout | null } = { current: null };
    try {
      const result = await Promise.race([
        copySqliteFiles(sourcePath, snapshotPath, process.platform, copy),
        new Promise<never>((_resolve, reject) => {
          timerHolder.current = setTimeout(() => {
            reject(new Error("copy blocked on the FIFO"));
          }, 5_000);
          timerHolder.current.unref();
        }),
      ]);

      expect(result).toBe("unreadable");
    } finally {
      if (timerHolder.current !== null) clearTimeout(timerHolder.current);
    }
  });
});
