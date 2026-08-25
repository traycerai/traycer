import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import type { BrowserCookieCryptoState } from "../../../ipc-contracts/browser-view-types";
import { log } from "../../app/logger";
import { BROWSER_VIEW_PARTITION } from "../browser-session";
import {
  applyBrowserViewStorageStateWithDependencies,
  captureBrowserPrimaryProfileWithDependencies,
  captureBrowserViewStorageStateWithDependencies,
  type BrowserPrimaryProfileCaptureDependencies,
  type BrowserStorageStateApplyDependencies,
  type BrowserStorageStateCaptureDependencies,
} from "../browser-storage-state";

vi.mock("electron", () => ({
  session: {
    fromPartition: () => {
      throw new Error("unexpected production electron session access");
    },
  },
  app: {
    commandLine: {
      hasSwitch: () => false,
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
}));

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

interface CookieSetDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly expirationDate: number | undefined;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "strict" | "lax" | "no_restriction";
}

const realState: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
  mockKeychainEnabled: false,
};

const degradedState: BrowserCookieCryptoState = {
  mode: "degraded",
  persistence: "ephemeral",
  reason: "mock-keychain",
  storageBackend: null,
  encryptionAvailable: false,
  mockKeychainEnabled: true,
};

const APPLY_CONTEXT = {
  sessionId: "session-test",
  tabId: "tab-test",
  purpose: "sync-back" as const,
};

describe("applyBrowserViewStorageStateWithDependencies", () => {
  let cookieSets: CookieSetDetails[];
  let cookieRemoves: Array<{ readonly url: string; readonly name: string }>;
  let fromPartitionCalls: Array<{
    readonly partition: string;
    readonly options: { readonly cache: boolean };
  }>;

  beforeEach(() => {
    cookieSets = [];
    cookieRemoves = [];
    fromPartitionCalls = [];
    vi.mocked(log.info).mockClear();
  });

  it("validates and applies cookies to the persistent browser partition", async () => {
    await expect(
      applyBrowserViewStorageStateWithDependencies(
        {
          sessionId: "session-cookie-map",
          tabId: "tab-cookie-map",
          purpose: "primary-profile-seed",
          storageState: {
            cookies: [
              {
                name: "sid",
                value: "abc",
                domain: ".example.test",
                path: "/",
                expires: 4102444800,
                httpOnly: true,
                secure: true,
                sameSite: "Lax",
              },
            ],
            origins: [
              {
                origin: "https://example.test",
                localStorage: [{ name: "theme", value: "dark" }],
              },
            ],
          },
        },
        dependencies(realState, cookieSets, fromPartitionCalls),
      ),
    ).resolves.toEqual({
      status: "applied",
      cookieCount: 1,
      localStorageApplied: false,
      reason: "cookies-only",
    });

    expect(fromPartitionCalls).toEqual([
      { partition: BROWSER_VIEW_PARTITION, options: { cache: true } },
    ]);
    expect(cookieSets).toEqual([
      {
        url: "https://example.test/",
        name: "sid",
        value: "abc",
        domain: ".example.test",
        path: "/",
        expirationDate: 4102444800,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] primary profile storage apply",
      {
        kind: "primary_profile_storage_apply",
        sessionId: "session-cookie-map",
        tabId: "tab-cookie-map",
        purpose: "primary-profile-seed",
        cookieCount: 1,
        originCount: 1,
        cookiesSet: 1,
        cookiesRemoved: 0,
        outcome: "applied",
      },
    );
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("abc");
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("dark");
  });

  it("omits host-only cookie domains while preserving dotted domain cookies", async () => {
    await applyBrowserViewStorageStateWithDependencies(
      {
        ...APPLY_CONTEXT,
        storageState: {
          cookies: [
            {
              ...storageCookie("host-only"),
              domain: "example.test",
            },
            {
              ...storageCookie("domain-cookie"),
              domain: ".example.test",
            },
          ],
          origins: [],
        },
      },
      dependencies(realState, cookieSets, fromPartitionCalls),
    );

    expect(cookieSets.map(({ name, domain }) => ({ name, domain }))).toEqual([
      { name: "host-only", domain: undefined },
      { name: "domain-cookie", domain: ".example.test" },
    ]);
    expect(cookieSets[0]).not.toHaveProperty("domain");
    expect(cookieSets[1]).toHaveProperty("domain", ".example.test");
  });

  it("removes deleted cookies, retains incoming cookies, and logs counts without values", async () => {
    const deleted = electronCookie("deleted", "secret-value");
    const retained = electronCookie("retained", "old-value");
    const nextStorageState = {
      cookies: [storageCookie("retained"), storageCookie("new")],
      origins: [],
    };

    await expect(
      applyBrowserViewStorageStateWithDependencies(
        { ...APPLY_CONTEXT, storageState: nextStorageState },
        dependenciesWithExistingCookies(
          realState,
          cookieSets,
          cookieRemoves,
          fromPartitionCalls,
          [deleted, retained],
        ),
      ),
    ).resolves.toMatchObject({
      status: "applied",
      cookieCount: 2,
      reason: "cookies-only",
    });

    expect(cookieRemoves).toEqual([
      { url: "http://example.test/", name: "deleted" },
    ]);
    expect(cookieSets.map((cookie) => cookie.name)).toEqual([
      "retained",
      "new",
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] primary profile sync-back applied",
      {
        kind: "primary_profile_sync_back",
        cookiesSet: 2,
        cookiesRemoved: 1,
      },
    );
    const logCall = vi.mocked(log.info).mock.calls.at(-1);
    expect(JSON.stringify(logCall)).not.toContain("secret-value");
    expect(JSON.stringify(logCall)).not.toContain("old-value");
  });

  it("skips persistent writes when browser cookie crypto is degraded", async () => {
    await expect(
      applyBrowserViewStorageStateWithDependencies(
        {
          ...APPLY_CONTEXT,
          storageState: {
            cookies: [
              {
                name: "sid",
                value: "abc",
                domain: "example.test",
                path: "/",
                expires: -1,
                httpOnly: false,
                secure: false,
                sameSite: "None",
              },
            ],
            origins: [],
          },
        },
        dependencies(degradedState, cookieSets, fromPartitionCalls),
      ),
    ).resolves.toEqual({
      status: "skipped-degraded",
      cookieCount: 0,
      localStorageApplied: false,
      reason: "mock-keychain",
    });

    expect(fromPartitionCalls).toEqual([]);
    expect(cookieSets).toEqual([]);
  });

  it.each([
    ["credentials syntax", "example.test@evil.test"],
    ["port syntax", "example.test:443"],
    ["path syntax", "example.test/path"],
    ["whitespace", "example. test"],
    ["control character", "example.test\n"],
    ["hostname normalization mismatch", "éxample.test"],
  ])(
    "rejects cookie domain with %s before opening the partition",
    async (_label, domain) => {
      await expect(
        applyBrowserViewStorageStateWithDependencies(
          {
            ...APPLY_CONTEXT,
            storageState: {
              cookies: [
                {
                  name: "sid",
                  value: "abc",
                  domain,
                  path: "/",
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: "Lax",
                },
              ],
              origins: [],
            },
          },
          dependencies(realState, cookieSets, fromPartitionCalls),
        ),
      ).rejects.toThrow("domain");

      expect(fromPartitionCalls).toEqual([]);
      expect(cookieSets).toEqual([]);
    },
  );

  it("rejects cookie paths that URL parsing would reshape before opening the partition", async () => {
    await expect(
      applyBrowserViewStorageStateWithDependencies(
        {
          ...APPLY_CONTEXT,
          storageState: {
            cookies: [
              {
                name: "sid",
                value: "abc",
                domain: "example.test",
                path: "/account?admin=true",
                expires: -1,
                httpOnly: false,
                secure: false,
                sameSite: "Lax",
              },
            ],
            origins: [],
          },
        },
        dependencies(realState, cookieSets, fromPartitionCalls),
      ),
    ).rejects.toThrow("path");

    expect(fromPartitionCalls).toEqual([]);
    expect(cookieSets).toEqual([]);
  });

  it("writes cookies sequentially and stops on runtime set failure", async () => {
    await expect(
      applyBrowserViewStorageStateWithDependencies(
        {
          ...APPLY_CONTEXT,
          storageState: {
            cookies: [
              storageCookie("first"),
              storageCookie("second"),
              storageCookie("third"),
            ],
            origins: [],
          },
        },
        dependenciesThatRejectCookie(
          realState,
          cookieSets,
          fromPartitionCalls,
          "second",
        ),
      ),
    ).rejects.toThrow("set failed for second");

    expect(fromPartitionCalls).toEqual([
      { partition: BROWSER_VIEW_PARTITION, options: { cache: true } },
    ]);
    expect(cookieSets.map((details) => details.name)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("captureBrowserViewStorageStateWithDependencies", () => {
  it("round-trips a host-only cookie from URL capture through native apply without widening scope", async () => {
    const calls: string[] = [];
    const appliedCookies: CookieSetDetails[] = [];
    const webContents = {
      getURL: () => "http://localhost:3000/dashboard",
      executeJavaScript: (script: string, userGesture: boolean) => {
        calls.push(`${userGesture ? "gesture" : "no-gesture"}:${script}`);
        return Promise.resolve([{ name: "token", value: "abc" }]);
      },
    };

    const captured = await captureBrowserViewStorageStateWithDependencies(
      {
        origin: "http://localhost:3000",
      },
      webContents,
      captureDependencies("http://localhost:3000", [
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
    expect(calls).toHaveLength(1);

    await applyBrowserViewStorageStateWithDependencies(
      { ...APPLY_CONTEXT, storageState: captured.storageState },
      dependencies(realState, appliedCookies, []),
    );
    expect(appliedCookies).toHaveLength(1);
    expect(appliedCookies[0]).not.toHaveProperty("domain");
  });

  it("keeps capture read-only and returns cookies when the source tile is no longer at the origin", async () => {
    await expect(
      captureBrowserViewStorageStateWithDependencies(
        {
          origin: "https://example.test",
        },
        {
          getURL: () => "https://other.test",
          executeJavaScript: () => {
            throw new Error("localStorage script should not run");
          },
        },
        captureDependencies("https://example.test", []),
      ),
    ).resolves.toMatchObject({
      storageState: {
        cookies: [],
        origins: [],
      },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: false,
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

function electronCookie(name: string, value: string): Cookie {
  return {
    name,
    value,
    domain: "example.test",
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    session: true,
    sameSite: "lax",
  };
}

function dependencies(
  cryptoState: BrowserCookieCryptoState,
  cookieSets: CookieSetDetails[],
  fromPartitionCalls: Array<{
    readonly partition: string;
    readonly options: { readonly cache: boolean };
  }>,
): BrowserStorageStateApplyDependencies {
  return {
    readCryptoState: () => cryptoState,
    fromPartition: (partition, options) => {
      fromPartitionCalls.push({ partition, options });
      return {
        cookies: {
          get: () => Promise.resolve([]),
          remove: () => Promise.resolve(),
          flushStore: () => Promise.resolve(),
          set: (details) => {
            cookieSets.push(details);
            return Promise.resolve();
          },
        },
      };
    },
  };
}

function dependenciesThatRejectCookie(
  cryptoState: BrowserCookieCryptoState,
  cookieSets: CookieSetDetails[],
  fromPartitionCalls: Array<{
    readonly partition: string;
    readonly options: { readonly cache: boolean };
  }>,
  rejectedCookieName: string,
): BrowserStorageStateApplyDependencies {
  return {
    readCryptoState: () => cryptoState,
    fromPartition: (partition, options) => {
      fromPartitionCalls.push({ partition, options });
      return {
        cookies: {
          get: () => Promise.resolve([]),
          remove: () => Promise.resolve(),
          flushStore: () => Promise.resolve(),
          set: (details) => {
            cookieSets.push(details);
            if (details.name === rejectedCookieName) {
              return Promise.reject(
                new Error(`set failed for ${rejectedCookieName}`),
              );
            }
            return Promise.resolve();
          },
        },
      };
    },
  };
}

function dependenciesWithExistingCookies(
  cryptoState: BrowserCookieCryptoState,
  cookieSets: CookieSetDetails[],
  cookieRemoves: Array<{ readonly url: string; readonly name: string }>,
  fromPartitionCalls: Array<{
    readonly partition: string;
    readonly options: { readonly cache: boolean };
  }>,
  existingCookies: Cookie[],
): BrowserStorageStateApplyDependencies {
  return {
    readCryptoState: () => cryptoState,
    fromPartition: (partition, options) => {
      fromPartitionCalls.push({ partition, options });
      return {
        cookies: {
          get: () => Promise.resolve(existingCookies),
          remove: (url, name) => {
            cookieRemoves.push({ url, name });
            return Promise.resolve();
          },
          flushStore: () => Promise.resolve(),
          set: (details) => {
            cookieSets.push(details);
            return Promise.resolve();
          },
        },
      };
    },
  };
}

function captureDependencies(
  expectedUrl: string,
  cookies: Cookie[],
): BrowserStorageStateCaptureDependencies {
  return {
    fromPartition: (partition, options) => {
      expect(partition).toBe(BROWSER_VIEW_PARTITION);
      expect(options).toEqual({ cache: true });
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
    },
  };
}

describe("captureBrowserPrimaryProfileWithDependencies", () => {
  it("round-trips partition capture through native apply without widening host-only scope", async () => {
    const cookieGetFilters: Array<{ readonly url?: string }> = [];
    const appliedCookies: CookieSetDetails[] = [];
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

    const result = await captureBrowserPrimaryProfileWithDependencies(
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
    if (result.status !== "captured") throw new Error("expected capture");

    await applyBrowserViewStorageStateWithDependencies(
      { ...APPLY_CONTEXT, storageState: result.storageState },
      dependencies(realState, appliedCookies, []),
    );
    expect(
      appliedCookies.map(({ name, domain }) => ({ name, domain })),
    ).toEqual([
      { name: "host-only", domain: undefined },
      { name: "domain-cookie", domain: ".example.com" },
    ]);
  });

  it("short-circuits unavailable on degraded crypto without reading the partition", async () => {
    const fromPartition = vi.fn();
    const result = await captureBrowserPrimaryProfileWithDependencies(
      [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "1" }],
        },
      ],
      {
        readCryptoState: () => degradedState,
        fromPartition,
      },
    );

    expect(result).toEqual({
      status: "unavailable",
      storageState: null,
      reason: "mock-keychain",
    });
    expect(fromPartition).not.toHaveBeenCalled();
  });
});

function primaryCaptureDependencies(
  cryptoState: BrowserCookieCryptoState,
  cookieGetFilters: Array<{ readonly url?: string }>,
  cookies: Cookie[],
): BrowserPrimaryProfileCaptureDependencies {
  return {
    readCryptoState: () => cryptoState,
    fromPartition: (partition, options) => {
      expect(partition).toBe(BROWSER_VIEW_PARTITION);
      expect(options).toEqual({ cache: true });
      return {
        cookies: {
          get: (filter) => {
            cookieGetFilters.push(filter);
            return Promise.resolve(cookies);
          },
          flushStore: () => Promise.resolve(),
          set: () => Promise.resolve(),
        },
      };
    },
  };
}
