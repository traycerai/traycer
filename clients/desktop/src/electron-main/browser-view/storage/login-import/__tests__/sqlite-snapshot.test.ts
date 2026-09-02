import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCopyFailure,
  sweepSqliteSnapshots,
  withSqliteSnapshot,
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
