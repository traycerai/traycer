import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  cookieKeyId,
  captureBrowserPrimaryProfile,
  mergeObservedProfileCookies,
  type BrowserPrimaryProfileCaptureDependencies,
  type BrowserPrimaryProfileOriginSnapshot,
  type BrowserStorageCaptureWebContents,
} from "../browser-storage-state";

/** `mergeObservedProfileCookies` is its one exported caller since H05 collapsed the seed onto it, so the case lives here. */
describe("host-contributed cookie normalisation", () => {
  it("derives the url and scope from the cookie rather than the sender", async () => {
    const written: CookiesSetDetails[] = [];
    const flushStore = vi.fn(() => Promise.resolve());

    const result = await mergeObservedProfileCookies(
      [
        {
          name: "host-only",
          value: "first",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
          partitionKey: null,
        },
        {
          name: "domain-cookie",
          value: "second",
          domain: ".secure.test",
          path: "/",
          expires: 4_102_444_800,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        },
      ],
      {
        cookies: {
          get: () => Promise.resolve([]),
          set: (details: CookiesSetDetails) => {
            written.push(details);
            return Promise.resolve();
          },
          flushStore,
        },
      },
    );

    expect(result).toEqual({ applied: 2, refused: [] });
    expect(written).toEqual([
      {
        // `http:` for an insecure cookie, `https:` for a secure one - the URL
        // is built from the cookie, never sent by the host.
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
        // The leading dot survives only as the DOMAIN attribute; a host-only
        // cookie carries none at all, which is what keeps the two forms
        // distinguishable in the jar.
        domain: ".secure.test",
        path: "/",
        expirationDate: 4_102_444_800,
        httpOnly: false,
        secure: true,
        sameSite: "lax",
      },
    ]);
    expect(flushStore).toHaveBeenCalledOnce();
  });

  it.each([
    ["credentials syntax", "example.test@evil.test"],
    ["port syntax", "example.test:443"],
    ["path syntax", "example.test/path"],
    ["whitespace", "example. test"],
    ["control character", "example.test\n"],
  ])(
    "refuses a cookie domain with %s before writing",
    async (_label, domain) => {
      const set = vi.fn();

      const result = await mergeObservedProfileCookies(
        [
          {
            name: "sid",
            value: "sid-value",
            domain,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        {
          cookies: {
            get: () => Promise.resolve([]),
            set,
            flushStore: () => Promise.resolve(),
          },
        },
      );

      // Counted, not thrown: this is untrusted remote input, and one
      // unrepresentable cookie must not cost the rest of the frame.
      expect(result.applied).toBe(0);
      expect(result.refused).toEqual([{ domain, name: "sid", path: "/" }]);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["uppercase", "Example.COM", "https://example.com/", null],
    ["trailing root dot", "example.com.", "https://example.com/", null],
    [
      // The DOMAIN attribute is canonicalised too (H11): Chromium files the
      // row under its own normalisation, so a claim spelled the sender's way
      // would never match the key the jar reads back.
      "uppercase and trailing dot",
      ".Example.COM.",
      "https://example.com/",
      ".example.com",
    ],
    ["unicode IDN", "m\u00fcnchen.de", "https://xn--mnchen-3ya.de/", null],
    ["punycode IDN", "xn--mnchen-3ya.de", "https://xn--mnchen-3ya.de/", null],
  ])(
    "canonicalises a %s cookie domain instead of dropping it",
    async (_label, domain, url, domainAttribute) => {
      const written: CookiesSetDetails[] = [];

      const result = await mergeObservedProfileCookies(
        [
          {
            name: "sid",
            value: "sid-value",
            domain,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        {
          cookies: {
            get: () => Promise.resolve([]),
            set: (details: CookiesSetDetails) => {
              written.push(details);
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        },
      );

      expect(result).toEqual({ applied: 1, refused: [] });
      expect(written).toHaveLength(1);
      expect(written[0]?.url).toBe(url);
      expect(written[0]?.domain ?? null).toBe(domainAttribute);
    },
  );

  it("V-18: refuses a partitioned (CHIPS) cookie, never writing it to the unpartitioned jar", async () => {
    // RULE: isUnpartitionedCookie refuses any cookie with a non-null partitionKey before it reaches cookies.set.
    // Its unpartitioned sibling in the same batch must still be applied.
    const written: CookiesSetDetails[] = [];

    const result = await mergeObservedProfileCookies(
      [
        {
          name: "partitioned",
          value: "chips-value",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
          partitionKey: "https://top.test",
        },
        {
          name: "unpartitioned",
          value: "ordinary-value",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        },
      ],
      {
        cookies: {
          get: () => Promise.resolve([]),
          set: (details: CookiesSetDetails) => {
            written.push(details);
            return Promise.resolve();
          },
          flushStore: () => Promise.resolve(),
        },
      },
    );

    expect(result.applied).toBe(1);
    expect(result.refused).toEqual([
      { domain: "example.test", name: "partitioned", path: "/" },
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe("unpartitioned");
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
      primaryCaptureDependencies(true, cookieGetFilters, [
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

  it("short-circuits when saved logins is turned off", async () => {
    const getSession = vi.fn();
    const result = await captureBrowserPrimaryProfile(
      [
        {
          origin: "https://a.example",
          localStorage: [{ name: "a", value: "1" }],
        },
      ],
      {
        readSaveLogins: () => false,
        getSession,
      },
    );

    expect(result).toEqual({
      status: "unavailable",
      storageState: null,
      reason: "saved-logins-off",
    });
    expect(getSession).not.toHaveBeenCalled();
  });
});

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
    // Maximal-break: with a pre-existing seeded origin present, this fails if LRU eviction DROPS instead of demoting (origin-0/1 vanish), if the demoted pair is appended after the seed.
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

  it("forgets remembered origins on reset, including an observation still in flight", async () => {
    let resolveInFlight: (
      snapshot: BrowserPrimaryProfileOriginSnapshot,
    ) => void = () => undefined;
    const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
      (origins) =>
        Promise.resolve({
          status: "captured",
          storageState: {
            cookies: [],
            origins: origins.map((origin) => ({
              origin: origin.origin,
              localStorage: [...origin.localStorage],
            })),
          },
          reason: null,
        }),
      (origin) =>
        origin === "https://settled.example"
          ? Promise.resolve({
              origin,
              localStorage: [{ name: "token", value: "kept" }],
            })
          : new Promise((resolve) => {
              resolveInFlight = resolve;
            }),
    );
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };
    coordinator.observe("https://settled.example/inbox", webContents);
    coordinator.observe("https://in-flight.example/inbox", webContents);
    await Promise.resolve();
    expect(coordinator.rememberedOrigins()).toHaveLength(1);

    coordinator.reset();
    // Read from the jar the forget is clearing: landing after the reset would
    // re-seed a recreated tile with the localStorage just forgotten.
    resolveInFlight({
      origin: "https://in-flight.example",
      localStorage: [{ name: "token", value: "stale" }],
    });
    await coordinator.capture();

    expect(coordinator.rememberedOrigins()).toEqual([]);
  });

  it("clearableOrigins names an origin whose read is still in flight", async () => {
    let resolveInFlight: (
      snapshot: BrowserPrimaryProfileOriginSnapshot,
    ) => void = () => undefined;
    const { coordinator } = createTestCoordinator(
      () =>
        new Promise((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };

    coordinator.observe("https://pending.example/inbox", webContents);

    expect(coordinator.clearableOrigins()).toEqual(["https://pending.example"]);
    expect(coordinator.rememberedOrigins()).toEqual([]);

    resolveInFlight({
      origin: "https://pending.example",
      localStorage: [{ name: "token", value: "kept" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Once the read settles it moves into the remembered tier, and
    // clearableOrigins still names it (now via rememberedOrigins) rather than
    // double-counting it as still pending.
    expect(coordinator.rememberedOrigins()).toEqual([
      {
        origin: "https://pending.example",
        localStorage: [{ name: "token", value: "kept" }],
      },
    ]);
    expect(coordinator.clearableOrigins()).toEqual(["https://pending.example"]);
  });

  it("keeps a demoted origin's fresh value when a LATER tab re-seeds the same jar", async () => {
    const { coordinator, captured } = createTestCoordinator((origin) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "value", value: "fresh" }],
      }),
    );
    const seed = {
      cookies: [],
      origins: [
        {
          origin: "https://origin-0.example",
          localStorage: [{ name: "value", value: "stale" }],
        },
      ],
    };

    coordinator.retainSeededOrigins(seed);
    const webContents = {
      getURL: () => "https://unused.example/",
      executeJavaScript: () => Promise.resolve([]),
    };
    // Nine origins against a limit of eight: `origin-0` is evicted from the
    // live map and demoted into the seeded tier carrying "fresh".
    for (let index = 0; index < 9; index += 1) {
      coordinator.observe(`https://origin-${index}.example/path`, webContents);
    }
    // Let the observations (and the eviction they trigger) settle before the
    // second tab seeds, which is the production order.
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.retainSeededOrigins(seed);

    await coordinator.capture();

    expect(
      captured[0]?.find(
        (origin) => origin.origin === "https://origin-0.example",
      ),
    ).toEqual({
      origin: "https://origin-0.example",
      localStorage: [{ name: "value", value: "fresh" }],
    });
  });

  it("carries the seeded origins this run never navigated", async () => {
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
    // The cookie jar lives in the Electron session, so bailing before the capture threw away every cookie on any quit that happened to navigate nothing.
    const coordinator = new BrowserPrimaryProfileSnapshotCoordinator(
      (origins) =>
        captureBrowserPrimaryProfile(
          origins,
          primaryCaptureDependencies(
            true,
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

function primaryCaptureDependencies(
  saveLogins: boolean,
  cookieGetFilters: Array<{ readonly url?: string }>,
  cookies: Cookie[],
): BrowserPrimaryProfileCaptureDependencies {
  return {
    readSaveLogins: () => saveLogins,
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

/** H11: the ownership ledger's key is minted from three sources that do not agree on spelling - the jar read, the applier's claim off the wire, and the observer's release. */
describe("cookieKeyId canonicalisation", () => {
  it("collapses case, a trailing root dot and IDN spelling onto one id", () => {
    const canonical = cookieKeyId({
      domain: ".example.com",
      name: "sid",
      path: "/",
    });
    for (const domain of [".Example.COM.", ".example.com.", ".EXAMPLE.com"]) {
      expect(cookieKeyId({ domain, name: "sid", path: "/" })).toBe(canonical);
    }
    expect(
      cookieKeyId({ domain: "m\u00fcnchen.de", name: "sid", path: "/" }),
    ).toBe(
      cookieKeyId({ domain: "xn--mnchen-3ya.de", name: "sid", path: "/" }),
    );
  });

  it("keeps a host-only cookie distinct from the domain cookie of the same name", () => {
    // Not a spelling: RFC 6265's leading dot is two different rows in the jar.
    expect(
      cookieKeyId({ domain: "example.com", name: "sid", path: "/" }),
    ).not.toBe(cookieKeyId({ domain: ".example.com", name: "sid", path: "/" }));
  });
});
