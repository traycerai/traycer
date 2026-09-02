import type { ImportCookieRow } from "./cookie-rows";

/**
 * Parser for Safari's `Cookies.binarycookies`.
 *
 * Layout, all offsets relative to the structure they sit in:
 *
 * ```
 * file:   "cook" · pageCount (u32 BE) · pageSize[pageCount] (u32 BE) · pages
 * page:   0x00000100 · cookieCount (u32 LE) · cookieOffset[cookieCount] (u32 LE)
 * cookie: size (u32 LE) · 4 unknown · flags (u32 LE) · 4 unknown ·
 *         urlOffset · nameOffset · pathOffset · valueOffset (u32 LE each) ·
 *         8 bytes end-of-header · expiry (f64 LE) · created (f64 LE) ·
 *         NUL-terminated strings at the offsets
 * ```
 *
 * Flags: bit 0 secure, bit 2 HttpOnly. Dates are Mac absolute time, seconds
 * since 2001-01-01. Safari stores no SameSite, so every cookie is `Lax`, the
 * default every browser enforces for an unspecified one.
 *
 * Every offset is bounds-checked and a cookie that fails a check is skipped,
 * not thrown on; a whole-file structural failure throws and the caller
 * reports the source as unreadable. Values are plaintext - the file's only
 * protection is the TCC-gated container it lives in.
 */

const FILE_MAGIC = "cook";
const PAGE_HEADER = 0x00000100;
const COOKIE_HEADER_LENGTH = 56;
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;
/** Seconds between 1970-01-01 and 2001-01-01 (Mac absolute time epoch). */
const MAC_ABSOLUTE_EPOCH_OFFSET_SECONDS = 978_307_200;

export interface SafariCookieParse {
  readonly rows: readonly ImportCookieRow[];
  /** Cookies whose record failed a bounds check and were skipped. */
  readonly malformed: number;
}

export function parseSafariBinaryCookies(bytes: Uint8Array): SafariCookieParse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 8 ||
    Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== FILE_MAGIC
  ) {
    throw new Error("Not a Safari binarycookies file");
  }
  const pageCount = view.getUint32(4, false);
  let cursor = 8;
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    if (cursor + 4 > bytes.length) {
      throw new Error("Safari binarycookies page table is truncated");
    }
    pageSizes.push(view.getUint32(cursor, false));
    cursor += 4;
  }
  const rows: ImportCookieRow[] = [];
  let malformed = 0;
  for (const pageSize of pageSizes) {
    const pageStart = cursor;
    const pageEnd = pageStart + pageSize;
    if (pageEnd > bytes.length) {
      throw new Error("Safari binarycookies page is truncated");
    }
    const page = parsePage(bytes, view, pageStart, pageEnd);
    rows.push(...page.rows);
    malformed += page.malformed;
    cursor = pageEnd;
  }
  return { rows, malformed };
}

function parsePage(
  bytes: Uint8Array,
  view: DataView,
  pageStart: number,
  pageEnd: number,
): SafariCookieParse {
  if (
    pageEnd - pageStart < 8 ||
    view.getUint32(pageStart, false) !== PAGE_HEADER
  ) {
    throw new Error("Safari binarycookies page header is invalid");
  }
  const cookieCount = view.getUint32(pageStart + 4, true);
  const rows: ImportCookieRow[] = [];
  let malformed = 0;
  for (let index = 0; index < cookieCount; index += 1) {
    const offsetAt = pageStart + 8 + index * 4;
    if (offsetAt + 4 > pageEnd) {
      malformed += cookieCount - index;
      break;
    }
    const cookieStart = pageStart + view.getUint32(offsetAt, true);
    const row = parseCookie(bytes, view, cookieStart, pageEnd);
    if (row === null) malformed += 1;
    else rows.push(row);
  }
  return { rows, malformed };
}

function parseCookie(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  pageEnd: number,
): ImportCookieRow | null {
  if (start < 0 || start + COOKIE_HEADER_LENGTH > pageEnd) return null;
  const size = view.getUint32(start, true);
  const end = start + size;
  if (size < COOKIE_HEADER_LENGTH || end > pageEnd) return null;
  const flags = view.getUint32(start + 8, true);
  const url = readString(bytes, start, end, view.getUint32(start + 16, true));
  const name = readString(bytes, start, end, view.getUint32(start + 20, true));
  const path = readString(bytes, start, end, view.getUint32(start + 24, true));
  const value = readString(bytes, start, end, view.getUint32(start + 28, true));
  if (url === null || name === null || path === null || value === null) {
    return null;
  }
  const expiry = view.getFloat64(start + 40, true);
  return {
    domain: url,
    name,
    path,
    expires: Number.isFinite(expiry)
      ? Math.floor(expiry + MAC_ABSOLUTE_EPOCH_OFFSET_SECONDS)
      : -1,
    secure: (flags & FLAG_SECURE) !== 0,
    httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
    sameSite: "Lax",
    partitioned: false,
    secret: { kind: "plain", value },
  };
}

/** A NUL-terminated string inside one cookie record; `null` if it runs out. */
function readString(
  bytes: Uint8Array,
  cookieStart: number,
  cookieEnd: number,
  offset: number,
): string | null {
  const from = cookieStart + offset;
  if (offset < COOKIE_HEADER_LENGTH || from >= cookieEnd) return null;
  const terminator = bytes.indexOf(0, from);
  if (terminator === -1 || terminator >= cookieEnd) return null;
  return Buffer.from(bytes.subarray(from, terminator)).toString("utf8");
}
