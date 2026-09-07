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

export function makeSessionCookie(input: {
  readonly name: string;
  readonly domain: string;
}): Cookie {
  const { expirationDate: _expirationDate, ...cookie } = makeCookie(input);
  return { ...cookie, session: true };
}

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

  /** Pre-existing jar state the applier never wrote, and no `changed` event. */
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
