import { z } from "zod";
import type { ImportCookieRow, ImportCookieSameSite } from "./cookie-rows";

/**
 * Parser for the cookie exports a user can produce without Traycer's help:
 *
 * - **Netscape `cookies.txt`** (curl, wget, the "Get cookies.txt" extensions):
 *   seven tab-separated fields per line, `#` comments, and the `#HttpOnly_`
 *   line prefix the extensions use to keep HttpOnly cookies in a format that
 *   has no column for it.
 * - **Cookie-Editor JSON**: an array of the extension's cookie objects.
 * - **Playwright storage state**: `{ cookies, origins }`. `origins` is dropped
 *   on purpose - the import is cookies only, and a localStorage blob from
 *   another browser has no origin here to be lent to.
 *
 * This is the way through for the jars no on-disk reader can open: Windows
 * Chrome under App-Bound Encryption, and Linux desktops with KWallet only.
 */

export type CookieFileParse =
  | { readonly ok: true; readonly rows: readonly ImportCookieRow[] }
  | { readonly ok: false };

const NETSCAPE_HTTP_ONLY_PREFIX = "#HttpOnly_";
const NETSCAPE_FIELD_COUNT = 7;

export function parseCookieFile(text: string): CookieFileParse {
  const trimmed = text.replace(/^\uFEFF/u, "").trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseJsonCookieFile(trimmed);
  }
  return parseNetscapeCookieFile(trimmed);
}

function parseNetscapeCookieFile(text: string): CookieFileParse {
  const rows: ImportCookieRow[] = [];
  let sawRow = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine;
    let httpOnly = false;
    if (line.startsWith(NETSCAPE_HTTP_ONLY_PREFIX)) {
      httpOnly = true;
      line = line.slice(NETSCAPE_HTTP_ONLY_PREFIX.length);
    } else if (line.startsWith("#") || line.trim().length === 0) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < NETSCAPE_FIELD_COUNT) continue;
    const [domain, includeSubdomains, path, secure, expiry, name, ...value] =
      fields;
    if (
      domain === undefined ||
      includeSubdomains === undefined ||
      path === undefined ||
      secure === undefined ||
      expiry === undefined ||
      name === undefined
    ) {
      continue;
    }
    sawRow = true;
    const expires = Number.parseInt(expiry, 10);
    rows.push({
      // The flag column, not the dot, is the format's statement of scope:
      // the extensions write both consistently, but the flag is the field the
      // format defines.
      domain: withDomainScope(
        domain,
        includeSubdomains.toUpperCase() === "TRUE",
      ),
      name,
      path,
      expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
      secure: secure.toUpperCase() === "TRUE",
      httpOnly,
      sameSite: "Lax",
      partitioned: false,
      // A value containing a tab is not representable in this format, but a
      // file that has one is better read whole than cut at the tab.
      secret: { kind: "plain", value: value.join("\t") },
    });
  }
  return sawRow ? { ok: true, rows } : { ok: false };
}

const cookieEditorCookieSchema = z.object({
  domain: z.string(),
  name: z.string(),
  value: z.string(),
  path: z.string().default("/"),
  expirationDate: z.number().nullable().default(null),
  hostOnly: z.boolean().default(false),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  // The extension writes Chrome's own spelling (`lax`, `strict`,
  // `no_restriction`, `unspecified`); some exports carry null.
  sameSite: z.string().nullable().default(null),
  session: z.boolean().default(false),
  // The extension serialises Chrome's own `cookies.Cookie`, whose
  // `partitionKey` is `{ topLevelSite, hasCrossSiteAncestor }` and is present
  // only on a CHIPS cookie; some exports flatten it to the top-level site.
  // Read, not stripped: a partitioned record must be flagged so the scan
  // counts it and the import leaves it out, since writing it to the
  // unpartitioned jar would widen a cookie one top-level site could read to
  // every site. Taken as `unknown` rather than a shape, so a value this
  // reader does not understand marks ITS row partitioned (left out) instead
  // of making the whole export unreadable.
  partitionKey: z.unknown().optional(),
});

/**
 * Chrome's `getAll` leaves `partitionKey` off an unpartitioned cookie, and
 * sets `{ topLevelSite }` on a CHIPS one; a flattened export writes the site
 * as a string. Absent or `null` is the only unpartitioned reading; a present
 * key whose site is empty is the one other shape a writer could use for
 * "none". Anything else present - an object without a string site, a number,
 * an array - is a shape this reader cannot vouch for, and the safe reading of
 * "maybe partitioned" is partitioned: the row is counted and left out rather
 * than written to a jar every site can read.
 */
function cookieEditorPartitioned(key: unknown): boolean {
  if (key === undefined || key === null) return false;
  if (typeof key === "string") return key.length > 0;
  if (typeof key === "object" && !Array.isArray(key) && "topLevelSite" in key) {
    const topLevelSite: unknown = key.topLevelSite;
    return typeof topLevelSite !== "string" || topLevelSite.length > 0;
  }
  return true;
}

function cookieEditorSameSite(value: string | null): ImportCookieSameSite {
  const lower = value === null ? "" : value.toLowerCase();
  if (lower === "strict") return "Strict";
  if (lower === "no_restriction" || lower === "none") return "None";
  return "Lax";
}

const cookieEditorFileSchema = z.array(cookieEditorCookieSchema);

const playwrightCookieSchema = z.object({
  domain: z.string(),
  name: z.string(),
  value: z.string(),
  path: z.string().default("/"),
  expires: z.number().default(-1),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  sameSite: z.enum(["Strict", "Lax", "None"]).default("Lax"),
  partitionKey: z.string().nullable().default(null),
});

const playwrightFileSchema = z.object({
  cookies: z.array(playwrightCookieSchema),
});

function parseJsonCookieFile(text: string): CookieFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const cookieEditor = cookieEditorFileSchema.safeParse(parsed);
  if (cookieEditor.success) {
    return {
      ok: true,
      rows: cookieEditor.data.map((cookie) => ({
        domain: withDomainScope(cookie.domain, !cookie.hostOnly),
        name: cookie.name,
        path: cookie.path,
        expires:
          cookie.session ||
          cookie.expirationDate === null ||
          cookie.expirationDate <= 0
            ? -1
            : Math.floor(cookie.expirationDate),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookieEditorSameSite(cookie.sameSite),
        partitioned: cookieEditorPartitioned(cookie.partitionKey),
        secret: { kind: "plain", value: cookie.value },
      })),
    };
  }
  const playwright = playwrightFileSchema.safeParse(parsed);
  if (playwright.success) {
    return {
      ok: true,
      rows: playwright.data.cookies.map((cookie) => ({
        // Playwright's `domain` already carries the leading dot for a domain
        // cookie: it is the storage-state wire form this jar speaks.
        domain: cookie.domain,
        name: cookie.name,
        path: cookie.path,
        expires: cookie.expires > 0 ? Math.floor(cookie.expires) : -1,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        partitioned: cookie.partitionKey !== null,
        secret: { kind: "plain", value: cookie.value },
      })),
    };
  }
  return { ok: false };
}

/** Leading dot for a domain cookie, none for host-only, whatever the file wrote. */
function withDomainScope(domain: string, includeSubdomains: boolean): string {
  const bare = domain.replace(/^\.+/u, "");
  return includeSubdomains ? `.${bare}` : bare;
}
