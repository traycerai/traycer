import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserPrimaryProfile,
  seedBrowserViewCookies,
  type BrowserPrimaryProfileCaptureDependencies,
  type BrowserPrimaryProfileOriginSnapshot,
  type BrowserStorageSession,
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

/** Mirrors `PRIMARY_PROFILE_SNAPSHOT_ORIGIN_LIMIT`, which is module-private. */
const SNAPSHOT_ORIGIN_LIMIT = 32;

describe("BrowserPrimaryProfileSnapshotCoordinator", () => {
  it("waits for prior observations and keeps the newest eight origins", async () => {
    const captureResolvers: Array<
      (snapshot: BrowserPrimaryProfileOriginSnapshot) => void
    > = [];
    const capturedOrigins: string[][] = [];
    const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
      (origins) => {
        capturedOrigins.push(origins.map((origin) => origin.origin));
        return Promise.resolve({
          status: "captured",
          storageState: {
            cookies: [],
            origins: origins.map((origin) => ({
              origin: origin.origin,
              localStorage: [...origin.localStorage],
            })),
          },
          reason: null,
        });
      },
      (origin) =>
        new Promise((resolve) => {
          captureResolvers.push((snapshot) => resolve(snapshot));
        }),
    );
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };
    for (let index = 0; index < 10; index += 1) {
      coordinator.observe(`https://origin-${index}.example/path`, webContents);
    }

    const capture = coordinator.capture();
    await Promise.resolve();
    expect(capturedOrigins).toEqual([]);
    captureResolvers.forEach((resolve, index) => {
      resolve({
        origin: `https://origin-${index}.example`,
        localStorage: [{ name: "index", value: String(index) }],
      });
    });
    await capture;

    expect(capturedOrigins).toEqual([
      [
        "https://origin-9.example",
        "https://origin-8.example",
        "https://origin-7.example",
        "https://origin-6.example",
        "https://origin-5.example",
        "https://origin-4.example",
        "https://origin-3.example",
        "https://origin-2.example",
      ],
    ]);
  });

  it("carries the seeded origins this run never navigated", async () => {
    // The host replaces its whole jar with what a capture sends, and the map
    // above only holds origins navigated in THIS process run. Without the
    // seeded half, quitting after visiting one site erases the localStorage of
    // every other origin the host was holding.
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
      (origin) =>
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
      (origin) =>
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
      (origin) =>
        Promise.resolve({
          origin,
          localStorage: [{ name: "visited", value: "this-run" }],
        }),
    );

    const seededCount = SNAPSHOT_ORIGIN_LIMIT + 10;
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
    expect(origins).toHaveLength(SNAPSHOT_ORIGIN_LIMIT);
    // Both freshly observed origins survive, ahead of every seeded one.
    expect(origins.slice(0, 2).map((entry) => entry.origin)).toEqual([
      "https://fresh-b.example",
      "https://fresh-a.example",
    ]);
    // The remainder is the seed in seed order, truncated at the cap - so the
    // last-seeded origins are the ones that age out.
    expect(origins.slice(2).map((entry) => entry.origin)).toEqual(
      Array.from(
        { length: SNAPSHOT_ORIGIN_LIMIT - 2 },
        (_unused, index) => `https://seeded-${index}.example`,
      ),
    );
  });

  it("omits an origin whose localStorage read was unavailable instead of emptying it", async () => {
    // An `[]` snapshot is indistinguishable from a genuinely empty origin, and
    // the host replaces its whole jar with what arrives - so reporting one for
    // an origin that merely could not be read ERASES it. Absent means unknown.
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
      // `captureBrowserOriginLocalStorage` answers null when the guest
      // navigated away mid-read, or the origin is not http(s).
      () => Promise.resolve(null),
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
