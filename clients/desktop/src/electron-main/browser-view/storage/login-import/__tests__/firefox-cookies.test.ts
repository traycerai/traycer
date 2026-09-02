import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readFirefoxCookieRows } from "../firefox-cookies";
import { withSqliteSnapshot } from "../sqlite-snapshot";
import type { ImportCookieRow } from "../cookie-rows";

/**
 * Builds a real Firefox `cookies.sqlite` on disk, with the writer connection
 * left open so a caller can insert WAL-only rows before the snapshot copy
 * runs - the same interleaving a live browser produces.
 */
async function createFirefoxDatabase(options: {
  readonly withOptionalColumns: boolean;
}): Promise<{
  readonly dir: string;
  readonly path: string;
  readonly writer: DatabaseSync;
}> {
  const dir = await mkdtemp(join(tmpdir(), "firefox-cookies-test-"));
  const path = join(dir, "cookies.sqlite");
  const writer = new DatabaseSync(path);
  const optionalColumns = options.withOptionalColumns
    ? ", sameSite INTEGER DEFAULT 0, originAttributes TEXT DEFAULT ''"
    : "";
  writer.exec(`
    CREATE TABLE moz_cookies (
      host TEXT,
      name TEXT,
      value TEXT,
      path TEXT,
      expiry INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER
      ${optionalColumns}
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

afterEach(async () => {
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of snapshotRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readRows(
  sourcePath: string,
): Promise<readonly ImportCookieRow[]> {
  const snapshotRoot = join(
    tmpdir(),
    `firefox-cookies-snapshot-${randomUUID()}`,
  );
  snapshotRoots.push(snapshotRoot);
  const result = await withSqliteSnapshot(
    { sourcePath, snapshotRoot, platform: process.platform },
    readFirefoxCookieRows,
  );
  if (!result.ok) {
    throw new Error(
      `expected a successful snapshot read, got: ${result.reason}`,
    );
  }
  return result.value;
}

describe("readFirefoxCookieRows - full schema", () => {
  it("reads a row that lives only in the WAL, never checkpointed to the main file", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wal-only.example.com",
        "wal_cookie",
        "wal-value",
        "/",
        0,
        0,
        0,
        0,
        "",
      );

    await assertWalFileHasData(path);
    const rows = await readRows(path);

    expect(rows.map((row) => row.name)).toContain("wal_cookie");
    await rm(dir, { recursive: true, force: true });
  });

  it("flags a partitioned row via a non-empty originAttributes, without dropping it", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "partitioned.example.com",
        "container_cookie",
        "container-value",
        "/",
        0,
        0,
        0,
        0,
        "^userContextId=2",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "container_cookie");
    if (row === undefined)
      throw new Error("expected the partitioned row to survive the read");
    expect(row.partitioned).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("reads an absent/zero expiry as a session cookie (expires: -1)", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session.example.com",
        "session_cookie",
        "value",
        "/",
        0,
        0,
        0,
        0,
        "",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "session_cookie");
    if (row === undefined)
      throw new Error("expected the session row to survive the read");
    expect(row.expires).toBe(-1);
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a positive expiry as-is, in unix seconds", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    const expiry = 1_893_456_000; // 2030-01-01T00:00:00Z
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "expiring.example.com",
        "expiring_cookie",
        "value",
        "/",
        expiry,
        0,
        0,
        0,
        "",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "expiring_cookie");
    if (row === undefined)
      throw new Error("expected the expiring row to survive the read");
    expect(row.expires).toBe(expiry);
    expect(typeof row.expires).toBe("number");
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    [0, "None"],
    [1, "Lax"],
    [2, "Strict"],
  ] as const)("maps firefox sameSite %d to %s", async (sameSite, expected) => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "samesite.example.com",
        `samesite_${sameSite}`,
        "value",
        "/",
        0,
        0,
        0,
        sameSite,
        "",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === `samesite_${sameSite}`);
    if (row === undefined)
      throw new Error("expected the samesite row to survive the read");
    expect(row.sameSite).toBe(expected);
    await rm(dir, { recursive: true, force: true });
  });

  it("always reads the cookie value as plain, never encrypted", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "plain.example.com",
        "plain_cookie",
        "plaintext-value",
        "/",
        0,
        1,
        1,
        1,
        "",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "plain_cookie");
    if (row === undefined)
      throw new Error("expected the plain row to survive the read");
    expect(row.secret).toEqual({ kind: "plain", value: "plaintext-value" });
    expect(row.secure).toBe(true);
    expect(row.httpOnly).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns actual numbers for expires, not bigints", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: true,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies
         (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "num.example.com",
        "num_cookie",
        "value",
        "/",
        1_893_456_000,
        0,
        0,
        0,
        "",
      );

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "num_cookie");
    if (row === undefined)
      throw new Error("expected the num row to survive the read");
    expect(typeof row.expires).toBe("number");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("readFirefoxCookieRows - schema missing sameSite/originAttributes", () => {
  it("reads gracefully via column probing: unpartitioned and Lax", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: false,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("old-schema.example.com", "old_cookie", "old-value", "/", 0, 0, 0);

    const rows = await readRows(path);

    const row = rows.find((entry) => entry.name === "old_cookie");
    if (row === undefined)
      throw new Error("expected the old-schema row to survive the read");
    expect(row.partitioned).toBe(false);
    expect(row.sameSite).toBe("Lax");
    await rm(dir, { recursive: true, force: true });
  });

  it("still reads a WAL-only row under the old schema", async () => {
    const { dir, path, writer } = await createFirefoxDatabase({
      withOptionalColumns: false,
    });
    writers.push(writer);
    writer
      .prepare(
        `INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("old-wal.example.com", "old_wal_cookie", "value", "/", 0, 0, 0);

    await assertWalFileHasData(path);
    const rows = await readRows(path);

    expect(rows.map((row) => row.name)).toContain("old_wal_cookie");
    await rm(dir, { recursive: true, force: true });
  });
});
