import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserStorageCookie,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewEnsureTab } from "../../browser-view/browser-view-port";

/**
 * The `createElectronTab` storage seed, through the same lock as the observed
 * applier (browser security review, root cause C).
 *
 * The seed used to be a bare `cookies.set` loop into `persist:traycer-browser`
 * with no domain scope, no expiry classification, no bound, no ledger gate and
 * no serializer, while the very same bytes arriving as `primaryProfileObserved`
 * got all five. These pin that it is now one door with one lock: what reaches
 * the jar is only ever what `applyBrowserObservedProfile` let through.
 *
 * The applier itself is REAL here - mocking it would leave nothing under test
 * but the shape of a call. What is faked is the jar underneath it.
 */

interface SeededCookie {
  readonly name: string;
  readonly domain: string;
}

const fixture = vi.hoisted(() => ({
  durablePartition: "persist:traycer-browser",
  /** Keys the jar already holds for the scope under test. */
  jarKeys: [] as { domain: string; name: string; path: string }[],
  /** Cookies that survived classification and reached the jar. */
  merged: [] as SeededCookie[],
  /** Origins the capture memory was told to keep localStorage for. */
  retained: [] as string[],
  /** The stream incarnation the `createElectronTab` frame claims to be on. */
  connectionId: "connection-1" as string | null,
  userDataDir: "/tmp/traycer-desktop-seed-test-0",
}));

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(_options: unknown) {}
  }
  class WebContentsView {
    readonly webContents = { id: 1, once: () => undefined };
    constructor(_options: unknown) {}
  }
  return {
    app: {
      getPath: (_key: string): string => fixture.userDataDir,
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
      // The destructive handlers ask asynchronously; nothing here raises one.
      showMessageBox: (): Promise<{ readonly response: number }> =>
        Promise.resolve({ response: 1 }),
      showMessageBoxSync: () => 1,
    },
    session: { fromPartition: () => ({}) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "unknown",
    },
  };
});

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
  describeLogError: (error: unknown) => String(error),
  sanitizeLogFields: (fields: unknown) => fields,
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn(() => Promise.resolve()),
}));

/**
 * Only the constructor options are wanted: `seedStorageState` is what the
 * provisioning path calls, and it is the unit under test.
 */
const managerOptions = vi.hoisted(() => ({
  seedStorageState: null as
    | ((
        input: BrowserViewEnsureTab,
        webContents: unknown,
      ) => Promise<BrowserStorageState | null>)
    | null,
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BOUNDS_STREAM_LOG_INTERVAL_MS: 1_000,
  BrowserViewManager: class {
    constructor(options: {
      readonly seedStorageState: (
        input: BrowserViewEnsureTab,
        webContents: unknown,
      ) => Promise<BrowserStorageState | null>;
    }) {
      managerOptions.seedStorageState = options.seedStorageState;
    }

    dispose(): void {}
  },
}));

vi.mock("../../browser-view/browser-session", () => {
  const durableSession = { partition: fixture.durablePartition };
  return {
    BROWSER_VIEW_PARTITION: fixture.durablePartition,
    createBrowserViewWebPreferences: vi.fn(() => ({})),
    cancelBrowserViewDownload: vi.fn(),
    clearBrowserViewPendingCertificateError: vi.fn(),
    ensureBrowserViewSession: vi.fn(() => durableSession),
    ensureBrowserViewSessionForPartition: vi.fn(() => durableSession),
    forgetBrowserPrimaryProfileAppliedKeys: vi.fn(),
    noteBrowserPrimaryProfileAppliedKeys: vi.fn(),
    onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
    onBrowserViewCertificateError: vi.fn(),
    onBrowserViewDownloadChange: vi.fn(),
    partitionForProfile: vi.fn(() => fixture.durablePartition),
    readBrowserViewPendingCertificateError: vi.fn(() => null),
    registerBrowserViewWebContents: vi.fn(),
    releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
    suppressAllBrowserPrimaryProfileDeltas: vi.fn(
      (action: () => Promise<unknown>) => action(),
    ),
  };
});

vi.mock("../../browser-view/storage/browser-saved-logins", () => ({
  isBrowserSavedLoginsEnabled: vi.fn(() => true),
  setBrowserSavedLoginsEnabled: vi.fn(() => Promise.resolve(true)),
  wrapStoreKey: vi.fn(() => "wrapped"),
  unwrapStoreKey: vi.fn(() => "unwrapped"),
}));

vi.mock("../../browser-view/storage/browser-storage-state", () => ({
  BrowserPrimaryProfileSnapshotCoordinator: class {
    observe(): void {}

    retainSeededOrigins(state: {
      readonly origins: readonly { readonly origin: string }[];
    }): void {
      for (const origin of state.origins) fixture.retained.push(origin.origin);
    }

    rememberedOrigins(): readonly { readonly origin: string }[] {
      return [];
    }

    forgetOriginsUnder(): void {}

    reset(): void {}
  },
  captureBrowserOriginLocalStorage: vi.fn(() => Promise.resolve(null)),
  captureBrowserPrimaryProfile: vi.fn(() =>
    Promise.resolve({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    }),
  ),
  clearBrowserSite: vi.fn(() => Promise.resolve()),
  browserJarCookieKeys: vi.fn(() => Promise.resolve(fixture.jarKeys)),
  mergeObservedProfileCookies: vi.fn((cookies: readonly SeededCookie[]) => {
    for (const cookie of cookies) {
      fixture.merged.push({ name: cookie.name, domain: cookie.domain });
    }
    return Promise.resolve({ applied: cookies.length, refused: [] });
  }),
  // The real one: the forget ledger's headless-origin custody set is keyed by
  // it, and a stub id would make the ownership rule untestable from here.
  cookieKeyId: (key: {
    readonly domain: string;
    readonly name: string;
    readonly path: string;
  }) => `${key.domain}\u0000${key.name}\u0000${key.path}`,
}));

function makeBridge() {
  return {
    handleInvoke: vi.fn(),
    disposeFns: [] as Array<() => void>,
    windowRegistry: {
      getRecordById: vi.fn(() => null),
      on: vi.fn(),
      off: vi.fn(),
    },
    safeSendToWindow: vi.fn(),
    fanOut: vi.fn(),
    markRendererUnavailable: vi.fn(),
    resolveSenderWindowId: vi.fn(() => "window-1"),
    // The jar-plane registry is built during registration (H10), so a bridge
    // double now has to answer for the host snapshot it subscribes to and the
    // auth session its bearer comes from. Nothing here dials: no stream is
    // opened unless a renderer asks for one.
    options: {
      authnBaseUrl: "https://authn.test",
      host: {
        getSnapshot: () => null,
        on: vi.fn(),
        off: vi.fn(),
      },
    },
    authSession: {
      get: () => ({ status: "signed-out", token: null, profile: null }),
      on: vi.fn(),
      off: vi.fn(),
    },
  };
}

function seedCookie(
  name: string,
  overrides: Partial<BrowserStorageCookie>,
): BrowserStorageCookie {
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
    ...overrides,
  };
}

/**
 * One seed through the real path, answering what the caller may install as a
 * localStorage document script - `null` when the seed was refused whole.
 */
async function seed(
  cookies: BrowserStorageCookie[],
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
  }[],
): Promise<BrowserStorageState | null> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  registerBrowserViewIpc(makeBridge() as never);
  const apply = managerOptions.seedStorageState;
  if (apply === null) throw new Error("The manager was given no seed path");
  return await apply(
    {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://app.example.test/inbox",
      profile: "primary",
      seedStorageState: { cookies, origins },
      connectionId: fixture.connectionId,
    },
    { session: { partition: fixture.durablePartition } },
  );
}

const ORIGIN = {
  origin: "https://app.example.test",
  localStorage: [{ name: "token", value: "carried" }],
};

let seedRun = 0;

describe("createElectronTab storage seed", () => {
  beforeEach(() => {
    fixture.jarKeys = [];
    fixture.merged = [];
    fixture.retained = [];
    fixture.connectionId = "connection-1";
    // A fresh userData directory and module registry per test: the forget
    // ledger is real and persists both on disk and in module state, so the
    // custody marks one test records must not decide the next test's
    // ownership answer.
    fixture.userDataDir = `/tmp/traycer-desktop-seed-test-${seedRun}`;
    seedRun += 1;
    vi.resetModules();
    managerOptions.seedStorageState = null;
  });

  it("drops an already-expired seed cookie instead of deleting the jar's", async () => {
    fixture.jarKeys = [{ domain: "example.test", name: "sid", path: "/" }];

    await seed(
      [seedCookie("sid", { expires: Math.floor(Date.now() / 1_000) - 60 })],
      [],
    );

    // Chromium treats setting an already-expired cookie as a DELETE of the
    // matching one, so a seed carrying the user's live session name with a
    // past expiry would sign them out. Nothing reaches the jar at all.
    expect(fixture.merged).toEqual([]);
  });

  it("refuses a name the desktop's own browsing owns and still adds a new one", async () => {
    fixture.jarKeys = [{ domain: "example.test", name: "sid", path: "/" }];

    await seed(
      [
        // The path shadow: a different Chromium key, the same name, and RFC 6265
        // orders it ahead of the desktop's in the request - an overwrite by
        // another name, which the (name, registrable domain) unit refuses.
        seedCookie("sid", { path: "/app", value: "attacker" }),
        seedCookie("prefs", {}),
      ],
      [],
    );

    expect(fixture.merged).toEqual([{ name: "prefs", domain: "example.test" }]);
  });

  it("drops a seed cookie for a site the tab is not on", async () => {
    await seed(
      [
        seedCookie("elsewhere", { domain: "victim.test" }),
        seedCookie("prefs", { domain: "sub.example.test" }),
      ],
      [],
    );

    // The tab's own origin is the seed's claim - the one fact about the write
    // no sender chose - and every cookie's registrable domain is re-derived
    // against it. A subdomain of the claim is in scope; another site is not.
    expect(fixture.merged).toEqual([
      { name: "prefs", domain: "sub.example.test" },
    ]);
  });
  it("refuses the whole seed for a site the user forgot until the sending connection acks", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");
    const ledger =
      await import("../../browser-view/storage/browser-forget-ledger");
    registerBrowserViewIpc(makeBridge() as never);
    const revision = await ledger.recordForgottenBrowserSite("example.test");

    // The user forgot this site and this connection has not yet said it
    // pruned, so the seed is exactly the resurrection the ledger gate exists
    // to refuse - including its localStorage half, which is why the caller is
    // handed nothing to install.
    expect(await seed([seedCookie("sid", {})], [ORIGIN])).toBeNull();
    expect(fixture.merged).toEqual([]);
    // Nothing retained either. These origins are what a quit capture reads
    // localStorage from and ships back to the host, so retaining a refused
    // seed's would hand the forgotten site back through the capture door -
    // which the ledger gate does not watch.
    expect(fixture.retained).toEqual([]);

    // The ack is clamped to what this connection was actually SENT, so the
    // digest has to have gone out for it to mean anything.
    await ledger.recordForgetLedgerAck({
      connectionId: "connection-1",
      hostId: "host-1",
      revision,
      sentRevision: revision,
    });

    expect(await seed([seedCookie("sid", {})], [ORIGIN])).not.toBeNull();
    expect(fixture.merged).toEqual([{ name: "sid", domain: "example.test" }]);
    expect(fixture.retained).toEqual([ORIGIN.origin]);
  });

  it("drops a seed over the shared per-frame cookie bound, whole", async () => {
    const { BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES } =
      await import("@traycer/protocol/host/browser/contracts");
    const cookies = Array.from(
      { length: BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES + 1 },
      (_unused, index) => seedCookie(`c${index}`, {}),
    );

    // Whole rather than a prefix: applying part of an over-bound seed would
    // let a sender choose which part by ordering it first.
    expect(await seed(cookies, [ORIGIN])).toBeNull();
    expect(fixture.merged).toEqual([]);
  });

  // The cookie half's verdict decides the localStorage half. A seed whose
  // every cookie names a key the desktop's own browsing already owns applied
  // nothing, so installing its localStorage would `clear()` and rewrite the
  // origin's storage for a site the cookies were just refused for - the user's
  // own session overwritten through the one door the cookie rule does not
  // watch. The applier's own outcome is still "applied", so the count is what
  // decides.
  it("installs no localStorage when every seeded cookie is one the desktop owns", async () => {
    fixture.jarKeys = [{ domain: "example.test", name: "sid", path: "/" }];

    const seeded = await seed(
      [seedCookie("sid", { path: "/app", value: "attacker" })],
      [ORIGIN],
    );

    expect(seeded).toBeNull();
    expect(fixture.merged).toEqual([]);
    expect(fixture.retained).toEqual([]);
  });

  // One unrelated cookie landing beside a refusal buys no right to clear the
  // origin: the refused key names a site the user's own browsing signed into
  // here, so its localStorage is the desktop's too and `clear()` would take
  // the very login the cookie rule just protected.
  it("installs no localStorage when any seeded cookie is one the desktop owns", async () => {
    fixture.jarKeys = [{ domain: "example.test", name: "sid", path: "/" }];

    const seeded = await seed(
      [
        seedCookie("sid", { path: "/app", value: "attacker" }),
        seedCookie("prefs", {}),
      ],
      [ORIGIN],
    );

    expect(fixture.merged).toEqual([{ name: "prefs", domain: "example.test" }]);
    expect(seeded).toBeNull();
    expect(fixture.retained).toEqual([]);
  });

  // A cookie-less seed establishes nothing about the origin, so clearing and
  // rewriting its localStorage would be an arbitrary overwrite of whatever
  // the desktop holds there.
  it("installs no localStorage for a seed that carries no cookies at all", async () => {
    const seeded = await seed([], [ORIGIN]);

    expect(seeded).toBeNull();
    expect(fixture.merged).toEqual([]);
    expect(fixture.retained).toEqual([]);
  });

  it("hands back only the tab's own site for the localStorage script", async () => {
    // The script does `localStorage.clear()` on whatever origin it matches, so
    // an unfiltered seed makes one tab an authority over every site in the
    // host's snapshot.
    const seeded = await seed(
      [seedCookie("sid", {})],
      [
        ORIGIN,
        {
          origin: "https://victim.test",
          localStorage: [{ name: "k", value: "v" }],
        },
      ],
    );

    expect(seeded?.origins).toEqual([ORIGIN]);
    expect(fixture.retained).toEqual([ORIGIN.origin]);
  });
});
