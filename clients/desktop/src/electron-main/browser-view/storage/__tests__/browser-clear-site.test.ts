import type { ClearStorageDataOptions, Cookie } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
} from "../browser-cookie-change-observer";
import {
  browserStorageCookies,
  clearBrowserSite,
  type BrowserSiteClearSession,
} from "../browser-storage-state";
import {
  makeCookie,
  matchesDomainFilter,
  type CookieChangeListener,
} from "./cookie-jar-fixture";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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

  it("flushes the jar, so a quit right after the clear cannot resurrect it", async () => {
    const session = new FakeClearSiteSession(SITE_JAR);

    await clearBrowserSite("example.com", session, noOrigins);

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

  it("emits no delta on the evict path - the store already knows", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeClearSiteSession(SITE_JAR);
      const deltas: BrowserPrimaryProfileDelta[] = [];
      const observer = attachObserver(session, deltas);

      await observer.suppress("example.com", () =>
        clearBrowserSite("example.com", session, noOrigins),
      );
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 2);

      expect(deltas).toEqual([]);
      observer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
