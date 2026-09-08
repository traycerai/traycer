import type { Cookie, CookiesSetDetails } from "electron";

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

/**
 * A `primary` jar with the two Chromium behaviours the observed-sign-in apply
 * path is written against, and nothing else: setting an already-expired cookie
 * DELETES the matching one, and `set` may refuse a single cookie without
 * failing the batch around it.
 *
 * Shared by ticket 03's applier suite and ticket 07's cross-plane suite, so
 * both halves of "what the desktop does with a frame" answer to one jar rather
 * than to two stand-ins that could drift apart.
 */
export class FakeCookieJar {
  private readonly jar: Cookie[] = [];
  private listener: CookieChangeListener | null = null;
  /** Cookie names this jar refuses, standing in for Chromium's own validation. */
  private readonly refusedNames = new Set<string>();
  flushes = 0;

  set(details: CookiesSetDetails): Promise<void> {
    // Electron types the name as optional; the apply path always names one.
    const name = details.name ?? "";
    if (this.refusedNames.has(name)) {
      return Promise.reject(new Error(`jar refused ${name}`));
    }
    const cookie = toJarCookie(details);
    if (
      details.expirationDate !== undefined &&
      details.expirationDate * 1_000 <= Date.now()
    ) {
      this.removeAt(this.indexOf(cookie), cookie);
      return Promise.resolve();
    }
    const index = this.indexOf(cookie);
    if (index === -1) this.jar.push(cookie);
    else this.jar[index] = cookie;
    this.emit(cookie, false);
    return Promise.resolve();
  }

  get(filter: { readonly domain?: string }): Promise<Cookie[]> {
    const domain = filter.domain;
    return Promise.resolve(
      domain === undefined
        ? [...this.jar]
        : this.jar.filter((cookie) =>
            matchesDomainFilter(cookie.domain ?? "", domain),
          ),
    );
  }

  flushStore(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }

  on(_event: "changed", listener: CookieChangeListener): void {
    this.listener = listener;
  }

  off(_event: "changed", listener: CookieChangeListener): void {
    if (this.listener === listener) this.listener = null;
  }

  /**
   * Pre-existing jar state the applier never wrote, and no `changed` event.
   * Replaces by key like the real jar does, so seeding over a cookie an
   * earlier apply left behind models a local re-write rather than a duplicate
   * key no Chromium jar could hold.
   */
  seed(cookie: Cookie): void {
    const index = this.indexOf(cookie);
    if (index === -1) this.jar.push(cookie);
    else this.jar[index] = cookie;
  }

  refuse(name: string): void {
    this.refusedNames.add(name);
  }

  names(): readonly string[] {
    return this.jar.map((cookie) => cookie.name).sort();
  }

  find(name: string): Cookie | undefined {
    return this.jar.find((cookie) => cookie.name === name);
  }

  private removeAt(index: number, cookie: Cookie): void {
    if (index === -1) return;
    this.jar.splice(index, 1);
    this.emit(cookie, true);
  }

  /**
   * Chromium replaces by (name, domain, path) with the domain taken RAW: a
   * leading dot is the difference between a host-only cookie and a domain
   * cookie, and a real jar holds both rows at once. Trimming it here collapsed
   * them into one, which made every ownership and delta test blind to exactly
   * the pair the production key spells apart.
   */
  private indexOf(cookie: Cookie): number {
    return this.jar.findIndex(
      (existing) =>
        existing.name === cookie.name &&
        existing.domain === cookie.domain &&
        existing.path === cookie.path,
    );
  }

  private emit(cookie: Cookie, removed: boolean): void {
    this.listener?.({}, cookie, "explicit", removed);
  }
}

function toJarCookie(details: CookiesSetDetails): Cookie {
  const hostOnly = details.domain === undefined;
  return {
    name: details.name ?? "",
    value: details.value ?? "",
    domain: details.domain ?? new URL(details.url).hostname,
    hostOnly,
    path: details.path ?? "/",
    secure: details.secure === true,
    httpOnly: details.httpOnly === true,
    session: details.expirationDate === undefined,
    sameSite: details.sameSite ?? "no_restriction",
    expirationDate: details.expirationDate,
  };
}
