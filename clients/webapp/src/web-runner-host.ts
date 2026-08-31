import {
  applySlowDown,
  createPollSchedule,
  DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
  isDeviceExpired,
  pollDeviceToken,
  resetPollInterval,
  startDeviceAuthorization,
  type DeviceAuthorizationResult,
  type DeviceClientId,
  type DevicePollSchedule,
} from "@traycer-clients/shared/auth/device-auth";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import {
  refreshOnceAbortable,
  validateAuthTokenIdentityAccessOnceAbortable,
  validateAuthTokenIdentityAccessOnly,
} from "@traycer-clients/shared/auth/auth-validation";
import {
  listUserSessionsViaHttp,
  mintHostCredentialViaHttp,
  requestStepUpChallengeViaHttp,
  revokeAllSessionsViaHttp,
  revokeUserSessionViaHttp,
  toRetainedStepUpVerifyResult,
  verifyStepUpChallengeViaHttp,
  type ListUserSessionsFetchResult,
  type MintHostCredentialFetchResult,
  type RetainedStepUpVerifyFetchResult,
  type RevokeAllSessionsFetchResult,
  type RevokeUserSessionFetchResult,
  type StepUpChallengeFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import {
  linkLoginStatusViaHttp,
  mintLinkLoginCodeViaHttp,
  respondLinkLoginViaHttp,
  type LinkLoginStatusFetchResult,
  type MintLinkLoginCodeFetchResult,
  type RespondLinkLoginFetchResult,
} from "@traycer-clients/shared/auth/link-login";
import type { MintHostCredentialRequest } from "@traycer/protocol/auth/devices-sessions";
import {
  fetchRegisteredHostsViaHttp,
  type HostListFetchResult,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  updateHostVersionPolicyViaHttp,
  type UpdateHostVersionPolicyFetchResult,
  type UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import {
  deregisterHostViaHttp,
  type DeregisterHostFetchResult,
} from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import type {
  DeviceFlowAuthorization,
  DeviceFlowResult,
  DeviceFlowSession,
  HostRestartRequestResult,
  IDeviceFlowHost,
  IDeviceDescriber,
  ILinkCodeScanner,
  ILinkLoginDeepLinkSource,
  INotificationHost,
  IPushPermissionHost,
  IRunnerHost,
  SystemResumeEvent,
  ISecureStorage,
  ITokenStore,
  ITrayState,
  IWorkspaceFoldersHost,
  LocalHostSnapshot,
  NotificationShowOutcome,
  RegisteredHostsChange,
  TrayEpic,
  TrayIndicatorState,
} from "@traycer-clients/shared/platform/runner-host";
import {
  createInProcessSelectionAuthority,
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
  type InProcessSelectionAuthority,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import {
  createIncrementingIncarnationIds,
  silentAuthorityLog,
  systemAuthorityClock,
  type PreferredHostSaveResult,
  type PreferredHostStore,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { SelectionAuthorityClient } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import {
  WebTokenStore,
  type WebCredentialStorage,
  type WebLockManager,
} from "./web-token-store";

export interface WebRunnerHostOptions {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hostLabel: string;
  /** The relay's fixed WS attach endpoint (`IRunnerHost.relayBaseUrl`). */
  readonly relayBaseUrl: string;
  /**
   * Origin-wide credential slot and the cross-tab lock guarding it. Injected
   * rather than reached for, because "two tabs of one origin" is the whole
   * contract of the token store below and a test has to be able to build it.
   */
  readonly credentialStorage: WebCredentialStorage;
  readonly locks: WebLockManager;
}

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

interface RetainedStepUpCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * The browser shell's `IRunnerHost`.
 *
 * Its CAPABILITY posture is the phone's, not the desktop's: no local host, no
 * native folder dialog, no tray/menu/updater/zoom, no OS service or CLI. What
 * it is NOT is the phone's PRODUCT posture - this shell deliberately never
 * calls `setMobileApp`, so multi-draft composing, shortcut hints and the
 * keybindings surface stay, which is correct for a desktop browser.
 *
 * Like the phone shell and unlike the desktop, this one owns its auth HTTP
 * IN-PROCESS: there is no privileged process to escape renderer CORS through,
 * so the tab's own origin must be the one authn allows (the web dashboard
 * origin). Every member below delegates to the same shared `*ViaHttp` helper
 * the desktop's main process uses, so the two boundaries cannot drift.
 */
export class WebRunnerHost implements IRunnerHost {
  /**
   * No native browser capability: a tab cannot host an embedded browser view
   * the way the desktop shell can. `null` is the contract's own answer for a
   * shell without one, so consumers branch on it rather than on the platform.
   */
  readonly browserView = null;
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly relayBaseUrl: string;
  readonly hasLocalHost = false;
  /**
   * The browser already gives every context its own tab, its own URL and
   * its own history, so an in-app strip would be a second row of tabs above
   * the one the person is already using.
   */
  readonly hasAppTabs = false;
  /**
   * A real browser tab is one of the surfaces that honours the write, so the
   * image reaches the system clipboard here and "Copy image" reports a success
   * the clipboard actually received.
   */
  readonly canCopyImages = true;
  readonly secureStorage: ISecureStorage;
  readonly tokenStore: ITokenStore;
  readonly notifications: INotificationHost = buildNotifications();
  readonly tray: ITrayState = new WebNoopTrayState();
  readonly workspaceFolders: IWorkspaceFoldersHost = {
    // No native folder dialog in a tab - remote-host folder adds go through
    // the RPC-backed remote folder picker in gui-app.
    canPickNatively: false,
    pickFolders: async (): Promise<readonly string[]> => [],
  };
  readonly fileDrops = {
    resolveDroppedFilePaths: async (
      files: readonly File[],
    ): Promise<readonly string[]> => {
      void files;
      return [];
    },
    copyDroppedFilePaths: async (
      paths: readonly string[],
    ): Promise<readonly string[]> => paths,
    readNativeClipboardFilePaths: async (): Promise<readonly string[]> => [],
  };
  /**
   * No native save route in a tab, and `null` is not a degradation here: the
   * File System Access API and `<a download>` are exactly what gui-app falls
   * back to when a shell reports none.
   */
  readonly fileSave: null = null;
  readonly zoom = null;
  readonly service = null;
  readonly traycerCli = null;
  readonly migration = null;
  readonly hostManagement = null;
  readonly hostTray = null;
  /** No camera scanner in a tab; the paste-the-code path is the whole surface. */
  readonly linkCodeScanner: ILinkCodeScanner | null = null;
  /** Nothing better than the browser UA is known here, so consumers use that. */
  readonly deviceDescriber: IDeviceDescriber | null = null;
  /** No OS ever opens a URL into a tab, so no code can arrive that way. */
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null = null;
  /** No Web Push adapter in v1: the in-app bell is the whole notification surface. */
  readonly pushPermission: IPushPermissionHost | null = null;
  readonly deviceFlow: IDeviceFlowHost;
  private retainedStepUpCredential: RetainedStepUpCredential | null = null;
  /**
   * Two emitters over the same DOM edge, deliberately not one shared instance -
   * see {@link WebVisibilityEdgeSignal} and the two subscription methods below.
   */
  private readonly browserReturn = new WebVisibilityEdgeSignal(
    "browser-return",
  );
  private readonly systemResume = new WebVisibilityEdgeSignal("system-resume");
  /**
   * The in-window selection authority (the "shell with no main process"
   * binding the contract names): the SAME engine desktop mounts in Electron
   * main, behind the in-process adapter. A tab has no local host and cannot
   * provision one, so the ensure port refuses and the outage signal is inert -
   * derivation only ever lands on a remote host or on ∅.
   */
  readonly selectionFleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: null,
    hosts: [],
  });
  readonly selectionIdentity = new InMemoryAuthorityIdentitySource(null);
  private readonly selectionPreferredStore: PreferredHostStore =
    new WebPreferredHostStore();
  private readonly selectionAuthorityMount: InProcessSelectionAuthority;
  readonly selectionAuthority: SelectionAuthorityClient;

  constructor(options: WebRunnerHostOptions) {
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.authnBaseUrl;
    this.relayBaseUrl = options.relayBaseUrl;
    this.secureStorage = buildSecureStorage(options.credentialStorage);
    this.tokenStore = new WebTokenStore({
      storage: options.credentialStorage,
      locks: options.locks,
      authnBaseUrl: options.authnBaseUrl,
      refresh: refreshOnceAbortable,
      probeIdentity: validateAuthTokenIdentityAccessOnceAbortable,
    });
    this.deviceFlow = new WebDeviceFlowHost(
      options.authnBaseUrl,
      options.hostLabel,
    );
    this.selectionAuthorityMount = createInProcessSelectionAuthority({
      fleet: this.selectionFleet,
      identity: this.selectionIdentity,
      // Refusing (rather than deferring) is what makes the engine's ∅
      // definition come out right on a shell that can never provision: no
      // usable lease AND no ensure available.
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      preferredStore: this.selectionPreferredStore,
      clock: systemAuthorityClock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });
    this.selectionAuthority = this.selectionAuthorityMount.client;
    // The identity port follows the token store: the stored credential IS this
    // tab's signed-in identity. The generation advances only when the USER
    // changes - `syncSelectionIdentity` compares ids before setting - so
    // neither a routine rotation nor a sibling tab's adopted write wipes the
    // authority's evidence.
    this.tokenStore.subscribe((change) => {
      this.syncSelectionIdentity(change.userId);
    });
    void this.tokenStore.get().then((stored) => {
      this.syncSelectionIdentity(stored?.user.id ?? null);
      if (stored === null) {
        void this.refreshHostFleet();
      }
    });
  }

  /**
   * Advances the identity port when the signed-in USER actually changed, and
   * re-reads the fleet under the new identity - the same "identity change
   * refreshes the fleet" edge the engine's own doc names.
   */
  private syncSelectionIdentity(userId: string | null): void {
    if (this.selectionIdentity.current().identityKey === userId) {
      return;
    }
    this.selectionIdentity.set(userId);
    void this.refreshHostFleet();
  }

  /**
   * `IRunnerHost.refreshHostFleet`: re-reads fleet membership and publishes it
   * atomically. The generation is captured before the (async) read and
   * re-checked after, so a fetch that raced an identity transition is dropped
   * rather than stamped onto the new account.
   */
  async refreshHostFleet(): Promise<void> {
    const identity = this.selectionIdentity.current();
    const hostIds = await this.resolveFleetHostIds();
    if (hostIds === null) {
      return;
    }
    if (this.selectionIdentity.current().generation !== identity.generation) {
      return;
    }
    this.selectionFleet.publish(
      identity.generation,
      null,
      hostIds.map((hostId) => ({ hostId, kind: "remote" as const })),
    );
  }

  /**
   * `null`: this shell owns no registry cadence - the directory keeps its own
   * poll timer, exactly as the browser/dev topology the contract describes.
   */
  onRegisteredHostsChange(
    handler: (push: RegisteredHostsChange) => void,
  ): Disposable | null {
    void handler;
    return null;
  }

  private async resolveFleetHostIds(): Promise<readonly string[] | null> {
    const stored = await this.tokenStore.get();
    if (stored === null) {
      // Signed out is an answer, not a failure: an empty fleet is what lets
      // the engine retire a previous account's derivation.
      return [];
    }
    const result = await fetchRegisteredHostsViaHttp(
      this.authnBaseUrl,
      stored.token,
    );
    if (result.kind !== "ok") {
      return null;
    }
    return result.response.hosts.map((host) => host.hostId);
  }

  beginAuthAttempt(): void {
    // Device-flow tokens arrive through `deviceFlow`; there is no callback
    // payload or attempt-specific URL state in a browser tab.
  }

  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    // Access-only: a stale token comes back `rejected` and the caller routes
    // the refresh spend through the locked `tokenStore.rotate`, so validation
    // can never consume a refresh token.
    return validateAuthTokenIdentityAccessOnly(this.authnBaseUrl, token);
  }

  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult> {
    return fetchRegisteredHostsViaHttp(this.authnBaseUrl, bearerToken);
  }

  listUserSessions(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<ListUserSessionsFetchResult> {
    // Owning the request in-process, this hands the caller's signal straight
    // to `fetch` and aborts for real - the desktop can only settle its caller.
    return listUserSessionsViaHttp(this.authnBaseUrl, bearerToken, signal);
  }

  async revokeUserSession(
    bearerToken: string,
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult> {
    const stepUpToken = useStepUpCredential
      ? this.activeRetainedStepUpToken()
      : null;
    const result = await revokeUserSessionViaHttp(
      this.authnBaseUrl,
      stepUpToken ?? bearerToken,
      familyId,
    );
    // A step-up-required verdict on a retained credential means the server
    // just rejected it, so holding it would re-send a credential known to be
    // dead and re-prompt in a loop.
    if (result.kind === "step-up-required" && useStepUpCredential) {
      this.retainedStepUpCredential = null;
    }
    return result;
  }

  async revokeAllSessions(
    bearerToken: string,
  ): Promise<RevokeAllSessionsFetchResult> {
    const result = await revokeAllSessionsViaHttp(
      this.authnBaseUrl,
      this.activeRetainedStepUpToken() ?? bearerToken,
    );
    this.retainedStepUpCredential = null;
    return result;
  }

  mintHostCredential(
    bearerToken: string,
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult> {
    // The caller's own bearer: the mint is not step-up gated, so a retained
    // step-up credential must not be substituted here.
    return mintHostCredentialViaHttp(
      this.authnBaseUrl,
      bearerToken,
      request,
      null,
    );
  }

  requestStepUpChallenge(
    bearerToken: string,
  ): Promise<StepUpChallengeFetchResult> {
    return requestStepUpChallengeViaHttp(this.authnBaseUrl, bearerToken);
  }

  mintLinkLoginCode(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<MintLinkLoginCodeFetchResult> {
    return mintLinkLoginCodeViaHttp(this.authnBaseUrl, bearerToken, signal);
  }

  linkLoginStatus(
    bearerToken: string,
    code: string,
    signal: AbortSignal,
  ): Promise<LinkLoginStatusFetchResult> {
    return linkLoginStatusViaHttp(this.authnBaseUrl, bearerToken, code, signal);
  }

  respondLinkLogin(
    bearerToken: string,
    code: string,
    approve: boolean,
  ): Promise<RespondLinkLoginFetchResult> {
    return respondLinkLoginViaHttp(
      this.authnBaseUrl,
      bearerToken,
      code,
      approve,
    );
  }

  async verifyStepUpChallenge(
    bearerToken: string,
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult> {
    const result = await verifyStepUpChallengeViaHttp(
      this.authnBaseUrl,
      bearerToken,
      code,
    );
    if (result.kind === "ok") {
      this.retainedStepUpCredential = {
        accessToken: result.response.access_token,
        expiresAtMs:
          Date.now() +
          Math.max(
            0,
            result.response.expires_in * 1_000 - STEP_UP_EXPIRY_SKEW_MS,
          ),
      };
    }
    // Only expiry metadata crosses back out; the bearer stays in here.
    return toRetainedStepUpVerifyResult(result);
  }

  /**
   * Self-nulls on expiry so a dead credential is never re-sent, matching the
   * desktop closure and `MockRunnerHost` - the three must not drift.
   */
  private activeRetainedStepUpToken(): string | null {
    if (this.retainedStepUpCredential === null) {
      return null;
    }
    if (this.retainedStepUpCredential.expiresAtMs <= Date.now()) {
      this.retainedStepUpCredential = null;
      return null;
    }
    return this.retainedStepUpCredential.accessToken;
  }

  updateHostVersionPolicy(
    bearerToken: string,
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult> {
    return updateHostVersionPolicyViaHttp(
      this.authnBaseUrl,
      bearerToken,
      hostId,
      input,
    );
  }

  deregisterHostFromAccount(
    bearerToken: string,
    hostId: string,
  ): Promise<DeregisterHostFetchResult> {
    return deregisterHostViaHttp(this.authnBaseUrl, bearerToken, hostId);
  }

  async getLastKnownLocalHostId(): Promise<string | null> {
    // A tab never runs a host, so there is no pid metadata to read and no "my
    // own host, currently down" case to disambiguate.
    return null;
  }

  async openExternalLink(url: string): Promise<void> {
    // A NEW browsing context, never `location.assign`: this is the app's own
    // tab, and navigating it away would tear down an in-flight device-flow
    // poll along with every open surface. Every markdown, settings and
    // sign-in link routes through here, so a same-tab navigation (or a no-op)
    // is what breaking sign-in looks like.
    //
    // `noopener` because the opened page is arbitrary user content: without
    // it the callee holds a live `window.opener` handle into this app's tab.
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]> {
    // A page cannot query the OS scheme registry, so nothing native is
    // offered - callers read the empty list as "offer nothing native".
    void schemes;
    return [];
  }

  async requestMicrophoneAccess(): Promise<"granted" | "denied"> {
    // No native gate in a tab; `getUserMedia` raises the browser's own prompt.
    return "granted";
  }

  async openMicrophoneSettings(): Promise<void> {
    // No settings pane a page may open.
  }

  onAuthCallback(handler: () => void): Disposable {
    // The browser-return signal is this tab regaining visibility after the
    // sign-in tab was used, not a parsed callback URL: there is no custom
    // scheme here and `IRunnerHost.onAuthCallback` is payload-free anyway.
    // The token always arrives through the device-flow poll, so sign-in still
    // completes if this never fires - all it buys is collapsing one poll
    // interval.
    //
    // Its own emitter, separate from `onSystemResumed`'s: the two read the same
    // DOM event and answer different questions, and this one's consumer is a
    // poll nudge that may be dropped freely.
    return this.browserReturn.subscribe(handler);
  }

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    handler(null);
    return disposable();
  }

  onNetworkPathChanged(_handler: () => void): Disposable {
    // Native-only: a tab cannot observe the interface moving under live
    // connectivity, which is the event this reports. The contract expects a
    // no-op here rather than a DOM approximation - `window`'s `online` event
    // is a different signal and the wake consumers already pair with it.
    return disposable();
  }

  onSystemResumed(handler: (event: SystemResumeEvent) => void): Disposable {
    // This document's hidden -> visible edge IS the wake signal here, for the
    // reason it is one on the phone: a tab the browser froze or discarded had
    // its sockets killed and its timers stopped while the network never moved,
    // so `window 'online'` - the only trigger the shared wake consumers have
    // left otherwise - cannot fire for it. What went away is this runtime.
    //
    // Raw visibility is a safe wake trigger ONLY because the wake path is
    // probe-first: it pings each live session and re-dials just the ones that
    // fail to answer inside the probe window, so an ordinary alt-tab keeps its
    // healthy streams. A BLIND reconnect on this same edge would tear them
    // down once per hide/show, and anything wiring one onto this signal breaks
    // the invariant that makes it publishable at all.
    //
    // Its own emitter, separate from `onAuthCallback`'s: the two share a DOM
    // event and nothing else. One collapses a device-flow poll's interval, the
    // other opens a stream-recovery episode, and an emission policy added for
    // either must not silently become the other's.
    //
    // `backgroundedForMs: null` is the honest answer, not a placeholder: the
    // signal is a raw visibility edge and carries no stamp of when the freeze
    // began, which is the case the contract documents as unmeasurable. It
    // selects the conservative, desktop-calibrated recovery - the right default
    // for a tab that cannot prove how long it was gone.
    return this.systemResume.subscribe(() =>
      handler({ backgroundedForMs: null }),
    );
  }

  async requestHostRespawn(): Promise<HostRestartRequestResult> {
    // Nothing in a tab can restart a host: the machine running it owns its
    // lifecycle. `declined` carries that back as a normal outcome the calling
    // surface renders - the lane never rejects.
    return {
      kind: "declined",
      message: "Restart this host from the machine running it.",
    };
  }
}

// The deployed authn's `/device/authorize` accepts `cli`, `desktop` and
// `mobile`; there is no web kind yet, so this shell asks as `desktop` - the
// same stand-in the phone shell uses. The approval page's copy is keyed off
// this, so it moves the moment a web kind exists.
const DEVICE_FLOW_CLIENT_ID: DeviceClientId = "desktop";

class WebDeviceFlowHost implements IDeviceFlowHost {
  constructor(
    private readonly authnBaseUrl: string,
    private readonly hostLabel: string,
  ) {}

  async start(): Promise<DeviceFlowSession | null> {
    const authorization = await startDeviceAuthorization(
      this.authnBaseUrl,
      { clientId: DEVICE_FLOW_CLIENT_ID, hostLabel: this.hostLabel },
      { signal: undefined, timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS },
    );
    if (authorization.kind !== "started") {
      return null;
    }
    return new WebDeviceFlowSession(this.authnBaseUrl, authorization);
  }
}

/**
 * A real RFC 8628 loop running in the page - the in-process variant
 * `IRunnerHost.deviceFlow` describes for a shell with no privileged process. A
 * shell that resolved `null` here could not sign in at all: device flow is the
 * only interactive login the GUI ships.
 *
 * No return scheme is threaded onto the verification URL. A tab registers no
 * custom scheme, and firing `traycer://` from a page would hand the approval
 * back to whichever app on the machine claims it. Completion is poll-only,
 * with the visibility edge merely collapsing the wait.
 */
class WebDeviceFlowSession implements DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization;
  private readonly abortController = new AbortController();
  private readonly handlers = new Set<(result: DeviceFlowResult) => void>();
  private settledResult: DeviceFlowResult | null = null;
  private wakePoll: (() => void) | null = null;

  constructor(
    private readonly authnBaseUrl: string,
    private readonly started: Extract<
      DeviceAuthorizationResult,
      { kind: "started" }
    >,
  ) {
    this.authorization = {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresInSeconds: started.expiresInSeconds,
      intervalSeconds: started.intervalSeconds,
    };
    void this.run();
  }

  onResult(handler: (result: DeviceFlowResult) => void): Disposable {
    if (this.settledResult !== null) {
      handler(this.settledResult);
      return disposable();
    }
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  pollNow(): void {
    this.wakePoll?.();
  }

  cancel(): void {
    this.abortController.abort();
    this.wakePoll?.();
    this.handlers.clear();
  }

  private async run(): Promise<void> {
    let schedule: DevicePollSchedule = createPollSchedule({
      intervalSeconds: this.started.intervalSeconds,
      expiresInSeconds: this.started.expiresInSeconds,
      startedAtMs: Date.now(),
    });
    while (!this.abortController.signal.aborted) {
      if (isDeviceExpired(schedule, Date.now())) {
        this.settle({ kind: "expired" });
        return;
      }
      const poll = await pollDeviceToken(
        this.authnBaseUrl,
        this.started.deviceCode,
        DEVICE_FLOW_CLIENT_ID,
        {
          signal: this.abortController.signal,
          timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
        },
      );
      if (this.abortController.signal.aborted) {
        return;
      }
      switch (poll.kind) {
        case "authorized":
          this.settle({
            kind: "authorized",
            token: poll.token,
            refreshToken: poll.refreshToken,
          });
          return;
        case "access-denied":
          this.settle({ kind: "denied" });
          return;
        case "expired":
          this.settle({ kind: "expired" });
          return;
        case "invalid":
          this.settle({ kind: "error" });
          return;
        case "slow-down":
          schedule = applySlowDown(schedule, poll.retryAfterSeconds);
          break;
        case "authorization-pending":
          // An accepted poll means the pacing is compliant again, so any
          // earlier slow_down widening must not outlive the violation -
          // especially here, where the visibility nudge may poll one interval
          // early.
          schedule = resetPollInterval(schedule);
          break;
        case "network-error":
          break;
      }
      await this.waitForNextPoll(schedule.intervalMs);
    }
  }

  private waitForNextPoll(intervalMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener("abort", finish);
        if (this.wakePoll === finish) {
          this.wakePoll = null;
        }
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      this.wakePoll = finish;
      this.abortController.signal.addEventListener("abort", finish, {
        once: true,
      });
    });
  }

  private settle(result: DeviceFlowResult): void {
    if (this.settledResult !== null || this.abortController.signal.aborted) {
      return;
    }
    this.settledResult = result;
    for (const handler of this.handlers) {
      handler(result);
    }
    this.handlers.clear();
    // Nothing to dismiss: the verification page lives in a tab this one does
    // not hold a handle to (see `openExternalLink`).
  }
}

/**
 * This document's hidden -> visible edge, as a subscribable signal.
 *
 * The shell holds TWO instances rather than one shared emitter - the auth
 * return-nudge (`onAuthCallback`) and the resume episode (`onSystemResumed`).
 * They observe the same DOM event and answer different questions, so each owns
 * its own subscriber set and its own edge state: a debounce, a filter or a
 * suppression added for one consumer stays with that consumer instead of
 * silently becoming the other's policy. `label` is what tells their log lines
 * apart.
 *
 * Fires ONLY on the hidden -> visible edge, and that edge filter is the whole
 * dedupe: a repeat needs a real hide in between. Deliberately no debounce
 * timer - every consumer downstream is idempotent and rate-limits itself (the
 * wake path probes before it re-dials; the device poll has one pending wait) -
 * and a timer here would only add latency to the recovery this exists to make
 * fast.
 */
class WebVisibilityEdgeSignal {
  private readonly handlers = new Set<() => void>();
  private hidden = false;
  private listening = false;

  constructor(private readonly label: string) {}

  private readonly onVisibilityChange = (): void => {
    const hidden = document.visibilityState === "hidden";
    const resumed = this.hidden && !hidden;
    this.hidden = hidden;
    if (!resumed) {
      return;
    }
    for (const handler of Array.from(this.handlers)) {
      try {
        handler();
      } catch (error) {
        // One bad subscriber must not cost the others their signal.
        console.error(`[web] ${this.label} handler threw`, error);
      }
    }
  };

  subscribe(handler: () => void): Disposable {
    this.ensureListening();
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  /**
   * Installs the DOM listener on first subscription and keeps it: the
   * visible/hidden state has to stay tracked across a window with no
   * subscribers, or the next edge is read against a stale baseline. Seeding
   * from the CURRENT state here (rather than at construction) is what keeps a
   * cold load from counting as an edge - a tab that loads visible has not
   * returned from anywhere, and one that loads hidden has not woken up yet.
   */
  private ensureListening(): void {
    if (this.listening || typeof document === "undefined") {
      return;
    }
    this.listening = true;
    this.hidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }
}

/**
 * Namespace for the generic `ISecureStorage` seam.
 *
 * The prefix is not decoration. `AuthService` reads two LEGACY slots through
 * this seam (`traycer.token` / `traycer.refresh-token`) and DELETES them once
 * it has migrated them - and this origin also serves the web dashboard, whose
 * own storage is a stranger to this shell. Namespacing makes that migration a
 * permanent no-op here (this shell has no legacy credentials, having never
 * shipped with those slots) instead of a read, and possible delete, of
 * whatever else happens to answer to those names on the origin.
 */
const WEB_SECURE_STORAGE_PREFIX = "traycer.webapp.";

function buildSecureStorage(storage: WebCredentialStorage): ISecureStorage {
  return {
    get: async (key) => storage.read(`${WEB_SECURE_STORAGE_PREFIX}${key}`),
    set: async (key, value) => {
      storage.write(`${WEB_SECURE_STORAGE_PREFIX}${key}`, value);
    },
    delete: async (key) => {
      storage.remove(`${WEB_SECURE_STORAGE_PREFIX}${key}`);
    },
  };
}

function buildNotifications(): INotificationHost {
  return {
    // Native OS notification preferences are a desktop-app surface; a tab has
    // no page of its own to open, so the contract's browser answer is `null`.
    systemSettings: null,
    // `show` is a no-op that reports `presented`, matching the phone shell.
    // v1 wires no Web Notification adapter, so the in-app bell is the alert
    // surface - and `presented` (rather than `undeliverable`) is what stops
    // the caller from adding a second, duplicate fallback cue on top of it.
    show: async (
      title,
      body,
      payload,
      replaceKey,
      deliveryKey,
      feedSource,
      foregroundAppLocal,
    ): Promise<NotificationShowOutcome> => {
      void title;
      void body;
      void payload;
      void replaceKey;
      void deliveryKey;
      void feedSource;
      void foregroundAppLocal;
      return "presented";
    },
    onClick: (handler) => {
      // Nothing shows an OS notification here, so nothing can be clicked.
      void handler;
      return disposable();
    },
    onForegroundDisplay: (handler) => {
      // The cross-window relay exists because a desktop shell can have another
      // Traycer window focused. This shell has no window bridge, so nothing
      // ever emits here.
      void handler;
      return disposable();
    },
  };
}

function disposable(): Disposable {
  return { dispose: () => undefined };
}

class WebNoopTrayState implements ITrayState {
  async setEpics(epics: readonly TrayEpic[]): Promise<void> {
    void epics;
  }

  async setIndicator(state: TrayIndicatorState): Promise<void> {
    void state;
  }

  onEpicSelected(handler: (epicId: string) => void): Disposable {
    void handler;
    return disposable();
  }
}

/**
 * Identity-bucketed preferred-host persistence for the in-window authority,
 * durable across loads via `localStorage`. Bucketing by identity keeps the
 * "another account inherits nothing" property the desktop store has.
 *
 * A failed READ is genuinely "no preference" (the first-run answer); a failed
 * WRITE is reported so the engine can treat the preference as unsaved.
 */
class WebPreferredHostStore implements PreferredHostStore {
  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    try {
      return window.localStorage.getItem(preferredHostKey(identityKey));
    } catch {
      return null;
    }
  }

  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult {
    if (identityKey === null) return { ok: true };
    try {
      if (hostId === null) {
        window.localStorage.removeItem(preferredHostKey(identityKey));
      } else {
        window.localStorage.setItem(preferredHostKey(identityKey), hostId);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }
}

function preferredHostKey(identityKey: string): string {
  return `traycer.webapp.preferred-host.${identityKey}`;
}
