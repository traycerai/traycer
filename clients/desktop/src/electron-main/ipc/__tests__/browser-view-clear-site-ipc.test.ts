import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserStorageCookie } from "@traycer/protocol/host/browser/contracts";
import type { BrowserPrimaryProfileCaptureResult } from "../../browser-view/storage/browser-storage-state";

/**
 * Which jars "clear cookies for this site" and its host-driven twin reach.
 *
 * The durable `persist:` jar outlives the saved-logins pref, so a clear taken
 * while saving is OFF has to reach it anyway - otherwise the login stays on
 * disk and turning the pref back on restores the site the user cleared. The
 * jar the tiles are actually on has to be cleared too, or the open tile keeps
 * showing the site signed in. These pin both, plus the snapshot memory the
 * clear has to prune with them.
 */

interface ClearCall {
  readonly domain: string;
  readonly partition: string;
}

const fixture = vi.hoisted(() => ({
  durablePartition: "persist:traycer-browser",
  ephemeralPartition: "traycer-browser-ephemeral",
  /** Which jar `primary` guests are born into right now - the pref's answer. */
  activePartition: "persist:traycer-browser",
  clears: [] as ClearCall[],
  /** Partitions whose per-site clear rejects, so a jar can be made to fail. */
  failingSiteClears: [] as string[],
  /** Whole-jar `clearStorageData()` calls, by partition ("forget all"). */
  jarClears: [] as string[],
  /** Partitions whose whole-jar `clearStorageData()` rejects. */
  failingJarClears: [] as string[],
  forgottenOrigins: [] as string[],
  forgetAllResets: 0,
  tabRecreations: 0,
  suppressedAll: 0,
  /** What the main-process confirmation dialog answers: 1 confirms. */
  confirmAnswer: 1,
  /** Every confirmation main actually raised, by title. */
  confirmations: [] as string[],
  /** The same confirmations' body copy, which is where the domain is named. */
  confirmationMessages: [] as string[],
  /**
   * Holds every confirmation open until the test releases it, so the answer's
   * arrival - not a timer - is what orders the assertions around it.
   */
  deferConfirmations: false,
  /** Answers the confirmation currently held open, when there is one. */
  releaseConfirmation: null as (() => void) | null,
  /** Frames the handlers asked the jar-plane registry to put on a host. */
  hostFrames: [] as string[],
  trustedCertificates: [] as string[],
  /**
   * The `jar.capturePrimaryProfile` callback registration handed the jar-plane
   * registry - the ledgered wrapper under test is otherwise unreachable from
   * here, since the registry mock below does not drive it on its own.
   */
  capturePrimaryProfile: null as
    | (() => Promise<BrowserPrimaryProfileCaptureResult>)
    | null,
  /** What `primaryProfileSnapshots.capture()` answers, settable per test. */
  captureResult: {
    status: "captured",
    storageState: { cookies: [], origins: [] },
    reason: null,
  } as BrowserPrimaryProfileCaptureResult,
  /**
   * Holds the whole-jar capture read open, so a test can run a clear to
   * completion WHILE that read is still in flight - the race
   * `captureLedgeredPrimaryProfile` brackets with a before-and-after mask.
   * `null` means the read resolves immediately, as every other test wants.
   */
  captureGate: null as Promise<void> | null,
  /**
   * Holds a site's jar clear open, so a test can read a capture from INSIDE
   * the window between the ledger write and the clear actually finishing.
   */
  deferSiteClears: false,
  /** Resolves the site clear currently held open, when there is one. */
  releaseSiteClear: null as (() => void) | null,
  /**
   * A fresh userData directory per test. The forget ledger is the REAL module
   * here, and it persists: a test that leaves a clear pending (the ones that
   * make a jar fail) would otherwise have the NEXT test's registration re-run
   * that forget as its boot reconciliation, and every count below would be
   * measuring the previous test.
   */
  userDataDir: "/tmp/traycer-desktop-test-0",
}));

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(_options: unknown) {}
  }
  return {
    app: {
      getPath: (_key: string): string => fixture.userDataDir,
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    dialog: {
      showSaveDialogSync: () => undefined,
      /**
       * The destructive handlers ask ASYNCHRONOUSLY. A dialog answered while
       * main's event loop keeps turning is the point: main owns every
       * `browser.sessions` socket, and a modal that froze the loop for as long
       * as the dialog was up dropped every jar stream on the machine past the
       * pong timeout.
       */
      showMessageBox: (options: {
        readonly title: string;
        readonly message: string;
      }): Promise<{ readonly response: number }> => {
        fixture.confirmations.push(options.title);
        fixture.confirmationMessages.push(options.message);
        if (!fixture.deferConfirmations) {
          return Promise.resolve({ response: fixture.confirmAnswer });
        }
        return new Promise((resolve) => {
          fixture.releaseConfirmation = (): void => {
            resolve({ response: fixture.confirmAnswer });
          };
        });
      },
      /**
       * Present, because the download prompt genuinely cannot await its
       * answer - and loud, because nothing under test here may use it. A
       * destructive browser action that fell back to the blocking dialog would
       * pass every assertion below while freezing main, so the fall back is
       * failed here rather than measured.
       */
      showMessageBoxSync: (): number => {
        throw new Error(
          "A destructive browser action must not block main with a synchronous dialog",
        );
      },
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
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn((hostname: string) => {
    fixture.trustedCertificates.push(hostname);
    return Promise.resolve();
  }),
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BrowserViewManager: class {
    constructor(_options: unknown) {}

    readClearSiteTarget(): string {
      return "example.com";
    }

    canTrustCertificateError(): boolean {
      return true;
    }

    clearCertificateError(): void {}

    recreateNativeTabsOnCurrentPartition(): Promise<void> {
      fixture.tabRecreations += 1;
      return Promise.resolve();
    }

    dispose(): void {}
  },
}));

/**
 * A jar here is just its partition name: what matters is WHICH one each clear
 * was handed. Memoised per partition, as the real module is - the handler tells
 * the two jars apart by object identity, so equal names must be one object.
 */
vi.mock("../../browser-view/browser-session", () => {
  interface FakeSession {
    readonly partition: string;
    clearStorageData(): Promise<void>;
  }
  const sessions = new Map<string, FakeSession>();
  const ensureBrowserViewSessionForPartition = (
    partition: string,
  ): FakeSession => {
    const existing = sessions.get(partition);
    if (existing !== undefined) return existing;
    const created: FakeSession = {
      partition,
      clearStorageData: (): Promise<void> => {
        fixture.jarClears.push(partition);
        return fixture.failingJarClears.includes(partition)
          ? Promise.reject(new Error(`jar clear failed on ${partition}`))
          : Promise.resolve();
      },
    };
    sessions.set(partition, created);
    return created;
  };
  return {
    BROWSER_VIEW_PARTITION: fixture.durablePartition,
    BROWSER_VIEW_EPHEMERAL_PARTITION: fixture.ephemeralPartition,
    createBrowserViewWebPreferences: vi.fn(() => ({})),
    cancelBrowserViewDownload: vi.fn(),
    clearBrowserViewPendingCertificateError: vi.fn(),
    ensureBrowserViewSession: vi.fn(() =>
      ensureBrowserViewSessionForPartition(fixture.activePartition),
    ),
    ensureBrowserViewSessionForPartition: vi.fn(
      ensureBrowserViewSessionForPartition,
    ),
    isBrowserPrimaryProfileClearInProgress: vi.fn(() => false),
    onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
    onBrowserViewCertificateError: vi.fn(),
    onBrowserViewDownloadChange: vi.fn(),
    partitionForProfile: vi.fn(() => fixture.activePartition),
    readBrowserViewPendingCertificateError: vi.fn(() => ({
      hostname: "expired.test",
      certificate: { data: "pem" },
    })),
    registerBrowserViewWebContents: vi.fn(),
    releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
    suppressAllBrowserPrimaryProfileDeltas: vi.fn(
      (action: () => Promise<unknown>) => {
        fixture.suppressedAll += 1;
        return action();
      },
    ),
  };
});

/**
 * The jar plane's registry, as a recorder: what matters here is WHICH host
 * frames each handler produces. Clearing one site produces none - the ledger
 * write is what reaches the hosts, including the ones that are not attached -
 * while forget-all still fans out.
 */
vi.mock("../../browser-sessions/browser-sessions-owner", () => ({
  BrowserSessionsRegistry: class {
    constructor(options: {
      readonly jar: {
        readonly capturePrimaryProfile: () => Promise<BrowserPrimaryProfileCaptureResult>;
      };
    }) {
      fixture.capturePrimaryProfile = options.jar.capturePrimaryProfile;
    }

    open(): void {}

    close(): void {}

    closeWindow(): void {}

    send(
      _windowId: string,
      _key: unknown,
      frame: { readonly kind: string },
    ): void {
      fixture.hostFrames.push(frame.kind);
    }

    forgetLoginsOnEveryHost(): number {
      fixture.hostFrames.push("forgetLogins");
      return 0;
    }

    dispose(): void {}
  },
}));

vi.mock("../../browser-view/storage/browser-saved-logins", () => ({
  isBrowserSavedLoginsEnabled: vi.fn(() => true),
  setBrowserSavedLoginsEnabled: vi.fn(() => Promise.resolve(true)),
  wrapStoreKey: vi.fn(() => "wrapped"),
  unwrapStoreKey: vi.fn(() => "unwrapped"),
}));

vi.mock("../../browser-view/storage/browser-storage-state", () => ({
  BrowserPrimaryProfileSnapshotCoordinator: class {
    observe(): void {}

    retainSeededOrigins(): void {}

    rememberedOrigins(): readonly { readonly origin: string }[] {
      return [];
    }

    forgetOriginsUnder(domain: string): void {
      fixture.forgottenOrigins.push(domain);
    }

    reset(): void {
      fixture.forgetAllResets += 1;
    }

    capture(): Promise<BrowserPrimaryProfileCaptureResult> {
      const gate = fixture.captureGate;
      if (gate === null) return Promise.resolve(fixture.captureResult);
      return gate.then(() => fixture.captureResult);
    }
  },
  captureBrowserOriginLocalStorage: vi.fn(() => Promise.resolve(null)),
  captureBrowserPrimaryProfile: vi.fn(() =>
    Promise.resolve({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    }),
  ),
  clearBrowserSite: vi.fn(
    (domain: string, browserSession: { readonly partition: string }) => {
      fixture.clears.push({ domain, partition: browserSession.partition });
      if (fixture.failingSiteClears.includes(browserSession.partition)) {
        return Promise.reject(
          new Error(`site clear failed on ${browserSession.partition}`),
        );
      }
      if (fixture.deferSiteClears) {
        return new Promise<void>((resolve) => {
          fixture.releaseSiteClear = resolve;
        });
      }
      return Promise.resolve();
    },
  ),
  // The real one: the forget ledger keys its headless-origin custody set by it
  // (universal-sign-in ticket 08), and a stub id would make the set's own
  // behaviour untestable from here rather than merely unexercised.
  cookieKeyId: (key: {
    readonly domain: string;
    readonly name: string;
    readonly path: string;
  }) => `${key.domain}\u0000${key.name}\u0000${key.path}`,
}));

type InvokeHandler = (
  event: unknown,
  payload: unknown,
) => unknown | Promise<unknown>;

function makeBridge() {
  return {
    handleInvoke: vi.fn(),
    disposeFns: [] as Array<() => void>,
    windowRegistry: {
      getRecordById: vi.fn(() => null),
      on: vi.fn(),
      off: vi.fn(),
    },
    zoomController: {
      getZoomPercent: vi.fn(() => 100),
      getZoomFactor: vi.fn(() => 1),
      onChange: vi.fn(() => () => undefined),
    },
    safeSendToWindow: vi.fn(),
    fanOut: vi.fn(),
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

function findInvokeHandler(
  bridge: {
    readonly handleInvoke: {
      readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
    };
  },
  channel: string,
): InvokeHandler {
  const match = bridge.handleInvoke.mock.calls.find(
    (call) => call[0] === channel,
  );
  if (match === undefined) {
    throw new Error(`No invoke handler registered for ${channel}`);
  }
  const handler = match[1];
  if (typeof handler !== "function") {
    throw new Error(`Invoke handler for ${channel} is not a function`);
  }
  return handler as InvokeHandler;
}

const TILE_KEY = {
  viewTabId: "view-tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-session-1",
};

type DestructiveChannel =
  | "browserViewClearSavedLoginSite"
  | "browserViewClearSite"
  | "browserViewForgetLogins"
  | "browserViewTrustCertificate";

/**
 * The registered handler itself, so a test can start it and hold it mid-flight.
 * Registration is asynchronous; the handler's own path to the dialog is not.
 */
async function handlerFor(channel: DestructiveChannel): Promise<InvokeHandler> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  return findInvokeHandler(bridge, RunnerHostInvoke[channel]);
}

async function invokeHandler(
  channel: DestructiveChannel,
  payload: unknown,
): Promise<unknown> {
  return await (
    await handlerFor(channel)
  )({}, payload);
}

/** Drains the microtask queue without ordering anything by a clock. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then().then().then();
}

const LEDGER_HOST_ID = "host-1";

/**
 * The forget ledger as the hosts see it: the revision every clear must bump,
 * and the digest each live stream pushes when that revision moves. The
 * subscription is the very edge the streams hang off, so a clear that pushed
 * nothing records nothing here.
 */
async function watchForgetLedger(): Promise<{
  readonly pushedDomains: string[][];
  readonly revision: () => number;
  readonly dispose: () => void;
}> {
  const ledger =
    await import("../../browser-view/storage/browser-forget-ledger");
  const readRevision = (): number =>
    ledger.browserForgetLedgerDigestForHost(LEDGER_HOST_ID).revision;
  const pushedDomains: string[][] = [];
  const subscription = ledger.onBrowserForgetLedgerChanged(() => {
    pushedDomains.push(
      ledger
        .browserForgetLedgerDigestForHost(LEDGER_HOST_ID)
        .domains.map((entry) => entry.domain),
    );
  });
  return {
    pushedDomains,
    revision: readRevision,
    dispose: (): void => {
      subscription.dispose();
    },
  };
}

let ledgerRun = 0;

describe("clear-site IPC jar targeting", () => {
  beforeEach(() => {
    fixture.clears = [];
    fixture.failingSiteClears = [];
    fixture.jarClears = [];
    fixture.failingJarClears = [];
    fixture.forgottenOrigins = [];
    fixture.forgetAllResets = 0;
    fixture.tabRecreations = 0;
    fixture.suppressedAll = 0;
    fixture.activePartition = fixture.durablePartition;
    fixture.confirmAnswer = 1;
    fixture.confirmations = [];
    fixture.confirmationMessages = [];
    fixture.deferConfirmations = false;
    fixture.releaseConfirmation = null;
    fixture.hostFrames = [];
    fixture.trustedCertificates = [];
    fixture.capturePrimaryProfile = null;
    fixture.captureResult = {
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    };
    fixture.captureGate = null;
    fixture.deferSiteClears = false;
    fixture.releaseSiteClear = null;
    fixture.userDataDir = `/tmp/traycer-desktop-test-${ledgerRun}`;
    ledgerRun += 1;
    // With the directory, the ledger module's own in-memory state has to go
    // too - it is loaded once per module registry, not once per directory.
    vi.resetModules();
  });

  it("clears the durable jar as well as the live one when saving is off (tile menu)", async () => {
    fixture.activePartition = fixture.ephemeralPartition;

    await invokeHandler("browserViewClearSite", TILE_KEY);

    // The durable jar first: it survives the pref, so skipping it leaves the
    // login on disk for the moment saving is switched back on.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.ephemeralPartition },
    ]);
    // The retained localStorage goes after both, never before - the second
    // clear reads the same remembered origins as the first.
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
  });

  it("forgets ALL logins from the ephemeral jar too when saving is off", async () => {
    fixture.activePartition = fixture.ephemeralPartition;

    await invokeHandler("browserViewForgetLogins", undefined);

    // The ephemeral jar is not `persist:`, but it outlives the toggle for the
    // whole process run: without this the user clicks "Forget all browser
    // logins", the tiles reload, and they are still signed in until restart.
    expect(fixture.jarClears).toEqual([
      fixture.durablePartition,
      fixture.ephemeralPartition,
    ]);
    // Both clears are inside the ONE suppression window - their removals must
    // not echo back to a host that already shredded the slice - and the
    // localStorage memory is dropped before the tiles come back.
    expect(fixture.suppressedAll).toBe(1);
    expect(fixture.forgetAllResets).toBe(1);
  });

  it("confirms in main before clearing ONE saved login, and refuses a cancelled dialog", async () => {
    // H05's residual, closed by H10: a renderer looping the saved-sites list
    // used to reproduce forget-all one domain at a time with no dialog, because
    // it minted the `clearSite` frames itself. Main owns them now, so the ask
    // and the act are separated by a native dialog the renderer cannot draw
    // over.
    fixture.confirmAnswer = 0;

    const cancelled = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(cancelled).toBe(false);
    expect(fixture.confirmations).toEqual(["Clear this saved login?"]);
  });

  it("reports a confirmed saved-login clear so the settings row can hide", async () => {
    const confirmed = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(confirmed).toBe(true);
    expect(fixture.confirmations).toEqual(["Clear this saved login?"]);
  });

  it("forgets from the one shared jar when saving is on", async () => {
    await invokeHandler("browserViewForgetLogins", undefined);

    expect(fixture.jarClears).toEqual([fixture.durablePartition]);
    expect(fixture.forgetAllResets).toBe(1);
  });

  it("clears the live jar even when the durable clear fails, keeps the origins, and still rejects", async () => {
    fixture.activePartition = fixture.ephemeralPartition;
    fixture.failingSiteClears = [fixture.durablePartition];

    await expect(
      invokeHandler("browserViewClearSite", TILE_KEY),
    ).rejects.toThrow("site clear failed on persist:traycer-browser");

    // The jars hold independent copies of the same login: giving up on the
    // durable jar's failure would leave the open tile signed in.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.ephemeralPartition },
    ]);
    // The remembered origins are the only record of which localStorage a clear
    // can name, so they survive a partial clear - pruning them would make the
    // failed jar's localStorage unreachable for the rest of the run.
    expect(fixture.forgottenOrigins).toEqual([]);
  });

  it("forgets from the live jar even when the durable jar clear fails, brings the tiles back, and still rejects", async () => {
    fixture.activePartition = fixture.ephemeralPartition;
    fixture.failingJarClears = [fixture.durablePartition];

    await expect(
      invokeHandler("browserViewForgetLogins", undefined),
    ).rejects.toThrow("jar clear failed on persist:traycer-browser");

    expect(fixture.jarClears).toEqual([
      fixture.durablePartition,
      fixture.ephemeralPartition,
    ]);
    // Unlike the per-site prune, this one is unconditional: a whole-jar clear
    // names no origins, so dropping the memory starves no retry, while keeping
    // it would let the next capture re-upload what the host just shredded.
    expect(fixture.forgetAllResets).toBe(1);
    // And the tiles are back before the failure is surfaced - they are sitting
    // on a jar the host no longer holds a key for.
    expect(fixture.tabRecreations).toBe(1);
  });

  // Root cause C: both of these were renderer-callable with nothing between
  // the invoke and the irreversible act. Main asks now, and a refusal has to
  // leave the world untouched - including the forget LEDGER, which is written
  // before the first cookie goes and is what tells every host to prune.
  it("forgets nothing, and records nothing, when the confirmation is declined", async () => {
    fixture.confirmAnswer = 0;

    await invokeHandler("browserViewForgetLogins", undefined);

    expect(fixture.confirmations).toEqual(["Forget browser logins?"]);
    expect(fixture.jarClears).toEqual([]);
    expect(fixture.forgetAllResets).toBe(0);
    expect(fixture.tabRecreations).toBe(0);
  });

  it("does not trust a certificate when the confirmation is declined", async () => {
    fixture.confirmAnswer = 0;

    await invokeHandler("browserViewTrustCertificate", {
      ...TILE_KEY,
      certificateErrorId: "certificate-error-1",
    });

    expect(fixture.confirmations).toEqual(["Trust this certificate?"]);
    expect(fixture.trustedCertificates).toEqual([]);
  });

  it("trusts a certificate once the confirmation is accepted", async () => {
    await invokeHandler("browserViewTrustCertificate", {
      ...TILE_KEY,
      certificateErrorId: "certificate-error-1",
    });

    expect(fixture.trustedCertificates).toEqual(["expired.test"]);
  });

  it("clears once when saving is on and the live jar IS the durable one", async () => {
    await invokeHandler("browserViewClearSite", TILE_KEY);

    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
    ]);
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
  });

  // Settings' row and the tile menu are ONE act with one implementation. The
  // row used to send `clearSite` to whichever hosts happened to be attached
  // and touch neither the ledger nor this machine's jar, so the cookies were
  // still here and the next whole-jar capture taught every host the login
  // back. Three effects, and no frame.
  it("empties the jar, bumps the ledger and pushes a digest when Settings clears one site", async () => {
    const ledger = await watchForgetLedger();
    const before = ledger.revision();

    const confirmed = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(confirmed).toBe(true);
    // (a) this machine's own jar is actually emptied of the site.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
    ]);
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
    // (b) the ledger revision moves, which is what refuses in-flight
    // observations for the site from every host that has not acked pruning it.
    expect(ledger.revision()).toBe(before + 1);
    // (c) and that move pushes a fresh digest naming the site, which is what
    // reaches the attached hosts AND the ones that come back later.
    expect(ledger.pushedDomains).toEqual([["example.com"]]);
    // No `clearSite` frame anywhere: the digest is the whole delivery, and a
    // frame would reach only the hosts that happen to be attached right now.
    expect(fixture.hostFrames).toEqual([]);

    ledger.dispose();
  });

  // The gap `withoutUnclearedForgets` exists for: the ledger write is the
  // FIRST step of a clear, well before the jar operation it queues actually
  // finishes, so a whole-jar capture taken from inside that window must not
  // carry the site back to a host - it would re-teach exactly the login the
  // clear is in the middle of removing.
  it("omits a site's cookies from a whole-jar capture taken while its clear is recorded but still queued", async () => {
    fixture.deferSiteClears = true;
    const clearHandler = await handlerFor("browserViewClearSavedLoginSite");
    fixture.captureResult = {
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "sid",
            value: "v",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
          {
            name: "sid",
            value: "v",
            domain: "kept.test",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        origins: [],
      },
      reason: null,
    };

    const pending = clearHandler({}, { domain: "example.com" });
    // The ledger write, the serializer queue and the jar call each add their
    // own microtask hops before `clearBrowserSite` is reached and held open -
    // polled rather than counted, since that hop count is an implementation
    // detail of the serializer, not a contract of this test.
    for (let i = 0; i < 50 && fixture.clears.length === 0; i += 1) {
      await flushMicrotasks();
    }

    // The ledger write has landed - the site is recorded as forgotten - but
    // the site's own jar clear is still held open below.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
    ]);

    const capturePrimaryProfile = fixture.capturePrimaryProfile;
    if (capturePrimaryProfile === null) {
      throw new Error(
        "registration never captured the jar.capturePrimaryProfile callback",
      );
    }
    const captured = await capturePrimaryProfile();
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") {
      throw new Error("expected a captured result");
    }
    // The site whose clear is still queued is filtered out even though the
    // jar operation itself has not resolved; the site the clear never named
    // survives untouched.
    expect(
      captured.storageState.cookies.map((cookie) => cookie.domain),
    ).toEqual(["kept.test"]);

    const release = fixture.releaseSiteClear;
    if (release === null) {
      throw new Error("no site clear was queued to release");
    }
    release();
    await pending;
  });

  it("leaves the jar, the ledger and the hosts untouched when Settings' clear is cancelled", async () => {
    fixture.confirmAnswer = 0;
    const ledger = await watchForgetLedger();
    const before = ledger.revision();

    const cancelled = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(cancelled).toBe(false);
    expect(fixture.clears).toEqual([]);
    expect(ledger.revision()).toBe(before);
    expect(ledger.pushedDomains).toEqual([]);
    expect(fixture.hostFrames).toEqual([]);

    ledger.dispose();
  });

  // The tile menu was the one destructive door with no dialog: a compromised
  // renderer could navigate a tile it owns to any site and call this, signing
  // the user out of it on every machine with nothing on screen. Main names the
  // domain in the copy, from the tile's own current URL - not the caller's.
  it("names the domain in the tile clear's confirmation and mutates nothing when it is cancelled", async () => {
    fixture.confirmAnswer = 0;
    const ledger = await watchForgetLedger();
    const before = ledger.revision();

    await invokeHandler("browserViewClearSite", TILE_KEY);

    expect(fixture.confirmations).toEqual(["Clear this saved login?"]);
    expect(fixture.confirmationMessages).toEqual([
      "Sign out of example.com everywhere?",
    ]);
    expect(fixture.clears).toEqual([]);
    expect(ledger.revision()).toBe(before);

    ledger.dispose();
  });

  it("bumps the ledger and empties the jar when the tile clear is confirmed", async () => {
    const ledger = await watchForgetLedger();
    const before = ledger.revision();

    await invokeHandler("browserViewClearSite", TILE_KEY);

    expect(fixture.confirmationMessages).toEqual([
      "Sign out of example.com everywhere?",
    ]);
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
    ]);
    expect(ledger.revision()).toBe(before + 1);
    expect(ledger.pushedDomains).toEqual([["example.com"]]);

    ledger.dispose();
  });

  // The confirmation is a BOUND on when the first mutation may happen, not a
  // decoration in front of one. Nothing runs between the answer and the act
  // because the handler awaits the answer and mutates next - so an answer that
  // has not arrived has to leave the world exactly as it was.
  it("mutates nothing while the confirmation is still unanswered", async () => {
    fixture.deferConfirmations = true;
    const ledger = await watchForgetLedger();
    const before = ledger.revision();
    const forgetAll = await handlerFor("browserViewForgetLogins");

    const pending = forgetAll({}, undefined);
    await flushMicrotasks();

    // The dialog is up - the handler reached the ask...
    expect(fixture.confirmations).toEqual(["Forget browser logins?"]);
    // ...and nothing moved behind it. The ledger revision is the first
    // irreversible step: it is what tells every host to prune.
    expect(ledger.revision()).toBe(before);
    expect(ledger.pushedDomains).toEqual([]);
    expect(fixture.jarClears).toEqual([]);
    expect(fixture.hostFrames).toEqual([]);

    const release = fixture.releaseConfirmation;
    if (release === null) {
      throw new Error("No confirmation was raised to answer");
    }
    release();
    await pending;

    // Only the answer's arrival moves it.
    expect(ledger.revision()).toBe(before + 1);
    expect(fixture.jarClears).toEqual([fixture.durablePartition]);
    expect(fixture.hostFrames).toEqual(["forgetLogins"]);

    ledger.dispose();
  });

  // The gap `captureLedgeredPrimaryProfile` closes: the mask is taken from
  // BOTH sides of the asynchronous read (before AND after, unioned), because
  // a site's whole clear - record, jar clear, mark cleared - can run to
  // completion entirely inside the window the read is pending in. A mask
  // taken only before the read would have seen nothing forgotten yet; one
  // taken only after would have missed a clear that started and finished
  // inside the window. The captureResult below still holds the cookie as if
  // it were read before the clear, and the assertion is that the RETURNED
  // capture omits it anyway.
  it("masks a site whose entire clear runs to completion while the whole-jar read that started before it was recorded is still pending", async () => {
    const clearHandler = await handlerFor("browserViewClearSavedLoginSite");
    fixture.captureResult = {
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "sid",
            value: "v",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
          {
            name: "sid",
            value: "v",
            domain: "kept.test",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        origins: [],
      },
      reason: null,
    };
    // A holder rather than a `let`: the executor assigns it from inside a
    // callback, which TypeScript's narrowing cannot see.
    const releaseGate: { current: (() => void) | null } = { current: null };
    fixture.captureGate = new Promise<void>((resolve) => {
      releaseGate.current = resolve;
    });

    const capturePrimaryProfile = fixture.capturePrimaryProfile;
    if (capturePrimaryProfile === null) {
      throw new Error(
        "registration never captured the jar.capturePrimaryProfile callback",
      );
    }
    // Started first, so its mark and before-read are taken before anything
    // below runs - the read genuinely does start before the clear.
    const pendingCapture = capturePrimaryProfile();

    // The FULL clear-site handler, run to completion: confirm, record,
    // clear the jar, mark cleared - all while the read above is still gated
    // open on `fixture.captureGate`.
    const confirmed = await clearHandler({}, { domain: "example.com" });
    expect(confirmed).toBe(true);

    const release = releaseGate.current;
    if (release === null) {
      throw new Error("no capture gate was created to release");
    }
    release();

    const captured = await pendingCapture;
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") {
      throw new Error("expected a captured result");
    }
    // The site cleared during the read is masked out even though the read
    // itself never observed the clear; the site never touched is untouched.
    expect(
      captured.storageState.cookies.map((cookie) => cookie.domain),
    ).toEqual(["kept.test"]);
  });

  it("keeps a site's cookies in a whole-jar capture when nothing is cleared during the read", async () => {
    await handlerFor("browserViewClearSavedLoginSite");
    fixture.captureResult = {
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "sid",
            value: "v",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
          {
            name: "sid",
            value: "v",
            domain: "kept.test",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
            partitionKey: null,
          },
        ],
        origins: [],
      },
      reason: null,
    };

    const capturePrimaryProfile = fixture.capturePrimaryProfile;
    if (capturePrimaryProfile === null) {
      throw new Error(
        "registration never captured the jar.capturePrimaryProfile callback",
      );
    }
    const captured = await capturePrimaryProfile();

    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") {
      throw new Error("expected a captured result");
    }
    expect(
      captured.storageState.cookies.map((cookie) => cookie.domain),
    ).toEqual(["example.com", "kept.test"]);
  });
});
