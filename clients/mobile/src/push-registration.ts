/**
 * Mobile push lifecycle: permission, APNs/FCM token registration against authn-v3, and tap-to-open relay into the gui's notification activation path.
 * Accordingly the lifecycle paths below never throw into a caller; failures are logged and swallowed.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  PushPermissionState,
  StoredCredentials,
  SystemResumeEvent,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type {
  DevicePushEnvironment,
  DevicePushPlatform,
  RegisterDevicePushTokenFn,
  RemoveDevicePushTokenFn,
} from "@traycer-clients/shared/auth/push-token-fetcher";

export type CapacitorPushPermissionState =
  | "prompt"
  | "prompt-with-rationale"
  | "granted"
  | "denied";

  /**
   * Capacitor's four states down to the three the shared contract speaks (`IRunnerHost.pushPermission`).
   * This file stays the only place that knows the plugin's vocabulary.
   */
export function toPushPermissionState(
  state: CapacitorPushPermissionState,
): PushPermissionState {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "prompt";
}

export interface PushRegistrationToken {
  readonly value: string;
}

export interface PushRegistrationError {
  readonly error: string;
}

export interface PushNotificationAction {
  readonly actionId: string;
  readonly notification: {
    readonly data: unknown;
  };
}

export interface PushNotificationsPluginSlice {
  checkPermissions(): Promise<{
    readonly receive: CapacitorPushPermissionState;
  }>;
  requestPermissions(): Promise<{
    readonly receive: CapacitorPushPermissionState;
  }>;
  register(): Promise<void>;
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
}

export interface PushTokenSource {
  get(): Promise<StoredCredentials | null>;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
}

export interface SystemResumeSource {
  onSystemResumed(handler: (event: SystemResumeEvent) => void): Disposable;
}

export interface PushRegistrationTarget {
  readonly platform: DevicePushPlatform;
  readonly environment: DevicePushEnvironment;
}

/**
 * How a Capacitor platform name becomes the `(platform, environment)` pair authn is told about, or `null` where OS push does not exist at all (the dev `web` entry).
 * FCM has no such split - one project, one token namespace - so Android is always `production`, and authn actively rejects `android` + `sandbox` as a caller bug rather than accepting a value it cannot honour.
 */
export function pushRegistrationTarget(
  capacitorPlatform: string,
  isDevBuild: boolean,
): PushRegistrationTarget | null {
  if (capacitorPlatform === "ios") {
    return {
      platform: "ios",
      environment: isDevBuild ? "sandbox" : "production",
    };
  }
  if (capacitorPlatform === "android") {
    return { platform: "android", environment: "production" };
  }
  return null;
}

export interface MobilePushRegistrationOptions {
  readonly plugin: PushNotificationsPluginSlice;
  readonly authnBaseUrl: string;
  readonly platform: DevicePushPlatform;
  readonly environment: DevicePushEnvironment;
  readonly registerToken: RegisterDevicePushTokenFn;
  readonly removeToken: RemoveDevicePushTokenFn;
}

export class MobilePushRegistration {
  private started = false;
  /** Provider token from the plugin's `registration` event. */
  private deviceToken: string | null = null;
  /** Latest access token seen while signed in. */
  private bearerToken: string | null = null;
  /**
   * `userId:deviceToken` of the last successful registration, so a routine bearer rotation (which also fires the token-store change event) does not re-send an identical registration on every refresh.
   */
  private lastRegisteredKey: string | null = null;
  private userId: string | null = null;
  private clickHandler: ((payload: unknown) => void) | null = null;
  private readonly pendingClicks: unknown[] = [];
  /**
   * The login session `start()` was given, retained so the register-once path can also be driven by a caller that has no token source of its own - the Settings row's `request()`.
   * `null` until `start()` runs (tests that only exercise the permission reads never start it).
   */
  private tokenSource: PushTokenSource | null = null;

  constructor(private readonly options: MobilePushRegistrationOptions) {}

  /** Attaches the plugin listeners and starts following the token store and the shell's resume edge. */
  start(tokenStore: PushTokenSource, systemResume: SystemResumeSource): void {
    if (this.started) return;
    this.started = true;
    this.tokenSource = tokenStore;

    void this.options.plugin
      .addListener("registration", (token) => {
        this.deviceToken = token.value;
        void this.registerCurrentToken();
      })
      .catch(logPushFailure("attach registration listener"));
    void this.options.plugin
      .addListener("registrationError", (error) => {
        // iOS: missing entitlement/provisioning, or APNs unreachable.
        // The app works without pushes; say why once instead of failing anything.
        console.warn("[push] registration failed", error.error);
      })
      .catch(logPushFailure("attach registrationError listener"));
    void this.options.plugin
      .addListener("pushNotificationActionPerformed", (action) => {
        this.emitClick(activationPayloadFromPushData(action.notification.data));
      })
      .catch(logPushFailure("attach action listener"));

    tokenStore.subscribe((change) => {
      if (change.present) {
        void this.ensureRegistered(tokenStore);
      } else {
        void this.unregisterAfterSignOut();
      }
    });
    // App start while already signed in: same path as a sign-in event.
    void this.ensureRegistered(tokenStore);
    // Foreground resume: the narrow late-grant path, NOT a re-run of the
    // sign-in path (see `registerIfGranted`).
    systemResume.onSystemResumed(() => {
      void this.registerIfGranted(false);
    });
  }

  /**
   * What the OS currently says, mapped to the shared three-state vocabulary.
   * A local read: `checkPermissions` never prompts, so the Settings row can poll it as often as it likes.
   */
  async permissionState(): Promise<PushPermissionState> {
    const permission = await this.options.plugin.checkPermissions();
    return toPushPermissionState(permission.receive);
  }

  /** The Settings row's Enable button. */
  async requestPermission(): Promise<PushPermissionState> {
    const permission = await this.options.plugin.requestPermissions();
    const state = toPushPermissionState(permission.receive);
    if (state === "granted") {
      await this.registerIfGranted(true);
    }
    return state;
  }

  /**
   * The gui's native-notification click sink (`INotificationHost.onClick`).
   * Replays any tap that arrived before the subscription - the cold-start case, where the tap IS the reason the app is running.
   */
  onClick(handler: (payload: unknown) => void): Disposable {
    this.clickHandler = handler;
    const pending = this.pendingClicks.splice(0);
    for (const payload of pending) {
      handler(payload);
    }
    return {
      dispose: () => {
        if (this.clickHandler === handler) {
          this.clickHandler = null;
        }
      },
    };
  }

  private emitClick(payload: unknown): void {
    if (this.clickHandler !== null) {
      this.clickHandler(payload);
      return;
    }
    this.pendingClicks.push(payload);
  }

  private async ensureRegistered(tokenStore: PushTokenSource): Promise<void> {
    try {
      const credentials = await tokenStore.get();
      if (credentials === null) return;
      this.bearerToken = credentials.token;
      this.userId = credentials.user.id;

      let permission = await this.options.plugin.checkPermissions();
      if (
        permission.receive === "prompt" ||
        permission.receive === "prompt-with-rationale"
      ) {
        permission = await this.options.plugin.requestPermissions();
      }
      if (permission.receive !== "granted") {
        // Denial is remembered by the OS; `requestPermissions` on a denied state resolves without prompting, so this never nags.
        // Android 13+ behaves the same way through POST_NOTIFICATIONS (and below API 33 the plugin answers "granted" from `checkPermissions`, so the request branch is never reached there at all).
        return;
      }
      // Idempotent with the OS; the provider token arrives (again) on the `registration` event, which registers it below.
      // This is also where an Android build with no `google-services.json` gives up: Firebase never initialized, so the call rejects rather than reporting through `registrationError`, and the catch below logs it.
      await this.options.plugin.register();
      await this.registerCurrentToken();
    } catch (error) {
      logPushFailure("ensure registration")(error);
    }
  }

  /**
   * Deliberately narrower than `ensureRegistered`, cheapest gate first, so a resume is free for everyone it does not concern: 1.
   * never started -> no token source to read, stop 3.
   */
  private async registerIfGranted(
    permissionKnownGranted: boolean,
  ): Promise<void> {
    if (this.lastRegisteredKey !== null) return;
    const tokenStore = this.tokenSource;
    if (tokenStore === null) return;
    try {
      const credentials = await tokenStore.get();
      if (credentials === null) return;
      if (!permissionKnownGranted) {
        const permission = await this.options.plugin.checkPermissions();
        if (permission.receive !== "granted") return;
      }
      this.bearerToken = credentials.token;
      this.userId = credentials.user.id;
      await this.options.plugin.register();
      await this.registerCurrentToken();
    } catch (error) {
      logPushFailure("register after permission grant")(error);
    }
  }

  private async registerCurrentToken(): Promise<void> {
    const token = this.deviceToken;
    const bearer = this.bearerToken;
    const userId = this.userId;
    if (token === null || bearer === null || userId === null) return;
    const key = `${userId}:${token}`;
    if (this.lastRegisteredKey === key) return;
    try {
      const result = await this.options.registerToken(
        this.options.authnBaseUrl,
        bearer,
        {
          token,
          platform: this.options.platform,
          environment: this.options.environment,
        },
      );
      if (result.kind === "ok") {
        if (this.bearerToken === bearer) {
          this.lastRegisteredKey = key;
        }
      } else {
        console.warn("[push] token registration was not accepted", result.kind);
      }
    } catch (error) {
      logPushFailure("register token")(error);
    }
  }

  private async unregisterAfterSignOut(): Promise<void> {
    const bearer = this.bearerToken;
    const token = this.deviceToken;
    this.bearerToken = null;
    this.userId = null;
    this.lastRegisteredKey = null;
    if (bearer === null || token === null) return;
    try {
      // If it fails, the row lingers deliverable until the family is revoked from the sessions panel, the token rebinds to another login, or authn's reaper collects it after the family's sessions expire.
      const result = await this.options.removeToken(
        this.options.authnBaseUrl,
        bearer,
        token,
      );
      if (result.kind !== "ok") {
        console.warn(
          "[push] sign-out unregister failed; the token row lingers until session revocation/expiry",
          result.kind,
        );
      }
    } catch (error) {
      logPushFailure("unregister token")(error);
    }
  }
}

function logPushFailure(context: string): (error: unknown) => void {
  return (error) => {
    console.warn(`[push] ${context} failed`, error);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The push data carries no route `kind`, so the mapping is by presence: chat when both ids exist, epic when only the epic does.
 * Anything less returns `{}`, which the bridge parses as `unknown` and answers by opening the notification center - the honest fallback, never a dropped tap.
 */
export function activationPayloadFromPushData(data: unknown): unknown {
  const record = isRecord(data) ? data : {};
  const entryId = readString(record.entryId);
  const epicId = readString(record.epicId);
  const chatId = readString(record.chatId);
  const route =
    epicId !== null && chatId !== null
      ? { kind: "chat", epicId, chatId }
      : epicId !== null
        ? { kind: "epic", epicId }
        : null;
  if (entryId === null || route === null) return {};
  return {
    kind: "notificationActivation",
    version: 1,
    route,
    feed: { source: "cloud", id: entryId },
    originHostId: null,
  };
}
