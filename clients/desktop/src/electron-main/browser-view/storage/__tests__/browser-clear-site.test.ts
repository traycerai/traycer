import type { ClearStorageDataOptions, Cookie } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
} from "../browser-cookie-change-observer";
import {
  clearBrowserSite,
  type BrowserSiteClearDependencies,
  type BrowserSiteClearSession,
} from "../browser-storage-state";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

type CookieChangeListener = (
  event: unknown,
  cookie: Cookie,
  cause: string,
  removed: boolean,
) => void;

const PARTITION = "persist:traycer-browser";

/**
 * One jar that answers both halves of the clear: the removal API the routine
 * drives, and the `changed` stream the observer listens to. They are the same
 * object in Electron, and the echo this ticket has to prevent only exists
 * because they are - a fake that split them could not show the echo at all.
 */
class FakeClearSiteSession implements BrowserSiteClearSession {
  private readonly jar: Cookie[] = [];
  private listener: CookieChangeListener | null = null;
  readonly clearedStorage: ClearStorageDataOptions[] = [];
  readonly removeCalls: { readonly url: string; readonly name: string }[] = [];
  flushes = 0;

  constructor(cookies: readonly Cookie[]) {
    this.jar.push(...cookies);
  }

  readonly cookies = {
    get: (filter: { readonly domain?: string }): Promise<Cookie[]> => {
      const domain = filter.domain;
      return Promise.resolve(
        domain === undefined
          ? [...this.jar]
          : this.jar.filter((cookie) =>
              matchesDomainFilter(cookie.domain ?? "", domain),
            ),
      );
    },
    remove: (url: string, name: string): Promise<void> => {
      this.removeCalls.push({ url, name });
      const host = new URL(url).hostname;
      const index = this.jar.findIndex(
        (cookie) =>
          cookie.name === name &&
          matchesDomainFilter(cookie.domain ?? "", host),
      );
      if (index === -1) return Promise.resolve();
      const [removed] = this.jar.splice(index, 1);
      // Chromium removes from the jar and then fires `changed`; the echo this
      // ticket suppresses is that event.
      if (removed !== undefined) this.listener?.({}, removed, "explicit", true);
      return Promise.resolve();
    },
    flushStore: (): Promise<void> => {
      this.flushes += 1;
      return Promise.resolve();
    },
    on: (_event: "changed", listener: CookieChangeListener): void => {
      this.listener = listener;
    },
    off: (_event: "changed", listener: CookieChangeListener): void => {
      if (this.listener === listener) this.listener = null;
    },
  };

  clearStorageData(options: ClearStorageDataOptions): Promise<void> {
    this.clearedStorage.push(options);
    return Promise.resolve();
  }

  names(): readonly string[] {
    return this.jar.map((cookie) => cookie.name).sort();
  }
}

/** Chromium's own `get({domain})`: the domain itself or any host under it. */
function matchesDomainFilter(
  cookieDomain: string,
  filterDomain: string,
): boolean {
  const normalized = cookieDomain.startsWith(".")
    ? cookieDomain.slice(1)
    : cookieDomain;
  return normalized === filterDomain || normalized.endsWith(`.${filterDomain}`);
}

function makeCookie(input: {
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

const SITE_JAR: readonly Cookie[] = [
  makeCookie({ name: "sid", domain: ".example.com" }),
  makeCookie({ name: "prefs", domain: "www.example.com" }),
  makeCookie({ name: "other-site", domain: "example.org" }),
  makeCookie({ name: "lookalike", domain: "notexample.com" }),
];

function makeDependencies(
  session: BrowserSiteClearSession,
  origins: readonly string[],
): BrowserSiteClearDependencies {
  return {
    getSession: () => session,
    rememberedOrigins: () => origins,
  };
}

describe("clearBrowserSite", () => {
  it("removes the site's own cookies and leaves every other site alone", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    const outcome = await clearBrowserSite(
      { partition: PARTITION, domain: "example.com" },
      makeDependencies(session, []),
    );

    expect(outcome.cookiesRemoved).toBe(2);
    // `example.org` is a different site; `notexample.com` merely ends with the
    // same characters, which is the RFC 6265 trap the scope predicate exists
    // to avoid.
    expect(session.names()).toEqual(["lookalike", "other-site"]);
  });

  it("clears localStorage for the remembered origins under the site, and no others", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    const outcome = await clearBrowserSite(
      { partition: PARTITION, domain: "example.com" },
      makeDependencies(session, [
        "https://app.example.com",
        "https://example.com",
        "https://example.org",
        "https://notexample.com",
      ]),
    );

    expect(outcome.originsCleared).toBe(2);
    expect(session.clearedStorage).toEqual([
      { origin: "https://app.example.com", storages: ["localstorage"] },
      { origin: "https://example.com", storages: ["localstorage"] },
    ]);
  });

  it("flushes the jar, so a quit right after the clear cannot resurrect it", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite(
      { partition: PARTITION, domain: "example.com" },
      makeDependencies(session, []),
    );

    expect(session.flushes).toBe(1);
  });
});

describe("clearBrowserSite delta behaviour", () => {
  function attachObserver(
    session: FakeClearSiteSession,
    deltas: BrowserPrimaryProfileDelta[],
  ): BrowserCookieChangeObserver {
    const observer = new BrowserCookieChangeObserver({
      cookies: session.cookies,
      emit: (delta) => deltas.push(delta),
      now: () => 1_000,
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    });
    observer.attach();
    return observer;
  }

  it("emits exactly one delta for the cleared site, and it is empty", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeClearSiteSession(SITE_JAR);
      const deltas: BrowserPrimaryProfileDelta[] = [];
      const observer = attachObserver(session, deltas);

      // Exactly what the IPC handler does: remove with the domain suppressed,
      // then say the one true thing about the slice.
      await observer.suppress("example.com", async () => {
        await clearBrowserSite(
          { partition: PARTITION, domain: "example.com" },
          makeDependencies(session, []),
        );
        await observer.emitDeltaNow("example.com");
      });
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 2);

      expect(deltas).toHaveLength(1);
      expect(deltas[0]?.scope).toEqual({
        kind: "domain",
        domain: "example.com",
      });
      // The complete picture of the scope: nothing left. That is what lets the
      // host tombstone by absence instead of trusting a removal list.
      expect(deltas[0]?.cookies).toEqual([]);
      observer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits no delta on the evict path - the store already knows", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeClearSiteSession(SITE_JAR);
      const deltas: BrowserPrimaryProfileDelta[] = [];
      const observer = attachObserver(session, deltas);

      await observer.suppress("example.com", () =>
        clearBrowserSite(
          { partition: PARTITION, domain: "example.com" },
          makeDependencies(session, []),
        ),
      );
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 2);

      expect(deltas).toEqual([]);
      observer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
