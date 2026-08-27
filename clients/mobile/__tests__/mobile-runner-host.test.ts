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
  /** Event names whose `App.addListener` registration rejects (partial-pair). */
  rejectAppListenerEvents: new Set<string>(),
  /** Event names whose registration parks until `releaseHeldAppRegistration`. */
  holdAppListenerEvents: new Set<string>(),
  heldAppRegistrations: new Map<string, { reject: (error: Error) => void }>(),
  releaseHeldAppRegistrationWithError: (event: string) => {
    const held = capacitorEventMocks.heldAppRegistrations.get(event);
    if (held !== undefined) {
      capacitorEventMocks.heldAppRegistrations.delete(event);
      held.reject(new Error("no plugin bridge"));
    }
  },
  /** How `handle.remove()` behaves for App listener handles. */
  appHandleRemoveMode: "immediate" as "immediate" | "held" | "reject",
  pendingAppHandleRemovals: new Array<() => void>(),
  releaseAppHandleRemovals: () => {
    for (const release of capacitorEventMocks.pendingAppHandleRemovals.splice(
      0,
    )) {
      release();
    }
  },
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
  /** Per-call `getStatus()` rejection flags, consumed in order. */
  networkStatusFailQueue: new Array<boolean>(),
  /** When true, `Network.addListener` rejects. */
  rejectNetworkListener: false,
  pendingSeedReleases: new Array<() => void>(),
  /** Resolves ONE parked `getStatus()` in call order (value captured at call). */
  releaseNextSeed: () => {
    const release = capacitorEventMocks.pendingSeedReleases.shift();
    if (release !== undefined) {
      release();
    }
  },
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
      if (
        capacitorEventMocks.rejectAppListeners ||
        capacitorEventMocks.rejectAppListenerEvents.has(event)
      ) {
        return Promise.reject(new Error("no plugin bridge"));
      }
      if (capacitorEventMocks.holdAppListenerEvents.has(event)) {
        return new Promise((_resolve, reject) => {
          capacitorEventMocks.heldAppRegistrations.set(event, { reject });
        });
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
      return Promise.resolve({
        remove: () => {
          if (capacitorEventMocks.appHandleRemoveMode === "reject") {
            return Promise.reject(new Error("remove failed"));
          }
          if (capacitorEventMocks.appHandleRemoveMode === "held") {
            return new Promise<void>((resolve) => {
              capacitorEventMocks.pendingAppHandleRemovals.push(resolve);
            });
          }
          return Promise.resolve();
        },
      });
    },
  },
}));

vi.mock("@capacitor/network", () => ({
  Network: {
    getStatus: () => {
      // The VALUE is captured at CALL time (native reads snapshot on entry);
      // holding defers only the promise resolution. This is what lets a test
      // model a snapshot that races the event stream: captured before a
      // newer callback, resolved after it.
      const shouldFail = capacitorEventMocks.networkStatusFailQueue.shift();
      if (shouldFail === true) {
        return Promise.reject(new Error("status read failed"));
      }
      const value =
        capacitorEventMocks.networkStatusQueue.shift() ??
        capacitorEventMocks.networkStatus;
      if (!capacitorEventMocks.holdNetworkSeed) {
        return Promise.resolve(value);
      }
      return new Promise((resolve) => {
        capacitorEventMocks.pendingSeedReleases.push(() => {
          resolve(value);
        });
      });
    },
    addListener: (
      _event: string,
      handler: (status: { connected: boolean; connectionType: string }) => void,
    ) => {
      if (capacitorEventMocks.rejectNetworkListener) {
        return Promise.reject(new Error("listener registration failed"));
      }
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

/**
 * Delivers a genuine network change: the mock's current-status truth moves
 * WITH the callback, so the watcher's confirmation read agrees with it. A
 * test modelling a STALE delivery (callback contradicted by current truth)
 * sets `networkStatus` itself and calls `fireNetworkCallbackOnly`.
 */
function fireNetworkStatus(status: {
  connected: boolean;
  connectionType: string;
}): void {
  capacitorEventMocks.networkStatus = status;
  fireNetworkCallbackOnly(status);
}

function fireNetworkCallbackOnly(status: {
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
    capacitorEventMocks.networkStatusFailQueue.length = 0;
    capacitorEventMocks.rejectNetworkListener = false;
    capacitorEventMocks.rejectAppListenerEvents.clear();
    capacitorEventMocks.holdAppListenerEvents.clear();
    capacitorEventMocks.heldAppRegistrations.clear();
    capacitorEventMocks.appHandleRemoveMode = "immediate";
    capacitorEventMocks.pendingAppHandleRemovals.length = 0;
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
      // A beat for the post-resume quarantine to settle before the change.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

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

    it("iOS: a HALF-registered pair is retired the instant failure is known - before removals settle", async () => {
      // `pause` registers with a HELD removal; `resume`'s registration is
      // held and then rejected by the test. This drives the full order Sol
      // specified: state written pre-failure is reset, the surviving
      // callback is inert DURING the pending removal (token, not cleanup, is
      // the boundary), DOM owns nothing until cleanup settles, and exactly
      // one null-dwell episode follows.
      capacitorEventMocks.appHandleRemoveMode = "held";
      capacitorEventMocks.holdAppListenerEvents.add("resume");
      const host = runner(null);
      const dwells: Array<number | null> = [];
      const subscription = host.onSystemResumed((event) =>
        dwells.push(event.backgroundedForMs),
      );
      await vi.waitFor(() =>
        expect(capacitorEventMocks.pauseListeners).toHaveLength(1),
      );
      const retiredPause = capacitorEventMocks.pauseListeners[0];

      // Before the peer rejection, the pair is presumed good: a real pause
      // legitimately writes background state. (Kills the deleted-state-reset
      // mutation: without the reset, this write survives the fallback.)
      retiredPause();

      // The peer registration now fails. Ownership must flip synchronously
      // with the failure being known - removals are still HELD.
      capacitorEventMocks.releaseHeldAppRegistrationWithError("resume");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The retired callback fires WHILE its removal is pending. Inertness
      // here is the token, not the (unfinished) cleanup - the mutation that
      // moves invalidation after removal fails on this call.
      retiredPause();

      // DOM owns nothing yet: cleanup has not settled, so a visibility
      // cycle produces no episode.
      setVisibility("hidden");
      setVisibility("visible");
      expect(dwells).toEqual([]);

      // Cleanup settles; the DOM pair installs and owns episodes.
      capacitorEventMocks.releaseAppHandleRemovals();
      await new Promise((resolve) => setTimeout(resolve, 0));
      setVisibility("hidden");
      setVisibility("visible");
      // Exactly one episode, and its dwell is null - the pre-failure native
      // stamp was reset, the retired callbacks wrote nothing after.
      expect(dwells).toEqual([null]);

      subscription.dispose();
    });

    it("iOS: a rejected handle removal still completes the fallback to a working DOM pair", async () => {
      capacitorEventMocks.appHandleRemoveMode = "reject";
      capacitorEventMocks.rejectAppListenerEvents.add("resume");
      const host = runner(null);
      const dwells: Array<number | null> = [];
      const subscription = host.onSystemResumed((event) =>
        dwells.push(event.backgroundedForMs),
      );
      await vi.waitFor(() =>
        expect(capacitorEventMocks.pauseListeners).toHaveLength(1),
      );
      const retiredPause = capacitorEventMocks.pauseListeners[0];
      await new Promise((resolve) => setTimeout(resolve, 0));

      retiredPause();
      setVisibility("hidden");
      setVisibility("visible");
      // The failed removal is cleanup, not the safety boundary: DOM owns the
      // (single, null-dwell) episode and the retired callback wrote nothing.
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
      await vi.waitFor(() => expect(changes).toEqual([1]));

      dispose();
    });

    it("fires when connectivity is regained, not when it is lost", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      fireNetworkStatus({ connected: false, connectionType: "none" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      dispose();
    });

    it("does not fire for a repeat of the same status", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await new Promise((resolve) => setTimeout(resolve, 0));
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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

    it("snapshot A failing does not skip B or leak an unhandled rejection - B alone catches the gap", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // A rejects; the transition that fell before listener registration is
        // visible only as B's differing snapshot.
        capacitorEventMocks.networkStatusFailQueue.push(true);
        capacitorEventMocks.networkStatus = {
          connected: true,
          connectionType: "cellular",
        };
        const host = runner(null);
        const { changes, dispose } = await subscribeNetwork(host);

        // Chain is [B] alone - one observation, no edge, but a live baseline.
        expect(changes).toEqual([]);
        fireNetworkStatus({ connected: true, connectionType: "wifi" });
        await vi.waitFor(() => expect(changes).toEqual([1]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);

        dispose();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("snapshot B failing degrades to A as baseline without losing later live edges", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // A succeeds (wifi); B's read fails.
        capacitorEventMocks.networkStatusFailQueue.push(false, true);
        const host = runner(null);
        const { changes, dispose } = await subscribeNetwork(host);

        expect(changes).toEqual([]);
        fireNetworkStatus({ connected: true, connectionType: "cellular" });
        await vi.waitFor(() => expect(changes).toEqual([1]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);

        dispose();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("listener registration failing degrades silently - A settles, nothing crashes", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        capacitorEventMocks.rejectNetworkListener = true;
        const host = runner(null);
        const changes: number[] = [];
        const subscription = host.onNetworkPathChanged(() => changes.push(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(changes).toEqual([]);
        expect(unhandled).toEqual([]);
        subscription.dispose();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("A and the listener BOTH failing degrades silently with no unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        capacitorEventMocks.networkStatusFailQueue.push(true);
        capacitorEventMocks.rejectNetworkListener = true;
        const host = runner(null);
        const changes: number[] = [];
        const subscription = host.onNetworkPathChanged(() => changes.push(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(changes).toEqual([]);
        expect(unhandled).toEqual([]);
        subscription.dispose();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("a snapshot captured before a newer callback but resolved after it is DISCARDED - the retry adopts the truth", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // A resolves (wifi, captured at its call).
      capacitorEventMocks.releaseNextSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // B has now been CALLED and captured wifi. The path then drops and the
      // callback beats B's resolution - B's value is stale the moment it
      // resolves.
      capacitorEventMocks.networkStatus = {
        connected: false,
        connectionType: "none",
      };
      fireNetworkCallbackOnly({ connected: false, connectionType: "none" });
      capacitorEventMocks.releaseNextSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The retry read captures the offline truth; release it.
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // wifi -> offline is a LOSS: no signal. The discriminating half: had
      // stale B (wifi) been adopted as baseline, the regain below would read
      // wifi -> wifi and be swallowed.
      expect(changes).toEqual([]);
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      subscription.dispose();
    });

    it("held bootstrap: a background-era observation is retired by the resume - the resume wake is the only owner", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // background -> network change (buffered, tagged background-era) ->
      // foreground -> bootstrap settles.
      fireAppPause();
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      fireAppResume();
      expect(resumes).toEqual([1]);
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Reconciliation rebaselines from the background-era observation but
      // never re-announces it: the resume wake already owns that recovery.
      expect(changes).toEqual([]);
      // The baseline DID advance: re-announcing cellular is not an edge, a
      // real later move is.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      subscription.dispose();
    });

    it("live path: a change queued in background but delivered after the resume folds into the quarantine", async () => {
      const host = runner(null);
      const resumes: Array<number | null> = [];
      const resumeSubscription = host.onSystemResumed((event) =>
        resumes.push(event.backgroundedForMs),
      );
      const { changes, dispose } = await subscribeNetwork(host);

      fireAppPause();
      // The path moves while backgrounded; iOS delivers the callback only
      // after the app resumes. Model exactly that: truth changes now, the
      // callback arrives after the foreground flip below.
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      const resumeHandlers = [...capacitorEventMocks.resumeListeners];
      for (const handler of resumeHandlers) {
        handler();
      }
      // Delivered AFTER the foreground flip - inside the quarantine the
      // epoch boundary opened BEFORE the resume wake was issued.
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Exactly one recovery owner: the resume fired, the network edge did
      // not double it.
      expect(resumes).toHaveLength(1);
      expect(changes).toEqual([]);

      // After the quarantine settles, genuine edges flow again.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      dispose();
    });

    it("post-baseline: a stale offline/online pair collapses against the confirmed current status", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      // The truth never leaves wifi; the pair exists only in the delivery
      // queue. Each callback is confirmed against the current read, so the
      // stale offline is discarded and the late online has no edge to ride.
      fireNetworkCallbackOnly({ connected: false, connectionType: "none" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // A genuine move still fires.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      dispose();
    });

    it("a snapshot HELD across a resume can never become trusted - the late background-era callback seeds, not fires", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );
      // A resolves (Wi-Fi, captured at call); B is now called and parks,
      // its Wi-Fi value captured on THIS side of the suspend.
      capacitorEventMocks.releaseNextSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The app suspends; the path moves to cellular while suspended; the
      // callback for it is still queued. The resume owns this recovery.
      fireAppPause();
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      fireAppResume();
      expect(resumes).toEqual([1]);
      // Old B resolves AFTER the resume - cross-epoch. Reconciliation may
      // place it as the baseline but must NOT trust it; the post-resume
      // rebaseline (which reads the cellular truth) establishes trust.
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The background-era cellular callback lands arbitrarily late. With
      // cross-epoch B trusted this would confirm cellular against trusted
      // Wi-Fi and duplicate the resume-owned recovery.
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // Genuine edges flow from the rebaselined truth.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      subscription.dispose();
    });

    it("B failing with an empty buffer cannot leave pre-resume A trusted across the epoch", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // The suspend crosses bootstrap while A is still parked; B will FAIL,
      // leaving the chain as pre-resume A alone - the tail the trust branch
      // would otherwise bless via its empty-buffer arm.
      fireAppPause();
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      fireAppResume();
      expect(resumes).toEqual([1]);
      capacitorEventMocks.networkStatusFailQueue.push(true);
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The late background-era cellular callback: against a trusted
      // pre-resume Wi-Fi baseline this would duplicate the resume-owned
      // recovery.
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      subscription.dispose();
    });

    it("held bootstrap: a callback delivered AFTER the resume is still owned by it - no reconcile emit", async () => {
      capacitorEventMocks.holdNetworkSeed = true;
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const changes: number[] = [];
      const subscription = host.onNetworkPathChanged(() => changes.push(1));
      await vi.waitFor(() =>
        expect(capacitorEventMocks.networkListeners).toHaveLength(1),
      );

      // The reorder of the held-bootstrap arm: background -> resume FIRST,
      // the buffered observation arrives after the foreground flip.
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1]);
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The resume owns the episode's recovery whichever side of it the
      // delivery landed on.
      expect(changes).toEqual([]);
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      subscription.dispose();
    });

    it("two callbacks racing before either confirmation resolves commit exactly once - FIFO completion", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);
      // Establish a trusted offline baseline (a loss fires nothing).
      fireNetworkStatus({ connected: false, connectionType: "none" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // Both regain callbacks arrive back-to-back, synchronously - no
      // macrotask serialization - with every confirmation read HELD.
      capacitorEventMocks.holdNetworkSeed = true;
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "wifi",
      };
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      // FIFO completion: the FIRST callback's read resolves first. Without a
      // single commit owner, both confirmations would compare the same
      // offline baseline against the online truth and force twice.
      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([1]);
      // Baseline is the newest truth: a re-announce is not an edge.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([1]);

      dispose();
    });

    it("two callbacks racing commit exactly once - OUT-OF-ORDER completion", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);
      fireNetworkStatus({ connected: false, connectionType: "none" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      capacitorEventMocks.holdNetworkSeed = true;
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "wifi",
      };
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      // The SECOND callback's read resolves first: pop the first parked read
      // out of order by resolving from the tail.
      const parked = capacitorEventMocks.pendingSeedReleases.splice(0);
      expect(parked.length).toBeGreaterThanOrEqual(2);
      const lastParked = parked[parked.length - 1];
      lastParked();
      for (const release of parked.slice(0, -1)) {
        release();
      }
      capacitorEventMocks.releaseNetworkSeed();
      await vi.waitFor(() => expect(changes).toEqual([1]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([1]);

      dispose();
    });

    it("a failed confirmation marks the baseline untrusted - the next confirmed status seeds without a false edge", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      // A stale offline callback whose confirmation READ fails: the raw
      // observation may move the baseline, but only as untrusted.
      capacitorEventMocks.networkStatusFailQueue.push(true);
      fireNetworkCallbackOnly({ connected: false, connectionType: "none" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // The next CONFIRMED status re-seeds silently. Promoting the
      // unconfirmed offline into a trusted predecessor would fire a false
      // offline -> online regain right here.
      fireNetworkCallbackOnly({ connected: true, connectionType: "wifi" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // Genuine edges flow again from the re-seeded baseline.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      dispose();
    });

    it("a confirmation held across background/resume cannot fire a second wake after the resume's own", async () => {
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const { changes, dispose } = await subscribeNetwork(host);

      // The path moves and its confirmation read parks...
      capacitorEventMocks.holdNetworkSeed = true;
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      // ...then the app suspends and resumes while the read is in flight.
      // The resume bumps the commit sequence in the pre-handler seam, so the
      // stale confirmation resolving in the foreground cannot compare the
      // pre-resume baseline and double the resume's wake.
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1]);
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // The rebaseline adopted the new truth: re-announce is silent, a real
      // later move fires.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      dispose();
    });

    it("a FAILED resume rebaseline retires the pre-background baseline - a late background-era callback seeds, never forces", async () => {
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const { changes, dispose } = await subscribeNetwork(host);

      fireAppPause();
      // The path moves while suspended; the callback is still queued.
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      // The post-resume rebaseline read FAILS - nothing confirmed describes
      // the new network, and the pre-background baseline must not survive as
      // a trusted predecessor.
      capacitorEventMocks.networkStatusFailQueue.push(true);
      fireAppResume();
      expect(resumes).toEqual([1]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The background-era callback lands arbitrarily late, in foreground,
      // and confirms against the CURRENT truth. With the stale wifi baseline
      // still trusted this would be a wifi -> cellular forced wake - the
      // exact double-recovery the resume already owns.
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      dispose();
    });

    it("a second resume supersedes the first rebaseline owner - the stale read neither seeds nor closes the window", async () => {
      const host = runner(null);
      const resumes: number[] = [];
      const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
      const { changes, dispose } = await subscribeNetwork(host);

      capacitorEventMocks.holdNetworkSeed = true;
      // First suspend/resume: its rebaseline read parks, capturing cellular.
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "cellular",
      };
      fireAppPause();
      fireAppResume();
      // Second suspend/resume while the first read is in flight: the newer
      // generation owns the window. Its read captures wifi.
      capacitorEventMocks.networkStatus = {
        connected: true,
        connectionType: "wifi",
      };
      fireAppPause();
      fireAppResume();
      expect(resumes).toEqual([1, 1]);
      // Resolve the STALE first read...
      capacitorEventMocks.releaseNextSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // ...and deliver a callback BEFORE the owning read resolves. The stale
      // read must not have closed the quarantine: this observation folds
      // silently, WITHOUT starting a confirmation read of its own. That is
      // the discriminating probe: with the quarantine intact exactly one
      // parked read remains (the current owner), while a mutant that clears
      // the window in the stale branch routes the callback into live
      // confirmation and parks a SECOND read - regardless of what that
      // accidental confirmation would later compare against.
      fireNetworkCallbackOnly({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(capacitorEventMocks.pendingSeedReleases).toHaveLength(1);
      expect(changes).toEqual([]);
      capacitorEventMocks.releaseNetworkSeed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // The baseline is the SECOND read's wifi: a cellular move is a real
      // edge. Had the stale first read seeded cellular, this would be a
      // silent re-announce and the edge would vanish.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

      resumeSubscription.dispose();
      dispose();
    });

    it("suppresses changes while backgrounded and does not replay them on resume", async () => {
      const host = runner(null);
      const { changes, dispose } = await subscribeNetwork(host);

      // iOS: the selected background evidence is the native pause.
      fireAppPause();
      // A backgrounded phone hopping networks must not reopen a splice
      // nobody is looking at.
      fireNetworkStatus({ connected: true, connectionType: "cellular" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // The tracked status still advanced, so the return itself replays
      // nothing - recovery on resume belongs to the resume edge.
      fireAppResume();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(changes).toEqual([]);

      // ...but the NEXT foreground change (after the post-resume quarantine
      // settles) fires against the updated baseline.
      fireNetworkStatus({ connected: true, connectionType: "wifi" });
      await vi.waitFor(() => expect(changes).toEqual([1]));

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
