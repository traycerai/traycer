import { AppLauncher } from "@capacitor/app-launcher";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import {
  applySlowDown,
  createPollSchedule,
  DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
  isDeviceExpired,
  pollDeviceToken,
  resetPollInterval,
  startDeviceAuthorization,
  withReturnScheme,
  type DeviceAuthorizationResult,
  type DeviceClientId,
  type DevicePollSchedule,
} from "@traycer-clients/shared/auth/device-auth";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import {
  credentialsIdentityFromAuthenticatedUser,
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
  CredentialsMigrationOutcome,
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
  ISecureStorage,
  ITokenStore,
  ITrayState,
  IWorkspaceFoldersHost,
  LocalHostSnapshot,
  NotificationShowOutcome,
  PushPermissionState,
  RegisteredHostsChange,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
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
import type { MobilePushRegistration } from "./push-registration";

export interface MobileRunnerHostOptions {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hostLabel: string;
  /** The relay's fixed WS attach endpoint (`IRunnerHost.relayBaseUrl`). */
  readonly relayBaseUrl: string;
  /**
   * OS push lifecycle owner, or `null` where pushes cannot exist (the dev web
   * entry, tests). Its click relay and its permission reads are consumed here -
   * registration itself follows the token store on its own once `start()` runs
   * in bootstrap.
   */
  readonly pushRegistration: MobilePushRegistration | null;
  /**
   * Jumps to this app's notification page in the OS Settings app - the only
   * repair path once the OS has remembered a refusal. Injected (rather than
   * called from here) so the native-settings plugin stays in the bootstrap
   * entry and these host tests stay plugin-free; `null` on the dev web entry,
   * where there is no OS page to open - which also makes `pushPermission`
   * itself `null` there (see `buildPushPermission`).
   */
  readonly openPushSettings: (() => Promise<void>) | null;
  /**
   * The deep-link scheme this build's NATIVE shell registered (`traycer` from
   * Info.plist / AndroidManifest), threaded into the verification URL as
   * `return_scheme` so the cloud's /device approval page can bounce the OS
   * back to this app after approval. `null` where no scheme is registered
   * (the dev web entry, tests) - firing `traycer://` from a plain browser tab
   * would launch an installed production app instead.
   */
  readonly returnScheme: string | null;
  /**
   * Overrides where the selection authority's fleet membership comes from, or
   * `null` for the production answer (the registry list under the stored
   * bearer). The dev entry passes the same dev-slot source the directory's
   * `remoteFetcher` uses, so the authority can derive an effective host for a
   * loopback dev host that is not registered in the cloud. Resolves to the
   * fleet's host ids, or `null` on a transient failure (the current fleet is
   * retained - a blip must not read as "you own no hosts").
   */
  readonly fleetHostIds: (() => Promise<readonly string[] | null>) | null;
  /**
   * Native QR scanner for link-login sign-in, or `null` where no camera
   * exists (the dev web entry, tests). Constructed by the entry point so the
   * barcode-scanner plugin import stays out of this module's web-safe
   * dependency set.
   */
  readonly linkCodeScanner: ILinkCodeScanner | null;
  /**
   * Native device self-description for the approver's prompt, or `null` on
   * the web entry. Constructed by the entry point for the same web-safety
   * reason as the scanner.
   */
  readonly deviceDescriber: IDeviceDescriber | null;
  /**
   * OS-delivered link-login codes (a QR scanned by the system camera), or
   * `null` on the web entry, which no OS opens URLs into. Constructed and
   * STARTED by the entry point: the capture has to be listening before this
   * host is even built, since a cold launch delivers the URL once.
   */
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null;
}

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

interface RetainedStepUpCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * The phone shell's `IRunnerHost`. Unlike the desktop, which routes these calls
 * through Electron main to escape renderer-origin CORS, this shell owns its
 * requests in-process and calls the shared `*ViaHttp` helpers directly - the
 * same posture `MockRunnerHost` takes, and the one the interface's doc comments
 * name for browser/dev shells. Nothing here reimplements a request: every
 * member below delegates to the helper the desktop's main process also uses, so
 * the two boundaries cannot drift.
 */
export class MobileRunnerHost implements IRunnerHost {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly relayBaseUrl: string;
  readonly hasLocalHost = false;
  readonly secureStorage: ISecureStorage = buildSecureStorage();
  readonly tokenStore: ITokenStore;
  readonly notifications: INotificationHost;
  readonly tray: ITrayState = new MobileNoopTrayState();
  readonly workspaceFolders: IWorkspaceFoldersHost = {
    // No native folder dialog on the phone - remote-host folder adds go
    // through the RPC-backed remote folder picker in gui-app.
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
  readonly zoom = null;
  readonly service = null;
  readonly traycerCli = null;
  readonly migration = null;
  readonly hostManagement = null;
  readonly hostTray = null;
  readonly linkCodeScanner: ILinkCodeScanner | null;
  readonly deviceDescriber: IDeviceDescriber | null;
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null;
  readonly deviceFlow: IDeviceFlowHost;
  /**
   * The phone's own notification switch. `null` wherever this shell cannot
   * both read the permission AND open the OS page to repair it (the dev web
   * entry, tests) - so the GUI's one branch on `null` hides the Settings row
   * wherever it would have nothing to report or no working button.
   */
  readonly pushPermission: IPushPermissionHost | null;
  private retainedStepUpCredential: RetainedStepUpCredential | null = null;
  private readonly systemResume = new MobileSystemResume();
  /**
   * The in-window selection authority (the "shell with no main process"
   * binding the contract names): the SAME engine desktop mounts in Electron
   * main, behind the in-process adapter, fed by the three ports below. The
   * phone has no local host and cannot provision one, so the ensure port
   * refuses and the outage signal is inert - derivation only ever lands on a
   * remote host or on ∅.
   */
  readonly selectionFleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: null,
    hosts: [],
  });
  readonly selectionIdentity = new InMemoryAuthorityIdentitySource(null);
  private readonly selectionPreferredStore: PreferredHostStore =
    new MobilePreferredHostStore();
  private readonly selectionAuthorityMount: InProcessSelectionAuthority;
  readonly selectionAuthority: SelectionAuthorityClient;
  private readonly fleetHostIds:
    (() => Promise<readonly string[] | null>) | null;

  constructor(options: MobileRunnerHostOptions) {
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.authnBaseUrl;
    this.relayBaseUrl = options.relayBaseUrl;
    this.fleetHostIds = options.fleetHostIds;
    this.linkCodeScanner = options.linkCodeScanner;
    this.deviceDescriber = options.deviceDescriber;
    this.linkLoginDeepLinks = options.linkLoginDeepLinks;
    this.notifications = buildNotifications(options.pushRegistration);
    this.pushPermission = buildPushPermission(
      options.pushRegistration,
      options.openPushSettings,
      this.systemResume,
    );
    this.tokenStore = new MobileTokenStore(
      this.secureStorage,
      options.authnBaseUrl,
    );
    this.deviceFlow = new MobileDeviceFlowHost(
      options.authnBaseUrl,
      options.hostLabel,
      options.returnScheme,
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
    // The identity port follows the token store: the stored credential IS the
    // phone's signed-in identity (there is no separate auth-session process).
    // The generation advances only when the USER changes - `syncSelectionId`
    // compares ids before setting - so a routine token rotation never wipes
    // the authority's evidence.
    this.tokenStore.subscribe((change) => {
      this.syncSelectionIdentity(change.userId);
    });
    // Seed both ports from whatever credential survived the last launch; the
    // fleet publish rides behind the identity so its generation stamp is the
    // seeded one, not the initial null's.
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
   * atomically. Callers are the membership mutations (a deregistration, a
   * fresh registration observed by the directory's poll) plus the identity
   * edge above; a duplicate call costs one refetch and can never publish
   * something false.
   *
   * The generation is captured before the (async) read and re-checked after,
   * so a fetch that raced an identity transition is dropped rather than
   * stamped onto the new account.
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
   * poll timer, exactly as the browser/dev topology does. Membership changes
   * that poll observes reach the authority through `refreshHostFleet`.
   */
  onRegisteredHostsChange(
    handler: (push: RegisteredHostsChange) => void,
  ): Disposable | null {
    void handler;
    return null;
  }

  private async resolveFleetHostIds(): Promise<readonly string[] | null> {
    if (this.fleetHostIds !== null) {
      return this.fleetHostIds();
    }
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
    // payload or attempt-specific URL state in the mobile shell.
  }

  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    // Access-only (tech plan §3): a stale token comes back `rejected` and the
    // caller routes the refresh spend through the locked `tokenStore.rotate`,
    // so validation can never consume a refresh token.
    return validateAuthTokenIdentityAccessOnly(this.authnBaseUrl, token);
  }

  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult> {
    // In-process shell: no CORS boundary to escape, so the shared HTTP helper
    // runs directly (browser/dev parity with the validator above).
    return fetchRegisteredHostsViaHttp(this.authnBaseUrl, bearerToken);
  }

  listUserSessions(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<ListUserSessionsFetchResult> {
    // Owning the request in-process, this hands the caller's signal straight to
    // `fetch` and aborts for real - the desktop can only settle its caller.
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
    // Parity with the desktop main-process handler (`auth-ipc.ts`): a
    // step-up-required verdict on a retained credential means the server just
    // rejected it, so holding it would re-send a credential known to be dead
    // and re-prompt in a loop.
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
    // In-process shell: the shared HTTP helper runs directly, and the caller's
    // signal aborts the request for real.
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
    // Addresses any registered host by id, not a local one, so the phone can
    // drive it the same as any other shell.
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
    // Registry-only write, same vantage as the version policy above: the
    // phone talks to authn directly (no Electron-main CORS detour) and can
    // remove any registered host by id.
    return deregisterHostViaHttp(this.authnBaseUrl, bearerToken, hostId);
  }

  async getLastKnownLocalHostId(): Promise<string | null> {
    // A phone never runs a host, so there is no pid metadata to read and no
    // "my own host, currently down" case to disambiguate.
    return null;
  }

  async openExternalLink(url: string): Promise<void> {
    // The system default browser, NOT an in-app SFSafariViewController sheet:
    // since iOS 11 the sheet gets an app-isolated cookie jar, so the user's
    // real Google/GitHub sessions never appear in it and every install
    // re-authenticates from scratch. The device-flow sign-in has no redirect
    // leg (the app polls), so leaving the app costs nothing - and the user's
    // own browser brings their sessions, password manager and passkeys.
    await AppLauncher.openUrl({ url });
  }

  async getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]> {
    void schemes;
    return [];
  }

  async requestMicrophoneAccess(): Promise<"granted" | "denied"> {
    return "granted";
  }

  async openMicrophoneSettings(): Promise<void> {
    // Mobile microphone permissions are driven by `getUserMedia`.
  }

  onAuthCallback(handler: () => void): Disposable {
    // The browser-return signal is the app coming back to the FOREGROUND, not
    // a parsed callback URL. The `traycer://auth/callback` deep link the
    // approval page fires exists only to make the OS switch back to this app -
    // it carries no payload (see `IRunnerHost.onAuthCallback`), and once the
    // WebView resumes, its `visibilitychange` edge is the same "the browser
    // returned" fact. Resume, and not the App plugin's `appUrlOpen`, because
    // resume ALSO covers the manual return - the user switching back by hand
    // after the manual-code page, where no deep link is fired at all. (The
    // App plugin does exist in this shell now, for the link-login deep link
    // that carries a real payload; see `link-login-deep-links.ts`. It has
    // nothing to add here, where the URL is payload-free by design.)
    // A resume with no in-flight attempt is a no-op in the consumer
    // (`AuthService.handleReturnSignal` only collapses an active poll wait).
    return this.systemResume.subscribe(handler);
  }

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    handler(null);
    return disposable();
  }

  onSystemResumed(handler: () => void): Disposable {
    return this.systemResume.subscribe(handler);
  }

  async requestHostRespawn(): Promise<HostRestartRequestResult> {
    // Nothing on the phone can restart a host: the machine running it owns its
    // lifecycle. `declined` carries that back as a normal outcome the calling
    // surface renders - the lane never rejects.
    return {
      kind: "declined",
      message: "Restart this host from the machine running it.",
    };
  }
}

// TEMPORARY: the DEPLOYED authn (verified 2026-08-14 against BOTH
// authn.dev.traycer.ai and authn.traycer.ai: `/device/authorize` returns 400
// "client_id must be 'cli' or 'desktop'") predates the "mobile" device client
// kind, so sign in as "desktop" until the authn-v3 mobile client-kind work is
// deployed. Flip back to "mobile" then - the approval-page copy and push-token
// registration are keyed off it. The repo's authn-v3 already accepts "mobile";
// only the deployment lags. NOTE the cloud /device page fires the
// return-to-app deep link for both "desktop" and "mobile", so this override
// does not affect the `return_scheme` behavior below.
const DEVICE_FLOW_CLIENT_ID: DeviceClientId = "desktop";

class MobileDeviceFlowHost implements IDeviceFlowHost {
  constructor(
    private readonly authnBaseUrl: string,
    private readonly hostLabel: string,
    private readonly returnScheme: string | null,
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
    return new MobileDeviceFlowSession(
      this.authnBaseUrl,
      authorization,
      this.returnScheme,
    );
  }
}

class MobileDeviceFlowSession implements DeviceFlowSession {
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
    returnScheme: string | null,
  ) {
    this.authorization = {
      userCode: started.userCode,
      // Desktop parity: the short display URI stays clean for manual entry;
      // only the pre-filled URL the shell opens carries the return scheme.
      verificationUri: started.verificationUri,
      verificationUriComplete:
        returnScheme === null
          ? started.verificationUriComplete
          : withReturnScheme(started.verificationUriComplete, returnScheme),
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
          // Desktop parity: an accepted poll means the pacing is compliant
          // again, so any earlier slow_down widening must not outlive the
          // violation (see `resetPollInterval` - especially costly here, where
          // the foreground-resume nudge may poll one interval early).
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
    // Nothing to dismiss here: the verification page lives in the system
    // browser (see `openExternalLink`), outside this app's control.
  }
}

// Must not be "traycer.token"/"traycer.refresh-token": AuthService owns those
// as the retired legacy per-window slots and wipes them at startup after its
// migration pre-step, which would destroy this store's credentials.
const MOBILE_TOKEN_STORE_KEY = "traycer.credentials";
const MISSING_STORAGE_ITEM = "Item with given key does not exist";

function buildSecureStorage(): ISecureStorage {
  return {
    get: async (key) => {
      const keys = await SecureStoragePlugin.keys();
      if (!keys.value.includes(key)) return null;
      return SecureStoragePlugin.get({ key })
        .then((result) => result.value)
        .catch((error: unknown) => {
          if (isMissingStorageItem(error)) return null;
          throw error;
        });
    },
    set: async (key, value) => {
      await SecureStoragePlugin.set({ key, value });
    },
    delete: async (key) => {
      const keys = await SecureStoragePlugin.keys();
      if (!keys.value.includes(key)) return;
      await SecureStoragePlugin.remove({ key }).catch((error: unknown) => {
        if (!isMissingStorageItem(error)) throw error;
      });
    },
  };
}

function isMissingStorageItem(error: unknown): boolean {
  return error instanceof Error && error.message.includes(MISSING_STORAGE_ITEM);
}

/**
 * Secure-storage-backed `ITokenStore` holding the full `StoredCredentials`
 * JSON under a single key. Mirrors the shared mock's rotate/migration
 * semantics (same guards, real HTTP refresh) - mobile has a single JS runtime
 * and no shared credentials file, so there is no cross-process lock; the
 * sequential guards inside `rotate` are the whole protocol.
 */
class MobileTokenStore implements ITokenStore {
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();
  private revision = 0;

  constructor(
    private readonly secureStorage: ISecureStorage,
    private readonly authnBaseUrl: string,
  ) {}

  async get(): Promise<StoredCredentials | null> {
    return parseStoredCredentials(
      await this.secureStorage.get(MOBILE_TOKEN_STORE_KEY),
    );
  }

  async signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    await this.write({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      savedAt: new Date().toISOString(),
      user: identity,
    });
  }

  async rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    const stored = await this.get();
    if (stored === null) {
      return { outcome: "deleted", pair: null };
    }
    if (stored.user.id !== expected.userId) {
      return { outcome: "user-mismatch", pair: stored };
    }
    if (stored.token !== expected.token) {
      return { outcome: "superseded", pair: stored };
    }
    const refreshed = await refreshOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: stored.token,
      refreshToken: stored.refreshToken,
      clientKind: null,
      signal: null,
    });
    if (refreshed.kind === "network-error") {
      return { outcome: "refresh-network", pair: null };
    }
    if (refreshed.kind === "rejected") {
      return { outcome: "refresh-rejected", pair: null };
    }
    const next: StoredCredentials = {
      ...stored,
      token: refreshed.token,
      refreshToken: refreshed.refreshToken,
      savedAt: new Date().toISOString(),
    };
    await this.write(next);
    return { outcome: "applied", pair: next };
  }

  async delete(): Promise<void> {
    await this.secureStorage.delete(MOBILE_TOKEN_STORE_KEY);
    this.notifyAfterMutation();
  }

  // Single-window store: no cross-process writers exist on mobile, so a
  // read-compare-delete here is already the store's own authority.
  async deleteIfToken(expectedToken: string): Promise<"deleted" | "kept"> {
    const stored = await this.get();
    if (stored === null || stored.token !== expectedToken) {
      return "kept";
    }
    await this.secureStorage.delete(MOBILE_TOKEN_STORE_KEY);
    this.notifyAfterMutation();
    return "deleted";
  }

  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    // Same branches as the shared mock: an existing credential wins, an
    // absent one adopts the spent legacy pair after a real probe + refresh.
    const existing = await this.get();
    if (existing !== null) {
      return "file-wins";
    }
    const probe = await validateAuthTokenIdentityAccessOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: legacy.token,
      signal: null,
    });
    if (probe.kind === "network-error") return "retryable";
    if (probe.kind !== "valid") return "identity-unknown";
    const refreshed = await refreshOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: legacy.token,
      refreshToken: legacy.refreshToken,
      clientKind: null,
      signal: null,
    });
    if (refreshed.kind === "network-error") return "retryable";
    if (refreshed.kind === "rejected") return "terminal-dead";
    await this.write({
      token: refreshed.token,
      refreshToken: refreshed.refreshToken,
      savedAt: new Date().toISOString(),
      user: credentialsIdentityFromAuthenticatedUser(probe.user),
    });
    return "committed";
  }

  private async write(credentials: StoredCredentials): Promise<void> {
    await this.secureStorage.set(
      MOBILE_TOKEN_STORE_KEY,
      JSON.stringify(credentials),
    );
    this.notifyAfterMutation();
  }

  // Self-writes notify on a microtask so the caller's apply path finishes
  // before the change event lands, matching the watcher-after-write ordering
  // the shared AuthService expects (see mock-runner-host.ts).
  private notifyAfterMutation(): void {
    queueMicrotask(() => {
      void this.get().then((stored) => {
        this.revision += 1;
        const change: TokenStoreChange = {
          present: stored !== null,
          userId: stored?.user.id ?? null,
          revision: this.revision,
        };
        for (const listener of this.listeners) {
          listener(change);
        }
      });
    });
  }
}

function parseStoredCredentials(raw: string | null): StoredCredentials | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const user = record.user;
  if (user === null || user === undefined || typeof user !== "object") {
    return null;
  }
  const userRecord = user as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.refreshToken !== "string" ||
    typeof record.savedAt !== "string" ||
    typeof userRecord.id !== "string" ||
    typeof userRecord.email !== "string" ||
    typeof userRecord.name !== "string"
  ) {
    // A pre-cutover `{token, refreshToken}` pair deliberately parses as
    // invalid: it reads as signed out and the user re-auths via device flow.
    return null;
  }
  return {
    token: record.token,
    refreshToken: record.refreshToken,
    savedAt: record.savedAt,
    user: {
      id: userRecord.id,
      email: userRecord.email,
      name: userRecord.name,
    },
  };
}

function buildNotifications(
  push: MobilePushRegistration | null,
): INotificationHost {
  return {
    // `show` stays a no-op ON PURPOSE: OS-level notifications on the phone
    // arrive as remote pushes from the cloud fan-out, not from the renderer's
    // display path - a foregrounded app shows its in-app surfaces instead.
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
      // Not `undeliverable`: on the phone an alert surface DOES exist - the
      // cloud push fan-out owns the OS banner and the foregrounded app owns
      // its in-app surfaces - so the caller's fallback cue would double the
      // push sound.
      return "presented";
    },
    // The click sink is REAL here: tapped pushes re-enter the GUI through the
    // same channel a desktop native-notification click uses, buffered across
    // cold start by the push-registration module.
    onClick: (handler) =>
      push === null ? disposable() : push.onClick(handler),
    onForegroundDisplay: (handler) => {
      // The cross-window relay exists because a desktop shell can have another
      // Traycer window focused. A phone shows one surface at a time, so nothing
      // ever emits here.
      void handler;
      return disposable();
    },
  };
}

function disposable(): Disposable {
  return { dispose: () => undefined };
}

/**
 * BOTH halves of the capability or none of it.
 *
 * A `pushPermission` that could read the OS answer but not open the OS page
 * would render the Settings row with a repair button that resolves
 * successfully and does nothing - the mutation's error toast, the one thing
 * that would report it, can never fire on a resolved promise. The two inputs
 * come from independent platform branches in `main.tsx` (the registration
 * target and the settings opener), so the agreement between them is asserted
 * HERE, once, instead of being assumed twice.
 */
function buildPushPermission(
  push: MobilePushRegistration | null,
  openPushSettings: (() => Promise<void>) | null,
  systemResume: MobileSystemResume,
): IPushPermissionHost | null {
  if (push === null || openPushSettings === null) return null;
  return new MobilePushPermissionHost(push, openPushSettings, systemResume);
}

/**
 * `IRunnerHost.pushPermission` on the phone: a thin adapter over the object
 * that already owns the plugin and the registration guard
 * (`MobilePushRegistration`) plus the shell's own resume edge.
 *
 * `onChange` deliberately carries no state - it says "this MAY have changed,
 * re-read it". Two things can change it without this app doing anything: the
 * person flipping the switch in the OS Settings app (observed as the
 * foreground-resume edge on the way back, the same edge registration follows)
 * and the OS prompt a `request()` just raised. Neither tells us the new value,
 * so the reader's `get()` is what settles it.
 */
class MobilePushPermissionHost implements IPushPermissionHost {
  private readonly handlers = new Set<() => void>();

  constructor(
    private readonly registration: MobilePushRegistration,
    private readonly openPushSettings: () => Promise<void>,
    private readonly systemResume: MobileSystemResume,
  ) {}

  get(): Promise<PushPermissionState> {
    return this.registration.permissionState();
  }

  async request(): Promise<PushPermissionState> {
    const state = await this.registration.requestPermission();
    // The prompt has settled (either way) - tell subscribers to re-read rather
    // than trusting them to correlate this with the value returned above.
    for (const handler of Array.from(this.handlers)) {
      handler();
    }
    return state;
  }

  async openSettings(): Promise<void> {
    // Always a real jump: this object only exists where an opener was
    // injected, so a rejection here means the OS refused, which is exactly
    // what the caller's error toast is for.
    await this.openPushSettings();
  }

  onChange(handler: () => void): Disposable {
    const resumeSubscription = this.systemResume.subscribe(handler);
    this.handlers.add(handler);
    return {
      dispose: () => {
        resumeSubscription.dispose();
        this.handlers.delete(handler);
      },
    };
  }
}

/**
 * The phone's `IRunnerHost.onSystemResumed` source.
 *
 * On this platform "the machine woke up" is not a power event - it is the app
 * coming back to the foreground. The OS suspends the WebView on every app
 * switch, which kills its sockets and freezes its timers, so the shared wake
 * consumers (host-stream re-dial, the auth refresh scheduler) need exactly the
 * signal a desktop gets from `powerMonitor` and a phone gets from
 * `visibilitychange`. Without it every wake consumer falls back to the
 * cross-platform `window 'online'` event, which does NOT fire on an app switch:
 * the network never went anywhere, only this runtime did.
 *
 * `visibilitychange` and not the App plugin's `appStateChange`: WKWebView and
 * the Android WebView both raise it, so the resume edge costs nothing on top
 * of whatever plugins the shell already carries, and it also fires for
 * in-WebView backgrounding the native app-state event does not describe.
 *
 * The shell's plugin set is kept SMALL rather than fixed at a number, and each
 * member earns its place by being the only way to reach an OS capability: core,
 * keyboard, push-notifications, app-launcher, secure-storage, native-settings,
 * device, barcode-scanner, and app. The last one is the newest and the least
 * obvious - `@capacitor/app` is there because a URL the OS opens (a QR scanned
 * by the system camera) has no other route into JS: Capacitor's iOS bridge
 * posts the launch/open URL to that plugin and nothing else listens, so
 * without it the app launches and the code is silently dropped. See
 * `link-login-deep-links.ts`. Its resume/state events are deliberately NOT
 * used - this class stays the resume source.
 *
 * Fires ONLY on the hidden -> visible edge. That edge filter is also the whole
 * dedupe, deliberately with no debounce timer: the event is edge-driven (a
 * repeat needs a real hide in between, which is a real suspend), and every
 * consumer downstream is idempotent and rate-limits itself - the remote
 * session's `wake` can only pull one redial forward per armed backoff, and the
 * auth scheduler coalesces on its own. A timer here would only add latency to
 * the recovery this exists to make fast.
 */
class MobileSystemResume {
  private readonly handlers = new Set<() => void>();
  private hidden = false;
  private listening = false;
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
        // One bad subscriber must not cost the others their wake.
        console.error("[mobile] system-resume handler threw", error);
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
   * Installs the DOM listener on first subscription and keeps it: this object
   * lives as long as the shell, and the visible/hidden state has to stay
   * tracked across a window with no subscribers or the next resume edge is
   * read against a stale baseline. Seeding from the CURRENT state here (rather
   * than at construction) is what keeps a cold start from counting as a
   * resume - a shell that boots hidden has not woken up yet.
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

class MobileNoopTrayState implements ITrayState {
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
 * durable across launches via `localStorage` (the WebView's storage survives
 * app restarts; only an uninstall clears it). Bucketing by identity keeps the
 * "another account inherits nothing" property the desktop store has.
 *
 * A failed READ is genuinely "no preference" (first-run answer); a failed
 * WRITE is reported so the engine can treat the preference as unsaved.
 */
class MobilePreferredHostStore implements PreferredHostStore {
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
  return `traycer.mobile.preferred-host.${identityKey}`;
}
