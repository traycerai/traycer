import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserPrimaryProfile,
  captureBrowserViewStorageState,
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

describe("captureBrowserViewStorageState", () => {
  it("captures host-only cookie scope without widening it", async () => {
    const scripts: string[] = [];
    const captured = await captureBrowserViewStorageState(
      { origin: "http://localhost:3000" },
      {
        getURL: () => "http://localhost:3000/dashboard",
        executeJavaScript: (script, userGesture) => {
          scripts.push(`${userGesture ? "gesture" : "no-gesture"}:${script}`);
          return Promise.resolve([{ name: "token", value: "abc" }]);
        },
        session: fakeSession("http://localhost:3000", [
          {
            name: "sid",
            value: "cookie",
            domain: ".localhost",
            hostOnly: true,
            path: "/",
            secure: false,
            httpOnly: true,
            session: true,
            sameSite: "lax",
          },
        ]),
      },
    );

    expect(captured).toEqual({
      storageState: {
        cookies: [
          {
            name: "sid",
            value: "cookie",
            domain: "localhost",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: "http://localhost:3000",
            localStorage: [{ name: "token", value: "abc" }],
          },
        ],
      },
      cookieCount: 1,
      cookieDomains: ["localhost"],
      localStorageCount: 1,
      localStorageAvailable: true,
      localStorageReason: null,
    });
    expect(scripts).toHaveLength(1);
  });

  it("returns cookies without inventing local storage when navigation races capture", async () => {
    let currentUrl = "https://example.test/start";
    await expect(
      captureBrowserViewStorageState(
        { origin: "https://example.test" },
        {
          getURL: () => currentUrl,
          executeJavaScript: () => {
            currentUrl = "https://other.test";
            return Promise.resolve([{ name: "stale", value: "value" }]);
          },
          session: fakeSession("https://example.test", []),
        },
      ),
    ).resolves.toMatchObject({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: false,
    });
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
  };
}

function fakeSession(
  expectedUrl: string,
  cookies: Cookie[],
): BrowserStorageSession {
  return {
    cookies: {
      get: (filter) => {
        expect(filter).toEqual({ url: expectedUrl });
        return Promise.resolve(cookies);
      },
      flushStore: () => Promise.resolve(),
      set: () => Promise.resolve(),
    },
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
