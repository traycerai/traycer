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
  /** What `Capacitor.getPlatform()` reports; per-test overridable. */
  platform: "ios",
  pauseListeners: new Array<() => void>(),
  resumeListeners: new Array<() => void>(),
  appStateListeners: new Array<(state: { isActive: boolean }) => void>(),
  /** When true, `App.addListener` rejects - the no-bridge dev/web shape. */
  rejectAppListeners: false,
  networkListeners: new Array<
    (status: { connected: boolean; connectionType: string }) => void
  >(),
  networkStatus: { connected: true, connectionType: "wifi" },
  /**
   * Per-call `getStatus()` answers, consumed in order; when empty,
   * `networkStatus` answers. Lets a test give the read-listen-read bootstrap
   * DIFFERENT before/after snapshots (the unobservable-gap transition).
   */
  networkStatusQueue: new Array<{
    connected: boolean;
    connectionType: string;
  }>(),
  /** When true, `getStatus()` promises park until released. */
  holdNetworkSeed: false,
  pendingSeedReleases: new Array<() => void>(),
  releaseNetworkSeed: () => {
    capacitorEventMocks.holdNetworkSeed = false;
    for (const release of capacitorEventMocks.pendingSeedReleases.splice(0)) {
      release();
    }
  },
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => capacitorEventMocks.platform,
    },
  };
});

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (
      event: string,
      handler: ((state: { isActive: boolean }) => void) | (() => void),
    ) => {
      if (capacitorEventMocks.rejectAppListeners) {
        return Promise.reject(new Error("no plugin bridge"));
      }
      if (event === "pause") {
        capacitorEventMocks.pauseListeners.push(handler as () => void);
      } else if (event === "resume") {
        capacitorEventMocks.resumeListeners.push(handler as () => void);
      } else if (event === "appStateChange") {
        capacitorEventMocks.appStateListeners.push(
          handler as (state: { isActive: boolean }) => void,
        );
      }
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  },
}));

vi.mock("@capacitor/network", () => ({
  Network: {
    getStatus: () => {
      const answer = (): { connected: boolean; connectionType: string } =>
        capacitorEventMocks.networkStatusQueue.shift() ??
        capacitorEventMocks.networkStatus;
      if (!capacitorEventMocks.holdNetworkSeed) {
        return Promise.resolve(answer());
      }
      return new Promise((resolve) => {
        capacitorEventMocks.pendingSeedReleases.push(() => {
          resolve(answer());
        });
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

function fireAppState(isActive: boolean): void {
  for (const handler of capacitorEventMocks.appStateListeners) {
    handler({ isActive });
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
    capacitorEventMocks.platform = "ios";
    capacitorEventMocks.rejectAppListeners = false;
    capacitorEventMocks.pauseListeners.length = 0;
    capacitorEventMocks.resumeListeners.length = 0;
    capacitorEventMocks.appStateListeners.length = 0;
    capacitorEventMocks.networkListeners.length = 0;
    capacitorEventMocks.networkStatus = {
      connected: true,
      connectionType: "wifi",
    };
    capacitorEventMocks.networkStatusQueue.length = 0;
    capacitorEventMocks.holdNetworkSeed = false;
    capacitorEventMocks.pendingSeedReleases.length = 0;
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

    it("iOS: one pause/resume pair emits exactly one resume with a numeric dwell", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(100_000);
        const host = runner(null);
        const dwells: Array<number | null> = [];
        const subscription = host.onSystemResumed((event) =>
          dwells.push(event.backgroundedForMs),
        );
        expect(capacitorEventMocks.pauseListeners).toHaveLength(1);
        expect(capacitorEventMocks.resumeListeners).toHaveLength(1);
        // iOS selects the native lifecycle pair exclusively - the
        // appStateChange inactivity event must not be registered at all, or
        // Face ID / Control Center dwell would count as background.
        expect(capacitorEventMocks.appStateListeners).toHaveLength(0);

        fireAppPause();
        vi.setSystemTime(100_000 + 7_500);
        fireAppResume();

        expect(dwells).toEqual([7_500]);
        subscription.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("iOS: DOM visibility events are not participants - noise in every order is inert", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      // DOM edges alone: no episode. (On iOS the WebView's visibility says
      // nothing the OS lifecycle does not say better, and fusing the two is
      // what allowed phantom/duplicate episodes.)
      setVisibility("hidden");
      setVisibility("visible");
      expect(resumes).toEqual([]);

      // DOM noise interleaved with the real pair changes nothing.
      fireAppPause();
      setVisibility("hidden");
      setVisibility("visible");
      fireAppResume();
      expect(resumes).toEqual([1]);

      // A delayed DOM `hidden` after the completed episode opens nothing:
      // the network gate stays foreground and no phantom resume can follow.
      setVisibility("hidden");
      expect(resumes).toEqual([1]);
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1, 1]);

      subscription.dispose();
    });

    it("iOS: a missed DOM foreground cannot strand the tracker - only the selected pair owns state", async () => {
      const host = runner(null);
      const changes: number[] = [];
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const networkSubscription = host.onNetworkPathChanged(() =>
        changes.push(1),
      );
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      // DOM goes hidden and NEVER reports visible again (the dropped-edge
      // WebView). The selected pair completes regardless, and the network
      // suppression gate follows the selected pair - not the dead DOM state.
      setVisibility("hidden");
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1]);
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([1]);

      resumeSubscription.dispose();
      networkSubscription.dispose();
    });

    it("iOS: duplicate pause and duplicate/cold resume reports are level-filtered", () => {
      const host = runner(null);
      const resumes: number[] = [];
      const subscription = host.onSystemResumed(() => resumes.push(1));

      fireAppResume();
      expect(resumes).toEqual([]);

      fireAppPause();
      fireAppPause();
      fireAppResume();
      fireAppResume();
      expect(resumes).toEqual([1]);

      subscription.dispose();
    });

    it("iOS: failed native registration falls back to the DOM pair exclusively", async () => {
      capacitorEventMocks.rejectAppListeners = true;
      const host = runner(null);
      const dwells: Array<number | null> = [];
      const subscription = host.onSystemResumed((event) =>
        dwells.push(event.backgroundedForMs),
      );
      // The rejected registrations resolve asynchronously; the DOM fallback
      // installs after the catch runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      setVisibility("hidden");
      setVisibility("visible");
      // Degraded to DOM means degraded to UNKNOWN dwell - never a number.
      expect(dwells).toEqual([null]);

      subscription.dispose();
    });

    it("Android: pause under a dialog neither backgrounds nor stamps - appStateChange owns the pair with numeric dwell", () => {
      capacitorEventMocks.platform = "android";
      vi.useFakeTimers();
      try {
        vi.setSystemTime(100_000);
        const host = runner(null);
        const dwells: Array<number | null> = [];
        const subscription = host.onSystemResumed((event) =>
          dwells.push(event.backgroundedForMs),
        );
        // Android must not register the pause/resume pair at all: Activity
        // onPause fires while the app can be fully visible (multi-window, a
        // dialog), so its dwell is not background evidence.
        expect(capacitorEventMocks.pauseListeners).toHaveLength(0);
        expect(capacitorEventMocks.resumeListeners).toHaveLength(0);
        expect(capacitorEventMocks.appStateListeners).toHaveLength(1);

        // A long dialog: pause-shaped events would have faked a >=10s dwell
        // and force-dropped a healthy mux. Nothing happens.
        vi.setSystemTime(100_000 + 60_000);
        expect(dwells).toEqual([]);

        // The real pair: onStop -> onResume, numeric.
        fireAppState(false);
        vi.setSystemTime(100_000 + 72_000);
        fireAppState(true);
        expect(dwells).toEqual([12_000]);

        subscription.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("Web: DOM owns the pair with unknown dwell, and no native listeners are registered", () => {
      capacitorEventMocks.platform = "web";
      const host = runner(null);
      const dwells: Array<number | null> = [];
      const subscription = host.onSystemResumed((event) =>
        dwells.push(event.backgroundedForMs),
      );
      // The Web App plugin emits pause/resume FROM the same DOM visibility
      // event - registering it would double every episode.
      expect(capacitorEventMocks.pauseListeners).toHaveLength(0);
      expect(capacitorEventMocks.resumeListeners).toHaveLength(0);
      expect(capacitorEventMocks.appStateListeners).toHaveLength(0);

      setVisibility("hidden");
      setVisibility("visible");
      expect(dwells).toEqual([null]);

      subscription.dispose();
    });

    it("Web: boot-hidden reports a null dwell on the first visible", () => {
      capacitorEventMocks.platform = "web";
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

    it("delivers the same resume to every subscriber and drops only the disposed one", () => {
      const host = runner(null);
      const firstResumes: number[] = [];
      const secondResumes: number[] = [];
      const first = host.onSystemResumed(() => firstResumes.push(1));
      const second = host.onSystemResumed(() => secondResumes.push(1));

      fireAppPause();
      fireAppResume();
      expect(firstResumes).toEqual([1]);
      expect(secondResumes).toEqual([1]);

      first.dispose();
      fireAppPause();
      fireAppResume();
      expect(firstResumes).toEqual([1]);
      expect(secondResumes).toEqual([1, 1]);

      second.dispose();
    });

    it("keeps notifying the other subscribers when one throws", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const host = runner(null);
      const liveResumes: number[] = [];
      const throwing = host.onSystemResumed(() => {
        throw new Error("subscriber failure");
      });
      const live = host.onSystemResumed(() => liveResumes.push(1));

      fireAppPause();
      fireAppResume();

      expect(liveResumes).toEqual([1]);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      throwing.dispose();
      live.dispose();
      errorSpy.mockRestore();
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

    /** Subscribes and lets the read-listen-read bootstrap settle. */
    async function subscribeNetwork(host: MobileRunnerHost): Promise<{
      readonly changes: number[];
      readonly dispose: () => void;
    }> {
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );
      // A macrotask beat for the two snapshots + reconcile to land.
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

    it("a transition INSIDE the registration gap - visible only as A != B - still signals once", async () => {
      // Snapshot A sees the boot network; the transition lands before the JS
      // listener exists (no callback anywhere); snapshot B sees the result.
      capacitorEventMocks.networkStatusQueue.push(
        { connected: true, connectionType: "wifi" },
        { connected: true, connectionType: "cellular" },
      );
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      expect(changes).toEqual([1]);
      // ...and the baseline adopted B, so a callback re-announcing it is not
      // a second edge.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([1]);

      dispose();
    });

    it("a buffered callback and snapshot B describing the same transition signal once", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      // Snapshot A (queued answer) sees the offline boot; snapshot B falls
      // back to the live status, which by then reports the regain.
      capacitorEventMocks.networkStatusQueue.push({
        connected: false,
        connectionType: "none",
      });
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // The regain arrives as a live callback while the snapshots are held,
      // and B (resolved after release) reports the same post-transition
      // state.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      expect(changes).toEqual([]);
      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));

      subscription.dispose();
    });

    it("a transient flap observed in the buffer still signals once - the socket it killed stays dead", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // wifi -> cellular -> wifi while bootstrap is held: A and B agree, but
      // the path provably moved twice in between.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));
      // Exactly once, not once per hop.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([1]);

      subscription.dispose();
    });

    it("a quiet bootstrap - snapshots and callbacks all agreeing - signals nothing", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      subscription.dispose();
    });

    it("suppresses changes while backgrounded and does not replay them on resume", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      // iOS: the selected background evidence is the native pause.
      fireAppPause();
      // A backgrounded phone hopping networks must not reopen a splice
      // nobody is looking at.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      expect(changes).toEqual([]);

      // The tracked status still advanced, so the return itself replays
      // nothing - recovery on resume belongs to the resume edge.
      fireAppResume();
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

    it("fires exactly once on the background -> foreground edge", () => {
      const host = runner(null);
      const callbacks: number[] = [];
      const subscription = host.onAuthCallback(() => callbacks.push(1));

      fireAppPause();
      expect(callbacks).toEqual([]);
      fireAppResume();
      expect(callbacks).toEqual([1]);

      subscription.dispose();
    });

    it("stops delivering once disposed", () => {
      const host = runner(null);
      const callbacks: number[] = [];
      const subscription = host.onAuthCallback(() => callbacks.push(1));

      fireAppPause();
      fireAppResume();
      expect(callbacks).toEqual([1]);

      subscription.dispose();

      fireAppPause();
      fireAppResume();
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

      fireAppPause();
      fireAppResume();

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

      fireAppPause();
      expect(changes).toEqual([]);
      fireAppResume();
      expect(changes).toEqual([1]);

      subscription.dispose();
      fireAppPause();
      fireAppResume();
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
