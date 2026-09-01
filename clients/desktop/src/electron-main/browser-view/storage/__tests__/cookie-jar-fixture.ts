import type { Cookie } from "electron";

/** Electron's `changed` listener signature, as both jar fakes install it. */
export type CookieChangeListener = (
  event: unknown,
  cookie: Cookie,
  cause: string,
  removed: boolean,
) => void;

/** Chromium's own `get({domain})`: the domain itself or any host under it. */
export function matchesDomainFilter(
  cookieDomain: string,
  filterDomain: string,
): boolean {
  const normalized = cookieDomain.startsWith(".")
    ? cookieDomain.slice(1)
    : cookieDomain;
  return normalized === filterDomain || normalized.endsWith(`.${filterDomain}`);
}

/** A persistent cookie: it carries an expiry, so it outlives the process. */
export function makeCookie(input: {
  readonly name: string;
  readonly domain: string;
}): Cookie {
  return {
    name: input.name,
    value: `${input.name}-value`,
    domain: input.domain,
    hostOnly: !input.domain.startsWith("."),
    path: "/",
    secure: true,
    httpOnly: false,
    session: false,
    sameSite: "lax",
    expirationDate: 4_102_444_800,
  };
}

/**
 * A session cookie, exactly as Chromium reports one: `session: true` and NO
 * `expirationDate` at all. The pair is not independent in Electron - one is
 * the other's shape - and the capture path reads the absent expiry, so a
 * fixture that set both would not exercise the rule it claims to.
 */
export function makeSessionCookie(input: {
  readonly name: string;
  readonly domain: string;
}): Cookie {
  const { expirationDate: _expirationDate, ...cookie } = makeCookie(input);
  return { ...cookie, session: true };
}
