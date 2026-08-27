import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import type { DeviceFlowResult } from "@traycer-clients/shared/platform/runner-host";
import { MobileRunnerHost } from "../src/mobile-runner-host";
import {
  MobilePushRegistration,
  type CapacitorPushPermissionState,
  type PushNotificationAction,
  type PushNotificationsPluginSlice,
  type PushRegistrationError,
  type PushRegistrationToken,
} from "../src/push-registration";

const nativeMocks = vi.hoisted(() => ({
  browserOpen: vi.fn(),
  storageKeys: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
  storage: new Map<string, string>(),
}));

/**
 * The App/Network plugin event bridges, faked at the package boundary like
 * every other plugin here. Handlers are captured so a test can play the
 * NATIVE side of an edge (app-state change, network-path change) directly -
 * the web implementations of these plugins would otherwise re-derive their
 * events from the same jsdom document and make the dedupe untestable.
 */
const capacitorEventMocks = vi.hoisted(() => ({
  pauseListeners: new Array<() => void>(),
  resumeListeners: new Array<() => void>(),
  networkListeners: new Array<
    (status: { connected: boolean; connectionType: string }) => void
  >(),
  networkStatus: { connected: true, connectionType: "wifi" },
  /** When set, `Network.getStatus()` never settles until released. */
  holdNetworkSeed: false,
  releaseNetworkSeed: () => {},
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (event: string, handler: () => void) => {
      if (event === "pause") {
        capacitorEventMocks.pauseListeners.push(handler);
      } else if (event === "resume") {
        capacitorEventMocks.resumeListeners.push(handler);
      }
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  },
}));

vi.mock("@capacitor/network", () => ({
  Network: {
    getStatus: () => {
      if (!capacitorEventMocks.holdNetworkSeed) {
        return Promise.resolve(capacitorEventMocks.networkStatus);
      }
      return new Promise((resolve) => {
        capacitorEventMocks.releaseNetworkSeed = () => {
          resolve(capacitorEventMocks.networkStatus);
        };
      });
    },
    addListener: (
      _event: string,
      handler: (status: { connected: boolean; connectionType: string }) => void,
    ) => {
      capacitorEventMocks.networkListeners.push(handler);
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  },
}));

function fireAppPause(): void {
  for (const handler of capacitorEventMocks.pauseListeners) {
    handler();
  }
}

function fireAppResume(): void {
  for (const handler of capacitorEventMocks.resumeListeners) {
    handler();
  }
}

function fireNetworkStatus(status: {
  connected: boolean;
  connectionType: string;
}): void {
  for (const handler of capacitorEventMocks.networkListeners) {
    handler(status);
  }
}

vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: {
    openUrl: nativeMocks.browserOpen,
  },
}));

vi.mock("capacitor-secure-storage-plugin", () => ({
  SecureStoragePlugin: {
    keys: nativeMocks.storageKeys,
    get: nativeMocks.storageGet,
    set: nativeMocks.storageSet,
    remove: nativeMocks.storageRemove,
  },
}));

function runner(returnScheme: string | null): MobileRunnerHost {
  return new MobileRunnerHost({
    signInUrl: "http://localhost:32352/sign-in",
    authnBaseUrl: "http://localhost:32350",
    hostLabel: "test-slot",
    relayBaseUrl: "ws://localhost:8787/attach",
    fleetHostIds: null,
    // Push lifecycle is exercised in push-registration.test.ts; the host's
    // click sink with `null` is the dev-web no-op these tests always had.
    pushRegistration: null,
    openPushSettings: null,
    returnScheme,
    linkCodeScanner: null,
    deviceDescriber: null,
    linkLoginDeepLinks: null,
  });
}

/**
 * The plugin slice, faked at the package boundary as everywhere else in this
 * workspace - `MobilePushRegistration` is a plain object here, never `start()`ed,
 * so nothing below touches Capacitor.
 */
class FakePushPlugin implements PushNotificationsPluginSlice {
  permission: CapacitorPushPermissionState = "denied";
  afterRequest: CapacitorPushPermissionState = "granted";

  readonly checkPermissions = vi.fn(async () => ({ receive: this.permission }));
  readonly requestPermissions = vi.fn(async () => ({
    receive: this.afterRequest,
  }));
  readonly register = vi.fn(async (): Promise<void> => {});

  addListener(
    eventName: "registration",
    listener: (token: PushRegistrationToken) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "registrationError",
    listener: (error: PushRegistrationError) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "pushNotificationActionPerformed",
    listener: (action: PushNotificationAction) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listener:
      | ((token: PushRegistrationToken) => void)
      | ((error: PushRegistrationError) => void)
      | ((action: PushNotificationAction) => void),
  ): Promise<PluginListenerHandle> {
    void eventName;
    void listener;
    return { remove: async () => {} };
  }
}

function phoneRunner(input: {
  readonly plugin: FakePushPlugin;
  /** `null` stands in for a platform with no OS settings page (dev web). */
  readonly openPushSettings: (() => Promise<void>) | null;
}): MobileRunnerHost {
  return new MobileRunnerHost({
    signInUrl: "http://localhost:32352/sign-in",
    authnBaseUrl: "http://localhost:32350",
    hostLabel: "test-slot",
    relayBaseUrl: "ws://localhost:8787/attach",
    fleetHostIds: null,
    pushRegistration: new MobilePushRegistration({
      plugin: input.plugin,
      authnBaseUrl: "http://localhost:32350",
      platform: "ios",
      environment: "sandbox",
      registerToken: async () => ({ kind: "ok" }),
      removeToken: async () => ({ kind: "ok" }),
    }),
    openPushSettings: input.openPushSettings,
    returnScheme: "traycer",
    linkCodeScanner: null,
    deviceDescriber: null,
    linkLoginDeepLinks: null,
  });
}

describe("MobileRunnerHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorEventMocks.pauseListeners.length = 0;
    capacitorEventMocks.resumeListeners.length = 0;
    capacitorEventMocks.networkListeners.length = 0;
    capacitorEventMocks.networkStatus = {
      connected: true,
      connectionType: "wifi",
    };
    capacitorEventMocks.holdNetworkSeed = false;
    capacitorEventMocks.releaseNetworkSeed = () => {};
    nativeMocks.storage.clear();
    nativeMocks.storageKeys.mockImplementation(async () => ({
      value: [...nativeMocks.storage.keys()],
    }));
    nativeMocks.storageGet.mockImplementation(
      async ({ key }: { readonly key: string }) => ({
        value: nativeMocks.storage.get(key) ?? "",
      }),
    );
    nativeMocks.storageSet.mockImplementation(
      async ({
        key,
        value,
      }: {
        readonly key: string;
        readonly value: string;
      }) => {
        nativeMocks.storage.set(key, value);
      },
    );
    nativeMocks.storageRemove.mockImplementation(
      async ({ key }: { readonly key: string }) => {
        nativeMocks.storage.delete(key);
      },
    );
    nativeMocks.browserOpen.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats an absent secure-storage key as a signed-out session", async () => {
    const host = runner(null);

    await expect(host.tokenStore.get()).resolves.toBeNull();
    expect(nativeMocks.storageGet).not.toHaveBeenCalled();
  });

  it("persists and rotates the full credential record", async () => {
    const host = runner(null);
    const changes: unknown[] = [];
    host.tokenStore.subscribe((change) => changes.push(change));

    await host.tokenStore.signIn(
      { token: "access-token", refreshToken: "refresh-token" },
      { id: "user-1", email: "user@example.com", name: "User" },
    );

    await expect(host.tokenStore.get()).resolves.toMatchObject({
      token: "access-token",
      refreshToken: "refresh-token",
      savedAt: expect.any(String),
      user: { id: "user-1", email: "user@example.com", name: "User" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: "rotated-access-token",
          refreshToken: "rotated-refresh-token",
        }),
      ),
    );

    await expect(
      host.tokenStore.rotate({
        userId: "user-1",
        token: "access-token",
      }),
    ).resolves.toMatchObject({
      outcome: "applied",
      pair: {
        token: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
      },
    });
    expect(changes).toEqual([
      { present: true, userId: "user-1", revision: 1 },
      { present: true, userId: "user-1", revision: 2 },
    ]);
  });

  it("publishes a null local-host snapshot synchronously", () => {
    const snapshots: unknown[] = [];

    runner(null).onLocalHostChange((snapshot) => snapshots.push(snapshot));

    expect(snapshots).toEqual([null]);
  });

  it("completes poll-only device authorization and appends return_scheme to the complete URL only", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-code",
          user_code: "ABCDE-FGHIJ",
          verification_uri: "https://app.traycer.test/device",
          verification_uri_complete:
            "https://app.traycer.test/device?user_code=ABCDE-FGHIJ",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 428 }))
      .mockResolvedValueOnce(
        Response.json({ token: "access-token", refreshToken: "refresh-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const session = await runner("traycer").deviceFlow.start();
    expect(session).not.toBeNull();
    if (session === null) return;

    // Desktop parity: only the pre-filled URL the shell opens carries the
    // return scheme - the short display URI stays clean for manual entry.
    expect(session.authorization.verificationUriComplete).toBe(
      "https://app.traycer.test/device?user_code=ABCDE-FGHIJ&return_scheme=traycer",
    );
    expect(session.authorization.verificationUri).toBe(
      "https://app.traycer.test/device",
    );

    const result = new Promise<DeviceFlowResult>((resolve) => {
      session.onResult(resolve);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    session.pollNow();

    await expect(result).resolves.toEqual({
      kind: "authorized",
      token: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("leaves both verification URLs verbatim when no return scheme is registered", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-code",
          user_code: "ABCDE-FGHIJ",
          verification_uri: "https://app.traycer.test/device",
          verification_uri_complete:
            "https://app.traycer.test/device?user_code=ABCDE-FGHIJ",
          expires_in: 600,
          interval: 1,
        }),
      )
      // The session polls immediately on start; keep it parked on a
      // non-terminal response so nothing else fires before we cancel it.
      .mockResolvedValueOnce(new Response(null, { status: 428 }));
    vi.stubGlobal("fetch", fetchMock);

    const session = await runner(null).deviceFlow.start();
    expect(session).not.toBeNull();
    if (session === null) return;

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(session.authorization.verificationUriComplete).toBe(
      "https://app.traycer.test/device?user_code=ABCDE-FGHIJ",
    );
    expect(session.authorization.verificationUri).toBe(
      "https://app.traycer.test/device",
    );

    session.cancel();
  });

  describe("onSystemResumed", () => {
    // `document.visibilityState` is a getter on jsdom's `Document.prototype`;
    // shadowing it per test (and removing the shadow afterwards) is how a
    // hidden <-> visible edge is driven without a real WebView.
    let state: DocumentVisibilityState = "visible";

    beforeEach(() => {
      state = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    function setVisibility(next: DocumentVisibilityState): void {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    }

    it("does not fire on subscribe - a cold app start is not a resume", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      expect(resumes).toEqual([]);
      subscription.dispose();
    });

    it("does not fire on subscribe when the document is already visible", () => {
      state = "visible";
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      expect(resumes).toEqual([]);
      subscription.dispose();
    });

    it("fires exactly once on the hidden -> visible edge", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      setVisibility("hidden");
      expect(resumes).toEqual([]);
      setVisibility("visible");
      expect(resumes).toEqual([1]);

      subscription.dispose();
    });

    it("does not fire on the visible -> hidden edge", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      setVisibility("hidden");
      expect(resumes).toEqual([]);

      subscription.dispose();
    });

    it("does not fire when a visibilitychange arrives with the state unchanged", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      // Already visible - a repeat "visible" event is not a real edge.
      setVisibility("visible");
      expect(resumes).toEqual([]);

      subscription.dispose();
    });

    it("fires twice across two suspend/resume cycles", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      setVisibility("hidden");
      setVisibility("visible");
      setVisibility("hidden");
      setVisibility("visible");

      expect(resumes).toEqual([1, 1]);
      subscription.dispose();
    });

    it("delivers the same resume to every subscriber", () => {
      const host = runner(null);
      const firstResumes: number[] = [];
      const secondResumes: number[] = [];
      const first = host.onSystemResumed(() => firstResumes.push(1));
      const second = host.onSystemResumed(() => secondResumes.push(1));

      setVisibility("hidden");
      setVisibility("visible");

      expect(firstResumes).toEqual([1]);
      expect(secondResumes).toEqual([1]);

      first.dispose();
      second.dispose();
    });

    it("stops notifying a disposed subscriber while a still-live one keeps receiving", () => {
      const host = runner(null);
      const disposedResumes: number[] = [];
      const liveResumes: number[] = [];
      const disposedSubscription = host.onSystemResumed(() =>
        disposedResumes.push(1),
      );
      const liveSubscription = host.onSystemResumed(() => liveResumes.push(1));

      setVisibility("hidden");
      setVisibility("visible");
      disposedSubscription.dispose();

      setVisibility("hidden");
      setVisibility("visible");

      expect(disposedResumes).toEqual([1]);
      expect(liveResumes).toEqual([1, 1]);

      liveSubscription.dispose();
    });

    it("keeps notifying the other subscribers when one throws", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const host = runner(null);
      const liveResumes: number[] = [];
      const throwing = host.onSystemResumed(() => {
        throw new Error("subscriber failure");
      });
      const live = host.onSystemResumed(() => liveResumes.push(1));

      setVisibility("hidden");
      setVisibility("visible");

      expect(liveResumes).toEqual([1]);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      throwing.dispose();
      live.dispose();
      errorSpy.mockRestore();
    });

    it("fires on the native pause/resume pair when the DOM visibility edge never arrives", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));
      expect(capacitorEventMocks.pauseListeners).toHaveLength(1);
      expect(capacitorEventMocks.resumeListeners).toHaveLength(1);

      // The missed-DOM-edge suspend: the OS backgrounds and foregrounds the
      // app, and the WebView never raises visibilitychange for either side.
      fireAppPause();
      expect(resumes).toEqual([]);
      fireAppResume();
      expect(resumes).toEqual([1]);

      subscription.dispose();
    });

    it("delivers ONE resume per app switch however the two sources interleave", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      // Native-first ordering.
      fireAppPause();
      setVisibility("hidden");
      fireAppResume();
      setVisibility("visible");
      expect(resumes).toEqual([1]);

      // DOM-first ordering, foreground reports crossed.
      setVisibility("hidden");
      fireAppPause();
      setVisibility("visible");
      fireAppResume();
      expect(resumes).toEqual([1, 1]);

      subscription.dispose();
    });

    it("a native-backed episode completes on the OS's own resume, not on the DOM edge", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      setVisibility("hidden");
      fireAppPause();
      // The WebView repainting (visible) is not the OS saying the app is
      // back: the episode stays open, and the network gate stays closed.
      setVisibility("visible");
      expect(resumes).toEqual([]);
      fireAppResume();
      expect(resumes).toEqual([1]);

      subscription.dispose();
    });

    it("ignores a native resume with no background to resume from, and duplicate foreground reports", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      // Cold start noise.
      fireAppResume();
      expect(resumes).toEqual([]);

      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1]);
      // Duplicates after completion find no open episode.
      fireAppResume();
      setVisibility("visible");
      expect(resumes).toEqual([1]);

      subscription.dispose();
    });

    it("measures dwell from the native pause stamp", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(100_000);
        const host = runner(null);
        const dwells: Array<number | null> = [];
        const subscription = host.onSystemResumed((event) =>
          dwells.push(event.backgroundedForMs),
        );

        fireAppPause();
        vi.setSystemTime(100_000 + 7_500);
        fireAppResume();

        expect(dwells).toEqual([7_500]);
        subscription.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a DOM-only episode reports an UNKNOWN dwell, never a fabricated one", () => {
      // Without the OS's own pause there is no reliable real-background entry
      // stamp - the WebView going hidden proves invisibility, not
      // backgrounding - so the duration gate must fall back to its
      // conservative default rather than force-drop on invented evidence.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(100_000);
        const host = runner(null);
        const dwells: Array<number | null> = [];
        const subscription = host.onSystemResumed((event) =>
          dwells.push(event.backgroundedForMs),
        );

        setVisibility("hidden");
        vi.setSystemTime(100_000 + 60_000);
        setVisibility("visible");

        expect(dwells).toEqual([null]);
        subscription.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stamps a DOM-opened episode the moment native pause confirms it", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(100_000);
        const host = runner(null);
        const dwells: Array<number | null> = [];
        const subscription = host.onSystemResumed((event) =>
          dwells.push(event.backgroundedForMs),
        );

        setVisibility("hidden");
        vi.setSystemTime(100_000 + 1_000);
        fireAppPause();
        vi.setSystemTime(100_000 + 9_000);
        fireAppResume();

        // Measured from the native confirmation, not the earlier DOM edge.
        expect(dwells).toEqual([8_000]);
        subscription.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a source's lagging background replay from an already-completed episode", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      // A full episode both sources contributed to, completed by the OS.
      setVisibility("hidden");
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1]);

      // The event queue replays the DOM's hidden from THAT episode after the
      // app is provably active again; its own visible never arrived. Without
      // rejection this would reopen the episode and strand the tracker in
      // background - suppressing network recovery for good.
      setVisibility("hidden");
      expect(resumes).toEqual([1]);
      // The tracker still reads foreground: a real network change fires.
      // (Asserted indirectly - a NEW native episode still works end to end.)
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1, 1]);

      subscription.dispose();
    });

    it("reports a null dwell when the shell booted hidden and never saw the background edge", () => {
      // Seeded hidden at first subscribe: the state says backgrounded, but
      // there is no entry stamp to measure from - the honest answer is null,
      // which keeps the conservative default probe downstream.
      state = "hidden";
      const host = runner(null);
      const dwells: Array<number | null> = [];
      const subscription = host.onSystemResumed((event) =>
        dwells.push(event.backgroundedForMs),
      );

      setVisibility("visible");

      expect(dwells).toEqual([null]);
      subscription.dispose();
    });
  });

  describe("onNetworkPathChanged", () => {
    let state: DocumentVisibilityState = "visible";

    beforeEach(() => {
      state = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    function setVisibility(next: DocumentVisibilityState): void {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    }

    /** Subscribes and lets the async seed (`Network.getStatus`) settle. */
    async function subscribeNetwork(host: MobileRunnerHost): Promise<{
      readonly changes: number[];
      readonly dispose: () => void;
    }> {
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );
      // One macrotask beat for the `getStatus` seed promise to land.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { changes, dispose: () => subscription.dispose() };
    }

    it("fires when the connection type changes while staying connected", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      // The Wi-Fi -> cellular handoff: never offline, path moved anyway.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([1]);

      dispose();
    });

    it("fires when connectivity is regained, not when it is lost", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      fireNetworkStatus({ connected: false, connectionType: "none" });
      expect(changes).toEqual([]);
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      expect(changes).toEqual([1]);

      dispose();
    });

    it("does not fire for a repeat of the same status", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      expect(changes).toEqual([]);

      dispose();
    });

    it("buffers a change racing the baseline read - connectivity regained is not eaten as bootstrap", async () => {
      capacitorEventMocks.networkStatus = {
        connected: false,
        connectionType: "none",
      };
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // The real transition lands while `getStatus()` is still in flight.
      // Unbuffered, it would BECOME the baseline and the edge would vanish.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      expect(changes).toEqual([]);

      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));

      subscription.dispose();
    });

    it("buffers a type-change racing the baseline read", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([]);

      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));

      subscription.dispose();
    });

    it("a buffered callback matching the baseline stays silent", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // The plugin re-announcing the boot status is bootstrap, not a change.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      subscription.dispose();
    });

    it("suppresses changes while backgrounded and does not replay them on resume", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      setVisibility("hidden");
      // A backgrounded phone hopping networks must not reopen a splice
      // nobody is looking at.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([]);

      // The tracked status still advanced, so the return itself replays
      // nothing - recovery on resume belongs to the resume edge.
      setVisibility("visible");
      expect(changes).toEqual([]);

      // ...but the NEXT foreground change fires against the updated baseline.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      expect(changes).toEqual([1]);

      dispose();
    });
  });

  describe("onAuthCallback", () => {
    // Same resume source as `onSystemResumed` (see mobile-runner-host.ts):
    // the deep link that fires this carries no payload, so the app-foreground
    // edge IS the callback signal. Mirrors the fixture above exactly.
    let state: DocumentVisibilityState = "visible";

    beforeEach(() => {
      state = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    function setVisibility(next: DocumentVisibilityState): void {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    }

    it("does not fire on subscribe - a cold app start is not a callback", () => {
      const host = runner(null);
      const callbacks: number[] = [];
      const subscription = host.onAuthCallback(() => callbacks.push(1));

      expect(callbacks).toEqual([]);
      subscription.dispose();
    });

    it("fires exactly once on the hidden -> visible edge", () => {
      const host = runner(null);
      const callbacks: number[] = [];
      const subscription = host.onAuthCallback(() => callbacks.push(1));

      setVisibility("hidden");
      expect(callbacks).toEqual([]);
      setVisibility("visible");
      expect(callbacks).toEqual([1]);

      subscription.dispose();
    });

    it("stops delivering once disposed", () => {
      const host = runner(null);
      const callbacks: number[] = [];
      const subscription = host.onAuthCallback(() => callbacks.push(1));

      setVisibility("hidden");
      setVisibility("visible");
      expect(callbacks).toEqual([1]);

      subscription.dispose();

      setVisibility("hidden");
      setVisibility("visible");
      expect(callbacks).toEqual([1]);
    });

    it("shares the same resume source as onSystemResumed - both fire on one edge", () => {
      const host = runner(null);
      const authCallbacks: number[] = [];
      const systemResumes: number[] = [];
      const authSubscription = host.onAuthCallback(() => authCallbacks.push(1));
      const resumeSubscription = host.onSystemResumed(() =>
        systemResumes.push(1),
      );

      setVisibility("hidden");
      setVisibility("visible");

      expect(authCallbacks).toEqual([1]);
      expect(systemResumes).toEqual([1]);

      authSubscription.dispose();
      resumeSubscription.dispose();
    });
  });

  describe("pushPermission", () => {
    // Same visibility fixture as the resume tests above: `onChange`'s first
    // source IS the foreground-resume edge.
    let state: DocumentVisibilityState = "visible";

    beforeEach(() => {
      state = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    function setVisibility(next: DocumentVisibilityState): void {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    }

    /** For the cases where the OS-settings jump is not what is under test. */
    const OPEN_SETTINGS = async (): Promise<void> => {};

    it("is null where push itself is absent - the dev web entry", () => {
      expect(runner(null).pushPermission).toBeNull();
    });

    it("is null when no OS settings page was injected - never a dead button", () => {
      // Both halves or none: a row that can read the permission but cannot
      // open the page to repair it would offer a button that resolves
      // successfully and does nothing.
      expect(
        phoneRunner({
          plugin: new FakePushPlugin(),
          openPushSettings: null,
        }).pushPermission,
      ).toBeNull();
    });

    it("reads the OS answer through the registration object", async () => {
      const plugin = new FakePushPlugin();
      plugin.permission = "prompt-with-rationale";
      const pushPermission = phoneRunner({
        plugin,
        openPushSettings: OPEN_SETTINGS,
      }).pushPermission;
      expect(pushPermission).not.toBeNull();
      if (pushPermission === null) return;

      // Mapped to the shared vocabulary, and never a prompt.
      await expect(pushPermission.get()).resolves.toBe("prompt");
      expect(plugin.requestPermissions).not.toHaveBeenCalled();
    });

    it("fires onChange on the resume edge - the person may have just changed it in OS Settings", () => {
      const pushPermission = phoneRunner({
        plugin: new FakePushPlugin(),
        openPushSettings: OPEN_SETTINGS,
      }).pushPermission;
      expect(pushPermission).not.toBeNull();
      if (pushPermission === null) return;
      const changes: number[] = [];
      const subscription = pushPermission.onChange(() => changes.push(1));

      setVisibility("hidden");
      expect(changes).toEqual([]);
      setVisibility("visible");
      expect(changes).toEqual([1]);

      subscription.dispose();
      setVisibility("hidden");
      setVisibility("visible");
      expect(changes).toEqual([1]);
    });

    it("fires onChange after a request settles", async () => {
      const plugin = new FakePushPlugin();
      plugin.permission = "prompt";
      plugin.afterRequest = "granted";
      const pushPermission = phoneRunner({
        plugin,
        openPushSettings: OPEN_SETTINGS,
      }).pushPermission;
      expect(pushPermission).not.toBeNull();
      if (pushPermission === null) return;
      const changes: number[] = [];
      const subscription = pushPermission.onChange(() => changes.push(1));

      await expect(pushPermission.request()).resolves.toBe("granted");
      expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
      expect(changes).toEqual([1]);

      subscription.dispose();
      await pushPermission.request();
      expect(changes).toEqual([1]);
    });

    it("opens the OS page through the injected fn", async () => {
      const opened: number[] = [];
      const pushPermission = phoneRunner({
        plugin: new FakePushPlugin(),
        openPushSettings: async () => {
          opened.push(1);
        },
      }).pushPermission;
      expect(pushPermission).not.toBeNull();
      if (pushPermission === null) return;

      await pushPermission.openSettings();

      expect(opened).toEqual([1]);
    });

    it("lets an openSettings failure reach the caller's error surface", async () => {
      const pushPermission = phoneRunner({
        plugin: new FakePushPlugin(),
        openPushSettings: async () => {
          throw new Error("the OS refused");
        },
      }).pushPermission;
      expect(pushPermission).not.toBeNull();
      if (pushPermission === null) return;

      await expect(pushPermission.openSettings()).rejects.toThrow(
        "the OS refused",
      );
    });
  });
});
