import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import {
  readCookieDomain,
  readCookiePath,
  type DesktopStorageCookie,
} from "../browser-storage-state";
import type { ImportCookieRow } from "./cookie-rows";

/**
 * From a reader's row to a cookie the durable jar will accept, through the
 * same validators the seed path runs (`readCookieDomain`, `readCookiePath`),
 * so nothing the import writes is a shape a later capture would refuse.
 *
 * Split in two because the scan and the import need different halves:
 * {@link classifyImportCookie} decides from metadata alone whether a row is
 * importable and which site it belongs to, and {@link normalizeImportCookie}
 * adds the value once one exists. The scan runs the first over every row and
 * the import runs both, so the site list and the write agree by construction.
 *
 * Per row, never per source: one IDN domain the URL parser rewrites, or one
 * `__Host-` cookie that breaks its own prefix rule, costs that cookie and is
 * counted, not the site beside it.
 */

export interface ImportCookieScope {
  /** Registrable domain (eTLD+1): the row of the dialog this cookie sits under. */
  readonly site: string;
  readonly domain: string;
  readonly canonicalDomain: string;
  readonly path: string;
}

export interface NormalizedImportCookie {
  readonly site: string;
  readonly cookie: DesktopStorageCookie;
}

const HOST_PREFIX = "__Host-";
const SECURE_PREFIX = "__Secure-";

/**
 * How long an imported SESSION cookie is kept, as seconds from the import.
 *
 * A session cookie (`expires: -1`) is one the source browser keeps for as
 * long as it runs - and, with session restore, across its own restarts. Set
 * into Electron's jar without an expiry it is dropped at quit, so a login
 * that rides on one (many SSO sessions do) would be gone the first time
 * Traycer restarts, while the Done step had called it saved on this machine.
 * It is given a bounded expiry instead: still the site's session to end,
 * still shorter than a source browser that restores its session, and long
 * enough that "saved" is true.
 */
export const IMPORTED_SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function classifyImportCookie(
  row: ImportCookieRow,
  nowSeconds: number,
): ImportCookieScope | null {
  // A nameless cookie is legal on the wire but not in this jar: the desktop
  // schema keys a cookie by its name and refuses an empty one.
  if (row.name.length === 0) return null;
  if (row.expires >= 0 && row.expires <= nowSeconds) return null;
  let scope: { readonly domain: string; readonly canonicalDomain: string };
  let path: string;
  try {
    scope = readCookieDomain(row.domain);
    path = readCookiePath(row.path);
  } catch {
    return null;
  }
  const site = registrableDomain(scope.canonicalDomain);
  if (site === null) return null;
  // RFC 6265bis prefix rules. A browser would never have stored a cookie that
  // breaks them, but a hand-edited file might, and Chromium rejects the set.
  if (row.name.startsWith(HOST_PREFIX)) {
    if (!row.secure || path !== "/" || scope.domain.startsWith(".")) {
      return null;
    }
  } else if (row.name.startsWith(SECURE_PREFIX) && !row.secure) {
    return null;
  }
  return {
    site,
    domain: scope.domain,
    canonicalDomain: scope.canonicalDomain,
    path,
  };
}

export function normalizeImportCookie(
  row: ImportCookieRow,
  value: string,
  nowSeconds: number,
): NormalizedImportCookie | null {
  const scope = classifyImportCookie(row, nowSeconds);
  if (scope === null) return null;
  return {
    site: scope.site,
    cookie: {
      name: row.name,
      value,
      domain: scope.domain,
      canonicalDomain: scope.canonicalDomain,
      path: scope.path,
      expires:
        row.expires < 0
          ? nowSeconds + IMPORTED_SESSION_COOKIE_TTL_SECONDS
          : row.expires,
      httpOnly: row.httpOnly,
      // `SameSite=None` without `Secure` is rejected by Chromium's setter;
      // the source browser only ever stored it secure, so this restates a
      // fact rather than widening one.
      secure: row.sameSite === "None" ? true : row.secure,
      sameSite: row.sameSite,
      // Electron's jar is unpartitioned by construction; partitioned rows
      // never reach this function (the readers flag them and the import
      // counts them instead).
      partitionKey: null,
    },
  };
}
