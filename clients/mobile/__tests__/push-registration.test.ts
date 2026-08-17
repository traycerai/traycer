/**
 * Push registration lifecycle properties.
 *
 * The plugin and the authn HTTP calls are faked at the package boundary; the
 * token source is a hand-rolled in-memory stand-in for `ITokenStore`'s
 * `get`/`subscribe` slice. The claims under test: registration follows the
 * login session (start-signed-in, sign-in, rotation, sign-out), permission
 * denial is respected without nagging, no failure ever escapes, and a tapped
 * push becomes the GUI's activation envelope - buffered across cold start.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  StoredCredentials,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type {
  DevicePushEnvironment,
  DevicePushPlatform,
  PushTokenFetchResult,
} from "@traycer-clients/shared/auth/push-token-fetcher";
import {
  MobilePushRegistration,
  activationPayloadFromPushData,
  pushRegistrationTarget,
  toPushPermissionState,
  type CapacitorPushPermissionState,
  type PushNotificationAction,
  type PushNotificationsPluginSlice,
  type PushRegistrationError,
  type PushRegistrationToken,
  type PushTokenSource,
  type SystemResumeSource,
} from "../src/push-registration";

const AUTHN_URL = "http://localhost:32350";

function credentials(userId: string, token: string): StoredCredentials {
  return {
    token,
    refreshToken: `refresh-${token}`,
    savedAt: "2026-08-05T00:00:00.000Z",
    user: { id: userId, email: "dev@traycer.ai", name: "Dev" },
  };
}

class FakeTokenSource implements PushTokenSource {
  private stored: StoredCredentials | null = null;
  private revision = 0;
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();

  async get(): Promise<StoredCredentials | null> {
    return this.stored;
  }

  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async setSignedIn(value: StoredCredentials): Promise<void> {
    this.stored = value;
    await this.notify();
  }

  async setSignedOut(): Promise<void> {
    this.stored = null;
    await this.notify();
  }

  private async notify(): Promise<void> {
    this.revision += 1;
    const change: TokenStoreChange = {
      present: this.stored !== null,
      userId: this.stored?.user.id ?? null,
      revision: this.revision,
    };
    for (const listener of this.listeners) {
      listener(change);
    }
    // Let the controller's fire-and-forget reactions settle.
    await drain();
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

/** A hand-driven stand-in for the shell's foreground-resume edge. */
class FakeSystemResume implements SystemResumeSource {
  private readonly handlers = new Set<() => void>();

  onSystemResumed(handler: () => void): Disposable {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }

  async resume(): Promise<void> {
    for (const handler of this.handlers) {
      handler();
    }
    await drain();
  }
}

/** For tests where the resume edge is not what is under test. */
const NO_RESUME: SystemResumeSource = {
  onSystemResumed: () => ({ dispose: () => {} }),
};

interface PermissionResult {
  readonly receive: CapacitorPushPermissionState;
}

type PushPluginEvent =
  PushRegistrationToken | PushRegistrationError | PushNotificationAction;

/**
 * A class rather than an object literal: `addListener`'s single broad-param
 * implementation satisfies the slice's overloads only under method-position
 * bivariance, which strictFunctionTypes reserves for method declarations.
 */
class FakePlugin implements PushNotificationsPluginSlice {
  private registration: ((token: PushRegistrationToken) => void) | null = null;
  private action: ((action: PushNotificationAction) => void) | null = null;

  readonly requestPermissions: Mock<() => Promise<PermissionResult>>;
  /**
   * Set to make `register()` reject. That is the Android shape when Firebase
   * never initialized (no `google-services.json`): the plugin call itself
   * throws instead of reporting through the `registrationError` event.
   */
  registerError: Error | null = null;
  // The real OS answers `register()` through the `registration` event; the
  // tests emit that event explicitly via `emitRegistration`.
  readonly register: Mock<() => Promise<void>> = vi.fn(async () => {
    if (this.registerError !== null) throw this.registerError;
  });

  /**
   * Mutable on purpose: the late-grant tests flip this from "denied" to
   * "granted" between start and resume, standing in for the person toggling
   * Traycer on in the OS Settings app.
   */
  permission: CapacitorPushPermissionState;

  constructor(
    permission: CapacitorPushPermissionState,
    afterRequest: CapacitorPushPermissionState,
  ) {
    this.permission = permission;
    this.requestPermissions = vi.fn(async () => ({ receive: afterRequest }));
  }

  readonly checkPermissions: Mock<() => Promise<PermissionResult>> = vi.fn(
    async () => ({ receive: this.permission }),
  );

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
    if (eventName === "registration") {
      this.registration = listener as (token: PushRegistrationToken) => void;
    } else if (eventName === "pushNotificationActionPerformed") {
      this.action = listener as (action: PushNotificationAction) => void;
    }
    return { remove: async () => {} };
  }

  emitRegistration(token: string): void {
    this.registration?.({ value: token });
  }

  emitAction(data: unknown): void {
    this.action?.({ actionId: "tap", notification: { data } });
  }
}

function fakePlugin(input: {
  readonly permission: CapacitorPushPermissionState;
  readonly afterRequest: CapacitorPushPermissionState;
}): FakePlugin {
  return new FakePlugin(input.permission, input.afterRequest);
}

interface FetchCalls {
  registered: Array<{
    bearer: string;
    token: string;
    platform: string;
    environment: string;
  }>;
  removed: Array<{ bearer: string; token: string }>;
}

/** The iOS-sandbox default; `controllerFor` when the pair is what is tested. */
function controller(input: {
  readonly plugin: FakePlugin;
  readonly registerResult: PushTokenFetchResult;
  readonly removeResult: PushTokenFetchResult;
}): { push: MobilePushRegistration; calls: FetchCalls } {
  return controllerFor({ ...input, platform: "ios", environment: "sandbox" });
}

function controllerFor(input: {
  readonly plugin: FakePlugin;
  readonly registerResult: PushTokenFetchResult;
  readonly removeResult: PushTokenFetchResult;
  readonly platform: DevicePushPlatform;
  readonly environment: DevicePushEnvironment;
}): { push: MobilePushRegistration; calls: FetchCalls } {
  const calls: FetchCalls = { registered: [], removed: [] };
  const push = new MobilePushRegistration({
    plugin: input.plugin,
    authnBaseUrl: AUTHN_URL,
    platform: input.platform,
    environment: input.environment,
    registerToken: async (authnBaseUrl, bearer, body) => {
      expect(authnBaseUrl).toBe(AUTHN_URL);
      calls.registered.push({ bearer, ...body });
      return input.registerResult;
    },
    removeToken: async (authnBaseUrl, bearer, token) => {
      expect(authnBaseUrl).toBe(AUTHN_URL);
      calls.removed.push({ bearer, token });
      return input.removeResult;
    },
  });
  return { push, calls };
}

const OK: PushTokenFetchResult = { kind: "ok" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MobilePushRegistration", () => {
  it("registers the provider token for a user already signed in at start", async () => {
    const plugin = fakePlugin({
      permission: "prompt",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();

    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(calls.registered).toEqual([
      {
        bearer: "bearer-1",
        token: "apns-token-1",
        platform: "ios",
        environment: "sandbox",
      },
    ]);
  });

  it("registers on sign-in after start, and once per (user, token) despite rotations", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();

    push.start(source, NO_RESUME);
    await drain();
    expect(calls.registered).toEqual([]);

    await source.setSignedIn(credentials("user-1", "bearer-1"));
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(calls.registered).toHaveLength(1);

    // A bearer refresh writes the store again; the identical (user, device
    // token) pair must not re-register.
    await source.setSignedIn(credentials("user-1", "bearer-2"));
    expect(calls.registered).toHaveLength(1);

    // A genuine provider-token rotation must.
    plugin.emitRegistration("apns-token-2");
    await drain();
    expect(calls.registered).toHaveLength(2);
    expect(calls.registered[1].token).toBe("apns-token-2");
    expect(calls.registered[1].bearer).toBe("bearer-2");
  });

  it("respects a denied permission: no register(), no HTTP, no nagging", async () => {
    const plugin = fakePlugin({ permission: "denied", afterRequest: "denied" });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();

    // Already-denied never re-prompts: `requestPermissions` is only reached
    // from the "prompt" states.
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });

  it("registers once on resume after the permission was granted in OS Settings", async () => {
    const plugin = fakePlugin({ permission: "denied", afterRequest: "denied" });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    const resume = new FakeSystemResume();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, resume);
    await drain();
    expect(plugin.register).not.toHaveBeenCalled();

    // Still refused: a resume reads the OS answer and stops. No prompt, no
    // APNs, no HTTP.
    await resume.resume();
    expect(plugin.checkPermissions).toHaveBeenCalledTimes(2);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);

    // The person flips Traycer on in the OS Settings app and swipes back.
    plugin.permission = "granted";
    await resume.resume();
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).toHaveBeenCalledTimes(1);
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(calls.registered).toEqual([
      {
        bearer: "bearer-1",
        token: "apns-token-1",
        platform: "ios",
        environment: "sandbox",
      },
    ]);
  });

  it("a resume while already registered is free: no OS read, no APNs, no HTTP", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    const resume = new FakeSystemResume();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, resume);
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(calls.registered).toHaveLength(1);
    const checksAfterStart = plugin.checkPermissions.mock.calls.length;

    // The common case - every foreground resume of a working install - must
    // stop at the in-memory guard before touching the OS, APNs, or authn.
    await resume.resume();
    await resume.resume();
    await resume.resume();
    expect(plugin.checkPermissions).toHaveBeenCalledTimes(checksAfterStart);
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(calls.registered).toHaveLength(1);
  });

  it("a resume while signed out never reaches the OS permission read", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    const resume = new FakeSystemResume();

    push.start(source, resume);
    await drain();
    await resume.resume();

    expect(plugin.checkPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });

  it("unregisters with the retained bearer on sign-out and re-registers on the next sign-in", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));
    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();

    await source.setSignedOut();
    expect(calls.removed).toEqual([
      { bearer: "bearer-1", token: "apns-token-1" },
    ]);

    // The per-(user, token) guard was cleared: the same device token
    // registers again for the next account.
    await source.setSignedIn(credentials("user-2", "bearer-3"));
    expect(calls.registered).toHaveLength(2);
    expect(calls.registered[1]).toEqual({
      bearer: "bearer-3",
      token: "apns-token-1",
      platform: "ios",
      environment: "sandbox",
    });
  });

  it("swallows registration HTTP failures and retries on the next store change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: { kind: "network-error" },
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));
    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();

    expect(calls.registered).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    // Not marked registered, so the next change retries rather than skipping.
    await source.setSignedIn(credentials("user-1", "bearer-2"));
    expect(calls.registered).toHaveLength(2);
  });

  it("a register still in flight at sign-out cannot resurrect the dedupe guard", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const calls: FetchCalls = { registered: [], removed: [] };
    // Held in a property so TS's flow analysis (which cannot see the promise
    // executor run) does not narrow it back to null at the release site.
    const releaseRegister: { fn: (() => void) | null } = { fn: null };
    const push = new MobilePushRegistration({
      plugin,
      authnBaseUrl: AUTHN_URL,
      platform: "ios",
      environment: "sandbox",
      registerToken: (authnBaseUrl, bearer, body) =>
        new Promise((resolve) => {
          calls.registered.push({ bearer, ...body });
          releaseRegister.fn = () => resolve(OK);
        }),
      removeToken: async (authnBaseUrl, bearer, token) => {
        calls.removed.push({ bearer, token });
        return OK;
      },
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));
    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(calls.registered).toHaveLength(1);

    // Sign out while the register HTTP call is still on the wire, then let
    // it resolve ok. The late success must not mark the pair as registered -
    // the sign-out's remove just deleted (or will delete) that row.
    await source.setSignedOut();
    releaseRegister.fn?.();
    await drain();

    await source.setSignedIn(credentials("user-1", "bearer-2"));
    expect(calls.registered).toHaveLength(2);
    expect(calls.registered[1].bearer).toBe("bearer-2");
  });

  it("buffers a cold-start tap and replays it to the first click subscriber", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    push.start(new FakeTokenSource(), NO_RESUME);
    await drain();

    // The tap that launched the app lands before the GUI mounts.
    plugin.emitAction({
      entryId: "entry-1",
      epicId: "epic-1",
      chatId: "chat-1",
    });

    const received: unknown[] = [];
    push.onClick((payload) => received.push(payload));

    expect(received).toEqual([
      {
        kind: "notificationActivation",
        version: 1,
        route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        feed: { source: "cloud", id: "entry-1" },
        originHostId: null,
      },
    ]);

    // Warm taps flow straight through.
    plugin.emitAction({ entryId: "entry-2", epicId: "epic-2", chatId: null });
    expect(received).toHaveLength(2);
  });
});

/**
 * The `IRunnerHost.pushPermission` half: what the Settings row reads and what
 * its Enable button does. The fixtures start from `denied` so the sign-in path
 * settles without prompting - `ensureRegistered` only prompts on a `prompt`
 * state - which leaves the request under test as the only prompt in the test.
 */
describe("MobilePushRegistration permission surface", () => {
  it("maps Capacitor's four states onto the shared three", () => {
    expect(toPushPermissionState("granted")).toBe("granted");
    expect(toPushPermissionState("denied")).toBe("denied");
    expect(toPushPermissionState("prompt")).toBe("prompt");
    // Android's "denied once, one more ask allowed" is a prompt from the GUI's
    // side: the row keeps offering Enable, and the OS decides what happens.
    expect(toPushPermissionState("prompt-with-rationale")).toBe("prompt");
  });

  it("reads the permission without ever prompting", async () => {
    const plugin = fakePlugin({
      permission: "prompt-with-rationale",
      afterRequest: "granted",
    });
    const { push } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });

    await expect(push.permissionState()).resolves.toBe("prompt");
    expect(plugin.checkPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it("registers exactly once when the person grants from the Settings row", async () => {
    const plugin = fakePlugin({
      permission: "denied",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    expect(plugin.register).not.toHaveBeenCalled();

    await expect(push.requestPermission()).resolves.toBe("granted");
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).toHaveBeenCalledTimes(1);
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(calls.registered).toEqual([
      {
        bearer: "bearer-1",
        token: "apns-token-1",
        platform: "ios",
        environment: "sandbox",
      },
    ]);

    // The guard the grant just set makes a second Enable (or any later resume)
    // stop before touching APNs or authn.
    await expect(push.requestPermission()).resolves.toBe("granted");
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(calls.registered).toHaveLength(1);
  });

  it("registers nothing when the person refuses the prompt", async () => {
    const plugin = fakePlugin({ permission: "prompt", afterRequest: "denied" });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    const requestsAfterStart = plugin.requestPermissions.mock.calls.length;

    await expect(push.requestPermission()).resolves.toBe("denied");
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(
      requestsAfterStart + 1,
    );
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });

  it("a grant before start() registers nothing - there is no login to bind to yet", async () => {
    const plugin = fakePlugin({
      permission: "denied",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });

    // `start()` is what hands this object the token source; bootstrap always
    // calls it before the GUI can mount, so this is the unreachable-by-design
    // gate - pinned so it stays a silent stop rather than becoming a throw.
    await expect(push.requestPermission()).resolves.toBe("granted");
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });

  it("grants while signed out cost nothing but the OS answer", async () => {
    const plugin = fakePlugin({
      permission: "denied",
      afterRequest: "granted",
    });
    const { push, calls } = controller({
      plugin,
      registerResult: OK,
      removeResult: OK,
    });
    const source = new FakeTokenSource();

    push.start(source, NO_RESUME);
    await drain();

    // Nothing to bind a token to yet; the sign-in path registers later.
    await expect(push.requestPermission()).resolves.toBe("granted");
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });
});

/**
 * The controller is platform-agnostic by construction, so these cover the
 * things that are genuinely Android-shaped rather than re-running the iOS
 * suite: the `(platform, environment)` pair authn receives, the two distinct
 * permission shapes API 33 draws a line between, and the way a build with no
 * Firebase config fails - `register()` rejecting outright, which is a
 * different path from the `registrationError` event iOS uses.
 */
describe("MobilePushRegistration on Android", () => {
  function androidController(input: { readonly plugin: FakePlugin }): {
    push: MobilePushRegistration;
    calls: FetchCalls;
  } {
    return controllerFor({
      plugin: input.plugin,
      registerResult: OK,
      removeResult: OK,
      platform: "android",
      environment: "production",
    });
  }

  it("registers the FCM token as android/production", async () => {
    // API 33+: POST_NOTIFICATIONS is still unanswered, so the plugin reports
    // "prompt" and the runtime dialog is what grants it.
    const plugin = fakePlugin({
      permission: "prompt",
      afterRequest: "granted",
    });
    const { push, calls } = androidController({ plugin });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("fcm-token-1");
    await drain();

    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(calls.registered).toEqual([
      {
        bearer: "bearer-1",
        token: "fcm-token-1",
        platform: "android",
        // Never "sandbox": authn rejects that pairing outright.
        environment: "production",
      },
    ]);
  });

  it("skips the runtime prompt below API 33, where the plugin reports granted", async () => {
    // Pre-Tiramisu the plugin short-circuits `checkPermissions` to "granted",
    // so the controller must go straight to register() without a dialog.
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = androidController({ plugin });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("fcm-token-1");
    await drain();

    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(calls.registered).toHaveLength(1);
  });

  it("stops at a denied POST_NOTIFICATIONS without touching Firebase", async () => {
    const plugin = fakePlugin({ permission: "prompt", afterRequest: "denied" });
    const { push, calls } = androidController({ plugin });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();

    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls.registered).toEqual([]);
  });

  it("survives a build with no google-services.json: register() rejects, nothing else breaks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    // What FirebaseMessaging.getInstance() raises when the google-services
    // plugin was never applied, surfaced as a rejected plugin call.
    plugin.registerError = new Error("Default FirebaseApp is not initialized");
    const { push, calls } = androidController({ plugin });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();

    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(calls.registered).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // And a later signed-in app that DOES have the config still registers -
    // the failure left no latch behind.
    plugin.registerError = null;
    await source.setSignedIn(credentials("user-1", "bearer-2"));
    plugin.emitRegistration("fcm-token-1");
    await drain();
    expect(calls.registered).toEqual([
      {
        bearer: "bearer-2",
        token: "fcm-token-1",
        platform: "android",
        environment: "production",
      },
    ]);
  });

  it("re-registers when FCM rotates the token", async () => {
    const plugin = fakePlugin({
      permission: "granted",
      afterRequest: "granted",
    });
    const { push, calls } = androidController({ plugin });
    const source = new FakeTokenSource();
    await source.setSignedIn(credentials("user-1", "bearer-1"));

    push.start(source, NO_RESUME);
    await drain();
    plugin.emitRegistration("fcm-token-1");
    await drain();
    plugin.emitRegistration("fcm-token-2");
    await drain();

    expect(calls.registered.map((call) => call.token)).toEqual([
      "fcm-token-1",
      "fcm-token-2",
    ]);
  });
});

describe("pushRegistrationTarget", () => {
  it("pins Android to production and tracks the build flavor on iOS", () => {
    expect(pushRegistrationTarget("android", true)).toEqual({
      platform: "android",
      environment: "production",
    });
    expect(pushRegistrationTarget("android", false)).toEqual({
      platform: "android",
      environment: "production",
    });
    expect(pushRegistrationTarget("ios", true)).toEqual({
      platform: "ios",
      environment: "sandbox",
    });
    expect(pushRegistrationTarget("ios", false)).toEqual({
      platform: "ios",
      environment: "production",
    });
  });

  it("has no target off-device, so the web entry builds no controller", () => {
    expect(pushRegistrationTarget("web", true)).toBeNull();
    expect(pushRegistrationTarget("", false)).toBeNull();
  });
});

describe("activationPayloadFromPushData", () => {
  it("maps chat and epic routes by id presence", () => {
    expect(
      activationPayloadFromPushData({
        entryId: "e",
        epicId: "ep",
        chatId: "ch",
      }),
    ).toEqual({
      kind: "notificationActivation",
      version: 1,
      route: { kind: "chat", epicId: "ep", chatId: "ch" },
      feed: { source: "cloud", id: "e" },
      originHostId: null,
    });
    expect(
      activationPayloadFromPushData({
        entryId: "e",
        epicId: "ep",
        chatId: null,
      }),
    ).toEqual({
      kind: "notificationActivation",
      version: 1,
      route: { kind: "epic", epicId: "ep" },
      feed: { source: "cloud", id: "e" },
      originHostId: null,
    });
  });

  it("degrades unroutable or junk data to {} — the bridge opens the center", () => {
    // No epic to route to.
    expect(
      activationPayloadFromPushData({
        entryId: "e",
        epicId: null,
        chatId: null,
      }),
    ).toEqual({});
    // No feed identity to acknowledge.
    expect(
      activationPayloadFromPushData({ epicId: "ep", chatId: null }),
    ).toEqual({});
    expect(activationPayloadFromPushData(undefined)).toEqual({});
    expect(activationPayloadFromPushData("junk")).toEqual({});
  });
});
