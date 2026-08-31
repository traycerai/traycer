import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserPrimaryProfile,
  seedBrowserViewCookies,
  type BrowserPrimaryProfileCaptureDependencies,
  type BrowserPrimaryProfileOriginSnapshot,
  type BrowserStorageCaptureWebContents,
} from "../browser-storage-state";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
}));

const realState: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
};

const degradedState: BrowserCookieCryptoState = {
  mode: "degraded",
  persistence: "ephemeral",
  reason: "keychain-denied",
  storageBackend: null,
  encryptionAvailable: false,
};

describe("seedBrowserViewCookies", () => {
  it("seeds supplied cookies without replacing unrelated cookies", async () => {
    const unrelated: CookiesSetDetails = {
      url: "https://unrelated.test/",
      name: "unrelated",
      value: "keep-me",
      path: "/",
      expirationDate: undefined,
      httpOnly: false,
      secure: true,
      sameSite: "lax",
    };
    const storedCookies = new Map([[unrelated.name, unrelated]]);
    const seededCookies: CookiesSetDetails[] = [];
    const flushStore = vi.fn(async () => {});

    await seedBrowserViewCookies(
      {
        cookies: [
          { ...storageCookie("host-only"), value: "first" },
          {
            ...storageCookie("domain-cookie"),
            value: "second",
            domain: ".secure.test",
            secure: true,
            expires: 4_102_444_800,
          },
        ],
        origins: [],
      },
      {
        session: {
          cookies: {
            get: async (): Promise<Cookie[]> => [],
            set: async (details: CookiesSetDetails): Promise<void> => {
              seededCookies.push(details);
              storedCookies.set(details.name, details);
            },
            flushStore,
          },
        },
      },
    );

    expect(seededCookies).toEqual([
      {
        url: "http://example.test/",
        name: "host-only",
        value: "first",
        path: "/",
        expirationDate: undefined,
        httpOnly: false,
        secure: false,
        sameSite: "lax",
      },
      {
        url: "https://secure.test/",
        name: "domain-cookie",
        value: "second",
        domain: ".secure.test",
        path: "/",
        expirationDate: 4_102_444_800,
        httpOnly: false,
        secure: true,
        sameSite: "lax",
      },
    ]);
    expect(storedCookies.get("unrelated")).toBe(unrelated);
    expect(flushStore).toHaveBeenCalledOnce();
  });

  it.each([
    ["credentials syntax", "example.test@evil.test"],
    ["port syntax", "example.test:443"],
    ["path syntax", "example.test/path"],
    ["whitespace", "example. test"],
    ["control character", "example.test\n"],
    ["hostname normalization mismatch", "éxample.test"],
  ])("rejects cookie domain with %s before writing", async (_label, domain) => {
    const set = vi.fn();

    await expect(
      seedBrowserViewCookies(
        {
          cookies: [{ ...storageCookie("sid"), domain }],
          origins: [],
        },
        {
          session: {
            cookies: {
              get: async () => [],
              set,
              flushStore: async () => {},
            },
          },
        },
      ),
    ).rejects.toThrow("domain");

    expect(set).not.toHaveBeenCalled();
  });

  it("skips partitioned cookies rather than merging them into the unpartitioned jar", async () => {
    const seeded: string[] = [];

    await seedBrowserViewCookies(
      {
        cookies: [
          {
            ...storageCookie("partitioned"),
            partitionKey: "https://top-level.test",
          },
          storageCookie("unpartitioned"),
        ],
        origins: [],
      },
      {
        session: {
          cookies: {
            get: async () => [],
            flushStore: async () => {},
            set: async (details) => {
              seeded.push(details.name ?? "");
            },
          },
        },
      },
    );

    expect(seeded).toEqual(["unpartitioned"]);
  });

  it("writes sequentially and stops on a cookie-store failure", async () => {
    const written: string[] = [];

    await expect(
      seedBrowserViewCookies(
        {
          cookies: [
            storageCookie("first"),
            storageCookie("second"),
            storageCookie("third"),
          ],
          origins: [],
        },
        {
          session: {
            cookies: {
              get: async () => [],
              flushStore: async () => {},
              set: async (details) => {
                written.push(details.name ?? "");
                if (details.name === "second") {
                  throw new Error("set failed for second");
                }
              },
            },
          },
        },
      ),
    ).rejects.toThrow("set failed for second");

    expect(written).toEqual(["first", "second"]);
  });
});

describe("captureBrowserPrimaryProfile", () => {
  it("preserves host-only and domain cookie scope", async () => {
    const cookieGetFilters: Array<{ readonly url?: string }> = [];
    const origins = [
      {
        origin: "https://a.example",
        localStorage: [{ name: "a", value: "1" }],
      },
      {
        origin: "https://b.example",
        localStorage: [],
      },
    ];

    const result = await captureBrowserPrimaryProfile(
      origins,
      primaryCaptureDependencies(realState, cookieGetFilters, [
        {
          name: "host-only",
          value: "cookie",
          domain: ".example.com",
          hostOnly: true,
          path: "/",
          secure: true,
          httpOnly: true,
          session: true,
          sameSite: "lax",
        },
        {
          name: "domain-cookie",
          value: "cookie-domain",
          domain: ".example.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          session: true,
          sameSite: "lax",
        },
      ]),
    );

    expect(cookieGetFilters).toEqual([{}]);
    expect(result).toEqual({
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "host-only",
            value: "cookie",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
          {
            name: "domain-cookie",
            value: "cookie-domain",
            domain: ".example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        origins,
      },
      reason: null,
    });
  });

  it("short-circuits when cookie persistence is unavailable", async () => {
    const getSession = vi.fn();
    const result = await captureBrowserPrimaryProfile(
      [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "1" }],
        },
      ],
      {
        readCryptoState: () => degradedState,
        getSession,
      },
    );

    expect(result).toEqual({
      status: "unavailable",
      storageState: null,
      reason: "keychain-denied",
    });
    expect(getSession).not.toHaveBeenCalled();
  });
});

/**
 * The five coordinator tests below all wire the same capture callback
 * (record what it was called with, echo it back as a "captured" result) and
 * differ only in the origin-capture callback and the observe/seed calls that
 * follow - so that plumbing is factored into this one local factory.
 */
function createTestCoordinator(
  captureOrigin: (
    origin: string,
    webContents: BrowserStorageCaptureWebContents,
  ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>,
): {
  readonly coordinator: BrowserPrimaryProfileSnapshotCoordinator;
  readonly captured: Array<readonly BrowserPrimaryProfileOriginSnapshot[]>;
} {
  const captured: Array<readonly BrowserPrimaryProfileOriginSnapshot[]> = [];
  const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) => {
      captured.push(origins);
      return Promise.resolve({
        status: "captured",
        storageState: { cookies: [], origins: [...origins] },
        reason: null,
      });
    },
    captureOrigin,
  );
  return { coordinator, captured };
}

describe("BrowserPrimaryProfileSnapshotCoordinator", () => {
  it("waits for prior observations, then orders live, demoted, and seeded tiers", async () => {
    // Maximal-break: with a pre-existing seeded origin present, this fails if
    // LRU eviction DROPS instead of demoting (origin-0/1 vanish), if the
    // demoted pair is appended after the seed instead of prepended ahead of
    // it, or if the live tier is not newest-first.
    const captureResolvers: Array<
      (snapshot: BrowserPrimaryProfileOriginSnapshot) => void
    > = [];
    const { coordinator, captured } = createTestCoordinator(
      () =>
        new Promise((resolve) => {
          captureResolvers.push((snapshot) => resolve(snapshot));
        }),
    );
    coordinator.retainSeededOrigins({
      cookies: [],
      origins: [
        {
          origin: "https://seeded.example",
          localStorage: [{ name: "seeded", value: "from-host" }],
        },
      ],
    });
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };
    for (let index = 0; index < 10; index += 1) {
      coordinator.observe(`https://origin-${index}.example/path`, webContents);
    }

    const capture = coordinator.capture();
    await Promise.resolve();
    expect(captured).toEqual([]);
    captureResolvers.forEach((resolve, index) => {
      resolve({
        origin: `https://origin-${index}.example`,
        localStorage: [{ name: "index", value: String(index) }],
      });
    });
    await capture;

    // Three tiers in order: the 8 live origins newest-first (the LRU `origins`
    // map is capped at PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT), then the
    // two DEMOTED into the seeded tier by that eviction (freshest demotion
    // first), then the pre-existing seed the run never navigated.
    expect(
      captured.map((origins) => origins.map((origin) => origin.origin)),
    ).toEqual([
      [
        "https://origin-9.example",
        "https://origin-8.example",
        "https://origin-7.example",
        "https://origin-6.example",
        "https://origin-5.example",
        "https://origin-4.example",
        "https://origin-3.example",
        "https://origin-2.example",
        "https://origin-1.example",
        "https://origin-0.example",
        "https://seeded.example",
      ],
    ]);
  });

  it("carries the seeded origins this run never navigated", async () => {
    // The host replaces its whole jar with what a capture sends, and the
    // coordinator's own origin map only holds origins navigated in THIS
    // process run. Without the seeded half, quitting after visiting one site
    // erases the localStorage of every other origin the host was holding.
    const { coordinator, captured } = createTestCoordinator((origin) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "visited", value: "this-run" }],
      }),
    );

    coordinator.retainSeededOrigins({
      cookies: [],
      origins: [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "1" }],
        },
        {
          origin: "https://b.example",
          localStorage: [{ name: "b", value: "2" }],
        },
      ],
    });
    coordinator.observe("https://c.example/page", {
      getURL: () => "https://c.example/page",
      executeJavaScript: () => Promise.resolve([]),
    });

    await coordinator.capture();

    expect(captured[0]).toEqual([
      {
        origin: "https://c.example",
        localStorage: [{ name: "visited", value: "this-run" }],
      },
      {
        origin: "https://a.example",
        localStorage: [{ name: "a", value: "1" }],
      },
      {
        origin: "https://b.example",
        localStorage: [{ name: "b", value: "2" }],
      },
    ]);
  });

  it("lets a freshly observed origin win over its seeded copy", async () => {
    const { coordinator, captured } = createTestCoordinator((origin) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "a", value: "fresh" }],
      }),
    );

    coordinator.retainSeededOrigins({
      cookies: [],
      origins: [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "stale" }],
        },
      ],
    });
    coordinator.observe("https://a.example/page", {
      getURL: () => "https://a.example/page",
      executeJavaScript: () => Promise.resolve([]),
    });

    await coordinator.capture();

    expect(captured[0]).toEqual([
      {
        origin: "https://a.example",
        localStorage: [{ name: "a", value: "fresh" }],
      },
    ]);
  });

  it("bounds the carried jar so it cannot grow with every origin ever visited", async () => {
    // A capture becomes the host's whole jar and that jar is the next run's
    // seed, so an unbounded union would ratchet the localStorage blob upward
    // on every quit forever. Observed origins are kept first; the seed fills
    // the remainder in seed order and the oldest imports age out.
    const { coordinator, captured } = createTestCoordinator((origin) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "visited", value: "this-run" }],
      }),
    );

    // Mirrored, not imported: importing the production constant would make
    // this pin agree with any value the module happens to hold.
    const snapshotOriginLimit = 32;
    const seededCount = snapshotOriginLimit + 10;
    coordinator.retainSeededOrigins({
      cookies: [],
      origins: Array.from({ length: seededCount }, (_unused, index) => ({
        origin: `https://seeded-${index}.example`,
        localStorage: [{ name: "seeded", value: String(index) }],
      })),
    });
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };
    coordinator.observe("https://fresh-a.example/page", webContents);
    coordinator.observe("https://fresh-b.example/page", webContents);

    await coordinator.capture();

    const origins = captured[0] ?? [];
    expect(origins).toHaveLength(snapshotOriginLimit);
    // Both freshly observed origins survive, ahead of every seeded one.
    expect(origins.slice(0, 2).map((entry) => entry.origin)).toEqual([
      "https://fresh-b.example",
      "https://fresh-a.example",
    ]);
    // The remainder is the seed in seed order, truncated at the cap - so the
    // last-seeded origins are the ones that age out.
    expect(origins.slice(2).map((entry) => entry.origin)).toEqual(
      Array.from(
        { length: snapshotOriginLimit - 2 },
        (_unused, index) => `https://seeded-${index}.example`,
      ),
    );
  });

  it("omits an origin whose localStorage read was unavailable instead of emptying it", async () => {
    // An `[]` snapshot is indistinguishable from a genuinely empty origin, and
    // the host replaces its whole jar with what arrives - so reporting one for
    // an origin that merely could not be read ERASES it. Absent means unknown.
    // `captureBrowserOriginLocalStorage` answers null when the guest
    // navigated away mid-read, or the origin is not http(s).
    const { coordinator, captured } = createTestCoordinator(() =>
      Promise.resolve(null),
    );

    coordinator.retainSeededOrigins({
      cookies: [],
      origins: [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "kept" }],
        },
      ],
    });
    coordinator.observe("https://a.example/page", {
      getURL: () => "https://a.example/page",
      executeJavaScript: () => Promise.resolve([]),
    });

    await coordinator.capture();

    expect(captured[0]).toEqual([
      {
        origin: "https://a.example",
        localStorage: [{ name: "a", value: "kept" }],
      },
    ]);
  });

  it("reports unavailable when the captured jar holds neither a cookie nor an origin", async () => {
    const { coordinator } = createTestCoordinator(() => Promise.resolve(null));

    const result = await coordinator.capture();

    expect(result).toEqual({
      status: "unavailable",
      storageState: null,
      reason: "No browser storage has been seeded or observed yet.",
    });
  });

  it("captures the cookie jar even when nothing was seeded or observed", async () => {
    // Maximal-break: catches a pre-`captureProfile` emptiness short-circuit on
    // the coordinator's OWN origin bookkeeping. The cookie jar lives in the
    // Electron session, so bailing before the capture threw away every cookie
    // on any quit that happened to navigate nothing. Wired to the real
    // `captureBrowserPrimaryProfile` because the coordinator fixture above
    // mocks cookies out entirely.
    const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
      (origins) =>
        captureBrowserPrimaryProfile(
          origins,
          primaryCaptureDependencies(
            realState,
            [],
            [
              {
                name: "sid",
                value: "signed-in",
                domain: "example.test",
                hostOnly: true,
                path: "/",
                secure: true,
                httpOnly: true,
                session: true,
                sameSite: "lax",
              },
            ],
          ),
        ),
      () => Promise.resolve(null),
    );

    const result = await coordinator.capture();

    expect(result).toEqual({
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "sid",
            value: "signed-in",
            domain: "example.test",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        origins: [],
      },
      reason: null,
    });
  });
});

function storageCookie(name: string): {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "Lax";
  readonly partitionKey: null;
} {
  return {
    name,
    value: `${name}-value`,
    domain: "example.test",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
    partitionKey: null,
  };
}

function primaryCaptureDependencies(
  cryptoState: BrowserCookieCryptoState,
  cookieGetFilters: Array<{ readonly url?: string }>,
  cookies: Cookie[],
): BrowserPrimaryProfileCaptureDependencies {
  return {
    readCryptoState: () => cryptoState,
    getSession: () => ({
      cookies: {
        get: (filter) => {
          cookieGetFilters.push(filter);
          return Promise.resolve(cookies);
        },
        flushStore: () => Promise.resolve(),
        set: () => Promise.resolve(),
      },
    }),
  };
}
