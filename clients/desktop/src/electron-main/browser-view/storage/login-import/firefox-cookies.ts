import type { DatabaseSync } from "node:sqlite";
import type { ImportCookieRow, ImportCookieSameSite } from "./cookie-rows";
import {
  readFlag,
  readInteger,
  readText,
  tableColumns,
  type SqliteRow,
} from "./sqlite-columns";

/**
 * Reader for Firefox's `cookies.sqlite`. Plaintext on every platform, so the
 * only thing this has to get right is scope: a non-empty `originAttributes`
 * is a container tab, a private window, or a partitioned (dFPI) cookie, and
 * none of those has an unpartitioned home in Electron's jar.
 */
export function readFirefoxCookieRows(
  database: DatabaseSync,
): readonly ImportCookieRow[] {
  const columns = tableColumns(database, "moz_cookies");
  const selected = [
    "host",
    "name",
    "value",
    "path",
    "expiry",
    "isSecure",
    "isHttpOnly",
  ];
  const hasSameSite = columns.has("sameSite");
  const hasOriginAttributes = columns.has("originAttributes");
  if (hasSameSite) selected.push("sameSite");
  if (hasOriginAttributes) selected.push("originAttributes");
  return database
    .prepare(`SELECT ${selected.join(", ")} FROM moz_cookies`)
    .all()
    .map((row) => toRow(row, { hasSameSite, hasOriginAttributes }));
}

function toRow(
  row: SqliteRow,
  schema: {
    readonly hasSameSite: boolean;
    readonly hasOriginAttributes: boolean;
  },
): ImportCookieRow {
  const expiry = readInteger(row, "expiry");
  return {
    domain: readText(row, "host"),
    name: readText(row, "name"),
    path: readText(row, "path"),
    // Firefox persists no session cookies to this table, so an absent or
    // zero expiry is a row it would not have written; it is read as a session
    // cookie rather than as "expired in 1970".
    expires: expiry === null || expiry <= 0 ? -1 : expiry,
    secure: readFlag(row, "isSecure"),
    httpOnly: readFlag(row, "isHttpOnly"),
    sameSite: schema.hasSameSite ? readSameSite(row) : "Lax",
    partitioned: schema.hasOriginAttributes
      ? readText(row, "originAttributes") !== ""
      : false,
    secret: { kind: "plain", value: readText(row, "value") },
  };
}

/** Firefox's `nsICookie` SameSite: 0 none, 1 lax, 2 strict. */
function readSameSite(row: SqliteRow): ImportCookieSameSite {
  const value = readInteger(row, "sameSite");
  if (value === 0) return "None";
  if (value === 2) return "Strict";
  return "Lax";
}
