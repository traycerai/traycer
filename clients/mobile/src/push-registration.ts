/**
 * Mobile push lifecycle: permission, APNs/FCM token registration against
 * authn-v3, and tap-to-open relay into the GUI's notification activation path.
 *
 * Everything here is BEST-EFFORT around the login session: a denied
 * permission or a failed HTTP call costs pushes, not notifications (the
 * in-app feed and its poll are unaffected). Accordingly the lifecycle paths
 * below never throw into a caller; registration failures update Settings and
 * report a fixed failure category through the existing mobile Sentry channel.
 *
 * The permission methods behind `IRunnerHost.pushPermission` propagate plugin
 * failures, and `setMutedSeverities()` propagates storage failures. A muted-set
 * read falls back to `[]` for unreadable or malformed storage. These methods
 * answer a person looking at Settings, where the GUI renders a rejection (the
 * query shows an error row, the mutation raises a toast). Wrapping a rejection in
 * this file's `logPushFailure` would fabricate a state and silently delete the
 * designed error surface. Their registration side effects stay swallowed, as
 * above.
 *
 * One asymmetry is worth knowing. EXPLICIT revocation (sessions panel,
 * revoke-all) cascades the token row away server-side - but plain sign-out is
 * LOCAL-ONLY (it deletes the stored credential without revoking the session
 * family), so the sign-out `remove` call below is the primary cleanup for
 * that path. If it fails, the row stays deliverable until the family is
 * revoked, the token rebinds, or authn's reaper collects it once the
 * family's sessions expire.
 *
 * Tap handling deliberately re-enters the GUI through the SAME sink native
 * desktop notifications use - `IRunnerHost.notifications.onClick` - so the
 * focus bridge, activation guards and read-acknowledgment all apply unchanged.
 * Taps that arrive before the GUI subscribes (a cold start, where Capacitor
 * retains the launching tap until a JS listener attaches) are buffered here
 * and replayed on subscribe.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { captureMessage, withScope } from "@sentry/browser";
import { hostNotificationSeveritySchema } from "@traycer/protocol/host/notifications/host-notifications";
import type {
  PushPermissionState,
  PushRegistrationState,
  PushSeverity,
  StoredCredentials,
  SystemResumeEvent,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { readAccessTokenExpiryMs } from "@traycer-clients/shared/auth/jwt-exp";
import type {
  DevicePushEnvironment,
  DevicePushPlatform,
  PushTokenFetchResult,
  RegisterDevicePushTokenFn,
  RemoveDevicePushTokenFn,
} from "@traycer-clients/shared/auth/push-token-fetcher";

/**
 * How long a scheduled re-registration waits for the next reason to send
 * before it goes: a muted-set change, or a want that moved while a request
 * was on the wire. The register route allows 20 calls per user per hour, and
 * a person flipping switches back and forth must not spend them on the
 * states in between.
 */
const SCHEDULED_REGISTRATION_DELAY_MS = 1_000;
const PROVIDER_REGISTRATION_TIMEOUT_MS = 20_000;
/**
 * How long an expired-looking bearer is held back for the refresh that is
 * about to replace it before it is sent anyway and authn decides.
 */
const EXPIRED_BEARER_GRACE_MS = 15_000;
// Four routine refreshes/hour per device leave room in the account's 20/hour
// budget for sign-ins and preference changes. The first resume always refreshes.
const RESUME_REVALIDATION_INTERVAL_MS = 15 * 60_000;

/** Capacitor's PermissionState, spelled out (no type dep on the plugin). */
export type CapacitorPushPermissionState =
  | "prompt"
  | "prompt-with-rationale"
  | "granted"
  | "denied";

/**
 * Capacitor's four states down to the three the shared contract speaks
 * (`IRunnerHost.pushPermission`). `prompt-with-rationale` is Android's "denied
 * once, the OS will still allow one more ask" - from the GUI's side that is
 * indistinguishable from a first ask, so it collapses to `prompt` and the row
 * keeps offering Enable. This file stays the only place that knows the
 * plugin's vocabulary.
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

/**
 * The slice of `@capacitor/push-notifications` this module drives. Tests fake
 * this boundary; `main.tsx` passes the real plugin, which satisfies it
 * structurally.
 */
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

/**
 * What registration actually needs from `ITokenStore` (which satisfies this
 * structurally): the stored credential and its change feed.
 */
export interface PushTokenSource {
  get(): Promise<StoredCredentials | null>;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
}

/** Foreground resume rechecks permission and periodically repairs registration. */
export interface SystemResumeSource {
  onSystemResumed(handler: (event: SystemResumeEvent) => void): Disposable;
}

export interface PushRegistrationTarget {
  readonly platform: DevicePushPlatform;
  readonly environment: DevicePushEnvironment;
}

/**
 * How a Capacitor platform name becomes the `(platform, environment)` pair
 * authn is told about, or `null` where OS push does not exist at all (the dev
 * `web` entry).
 *
 * The two providers differ in exactly one way here. APNs really does have two
 * gateways, and which one a token is valid on is fixed by the build's
 * `aps-environment` entitlement: debug signing means `development`, so a
 * dev-served bundle must say `sandbox` or the sender addresses the wrong
 * gateway and the push silently vanishes. FCM has no such split - one project,
 * one token namespace - so Android is always `production`, and authn actively
 * rejects `android` + `sandbox` as a caller bug rather than accepting a value
 * it cannot honour.
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
  private state: PushRegistrationState = "pending";
  private readonly registrationHandlers = new Set<() => void>();
  private providerRegistrationTimer: number | null = null;
  private registrationRevision = 0;
  private lastResumeRevalidationAt: number | null = null;
  /** Provider token from the plugin's `registration` event. */
  private deviceToken: string | null = null;
  // A refresh can fail before returning an address. Sign-out must still remove
  // the last address we registered: plain sign-out does not revoke its family.
  private cleanupToken: string | null = null;
  /**
   * Latest access token seen while signed in. Retained IN MEMORY ONLY so the
   * sign-out unregister has a bearer to send - the token-store change event
   * fires after the credential is already deleted, and plain sign-out does
   * not revoke the session family, so this bearer is normally still accepted
   * by authn for exactly the remove call it is retained for.
   */
  private bearerToken: string | null = null;
  /** The expired-looking bearer already held back once (see `registerCurrentToken`). */
  private heldExpiredBearer: string | null = null;
  /**
   * `userId:deviceToken:<sorted muted set>` last accepted by the server (see
   * `registrationKey`), or `null` when that is not known. A routine bearer
   * rotation (which also fires the token-store change event) leaves all
   * three unchanged, so it re-sends nothing; a provider-token rotation or a
   * muted-set change is a mismatch, and every path that compares the key
   * sends again. Resume periodically bypasses this key because the server can
   * prune a row without notifying the app. Cleared while a request is on the wire and set only on an
   * accepted response, so a failed or lost request stays a mismatch for the
   * next edge to retry (see `registerCurrentToken`).
   */
  private lastRegisteredKey: string | null = null;
  /** At most one registration request on the wire at a time. */
  private registrationInFlight = false;
  /** The pending scheduled re-registration, if one is waiting. */
  private scheduledRegistrationTimer: number | null = null;
  private userId: string | null = null;
  private clickHandler: ((payload: unknown) => void) | null = null;
  private readonly pendingClicks: unknown[] = [];
  /**
   * The login session `start()` was given, retained so the register-once path
   * can also be driven by a caller that has no token source of its own - the
   * Settings row's `request()`. `null` until `start()` runs (tests that only
   * exercise the permission reads never start it).
   */
  private tokenSource: PushTokenSource | null = null;

  constructor(private readonly options: MobilePushRegistrationOptions) {}

  /**
   * Attaches the plugin listeners and starts following the token store and
   * the shell's resume edge. Called once from bootstrap; listeners attach as
   * early as possible so a cold-start tap (retained by Capacitor until a
   * listener exists) is captured even though the GUI subscribes later.
   */
  start(tokenStore: PushTokenSource, systemResume: SystemResumeSource): void {
    if (this.started) return;
    this.started = true;
    this.tokenSource = tokenStore;

    void this.options.plugin
      .addListener("registration", (token) => {
        this.clearProviderRegistrationTimer();
        this.deviceToken = token.value;
        this.cleanupToken = token.value;
        void this.registerCurrentToken();
      })
      .catch(() => this.failProviderRegistration("listener-error"));
    void this.options.plugin
      .addListener("registrationError", () => {
        this.failProviderRegistration("provider-error");
      })
      .catch(() => this.failProviderRegistration("listener-error"));
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
    systemResume.onSystemResumed(() => {
      void this.revalidateOnResume();
    });
  }

  /**
   * What the OS currently says, mapped to the shared three-state vocabulary.
   * A LOCAL read: `checkPermissions` never prompts, so the Settings row can
   * poll it as often as it likes.
   */
  async permissionState(): Promise<PushPermissionState> {
    const permission = await this.options.plugin.checkPermissions();
    return toPushPermissionState(permission.receive);
  }

  registrationState(): PushRegistrationState {
    if (
      this.state === "registered" &&
      this.wantedRegistrationKey() !== this.lastRegisteredKey
    ) {
      return "pending";
    }
    return this.state;
  }

  onRegistrationChange(handler: () => void): Disposable {
    this.registrationHandlers.add(handler);
    return { dispose: () => this.registrationHandlers.delete(handler) };
  }

  async retryRegistration(): Promise<void> {
    await this.registerIfGranted(false, true);
  }

  private async revalidateOnResume(): Promise<void> {
    // A denied/signed-out resume must not spend the next late-grant repair.
    try {
      if (this.tokenSource === null || (await this.tokenSource.get()) === null)
        return;
      if ((await this.permissionState()) !== "granted") return;
    } catch {
      this.setRegistrationState("failed");
      reportPushRegistrationFailure("registration-error");
      return;
    }
    if (this.providerRegistrationTimer !== null) return;
    const now = Date.now();
    if (
      this.lastResumeRevalidationAt !== null &&
      now - this.lastResumeRevalidationAt < RESUME_REVALIDATION_INTERVAL_MS
    )
      return;
    this.lastResumeRevalidationAt = now;
    await this.registerIfGranted(true, true);
  }

  private setRegistrationState(state: PushRegistrationState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.registrationHandlers) handler();
  }

  private clearProviderRegistrationTimer(): void {
    if (this.providerRegistrationTimer === null) return;
    window.clearTimeout(this.providerRegistrationTimer);
    this.providerRegistrationTimer = null;
  }

  private failProviderRegistration(reason: PushRegistrationFailure): void {
    this.clearProviderRegistrationTimer();
    this.registrationRevision += 1;
    this.deviceToken = null;
    this.lastRegisteredKey = null;
    this.setRegistrationState("failed");
    reportPushRegistrationFailure(reason);
  }

  private async registerWithProvider(): Promise<void> {
    // Do not spend another provider request while its callback is pending.
    if (this.providerRegistrationTimer !== null) return;
    this.registrationRevision += 1;
    this.lastRegisteredKey = null;
    this.deviceToken = null;
    this.setRegistrationState("pending");
    this.providerRegistrationTimer = window.setTimeout(() => {
      this.failProviderRegistration("provider-timeout");
    }, PROVIDER_REGISTRATION_TIMEOUT_MS);
    try {
      await this.options.plugin.register();
    } catch {
      this.failProviderRegistration("provider-error");
    }
  }

  /**
   * The Settings row's Enable button. Raises the OS prompt if the OS still
   * allows one - after a refusal `requestPermissions` resolves the remembered
   * answer without showing anything, which is why the row only offers this in
   * the `prompt` state - and, on a grant, registers the device token right
   * away through the SAME narrow path a late grant from OS Settings takes.
   * Registration stays best-effort as everywhere else in this file: a failed
   * token round trip is logged and swallowed, so a granted permission still
   * reports `"granted"`.
   */
  async requestPermission(): Promise<PushPermissionState> {
    const permission = await this.options.plugin.requestPermissions();
    const state = toPushPermissionState(permission.receive);
    if (state === "granted") {
      await this.registerIfGranted(true, true);
    }
    return state;
  }

  /**
   * The muted set this phone stored for the signed-in account; `[]` while
   * signed out or before anything was turned off. A local read: the phone is
   * the authority, and the server row is only a copy of what it last sent.
   */
  async getMutedSeverities(): Promise<readonly PushSeverity[]> {
    const userId = await this.signedInUserId();
    return userId === null ? [] : readMutedSeverities(userId);
  }

  /**
   * The Settings rows' switches. Stores the whole new set FIRST, so the
   * choice survives whatever the network does, then schedules one trailing
   * send. The send goes through the same narrow path as a late grant, so it
   * happens only while signed in with permission granted; otherwise the set
   * waits in storage and the next registration (a grant, a sign-in) carries
   * it. A failed send is logged and left as a key mismatch, which the next
   * foreground resume retries. A storage failure rejects instead: the person
   * at the row has to learn their choice was not kept.
   */
  async setMutedSeverities(set: readonly PushSeverity[]): Promise<void> {
    const userId = await this.signedInUserId();
    if (userId === null) {
      throw new Error("Sign in to choose what reaches this phone.");
    }
    window.localStorage.setItem(
      mutedSeveritiesStorageKey(userId),
      JSON.stringify(normalizeMutedSeverities(set)),
    );
    this.scheduleRegistration(SCHEDULED_REGISTRATION_DELAY_MS);
  }

  /**
   * The GUI's native-notification click sink (`INotificationHost.onClick`).
   * Replays any tap that arrived before the subscription - the cold-start
   * case, where the tap IS the reason the app is running.
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
        // Denial is remembered by the OS; `requestPermissions` on a denied
        // state resolves without prompting, so this never nags. Android 13+
        // behaves the same way through POST_NOTIFICATIONS (and below API 33
        // the plugin answers "granted" from `checkPermissions`, so the request
        // branch is never reached there at all).
        return;
      }
      // Idempotent with the OS; the provider token arrives (again) on the
      // `registration` event, which registers it below. This is also where an
      // Android build with no `google-services.json` gives up: Firebase never
      // initialized, so the call REJECTS rather than reporting through
      // `registrationError`, and the catch below logs it.
      if (this.deviceToken === null) {
        await this.registerWithProvider();
      } else {
        await this.registerCurrentToken();
      }
    } catch {
      this.setRegistrationState("failed");
      reportPushRegistrationFailure("registration-error");
    }
  }

  /**
   * Resume refreshes bypass the local registration key: the server may have
   * pruned the row or its old family may no longer be live. The existing upsert
   * rebinds it to the credential we hold now; a revoked credential still fails
   * authorization and is shown as a failure, never as a repaired registration.
   * No resume or retry raises an OS permission prompt.
   */
  private async registerIfGranted(
    permissionKnownGranted: boolean,
    refresh: boolean,
  ): Promise<void> {
    const wantedKey = this.wantedRegistrationKey();
    if (!refresh && wantedKey !== null && wantedKey === this.lastRegisteredKey)
      return;
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
      // A repair asks the provider again too: an address pruned after
      // BadDeviceToken may need replacing, not just uploading again.
      if (refresh || this.deviceToken === null) {
        await this.registerWithProvider();
      } else {
        await this.registerCurrentToken();
      }
    } catch {
      this.setRegistrationState("failed");
      reportPushRegistrationFailure("registration-error");
    }
  }

  /**
   * Sends what the phone wants now, unless the server is known to hold it.
   *
   * One request at a time: two on the wire could land out of order and leave
   * the older one standing, so a call that arrives while one is in flight
   * sends nothing itself. While a request is out, whatever the server held
   * before is no longer known, so the key is cleared when it starts. When it
   * settles:
   *
   *   - accepted: the sent key is recorded (for the login that sent it), and
   *     if the phone now wants something else - a switch flipped back, a
   *     rotated token, a sign-in that arrived meanwhile - one more send is
   *     scheduled.
   *   - failed, rejected or lost: the key stays cleared, so the next resume
   *     sends whatever is wanted then. That holds even when the wanted set is
   *     one the server accepted earlier: a lost response may have changed it.
   */
  private async registerCurrentToken(): Promise<void> {
    if (this.registrationInFlight) return;
    const token = this.deviceToken;
    const bearer = this.bearerToken;
    const userId = this.userId;
    if (token === null || bearer === null || userId === null) return;
    // A cold start or a resume after a long background reads the stored pair
    // before the auth service has refreshed it, and authn answers 401 to an
    // access token past its `exp`. The refresh writes the store, and that
    // change registers again with the new bearer, so a bearer that reads as
    // expired waits once for it. The read is the device clock's: a phone set
    // hours ahead sees every fresh token as expired, so after the grace the
    // same bearer is sent and authn's answer decides.
    const expiresAtMs = readAccessTokenExpiryMs(bearer);
    if (
      expiresAtMs !== null &&
      expiresAtMs <= Date.now() &&
      this.heldExpiredBearer !== bearer
    ) {
      this.heldExpiredBearer = bearer;
      this.scheduleRegistration(EXPIRED_BEARER_GRACE_MS);
      return;
    }
    const mutedSeverities = readMutedSeverities(userId);
    const key = registrationKey(userId, token, mutedSeverities);
    if (this.lastRegisteredKey === key) return;
    const revision = this.registrationRevision;
    this.lastRegisteredKey = null;
    this.setRegistrationState("pending");
    this.registrationInFlight = true;
    let result: PushTokenFetchResult;
    try {
      result = await this.options.registerToken(
        this.options.authnBaseUrl,
        bearer,
        {
          token,
          platform: this.options.platform,
          environment: this.options.environment,
          mutedSeverities,
        },
      );
    } catch {
      if (
        this.bearerToken === bearer &&
        revision === this.registrationRevision
      ) {
        this.setRegistrationState("failed");
      }
      reportPushRegistrationFailure("upload-error");
      return;
    } finally {
      this.registrationInFlight = false;
      const wantedKey = this.wantedRegistrationKey();
      if (
        wantedKey !== null &&
        (wantedKey !== key ||
          this.bearerToken !== bearer ||
          revision !== this.registrationRevision)
      ) {
        this.scheduleRegistration(SCHEDULED_REGISTRATION_DELAY_MS);
      }
    }
    if (result.kind !== "ok") {
      if (
        this.bearerToken === bearer &&
        revision === this.registrationRevision
      ) {
        this.setRegistrationState("failed");
      }
      reportPushRegistrationFailure(result.kind);
      return;
    }
    // Record the key only if this login is still the current one: a sign-out
    // that landed during the HTTP round trip already cleared the guard, and
    // restoring it here would make the NEXT sign-in of this same user skip
    // registering a row the sign-out just removed.
    if (this.bearerToken === bearer && revision === this.registrationRevision) {
      this.lastRegisteredKey = key;
      if (this.wantedRegistrationKey() === key)
        this.setRegistrationState("registered");
    }
    const wantedKey = this.wantedRegistrationKey();
    if (wantedKey !== null && wantedKey !== this.lastRegisteredKey) {
      this.scheduleRegistration(SCHEDULED_REGISTRATION_DELAY_MS);
    }
  }

  /** The key a registration sent now would carry; `null` with nothing to send. */
  private wantedRegistrationKey(): string | null {
    if (this.userId === null || this.deviceToken === null) return null;
    return registrationKey(
      this.userId,
      this.deviceToken,
      readMutedSeverities(this.userId),
    );
  }

  /** The signed-in account's user id, read from the login session itself. */
  private async signedInUserId(): Promise<string | null> {
    const tokenStore = this.tokenSource;
    if (tokenStore === null) return null;
    const credentials = await tokenStore.get();
    return credentials === null ? null : credentials.user.id;
  }

  /**
   * (Re)arms one trailing send through the late-grant path, which sends only
   * while signed in with permission granted.
   */
  private scheduleRegistration(delayMs: number): void {
    this.cancelScheduledRegistration();
    this.scheduledRegistrationTimer = window.setTimeout(() => {
      this.scheduledRegistrationTimer = null;
      void this.registerIfGranted(false, false);
    }, delayMs);
  }

  private cancelScheduledRegistration(): void {
    if (this.scheduledRegistrationTimer === null) return;
    window.clearTimeout(this.scheduledRegistrationTimer);
    this.scheduledRegistrationTimer = null;
  }

  private async unregisterAfterSignOut(): Promise<void> {
    const bearer = this.bearerToken;
    const token = this.cleanupToken;
    this.registrationRevision += 1;
    this.clearProviderRegistrationTimer();
    this.lastResumeRevalidationAt = null;
    this.setRegistrationState("pending");
    this.bearerToken = null;
    this.heldExpiredBearer = null;
    this.userId = null;
    this.lastRegisteredKey = null;
    // The stored set stays for this account's next sign-in, which sends it.
    this.cancelScheduledRegistration();
    if (bearer === null || token === null) return;
    try {
      // This remove is the PRIMARY cleanup, not a nicety: plain sign-out is
      // local-only (the credential is deleted, the session family is NOT
      // revoked), so the retained bearer is normally still valid - which is
      // exactly what lets this call succeed. If it fails, the row lingers
      // deliverable until the family is revoked from the sessions panel, the
      // token rebinds to another login, or authn's reaper collects it after
      // the family's sessions expire.
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

type PushRegistrationFailure =
  | "provider-error"
  | "provider-timeout"
  | "listener-error"
  | "registration-error"
  | "upload-error"
  | "unauthorized"
  | "rejected"
  | "network-error";

function reportPushRegistrationFailure(reason: PushRegistrationFailure): void {
  // Native/HTTP errors can contain credentials or addresses. Only this closed
  // vocabulary leaves the process, without inherited user data or breadcrumbs.
  withScope((scope) => {
    scope.clear();
    scope.addEventProcessor((event) => ({
      event_id: event.event_id,
      timestamp: event.timestamp,
      platform: event.platform,
      release: event.release,
      environment: event.environment,
      level: "error",
      message: "Mobile push registration failed",
      tags: { "push.failure": reason },
    }));
    captureMessage("Mobile push registration failed", "error");
  });
}

function logPushFailure(context: string): (error: unknown) => void {
  return (error) => {
    console.warn(`[push] ${context} failed`, error);
  };
}

/** `mutedSeverities` must already be normalized (sorted, deduplicated). */
function registrationKey(
  userId: string,
  deviceToken: string,
  mutedSeverities: readonly PushSeverity[],
): string {
  return `${userId}:${deviceToken}:${mutedSeverities.join(",")}`;
}

/**
 * Per account, so two accounts on one phone never share a choice; sign-out
 * leaves it, so signing back in gets the same phone back.
 */
function mutedSeveritiesStorageKey(userId: string): string {
  return `traycer.push.mutedSeverities:${userId}`;
}

/**
 * The muted set stored for `userId`, normalized. Missing, unreadable or
 * malformed storage reads as `[]` - nothing muted, which is what a phone that
 * never changed anything sends.
 */
function readMutedSeverities(userId: string): readonly PushSeverity[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(mutedSeveritiesStorageKey(userId));
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return isUnknownArray(parsed) ? normalizeMutedSeverities(parsed) : [];
}

/**
 * Known severities only, each once, sorted: the stored value, the key segment
 * and the wire value are then the same for the same choice whatever order
 * the switches were flipped in.
 */
function normalizeMutedSeverities(
  values: readonly unknown[],
): readonly PushSeverity[] {
  const muted = new Set<PushSeverity>();
  for (const value of values) {
    const severity = hostNotificationSeveritySchema.safeParse(value);
    if (severity.success) muted.add(severity.data);
  }
  return Array.from(muted).sort();
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Maps a tapped push's `data` (`{entryId, epicId, chatId}` from the server's
 * fan-out contract, with `botId`, `threadId` and `messageId` for a row of a
 * bot's channel) onto the GUI's versioned notification-activation envelope,
 * so the focus bridge routes it exactly like a desktop native notification
 * click and acknowledges the correlated cloud feed row.
 *
 * The push data carries no route `kind`, so the mapping is by presence:
 * chat when both ids exist, epic when only the epic does. A chat that names
 * its bot carries the bot's row with it, which opens the bot's channel with
 * the thread beside it; without one it opens as a chat. Anything less
 * returns `{}`, which the bridge parses as `unknown` and answers by opening
 * the notification center - the honest fallback, never a dropped tap.
 */
export function activationPayloadFromPushData(data: unknown): unknown {
  const record = isRecord(data) ? data : {};
  const entryId = readString(record.entryId);
  const epicId = readString(record.epicId);
  const chatId = readString(record.chatId);
  const botId = readString(record.botId);
  const bot =
    botId === null
      ? {}
      : {
          botId,
          threadId: readString(record.threadId),
          messageId: readString(record.messageId),
        };
  const route =
    epicId !== null && chatId !== null
      ? { kind: "chat", epicId, chatId, ...bot }
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
