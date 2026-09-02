import type { ClearStorageDataOptions, Cookie } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BROWSER_COOKIE_REMOVAL_GRACE_MS,
  BrowserCookieChangeObserver,
} from "../browser-cookie-change-observer";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  browserStorageCookies,
  clearBrowserSite,
  clearBrowserSiteLocalStorage,
  type BrowserPrimaryProfileOriginSnapshot,
  type BrowserSiteClearSession,
} from "../browser-storage-state";
import {
  makeCookie,
  matchesDomainFilter,
  type CookieChangeListener,
} from "./cookie-jar-fixture";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  sanitizeLogFields: (fields: Record<string, unknown>) => fields,
  describeLogError: (error: unknown) => String(error),
}));

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

const SITE_JAR: readonly Cookie[] = [
  makeCookie({ name: "sid", domain: ".example.com" }),
  makeCookie({ name: "prefs", domain: "www.example.com" }),
  makeCookie({ name: "other-site", domain: "example.org" }),
  makeCookie({ name: "lookalike", domain: "notexample.com" }),
];

const noOrigins = (): readonly string[] => [];

/**
 * A cookie this shell cannot represent, and not a contrived one: the domain
 * check rejects any host the URL parser rewrites, and an IDN domain punycodes
 * there. Chromium will hand one over for any site the user visits.
 */
const IDN_COOKIE = makeCookie({
  name: "exämple",
  domain: "exämple.example.com",
});

describe("clearBrowserSite", () => {
  it("removes the site's own cookies and leaves every other site alone", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite("example.com", session, noOrigins);

    // `example.org` is a different site; `notexample.com` merely ends with the
    // same characters, which is the RFC 6265 trap the scope predicate exists
    // to avoid.
    expect(session.names()).toEqual(["lookalike", "other-site"]);
  });

  it("clears localStorage for the remembered origins under the site, and no others", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite("example.com", session, () => [
      "https://app.example.com",
      "https://example.com",
      "https://example.org",
      "https://notexample.com",
    ]);

    expect(session.clearedStorage).toEqual([
      { origin: "https://app.example.com", storages: ["localstorage"] },
      { origin: "https://example.com", storages: ["localstorage"] },
    ]);
  });

  it("clears the rest of the site around a cookie it cannot represent, and still flushes", async () => {
    const session = new FakeClearSiteSession([...SITE_JAR, IDN_COOKIE]);

    await clearBrowserSite("example.com", session, () => [
      "https://app.example.com",
    ]);

    // The unrepresentable cookie has no URL to remove it by, so it stays - but
    // it does not abort the clear: every other cookie of the site is gone, the
    // localStorage pass still ran, and the removals that were issued are
    // durable. Before this, one such cookie left the site half signed out with
    // its removals unflushed.
    expect(session.names()).toEqual(["exämple", "lookalike", "other-site"]);
    expect(session.clearedStorage).toEqual([
      { origin: "https://app.example.com", storages: ["localstorage"] },
    ]);
    expect(session.flushes).toBe(1);
  });

  it("flushes the jar, so a quit right after the clear cannot resurrect it", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite("example.com", session, noOrigins);

    expect(session.flushes).toBe(1);
  });
});

describe("clearBrowserSiteLocalStorage", () => {
  it("clears localStorage for the remembered origins in scope, and no others", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSiteLocalStorage("example.com", session, () => [
      "https://app.example.com",
      "https://example.com",
      "https://other.org",
    ]);

    expect(session.clearedStorage).toEqual([
      { origin: "https://app.example.com", storages: ["localstorage"] },
      { origin: "https://example.com", storages: ["localstorage"] },
    ]);
  });
});

/**
 * The coordinator holding one origin of the cleared site and one of another
 * site in EACH tier: the live tier this run observed, and the retained tier
 * carried over from the host's seed. A fixture with a single tier could not
 * tell a half-fix from a fix, since a capture merges both.
 */
async function coordinatorWithBothTiers(
  captured: Array<readonly BrowserPrimaryProfileOriginSnapshot[]>,
): Promise<BrowserPrimaryProfileSnapshotCoordinator> {
  const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) => {
      captured.push(origins);
      return Promise.resolve({
        status: "captured",
        storageState: { cookies: [], origins: [...origins] },
        reason: null,
      });
    },
    (origin) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "token", value: origin }],
      }),
  );
  coordinator.retainSeededOrigins({
    cookies: [],
    origins: [
      {
        origin: "https://seeded.example.com",
        localStorage: [{ name: "token", value: "cleared-site" }],
      },
      {
        origin: "https://seeded.example.org",
        localStorage: [{ name: "token", value: "other-site" }],
      },
    ],
  });
  const webContents = {
    getURL: () => "https://unused.example/",
    executeJavaScript: () => Promise.resolve([]),
  };
  coordinator.observe("https://app.example.com/page", webContents);
  coordinator.observe("https://app.example.org/page", webContents);
  // The only way to await the observations; the capture it takes on the way is
  // not the one under test.
  await coordinator.capture();
  captured.length = 0;
  return coordinator;
}

describe("clearBrowserSite retained origins", () => {
  it("forgets exactly the origins the clear reached, in both retained tiers", async () => {
    const captured: Array<readonly BrowserPrimaryProfileOriginSnapshot[]> = [];
    const coordinator = await coordinatorWithBothTiers(captured);
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite("example.com", session, () =>
      coordinator.rememberedOrigins().map((origin) => origin.origin),
    );
    coordinator.forgetOriginsUnder("example.com");

    // What Chromium was told to clear - one origin from each tier.
    expect(session.clearedStorage.map((options) => options.origin)).toEqual([
      "https://app.example.com",
      "https://seeded.example.com",
    ]);
    // And exactly that is what the coordinator forgot: the next capture carries
    // the other site alone, so it neither re-uploads the cleared localStorage
    // to the host nor re-seeds a recreated tile with it.
    await coordinator.capture();
    expect(
      captured.map((origins) => origins.map((entry) => entry.origin)),
    ).toEqual([["https://app.example.org", "https://seeded.example.org"]]);
  });
});

describe("clearBrowserSite against an in-flight observation", () => {
  it("drops a read of the cleared site that lands after the prune, and keeps another site's", async () => {
    const captured: Array<readonly BrowserPrimaryProfileOriginSnapshot[]> = [];
    // Every localStorage read parked until the test lets it land - the only way
    // to place a clear INSIDE a read, which is the interval the completion
    // guard has to see.
    const parkedReads = new Map<string, () => void>();
    const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
      (origins) => {
        captured.push(origins);
        return Promise.resolve({
          status: "captured",
          storageState: { cookies: [], origins: [...origins] },
          reason: null,
        });
      },
      (origin) =>
        new Promise<BrowserPrimaryProfileOriginSnapshot | null>((resolve) => {
          parkedReads.set(origin, () => {
            resolve({
              origin,
              localStorage: [{ name: "token", value: origin }],
            });
          });
        }),
    );
    const releaseRead = (origin: string): void => {
      const resolve = parkedReads.get(origin);
      if (resolve === undefined) throw new Error(`no parked read: ${origin}`);
      resolve();
    };
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };

    coordinator.observe("https://app.example.com/page", webContents);
    coordinator.observe("https://app.example.org/page", webContents);
    coordinator.forgetOriginsUnder("example.com");
    releaseRead("https://app.example.com");
    releaseRead("https://app.example.org");

    await coordinator.capture();

    // The cleared site's read landed after the prune and was dropped: keeping
    // it would re-upload the localStorage the user just cleared and re-seed it
    // into a recreated tile. The OTHER site's read is untouched - which is what
    // separates this from bumping the jar-wide era.
    expect(
      captured.map((origins) => origins.map((entry) => entry.origin)),
    ).toEqual([["https://app.example.org"]]);
    expect(
      coordinator.rememberedOrigins().map((entry) => entry.origin),
    ).toEqual(["https://app.example.org"]);
  });
});

describe("clearBrowserSite delta behaviour", () => {
  /**
   * Attached, then stepped past the observer's startup grace window: inside it
   * no removal is witnessed at all (universal-sign-in decision 7), and a clear
   * is a steady-state action. A clear that DOES fall inside the window still
   * reaches the host - `recordForgottenBrowserSite` bumps the forget ledger
   * before the jar is touched and the digest is what prunes the host's store
   * (ticket 04) - it just does not reach it through `removedKeys`.
   */
  function attachObserver(
    session: FakeClearSiteSession,
    deltas: BrowserPrimaryProfileDelta[],
  ): BrowserCookieChangeObserver {
    let now = 1_000;
    const observer = new BrowserCookieChangeObserver({
      cookies: session.cookies,
      emit: (delta) => deltas.push(delta),
      now: () => now,
      monotonicNow: () => now,
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
      onLocalCookieWrite: () => undefined,
    });
    observer.attach();
    now += BROWSER_COOKIE_REMOVAL_GRACE_MS;
    return observer;
  }

  it("emits exactly one delta for the cleared site, and it is empty", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeClearSiteSession(SITE_JAR);
      const deltas: BrowserPrimaryProfileDelta[] = [];
      const observer = attachObserver(session, deltas);

      // Exactly what the IPC handler does: remove, and let the jar's own
      // removal events coalesce into the one delta that describes the slice.
      await clearBrowserSite("example.com", session, noOrigins);
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 2);

      expect(deltas).toHaveLength(1);
      const delta = deltas[0];
      if (delta === undefined) throw new Error("expected a flushed delta");
      expect(delta.domain).toBe("example.com");
      // The complete picture of the scope: nothing left.
      expect(delta.cookies).toEqual([]);
      // And the removals are NAMED, which is the half that actually does the
      // work now (ticket 14). `example.com` is typically unwatermarked - known
      // to the host only through a whole-jar capture - and an observed empty
      // picture may not bury an unwatermarked domain. So an empty `cookies`
      // alone would tombstone nothing and "clear cookies for this site" would
      // silently do nothing to the store; it is `removedKeys` that buries.
      // Derived through the capture routine rather than spelled out, for the
      // same reason the observer's own byte-identity test does: a removal only
      // matches a stored key if the two normalise identically.
      const byName = (
        left: { readonly name: string },
        right: { readonly name: string },
      ): number => left.name.localeCompare(right.name);
      const expectedRemoved = browserStorageCookies(
        SITE_JAR.filter(
          (cookie) => cookie.name === "sid" || cookie.name === "prefs",
        ),
      )
        .map((cookie) => ({
          domain: cookie.domain,
          name: cookie.name,
          path: cookie.path,
        }))
        .sort(byName);
      // Pin the positive count first: comparing two empty arrays would pass
      // for an observer that had stopped tracking removals entirely.
      expect(expectedRemoved).toHaveLength(2);
      expect([...delta.removedKeys].sort(byName)).toEqual(expectedRemoved);
      observer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
