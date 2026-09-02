import { describe, expect, it } from "vitest";
import { parseSafariBinaryCookies } from "../safari-binarycookies";

/**
 * Hand-builds a Safari `Cookies.binarycookies` fixture per the layout
 * documented at the top of `safari-binarycookies.ts`:
 *
 *   file:   "cook" · pageCount (u32 BE) · pageSize[pageCount] (u32 BE) · pages
 *   page:   0x00000100 · cookieCount (u32 LE) · cookieOffset[cookieCount] (u32 LE)
 *   cookie: size (u32 LE) · 4 unknown · flags (u32 LE) · 4 unknown ·
 *           urlOffset · nameOffset · pathOffset · valueOffset (u32 LE each) ·
 *           8 bytes end-of-header · expiry (f64 LE) · created (f64 LE) ·
 *           NUL-terminated strings at the offsets
 */

const COOKIE_HEADER_LENGTH = 56;
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;
const MAC_ABSOLUTE_EPOCH_OFFSET_SECONDS = 978_307_200;

interface CookieSpec {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
  readonly flags: number;
  readonly expiryMacAbsolute: number;
  readonly createdMacAbsolute: number;
}

/** Builds one cookie record's bytes, per the documented 56-byte header layout. */
function buildCookieRecord(spec: CookieSpec): Buffer {
  const strings = [spec.domain, spec.name, spec.path, spec.value].map((value) =>
    Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]),
  );
  const [domainBytes, nameBytes, pathBytes, valueBytes] = strings;
  if (
    domainBytes === undefined ||
    nameBytes === undefined ||
    pathBytes === undefined ||
    valueBytes === undefined
  ) {
    throw new Error("unreachable: strings has exactly four entries");
  }
  const urlOffset = COOKIE_HEADER_LENGTH;
  const nameOffset = urlOffset + domainBytes.length;
  const pathOffset = nameOffset + nameBytes.length;
  const valueOffset = pathOffset + pathBytes.length;
  const size = valueOffset + valueBytes.length;

  const header = Buffer.alloc(COOKIE_HEADER_LENGTH);
  header.writeUInt32LE(size, 0);
  header.writeUInt32LE(0, 4); // 4 unknown bytes
  header.writeUInt32LE(spec.flags, 8);
  header.writeUInt32LE(0, 12); // 4 unknown bytes
  header.writeUInt32LE(urlOffset, 16);
  header.writeUInt32LE(nameOffset, 20);
  header.writeUInt32LE(pathOffset, 24);
  header.writeUInt32LE(valueOffset, 28);
  // 8 bytes end-of-header (offset 32..39, unused by the parser).
  header.writeDoubleLE(spec.expiryMacAbsolute, 40);
  header.writeDoubleLE(spec.createdMacAbsolute, 48);

  return Buffer.concat([header, domainBytes, nameBytes, pathBytes, valueBytes]);
}

/** Builds one page's bytes: the 0x100 header, cookie count, offsets, records. */
function buildPage(cookies: readonly Buffer[]): Buffer {
  const pageHeaderAndCount = Buffer.alloc(8);
  pageHeaderAndCount.writeUInt32BE(0x00000100, 0);
  pageHeaderAndCount.writeUInt32LE(cookies.length, 4);

  const offsetTable = Buffer.alloc(cookies.length * 4);
  let cursor = 8 + offsetTable.length;
  cookies.forEach((cookie, index) => {
    offsetTable.writeUInt32LE(cursor, index * 4);
    cursor += cookie.length;
  });

  return Buffer.concat([pageHeaderAndCount, offsetTable, ...cookies]);
}

/** Builds the whole file: magic, page table, and the pages themselves. */
function buildFile(pages: readonly Buffer[]): Buffer {
  const magicAndCount = Buffer.alloc(8);
  magicAndCount.write("cook", 0, "latin1");
  magicAndCount.writeUInt32BE(pages.length, 4);

  const pageSizeTable = Buffer.alloc(pages.length * 4);
  pages.forEach((page, index) => {
    pageSizeTable.writeUInt32BE(page.length, index * 4);
  });

  return Buffer.concat([magicAndCount, pageSizeTable, ...pages]);
}

function secondsFromNow(deltaSeconds: number): number {
  return (
    Math.floor(Date.now() / 1000) -
    MAC_ABSOLUTE_EPOCH_OFFSET_SECONDS +
    deltaSeconds
  );
}

describe("parseSafariBinaryCookies - well-formed fixtures", () => {
  it("parses a secure + httpOnly cookie, a host-only cookie", () => {
    const cookie = buildCookieRecord({
      domain: "secure.example.com",
      name: "session",
      path: "/",
      value: "abc123",
      flags: FLAG_SECURE | FLAG_HTTP_ONLY,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const bytes = buildFile([buildPage([cookie])]);

    const parsed = parseSafariBinaryCookies(bytes);

    expect(parsed.malformed).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.domain).toBe("secure.example.com");
    expect(row.name).toBe("session");
    expect(row.secure).toBe(true);
    expect(row.httpOnly).toBe(true);
    expect(row.sameSite).toBe("Lax");
    expect(row.partitioned).toBe(false);
    expect(row.secret).toEqual({ kind: "plain", value: "abc123" });
  });

  it("parses an expired cookie (Mac absolute time in the past) as an expires value in the past", () => {
    const pastExpiry = secondsFromNow(-100_000);
    const cookie = buildCookieRecord({
      domain: "expired.example.com",
      name: "old",
      path: "/",
      value: "gone",
      flags: 0,
      expiryMacAbsolute: pastExpiry,
      createdMacAbsolute: secondsFromNow(-200_000),
    });
    const bytes = buildFile([buildPage([cookie])]);

    const parsed = parseSafariBinaryCookies(bytes);

    const row = parsed.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.expires).toBeLessThan(Math.floor(Date.now() / 1000));
    expect(row.secure).toBe(false);
    expect(row.httpOnly).toBe(false);
  });

  it("parses a domain cookie (leading-dot domain)", () => {
    const cookie = buildCookieRecord({
      domain: ".example.com",
      name: "wide",
      path: "/",
      value: "shared",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const bytes = buildFile([buildPage([cookie])]);

    const parsed = parseSafariBinaryCookies(bytes);

    const row = parsed.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.domain).toBe(".example.com");
  });

  it("parses two pages, each contributing its own rows", () => {
    const cookieA = buildCookieRecord({
      domain: "a.example.com",
      name: "a",
      path: "/",
      value: "a-value",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const cookieB = buildCookieRecord({
      domain: "b.example.com",
      name: "b",
      path: "/",
      value: "b-value",
      flags: FLAG_SECURE,
      expiryMacAbsolute: secondsFromNow(7_200),
      createdMacAbsolute: secondsFromNow(-7_200),
    });
    const bytes = buildFile([buildPage([cookieA]), buildPage([cookieB])]);

    const parsed = parseSafariBinaryCookies(bytes);

    expect(parsed.malformed).toBe(0);
    expect(parsed.rows.map((row) => row.name).sort()).toEqual(["a", "b"]);
  });
});

describe("parseSafariBinaryCookies - malformed records", () => {
  it("counts a cookie with an out-of-range record offset as malformed, without throwing", () => {
    const cookie = buildCookieRecord({
      domain: "ok.example.com",
      name: "ok",
      path: "/",
      value: "value",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const page = buildPage([cookie]);
    // Corrupt the one cookie-offset entry (right after the 8-byte page
    // header) to point far past the end of the page.
    const corruptedPage = Buffer.from(page);
    corruptedPage.writeUInt32LE(0xffffff00, 8);
    const bytes = buildFile([corruptedPage]);

    const parsed = parseSafariBinaryCookies(bytes);

    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });

  it("counts a cookie whose declared size overruns the page as malformed, without throwing", () => {
    const cookie = buildCookieRecord({
      domain: "ok.example.com",
      name: "ok",
      path: "/",
      value: "value",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const corruptedCookie = Buffer.from(cookie);
    // Declare a size far larger than the actual record.
    corruptedCookie.writeUInt32LE(0x7fffffff, 0);
    const bytes = buildFile([buildPage([corruptedCookie])]);

    const parsed = parseSafariBinaryCookies(bytes);

    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });

  it("keeps the well-formed cookies on a page that also holds a malformed one", () => {
    const good = buildCookieRecord({
      domain: "good.example.com",
      name: "good",
      path: "/",
      value: "value",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const bad = buildCookieRecord({
      domain: "bad.example.com",
      name: "bad",
      path: "/",
      value: "value",
      flags: 0,
      expiryMacAbsolute: secondsFromNow(3_600),
      createdMacAbsolute: secondsFromNow(-3_600),
    });
    const corruptedBad = Buffer.from(bad);
    corruptedBad.writeUInt32LE(0x7fffffff, 0);
    const bytes = buildFile([buildPage([good, corruptedBad])]);

    const parsed = parseSafariBinaryCookies(bytes);

    expect(parsed.rows.map((row) => row.name)).toEqual(["good"]);
    expect(parsed.malformed).toBe(1);
  });
});

describe("parseSafariBinaryCookies - structural failure", () => {
  it("throws when the file does not start with the 'cook' magic", () => {
    const bytes = Buffer.from("not a safari cookies file at all", "utf8");

    expect(() => parseSafariBinaryCookies(bytes)).toThrow();
  });

  it("throws on a truncated page table", () => {
    // Declares 2 pages but supplies no page-size table or page bytes at all.
    const bytes = Buffer.alloc(8);
    bytes.write("cook", 0, "latin1");
    bytes.writeUInt32BE(2, 4);

    expect(() => parseSafariBinaryCookies(bytes)).toThrow();
  });

  it("throws when a declared page runs past the end of the file", () => {
    const magicAndCount = Buffer.alloc(8);
    magicAndCount.write("cook", 0, "latin1");
    magicAndCount.writeUInt32BE(1, 4);
    const pageSizeTable = Buffer.alloc(4);
    // Declare a page far larger than any bytes actually supplied.
    pageSizeTable.writeUInt32BE(1_000_000, 0);
    const bytes = Buffer.concat([magicAndCount, pageSizeTable]);

    expect(() => parseSafariBinaryCookies(bytes)).toThrow();
  });
});
