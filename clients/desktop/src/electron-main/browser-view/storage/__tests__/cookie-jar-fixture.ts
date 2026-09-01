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
    session: true,
    sameSite: "lax",
    expirationDate: 4_102_444_800,
  };
}
