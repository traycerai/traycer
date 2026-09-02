import type { DatabaseSync } from "node:sqlite";
import type {
  ImportCookieRow,
  ImportCookieSameSite,
  ImportCookieSecret,
} from "./cookie-rows";
import {
  readBigInteger,
  readBytes,
  readFlag,
  readInteger,
  readText,
  tableColumns,
  type SqliteRow,
} from "./sqlite-columns";

/**
 * Reader for a Chromium-family `Cookies` database (Chrome, Edge, Brave, Arc,
 * Vivaldi, Opera, Chromium itself). Metadata only: the value column is
 * carried as bytes plus its version prefix and decrypted later, by
 * `chromium-crypto.ts`, and only for the rows the user chose.
 */

export interface ChromiumCookieDatabase {
  /**
   * `meta.version`, Chromium's own schema number. From 24 on, every encrypted
   * value carries a SHA-256 of its `host_key` in front of the plaintext; the
   * decryptor needs to know which side of that line the jar is on.
   */
  readonly metaVersion: number;
  readonly rows: readonly ImportCookieRow[];
}

/** Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const UNIX_TO_WINDOWS_EPOCH_SECONDS = 11_644_473_600n;
const MICROSECONDS_PER_SECOND = 1_000_000n;

export function readChromiumCookieDatabase(
  database: DatabaseSync,
): ChromiumCookieDatabase {
  return {
    metaVersion: readMetaVersion(database),
    rows: readRows(database),
  };
}

function readMetaVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'version'")
    .get();
  if (row === undefined) return 0;
  const value = row.value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readRows(database: DatabaseSync): readonly ImportCookieRow[] {
  const columns = tableColumns(database, "cookies");
  const selected = [
    "host_key",
    "name",
    "path",
    "value",
    "encrypted_value",
    "expires_utc",
    "is_secure",
    "is_httponly",
  ];
  // Older schemas predate these three; a jar without them is read as
  // unpartitioned, persistent, and Lax - which is what Chromium of that era
  // meant by their absence.
  const hasTopFrameSiteKey = columns.has("top_frame_site_key");
  const hasHasExpires = columns.has("has_expires");
  const hasSameSite = columns.has("samesite");
  if (hasTopFrameSiteKey) selected.push("top_frame_site_key");
  if (hasHasExpires) selected.push("has_expires");
  if (hasSameSite) selected.push("samesite");
  const statement = database.prepare(
    `SELECT ${selected.join(", ")} FROM cookies`,
  );
  // `expires_utc` is past 2^53 for any date after 1886, and node:sqlite
  // refuses to hand such an integer over as a number.
  statement.setReadBigInts(true);
  return statement
    .all()
    .map((row) =>
      toRow(row, { hasTopFrameSiteKey, hasHasExpires, hasSameSite }),
    );
}

function toRow(
  row: SqliteRow,
  schema: {
    readonly hasTopFrameSiteKey: boolean;
    readonly hasHasExpires: boolean;
    readonly hasSameSite: boolean;
  },
): ImportCookieRow {
  return {
    domain: readText(row, "host_key"),
    name: readText(row, "name"),
    path: readText(row, "path"),
    expires: readExpires(row, schema.hasHasExpires),
    secure: readFlag(row, "is_secure"),
    httpOnly: readFlag(row, "is_httponly"),
    sameSite: schema.hasSameSite ? readSameSite(row) : "Lax",
    partitioned: schema.hasTopFrameSiteKey
      ? readText(row, "top_frame_site_key") !== ""
      : false,
    secret: readSecret(row),
  };
}

function readExpires(row: SqliteRow, hasHasExpires: boolean): number {
  // `has_expires = 0` is a session cookie. Its `expires_utc` is 0, which is
  // the year 1601 - a real expiry only by accident, and one that would drop
  // every session cookie as expired if it were read as a date.
  if (hasHasExpires && !readFlag(row, "has_expires")) return -1;
  const microseconds = readBigInteger(row, "expires_utc");
  if (microseconds === null || microseconds <= 0n) return -1;
  return Number(
    microseconds / MICROSECONDS_PER_SECOND - UNIX_TO_WINDOWS_EPOCH_SECONDS,
  );
}

/**
 * Chromium's `CookieSameSite`: -1 unspecified, 0 none, 1 lax, 2 strict. An
 * unspecified cookie is enforced as Lax by every current browser, so that is
 * what it becomes here rather than a `None` it never had.
 */
function readSameSite(row: SqliteRow): ImportCookieSameSite {
  const value = readInteger(row, "samesite");
  if (value === 0) return "None";
  if (value === 2) return "Strict";
  return "Lax";
}

function readSecret(row: SqliteRow): ImportCookieSecret {
  const encrypted = readBytes(row, "encrypted_value");
  if (encrypted === null || encrypted.length === 0) {
    return { kind: "plain", value: readText(row, "value") };
  }
  const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
  if (prefix === "v10")
    return { kind: "encrypted", version: "v10", bytes: encrypted };
  if (prefix === "v11")
    return { kind: "encrypted", version: "v11", bytes: encrypted };
  // `v20` is App-Bound Encryption (Chrome 127+ on Windows); anything else is
  // a prefix this reader has never seen, which is treated the same way - the
  // count is honest and nothing is guessed at.
  return { kind: "protected" };
}
