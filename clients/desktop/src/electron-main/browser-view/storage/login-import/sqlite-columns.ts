import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/**
 * Typed reads over `node:sqlite` rows. A browser's schema is not ours: a
 * column may be missing on an old profile, or hold a type the current
 * Chromium would never write, and a reader that trusted the shape would throw
 * on the one row it did not expect. These helpers answer with a default
 * instead, so the row is dropped or degraded rather than the whole jar.
 *
 * Two facts about `node:sqlite` shape them. A statement with
 * `setReadBigInts(true)` hands EVERY integer column over as a bigint, not
 * only the wide one it was set for, so each integer reader accepts both. And
 * a BLOB arrives as a `Uint8Array` that may belong to another realm (a
 * jsdom test environment, a VM context), where `instanceof` is false; the
 * byte reader asks `ArrayBuffer.isView` instead.
 */

export type SqliteRow = Record<string, SQLOutputValue>;

export function readText(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  const bytes = asBytes(value);
  return bytes === null ? "" : Buffer.from(bytes).toString("utf8");
}

export function readInteger(row: SqliteRow, column: string): number | null {
  const value = row[column];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
}

/**
 * For a column that may hold an integer past 2^53 - Chromium's microseconds
 * since 1601 are - read with `setReadBigInts(true)` and convert here.
 */
export function readBigInteger(row: SqliteRow, column: string): bigint | null {
  const value = row[column];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  return null;
}

export function readBytes(row: SqliteRow, column: string): Uint8Array | null {
  return asBytes(row[column]);
}

export function readFlag(row: SqliteRow, column: string): boolean {
  const value = row[column];
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  return false;
}

/** The column names of one table, so a SELECT can be built for the schema at hand. */
/**
 * The most rows one cookie table read materialises. Every browser caps its
 * jar - Chromium at 3 300 cookies, Firefox at 3 000 - so a table past this
 * is not a bigger profile, it is a corrupt or hand-made file, and `.all()`
 * on it would build that many objects in Electron main.
 */
export const MAX_SQLITE_COOKIE_ROWS = 50_000;

/** Thrown by {@link assertRowBudget}; the snapshot answers it as `too-large`. */
export class SqliteRowBudgetError extends Error {
  constructor(table: string) {
    // The table name, never the path: this message may be logged.
    super(`The ${table} table holds more rows than the import reads`);
    this.name = "SqliteRowBudgetError";
  }
}

/**
 * Refuses `table` before a reader selects from it, by count alone: a count
 * touches no row's value, so the refusal costs nothing on a real jar.
 */
export function assertRowBudget(database: DatabaseSync, table: string): void {
  const counted = database
    .prepare(`SELECT count(*) AS rows FROM ${table}`)
    .get();
  const rows = counted === undefined ? 0 : (readInteger(counted, "rows") ?? 0);
  if (rows > MAX_SQLITE_COOKIE_ROWS) throw new SqliteRowBudgetError(table);
}

export function tableColumns(
  database: DatabaseSync,
  table: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  // `PRAGMA table_info` takes an identifier, not a bound parameter; the table
  // names here are compile-time constants in the readers, never user input.
  for (const row of database.prepare(`PRAGMA table_info(${table})`).all()) {
    const name = row.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function asBytes(value: SQLOutputValue | undefined): Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || !ArrayBuffer.isView(value)) return null;
  if (value instanceof DataView) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
