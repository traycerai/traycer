import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  readChromiumCookieDatabase,
  type ChromiumCookieDatabase,
} from "../chromium-cookies";
import { MAX_SQLITE_COOKIE_ROWS } from "../sqlite-columns";
import { withSqliteSnapshot } from "../sqlite-snapshot";

/**
 * Builds a real Chromium `Cookies` database on disk, with the writer
 * connection left open so a caller can insert WAL-only rows before the
 * snapshot copy runs - the same interleaving a live browser produces.
 */
async function createChromiumDatabase(options: {
  readonly withPartitionColumns: boolean;
}): Promise<{
  readonly dir: string;
  readonly path: string;
  readonly writer: DatabaseSync;
}> {
  const dir = await mkdtemp(join(tmpdir(), "chromium-cookies-test-"));
  const path = join(dir, "Cookies");
  const writer = new DatabaseSync(path);
  writer.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('version', '24');
  `);
  const partitionColumns = options.withPartitionColumns
    ? ", top_frame_site_key TEXT DEFAULT '', has_expires INTEGER DEFAULT 1, samesite INTEGER DEFAULT -1"
    : "";
  writer.exec(`
    CREATE TABLE cookies (
      host_key TEXT,
      name TEXT,
      path TEXT,
      value TEXT,
      encrypted_value BLOB,
      expires_utc INTEGER,
      is_secure INTEGER,
      is_httponly INTEGER
      ${partitionColumns}
    );
  `);
  // Enable WAL only after the schema exists, matching how a live browser
  // profile is opened once and left in WAL mode for its whole life. Disable
  // auto-checkpoint so a row inserted after this point stays in the -wal
  // file for as long as this writer connection is open - the interleaving
  // withSqliteSnapshot's read-write-open + page-read + unlink sequence has
  // to survive.
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  return { dir, path, writer };
}

/** Proof the fixture actually has uncheckpointed data before the snapshot runs. */
async function assertWalFileHasData(sourcePath: string): Promise<void> {
  const info = await stat(`${sourcePath}-wal`);
  expect(info.size).toBeGreaterThan(0);
}

const snapshotRoots: string[] = [];
const writers: DatabaseSync[] = [];
const dirsToClean: string[] = [];

afterEach(async () => {
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of dirsToClean.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const dir of snapshotRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readDatabase(
  sourcePath: string,
): Promise<ChromiumCookieDatabase> {
  const snapshotRoot = join(
    tmpdir(),
    `chromium-cookies-snapshot-${randomUUID()}`,
  );
  snapshotRoots.push(snapshotRoot);
  const result = await withSqliteSnapshot(
    { sourcePath, snapshotRoot, platform: process.platform },
    readChromiumCookieDatabase,
  );
  if (!result.ok) {
    throw new Error(
      `expected a successful snapshot read, got: ${result.reason}`,
    );
  }
  return result.value;
}

describe("readChromiumCookieDatabase - full schema", () => {
  it("reads a row that lives only in the WAL, never checkpointed to the main file", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wal-only.example.com",
        "wal_cookie",
        "/",
        "wal-value",
        Buffer.alloc(0),
        0,
        0,
        0,
        "",
        0,
        -1,
      );

    await assertWalFileHasData(path);
    const database = await readDatabase(path);

    expect(database.rows.map((row) => row.name)).toContain("wal_cookie");
  });

  it("flags a partitioned row via a non-empty top_frame_site_key, without dropping it", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "partitioned.example.com",
        "chips_cookie",
        "/",
        "chips-value",
        Buffer.alloc(0),
        0,
        0,
        0,
        "https://top-level.example",
        0,
        1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "chips_cookie");
    if (row === undefined)
      throw new Error("expected the partitioned row to survive the read");
    expect(row.partitioned).toBe(true);
  });

  it("reads has_expires = 0 as a session cookie (expires: -1), not an epoch-1601 date", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session.example.com",
        "session_cookie",
        "/",
        "session-value",
        Buffer.alloc(0),
        // expires_utc = 0 is the literal 1601 epoch; has_expires = 0 must win.
        0,
        0,
        0,
        "",
        0,
        -1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "session_cookie");
    if (row === undefined)
      throw new Error("expected the session row to survive the read");
    expect(row.expires).toBe(-1);
  });

  it("converts expires_utc microseconds-since-1601 to unix seconds", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    const unixSeconds = 1_893_456_000; // 2030-01-01T00:00:00Z
    const windowsEpochOffsetSeconds = 11_644_473_600;
    const expiresUtcMicroseconds =
      BigInt(unixSeconds + windowsEpochOffsetSeconds) * 1_000_000n;
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "expiring.example.com",
        "expiring_cookie",
        "/",
        "expiring-value",
        Buffer.alloc(0),
        expiresUtcMicroseconds,
        0,
        0,
        "",
        1,
        -1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "expiring_cookie");
    if (row === undefined)
      throw new Error("expected the expiring row to survive the read");
    expect(row.expires).toBe(unixSeconds);
    expect(typeof row.expires).toBe("number");
  });

  it.each([
    [-1, "Lax"],
    [0, "None"],
    [1, "Lax"],
    [2, "Strict"],
  ] as const)("maps chromium samesite %d to %s", async (samesite, expected) => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "samesite.example.com",
        `samesite_${samesite}`,
        "/",
        "value",
        Buffer.alloc(0),
        0,
        0,
        0,
        "",
        0,
        samesite,
      );

    const database = await readDatabase(path);

    const row = database.rows.find(
      (entry) => entry.name === `samesite_${samesite}`,
    );
    if (row === undefined)
      throw new Error("expected the samesite row to survive the read");
    expect(row.sameSite).toBe(expected);
  });

  it.each([
    ["v10", "encrypted"],
    ["v11", "encrypted"],
    ["v20", "protected"],
  ] as const)(
    "classifies an encrypted_value prefixed %s as %s",
    async (prefix, expectedKind) => {
      const { dir, path, writer } = await createChromiumDatabase({
        withPartitionColumns: true,
      });
      writers.push(writer);
      dirsToClean.push(dir);
      const encryptedValue = Buffer.concat([
        Buffer.from(prefix, "latin1"),
        Buffer.from([1, 2, 3, 4]),
      ]);
      writer
        .prepare(
          `INSERT INTO cookies
           (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "encrypted.example.com",
          `enc_${prefix}`,
          "/",
          "",
          encryptedValue,
          0,
          0,
          0,
          "",
          0,
          -1,
        );

      const database = await readDatabase(path);

      const row = database.rows.find((entry) => entry.name === `enc_${prefix}`);
      if (row === undefined)
        throw new Error("expected the encrypted row to survive the read");
      expect(row.secret.kind).toBe(expectedKind);
      if (row.secret.kind === "encrypted") {
        expect(row.secret.version).toBe(prefix);
        // The version prefix travels WITH the bytes, so the decryptor sees
        // exactly what Chromium wrote.
        expect(Buffer.from(row.secret.bytes).toString("latin1", 0, 3)).toBe(
          prefix,
        );
      }
    },
  );

  it("reads an empty encrypted_value with a plain value column as unencrypted", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "plain.example.com",
        "plain_cookie",
        "/",
        "plaintext-value",
        Buffer.alloc(0),
        0,
        0,
        0,
        "",
        0,
        -1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "plain_cookie");
    if (row === undefined)
      throw new Error("expected the plain row to survive the read");
    expect(row.secret).toEqual({ kind: "plain", value: "plaintext-value" });
  });

  it("reads a real BLOB encrypted_value as bytes the byte reader accepts, not bigint or string", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    const blob = Buffer.from("v10secretbytes", "latin1");
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "blob.example.com",
        "blob_cookie",
        "/",
        "",
        blob,
        0,
        1,
        1,
        "",
        0,
        -1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "blob_cookie");
    if (row === undefined)
      throw new Error("expected the blob row to survive the read");
    expect(row.secure).toBe(true);
    expect(row.httpOnly).toBe(true);
    expect(row.secret.kind).toBe("encrypted");
    if (row.secret.kind === "encrypted") {
      expect(Buffer.from(row.secret.bytes).equals(blob)).toBe(true);
    }
  });

  it("returns actual numbers, never bigints, for expires even though the statement reads with setReadBigInts(true)", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "bigint.example.com",
        "bigint_cookie",
        "/",
        "value",
        Buffer.alloc(0),
        13_285_929_600_000_000n,
        0,
        0,
        "",
        1,
        -1,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "bigint_cookie");
    if (row === undefined)
      throw new Error("expected the bigint row to survive the read");
    expect(typeof row.expires).toBe("number");
    expect(Number.isFinite(row.expires)).toBe(true);
  });
});

describe("readChromiumCookieDatabase - schema missing partition/expiry/samesite columns", () => {
  it("reads gracefully via column probing: unpartitioned, persistent, Lax", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: false,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "old-schema.example.com",
        "old_cookie",
        "/",
        "old-value",
        Buffer.alloc(0),
        0,
        0,
        0,
      );

    const database = await readDatabase(path);

    const row = database.rows.find((entry) => entry.name === "old_cookie");
    if (row === undefined)
      throw new Error("expected the old-schema row to survive the read");
    expect(row.partitioned).toBe(false);
    expect(row.sameSite).toBe("Lax");
    // Without `has_expires`, an expires_utc of 0 (or unset) reads as no expiry
    // at all, per readExpires' fallback to the raw microseconds check.
    expect(row.expires).toBe(-1);
  });

  it("still reads a WAL-only row under the old schema", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: false,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer
      .prepare(
        `INSERT INTO cookies
         (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "old-wal.example.com",
        "old_wal_cookie",
        "/",
        "value",
        Buffer.alloc(0),
        0,
        0,
        0,
      );

    await assertWalFileHasData(path);
    const database = await readDatabase(path);

    expect(database.rows.map((row) => row.name)).toContain("old_wal_cookie");
  });
});

describe("readChromiumCookieDatabase - meta version", () => {
  it("reads meta.version as a number", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);

    const database = await readDatabase(path);

    expect(database.metaVersion).toBe(24);
  });
});

describe("readChromiumCookieDatabase - row budget", () => {
  it("refuses ('too-large') a cookies table one row past MAX_SQLITE_COOKIE_ROWS", async () => {
    const { dir, path, writer } = await createChromiumDatabase({
      withPartitionColumns: true,
    });
    writers.push(writer);
    dirsToClean.push(dir);
    writer.exec(`
      INSERT INTO cookies
        (host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, samesite)
      SELECT
        'row-budget.example.com',
        'cookie_' || x,
        '/',
        'value',
        X'',
        0,
        0,
        0,
        '',
        0,
        -1
      FROM (
        WITH RECURSIVE seq(x) AS (
          SELECT 1
          UNION ALL
          SELECT x + 1 FROM seq WHERE x < ${MAX_SQLITE_COOKIE_ROWS + 1}
        )
        SELECT x FROM seq
      );
    `);

    const snapshotRoot = join(
      tmpdir(),
      `chromium-cookies-snapshot-${randomUUID()}`,
    );
    snapshotRoots.push(snapshotRoot);

    const result = await withSqliteSnapshot(
      { sourcePath: path, snapshotRoot, platform: process.platform },
      readChromiumCookieDatabase,
    );

    expect(result).toEqual({ ok: false, reason: "too-large" });
  });
});
