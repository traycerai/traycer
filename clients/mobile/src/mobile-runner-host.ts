import { App } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { AppLauncher } from "@capacitor/app-launcher";
import { Network, type ConnectionStatus } from "@capacitor/network";
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
  IFileSaveHost,
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
  SystemResumeEvent,
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
  /**
   * Native save route for everything the GUI exports (artifact markdown, the
   * usage image, a Mermaid PNG, a chat image), or `null` where the plugins it
   * needs have no implementation - the dev web entry, tests. Constructed by
   * the entry point for the same web-safety reason as the scanner above, and
   * `null` is not a degradation there: a browser tab still has the File System
   * Access API and `<a download>`, which is exactly what gui-app falls back to.
   */
  readonly fileSave: IFileSaveHost | null;
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
  readonly fileSave: IFileSaveHost | null;
  readonly zoom = null;
  readonly service = null;
  readonly traycerCli = null;
  readonly migration = null;
  readonly hostManagement = null;
  readonly hostTray = null;
  readonly browserView = null;
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
  // One evidence pair per platform - see `resumeEvidenceModeFor` and the
  // MobileSystemResume class doc for why the same Capacitor event names mean
  // different things on iOS, Android, and Web.
  private readonly systemResume = new MobileSystemResume(
    resumeEvidenceModeFor(Capacitor.getPlatform()),
  );
  private readonly networkPath = new MobileNetworkPathWatcher(
    this.systemResume,
  );
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
    | (() => Promise<readonly string[] | null>)
    | null;

  constructor(options: MobileRunnerHostOptions) {
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.authnBaseUrl;
    this.relayBaseUrl = options.relayBaseUrl;
    this.fleetHostIds = options.fleetHostIds;
    this.linkCodeScanner = options.linkCodeScanner;
    this.deviceDescriber = options.deviceDescriber;
    this.linkLoginDeepLinks = options.linkLoginDeepLinks;
    this.fileSave = options.fileSave;
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
    // WebView resumes, the shell's foreground edge (DOM visibility or native
    // app-state, whichever reports first) is the same "the browser returned"
    // fact. Resume, and not the App plugin's `appUrlOpen`, because
    // resume ALSO covers the manual return - the user switching back by hand
    // after the manual-code page, where no deep link is fired at all. (The
    // App plugin's `appUrlOpen` still has nothing to add here, where the URL
    // is payload-free by design; see `link-login-deep-links.ts` for the deep
    // link that does carry one.)
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

  onSystemResumed(handler: (event: SystemResumeEvent) => void): Disposable {
    return this.systemResume.subscribe(handler);
  }

  onNetworkPathChanged(handler: () => void): Disposable {
    return this.networkPath.subscribe(handler);
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

// The client kind this app signs in as. It labels the minted session on the
// sessions page, keys the approval-page copy, and gates push-token
// registration. The cloud /device page fires the return-to-app deep link for
// either kind, so `return_scheme` behaves the same both ways.
//
// Production builds sign in as "desktop": the production authn deployment
// rejects the "mobile" device client kind, and a build that sends it cannot
// sign in at all. Every other environment sends the honest kind - dev and
// staging authn accept it, which is what lets staging exercise the real
// labeling. When the production authn accepts "mobile", this collapses back
// to the unconditional kind.
const DEVICE_FLOW_CLIENT_ID: DeviceClientId =
  __TRAYCER_MOBILE_CONFIG__.environment === "production" ? "desktop" : "mobile";

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
    // Phones expose permission state and the OS repair link together through
    // `pushPermission`; duplicating that link here would split one capability.
    systemSettings: null,
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
 * signal a desktop gets from `powerMonitor`. Without it every wake consumer
 * falls back to the cross-platform `window 'online'` event, which does NOT
 * fire on an app switch: the network never went anywhere, only this runtime
 * did.
 *
 * EXACTLY ONE paired evidence source is selected per platform, because
 * Capacitor's identically-named events mean different things on each - and
 * because no callback-only algorithm can distinguish a source's late-replayed
 * event from the genuine first event of the next episode, fusing two sources
 * over one episode is unsound by construction (a delayed callback from the
 * source that missed the completed episode is indistinguishable from a new
 * episode's opener). One source, one level-triggered pair, no fusion:
 *
 *  - iOS (`ios-lifecycle`): App `pause`/`resume`, which map to UIKit
 *    did-enter-background / will-enter-foreground - the OS's own statement
 *    that the app really left and returned. `pause` stamps `Date.now()`, so
 *    the paired resume reports a NUMERIC dwell. DOM visibility is not a
 *    participant. (`appStateChange(false)` is not used here: on iOS it is
 *    will-resign-active, which also fires under Control Center, Face ID, and
 *    permission overlays where the app never backgrounds.)
 *  - Android (`android-app-state`): App `appStateChange` - `false` fires at
 *    `onStop` (no longer visible), `true` at resume. Android's `pause` is
 *    Activity `onPause`, which the lifecycle contract allows while the app
 *    is still fully visible (multi-window, a dialog), so counting paused
 *    dwell would force-drop a healthy mux under a permission dialog. The
 *    dwell reported is specifically invisibility time (onStop -> onResume),
 *    deliberately shorter than total inactivity.
 *  - Web/dev (`dom`): DOM `hidden` opens, DOM `visible` closes, dwell is
 *    `null` - a hidden document proves invisibility, not real backgrounding,
 *    so no number is fabricated. The Web App plugin's `pause`/`resume` are
 *    emitted FROM this same DOM event and are not registered - a duplicate
 *    source with a native label.
 *
 * If installing the selected native pair FAILS (no plugin bridge), the
 * tracker disposes whatever half registered and switches exclusively to the
 * DOM pair - degraded to unknown dwell, never to two owners of one episode.
 *
 * Level-triggered semantics on the selected pair: a duplicate background or
 * foreground report is ignored, a cold-start foreground is ignored, and one
 * background followed by its paired foreground emits exactly one resume.
 * `isBackgrounded()` (the network watcher's suppression gate) reflects only
 * the selected source.
 *
 * The resume event carries the measured dwell
 * (`SystemResumeEvent.backgroundedForMs`) - what lets the wake policy
 * distinguish a quick app switch (the socket may have survived - probe it
 * fast) from a long one (the OS has torn the socket down - redial without
 * asking). `null` keeps the conservative default downstream.
 *
 * The shell's plugin set is kept SMALL rather than fixed at a number, and each
 * member earns its place by being the only way to reach an OS capability:
 * core, keyboard, push-notifications, app-launcher, secure-storage,
 * native-settings, device, barcode-scanner, network, app, and the
 * filesystem/share pair a WKWebView save has no browser route to (see
 * `file-save.ts`). `@capacitor/app`
 * first earned its place because a URL the OS opens (a QR scanned by the
 * system camera) has no other route into JS (see `link-login-deep-links.ts`);
 * its lifecycle events are the second capability it is the only route to.
 */

/** Which paired evidence source owns background/foreground on this platform. */
type ResumeEvidenceMode = "ios-lifecycle" | "android-app-state" | "dom";

/** The selected evidence pair for `Capacitor.getPlatform()`'s answer. */
function resumeEvidenceModeFor(platform: string): ResumeEvidenceMode {
  if (platform === "ios") {
    return "ios-lifecycle";
  }
  if (platform === "android") {
    return "android-app-state";
  }
  return "dom";
}

class MobileSystemResume {
  private readonly handlers = new Set<(event: SystemResumeEvent) => void>();
  private listening = false;
  private background = false;
  /** Stamped only by the numeric modes; `null` dwell everywhere else. */
  private enteredAt: number | null = null;
  /**
   * Ownership token for the native pair. Every native callback checks it
   * before acting, and the FIRST registration failure bumps it SYNCHRONOUSLY -
   * so a successfully-registered half whose handle removal is still in
   * flight, or whose events were already queued, is retired the instant the
   * pair is known broken, before the DOM fallback can take over. Without
   * this there is a real interval with two owners: a late partial `pause`
   * could stamp numeric state under DOM ownership, sticking the network gate
   * or making the null-dwell fallback report a number.
   */
  private nativeOwnerToken = 0;

  constructor(private readonly mode: ResumeEvidenceMode) {}

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.noteBackground(false);
    } else {
      this.noteForeground();
    }
  };

  /** Whether the selected source currently reports the app backgrounded. */
  isBackgrounded(): boolean {
    return this.background;
  }

  subscribe(handler: (event: SystemResumeEvent) => void): Disposable {
    this.ensureTracking();
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  private noteBackground(stampDwell: boolean): void {
    if (this.background) {
      // Level-triggered: a duplicate background report says nothing new.
      return;
    }
    this.background = true;
    this.enteredAt = stampDwell ? Date.now() : null;
  }

  /**
   * Invoked synchronously on every background -> foreground transition,
   * BEFORE any resume handler runs. The network watcher registers here: its
   * quarantine generation must be open before the resume wake is issued, or
   * a queued network callback delivered between the wake and the watcher's
   * own (unordered) resume handler could fire a second forced drop against
   * the mux that wake just recovered.
   */
  private epochBoundaryListener: (() => void) | null = null;

  setEpochBoundaryListener(listener: () => void): void {
    this.epochBoundaryListener = listener;
  }

  private noteForeground(): void {
    if (!this.background) {
      // A duplicate foreground, or a cold start's first active report.
      return;
    }
    this.background = false;
    if (this.epochBoundaryListener !== null) {
      this.epochBoundaryListener();
    }
    const enteredAt = this.enteredAt;
    this.enteredAt = null;
    const event: SystemResumeEvent = {
      backgroundedForMs:
        enteredAt === null ? null : Math.max(0, Date.now() - enteredAt),
    };
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(event);
      } catch (error) {
        // One bad subscriber must not cost the others their wake.
        console.error("[mobile] system-resume handler threw", error);
      }
    }
  }

  /**
   * Installs the selected pair on first subscription and keeps it: this
   * object lives as long as the shell, and the level state has to stay
   * tracked across a window with no subscribers or the next edge is read
   * against a stale baseline.
   *
   * Public (not folded into `subscribe`) because the network watcher reads
   * `isBackgrounded()` without ever subscribing to resumes, and that read is
   * only meaningful while the state is actually being tracked - it must be
   * able to start the tracking itself rather than depend on some unrelated
   * consumer having subscribed first.
   */
  ensureTracking(): void {
    if (this.listening || typeof document === "undefined") {
      return;
    }
    this.listening = true;
    if (this.mode === "dom") {
      this.installDomPair();
      return;
    }
    this.installNativePair(this.mode);
  }

  /**
   * The DOM pair - the `dom` mode's whole tracker, and the exclusive
   * fallback when native registration fails. Seeding from the CURRENT state
   * (rather than at construction) is what keeps a cold start from counting
   * as a resume - and a boot-hidden seed carries no entry stamp, so a resume
   * measured against it honestly reports `null` rather than counting time
   * before the listener existed.
   */
  private installDomPair(): void {
    if (document.visibilityState === "hidden") {
      this.noteBackground(false);
    }
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /**
   * The selected native pair, with an exclusive-fallback contract: if either
   * registration rejects (no plugin bridge - the dev web entry, tests), the
   * half that DID register is disposed before the DOM pair takes over, so
   * two sources can never own one episode.
   */
  private installNativePair(mode: "ios-lifecycle" | "android-app-state"): void {
    const token = ++this.nativeOwnerToken;
    const owned = (callback: () => void) => (): void => {
      if (token !== this.nativeOwnerToken) {
        // A retired owner's callback - a queued event from a half-registered
        // pair, delivered after fallback. Inert by contract.
        return;
      }
      callback();
    };
    const registrations =
      mode === "ios-lifecycle"
        ? [
            App.addListener(
              "pause",
              owned(() => {
                this.noteBackground(true);
              }),
            ),
            App.addListener(
              "resume",
              owned(() => {
                this.noteForeground();
              }),
            ),
          ]
        : [
            App.addListener("appStateChange", (state) => {
              if (token !== this.nativeOwnerToken) {
                return;
              }
              if (state.isActive) {
                this.noteForeground();
              } else {
                this.noteBackground(true);
              }
            }),
          ];
    void (async () => {
      try {
        await Promise.all(registrations);
        return;
      } catch (error) {
        console.warn(
          "[mobile] native lifecycle listeners unavailable - falling back to DOM visibility",
          error,
        );
      }
      // Ownership changes FIRST, synchronously with learning of the failure:
      // every native callback above is inert from this line on, however long
      // the handle removals below take and whatever the bridge already
      // queued.
      this.nativeOwnerToken += 1;
      // Reset anything a partial native callback wrote before retirement -
      // the DOM pair must seed from a clean slate, and a native-stamped
      // number must never ride out through the null-dwell fallback.
      this.background = false;
      this.enteredAt = null;
      const settled = await Promise.allSettled(registrations);
      await Promise.allSettled(
        settled
          .filter(
            (
              outcome,
            ): outcome is PromiseFulfilledResult<PluginListenerHandle> =>
              outcome.status === "fulfilled",
          )
          .map((outcome) => outcome.value.remove()),
      );
      this.installDomPair();
    })();
  }
}

/**
 * The phone's `IRunnerHost.onNetworkPathChanged` source: Capacitor
 * `networkStatusChange`, filtered down to the two transitions under which an
 * existing socket is dead (or about to behave like it) with no DOM `online`
 * event and no resume edge to notice:
 *
 *  - connectivity REGAINED (`connected` false -> true);
 *  - the interface TYPE changing while staying connected (Wi-Fi -> cellular).
 *    The OS migrates the route out from under the socket and the enum never
 *    passes through "offline", so every other trigger stays silent while
 *    sends quietly die.
 *
 * Suppressed while the app is backgrounded: a backgrounded phone hopping
 * networks must not reopen a relay splice nobody is looking at, and the
 * resume edge owns recovery on the way back (its duration gate already
 * forces a redial after any background long enough for a network hop to be
 * likely). The tracked status still updates while backgrounded, so a change
 * that happened mid-background is not replayed as a stale edge on the next
 * foreground change.
 *
 * Bootstrap is READ-LISTEN-READ with a single reconciliation, because the
 * native side monitors and emits independently of this JS registration:
 * a transition can land after snapshot A but before the listener is live
 * (invisible to both A and the callback stream), and a callback can describe
 * the same post-transition state a later snapshot also reports. So: snapshot
 * A, register the listener (buffering callbacks), snapshot B, then walk the
 * observed chain A -> buffered... -> B ONCE - if any step is a
 * regained/type-change transition, at most ONE recovery signal is emitted
 * (a transient flap observed inside the buffer still counts: the socket it
 * killed stays dead however briefly the path flapped), the newest
 * observation becomes the live baseline, and only then do callbacks flow
 * straight through. A chain with no qualifying step - including callbacks
 * that merely re-announce B - emits nothing. Failed reads degrade to
 * whatever the chain did observe, without an unhandled rejection.
 */
class MobileNetworkPathWatcher {
  private readonly handlers = new Set<() => void>();
  private lastStatus: ConnectionStatus | null = null;
  /**
   * Observations buffered during bootstrap, each tagged with the lifecycle
   * tracker's state AT ARRIVAL - a transition observed while backgrounded
   * belongs to that background episode, and the resume edge (not this
   * watcher) owns that episode's recovery. `null` once bootstrap has
   * reconciled and callbacks flow straight through.
   */
  private preSeedObservations: Array<{
    readonly status: ConnectionStatus;
    readonly backgrounded: boolean;
  }> | null = [];
  /**
   * Bumped on EVERY callback arrival, buffered or live. A snapshot may be
   * adopted as a baseline only if it resolved with no intervening callback
   * (its captured value could otherwise be OLDER than an already-delivered
   * observation - the native read races the event stream).
   */
  private callbackRevision = 0;
  /** Whether a resume completed while bootstrap was still reconciling. */
  private bootstrapSawResume = false;
  /**
   * True from a resume event until the post-resume rebaseline read settles.
   * Callbacks arriving inside this window are retired into the baseline
   * silently: they describe (or race with) the background episode the resume
   * just recovered from, and the resume wake is that episode's single
   * recovery owner.
   */
  private rebaselineActive = false;
  /**
   * THE single commit owner for live confirmations. Bumped on every live
   * callback arrival and on every resume boundary; a confirmation may only
   * commit (write the baseline, fire the wake) if the sequence it captured
   * at arrival is still current when its read settles. This is what makes
   * overlapping confirmations converge on exactly one commit - without it,
   * two raced callbacks could each compare the same stale baseline against
   * the current truth and force twice, and an OLDER confirmation exhausting
   * its quiet reads could overwrite a newer observation.
   */
  private liveCommitSeq = 0;
  /**
   * Whether `lastStatus` was established by a CONFIRMED read (a quiet
   * snapshot or a confirmed commit) rather than a raw callback adopted when
   * confirmation was unavailable. An untrusted baseline may be superseded
   * but never serve as the predecessor of a forced wake: the next confirmed
   * status SEEDS from it silently. Without this, a failed confirmation would
   * promote its own unconfirmed observation into a trusted predecessor and
   * the following confirmed status could ride a false edge.
   */
  private baselineTrusted = true;
  /**
   * Which resume owns the current rebaseline read. A second resume during
   * the read supersedes the first: only the newest generation may adopt the
   * post-resume baseline and close the quarantine window.
   */
  private resumeGeneration = 0;
  private listening = false;

  constructor(private readonly systemResume: MobileSystemResume) {}

  subscribe(handler: () => void): Disposable {
    this.ensureListening();
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  /** The two transitions under which an existing socket is dead - see doc. */
  private static isRecoveryTransition(
    previous: ConnectionStatus,
    status: ConnectionStatus,
  ): boolean {
    const regained = !previous.connected && status.connected;
    const pathMoved =
      previous.connected &&
      status.connected &&
      previous.connectionType !== status.connectionType;
    return regained || pathMoved;
  }

  private emitPathChanged(): void {
    for (const handler of Array.from(this.handlers)) {
      try {
        handler();
      } catch (error) {
        // One bad subscriber must not cost the others the signal.
        console.error("[mobile] network-path handler threw", error);
      }
    }
  }

  /**
   * Applies one live observation with CONFIRMATION: the observed status is
   * validated against a revision-guarded current read before it may change
   * the baseline or force a redial. JS delivery order is not occurrence
   * order - a native event queued during a background episode can be
   * delivered long after resume, and a stale `offline` followed by a late
   * `online` must collapse against the confirmed current status instead of
   * manufacturing a recovery edge. Confirmation is UNIVERSAL rather than
   * scoped to a could-still-be-stale window because no callback-side
   * property bounds that window; the cost is one native round trip per
   * (rare) network event. The accepted trade: a genuine flap shorter than
   * that round trip also collapses - the resume/probe machinery, not this
   * edge, owns sub-roundtrip blips.
   *
   * A read that never goes quiet means newer callbacks are already in
   * flight and each will run its own confirmation - this one folds the raw
   * observation into the baseline WITHOUT forcing (conservative: an
   * unconfirmable edge must not tear down a possibly-healthy mux).
   */
  private async confirmAndApply(
    observed: ConnectionStatus,
    commitSeq: number,
  ): Promise<void> {
    const confirmed = await this.settleQuietRead();
    if (commitSeq !== this.liveCommitSeq) {
      // A newer callback - or a resume boundary - owns the commit now. This
      // confirmation writes NOTHING: committing here would either double the
      // wake (both raced confirmations comparing the same stale baseline) or
      // let an older observation overwrite a newer one after its quiet reads
      // ran out.
      return;
    }
    if (confirmed === null) {
      // No quiet read - but the ownership check above just proved this IS
      // the newest observation, so it may move the baseline. It moves it as
      // UNTRUSTED: an unconfirmed raw callback must never become the
      // predecessor a later confirmed status fires against.
      this.lastStatus = observed;
      this.baselineTrusted = false;
      return;
    }
    // `previous` is read AT COMMIT, not at arrival: an arrival-time capture
    // is exactly what let two overlapping confirmations both see the old
    // baseline.
    const previous = this.lastStatus;
    const previousTrusted = this.baselineTrusted;
    this.lastStatus = confirmed;
    this.baselineTrusted = true;
    if (previous === null || !previousTrusted) {
      // Seeding (or re-seeding after an untrusted interval): adopt silently.
      return;
    }
    if (!MobileNetworkPathWatcher.isRecoveryTransition(previous, confirmed)) {
      return;
    }
    if (this.systemResume.isBackgrounded()) {
      return;
    }
    this.emitPathChanged();
  }

  private ensureListening(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    // The resume edge is this watcher's epoch boundary, wired through the
    // tracker's SYNCHRONOUS pre-handler seam rather than an ordinary resume
    // subscription: the quarantine below must already be open when the
    // resume wake is issued, and subscriber iteration order guarantees
    // nothing.
    this.systemResume.setEpochBoundaryListener(() => {
      this.onResumed();
    });
    this.systemResume.ensureTracking();
    // Failure-isolated read-listen-read bootstrap; see the class doc. The
    // rejection handler attaches to snapshot A IMMEDIATELY - a listener
    // registration failure must not leave A as an unhandled rejection.
    const snapshotARead: Promise<ConnectionStatus | null> =
      Network.getStatus().catch((error: unknown): null => {
        console.warn("[mobile] network snapshot A unavailable", error);
        return null;
      });
    const listenerReady = Network.addListener(
      "networkStatusChange",
      (status) => {
        this.callbackRevision += 1;
        if (this.preSeedObservations !== null) {
          // Bootstrap has not reconciled - hold the observation, tagged with
          // the lifecycle state it arrived under, instead of letting it
          // BECOME the baseline.
          this.preSeedObservations.push({
            status,
            backgrounded: this.systemResume.isBackgrounded(),
          });
          return;
        }
        if (this.rebaselineActive) {
          // Inside the post-resume quarantine: retire into the baseline. The
          // resume wake owns this episode's recovery.
          this.lastStatus = status;
          return;
        }
        this.liveCommitSeq += 1;
        void this.confirmAndApply(status, this.liveCommitSeq);
      },
    );
    void (async () => {
      let listenerInstalled = false;
      try {
        await listenerReady;
        listenerInstalled = true;
      } catch (error) {
        console.warn(
          "[mobile] networkStatusChange listener unavailable",
          error,
        );
      }
      const snapshotA = await snapshotARead;
      // Snapshot B exists to close the A-to-registration gap, so it is
      // attempted whenever the listener actually installed - INDEPENDENT of
      // whether A failed. A quiet read (no callback landing during its round
      // trip) is required before its value may serve as an ordering anchor.
      const snapshotB = listenerInstalled ? await this.settleQuietRead() : null;
      this.reconcileBootstrap(snapshotA, snapshotB);
    })();
  }

  /**
   * Bounds the quiet-read retry loop: after this many reads that each raced
   * a callback, the newest CALLBACK is simply the freshest observation there
   * is, and it becomes the baseline instead.
   */
  private static readonly QUIET_READ_ATTEMPTS = 3;

  /**
   * Reads the current status until one read completes with NO callback
   * arriving during its native round trip, or the attempt bound is hit
   * (`null` - the caller falls back to the newest buffered/live callback).
   * The revision check is what makes adoption LINEARIZABLE: a snapshot's
   * value is captured native-side at call time, so a callback delivered
   * before the promise resolves can be NEWER than the snapshot - adopting
   * such a read as the baseline would resurrect a state the event stream
   * already superseded.
   */
  private async settleQuietRead(): Promise<ConnectionStatus | null> {
    for (
      let attempt = 0;
      attempt < MobileNetworkPathWatcher.QUIET_READ_ATTEMPTS;
      attempt += 1
    ) {
      const revisionAtCall = this.callbackRevision;
      let value: ConnectionStatus;
      try {
        value = await Network.getStatus();
      } catch (error) {
        console.warn("[mobile] network snapshot unavailable", error);
        return null;
      }
      if (this.callbackRevision === revisionAtCall) {
        return value;
      }
    }
    return null;
  }

  /**
   * The single bootstrap walk: chain the observations in order (snapshot A,
   * every buffered callback, quiet snapshot B), emit at most ONE recovery
   * signal, and adopt the newest observation as the live baseline. A flap
   * that returned to the starting state still signals - the socket it killed
   * stays dead - and a callback that merely re-announces a snapshot
   * contributes no step.
   *
   * A step is signal-worthy only if BOTH its endpoints were observed in the
   * foreground and no resume completed during bootstrap: an observation made
   * (or raced) under a background episode belongs to that episode, and the
   * resume edge is that episode's single recovery owner - reconciliation
   * re-baselines from it, never re-announces it.
   */
  private reconcileBootstrap(
    snapshotA: ConnectionStatus | null,
    snapshotB: ConnectionStatus | null,
  ): void {
    const buffered = this.preSeedObservations ?? [];
    this.preSeedObservations = null;
    const chain: Array<{
      readonly status: ConnectionStatus;
      readonly backgrounded: boolean;
    }> = [];
    if (snapshotA !== null) {
      chain.push({
        status: snapshotA,
        backgrounded: this.systemResume.isBackgrounded(),
      });
    }
    chain.push(...buffered);
    if (snapshotB !== null) {
      chain.push({
        status: snapshotB,
        backgrounded: this.systemResume.isBackgrounded(),
      });
    }
    if (chain.length === 0) {
      // Nothing observed at all (reads failed, no callbacks): the first live
      // callback will seed the baseline, exactly as an unbuffered listener
      // would have. A resume seen during bootstrap still needs its
      // rebaseline started - nothing else will.
      if (this.bootstrapSawResume) {
        this.baselineTrusted = false;
        this.beginRebaseline();
      }
      return;
    }
    let sawForegroundRecovery = false;
    for (let i = 1; i < chain.length; i += 1) {
      if (
        !chain[i - 1].backgrounded &&
        !chain[i].backgrounded &&
        MobileNetworkPathWatcher.isRecoveryTransition(
          chain[i - 1].status,
          chain[i].status,
        )
      ) {
        sawForegroundRecovery = true;
        break;
      }
    }
    this.lastStatus = chain[chain.length - 1].status;
    if (this.bootstrapSawResume) {
      // A resume completed while bootstrap was reconciling: every bootstrap
      // observation is CROSS-EPOCH - snapshot B may have been captured on
      // the far side of the suspend and resolved after it, so trusting it
      // would let a late background-era callback confirm the new path
      // against a stale trusted baseline and duplicate the resume-owned
      // recovery. The newest observation still places the baseline, but
      // only as untrusted, and the post-resume rebaseline (deferred until
      // this walk placed its baseline) establishes the trusted one.
      this.baselineTrusted = false;
      this.beginRebaseline();
      return;
    }
    // Trust follows provenance: a SNAPSHOT tail (quiet B, or A with nothing
    // after it) is a confirmed read; a buffered-callback tail is raw, so the
    // first live confirmation re-seeds from it silently.
    this.baselineTrusted = snapshotB !== null || buffered.length === 0;
    if (!sawForegroundRecovery || this.systemResume.isBackgrounded()) {
      return;
    }
    this.emitPathChanged();
  }

  /**
   * The resume edge's hand-off: the completed background episode's recovery
   * belongs to the resume wake, so the network baseline is re-read (quietly,
   * same linearizable rule as bootstrap) and every observation delivered in
   * the window - including the episode's own queued callbacks arriving after
   * the foreground flip - is retired into the baseline rather than
   * re-announced as a second forced wake against the freshly recovered mux.
   */
  private onResumed(): void {
    // Every resume is a commit boundary: confirmations already in flight
    // belong to the epoch the app just left and must not commit against the
    // post-resume world.
    this.liveCommitSeq += 1;
    this.resumeGeneration += 1;
    if (this.preSeedObservations !== null) {
      // Bootstrap is still reconciling: record the epoch handoff. The
      // reconcile walk consumes this by refusing to trust ANY bootstrap
      // snapshot (they may straddle the suspend) and by starting the
      // post-resume rebaseline itself once its baseline is placed.
      this.bootstrapSawResume = true;
      return;
    }
    this.beginRebaseline();
  }

  /**
   * Starts the generation-owned post-resume rebaseline read. The newest
   * resume generation owns both the adopted baseline and the closing of the
   * quarantine window; a superseded read does neither.
   */
  private beginRebaseline(): void {
    this.rebaselineActive = true;
    const generation = this.resumeGeneration;
    void this.settleQuietRead().then((status) => {
      if (generation !== this.resumeGeneration) {
        // A newer resume superseded this read; that resume's own rebaseline
        // owns the baseline and the window.
        return;
      }
      if (status !== null) {
        this.lastStatus = status;
        this.baselineTrusted = true;
      } else {
        // The read never went quiet (or failed). Whatever the baseline holds
        // - the newest quarantine fold, or, with no folds at all, the
        // PRE-background status - it does not describe a confirmed
        // post-resume network. Mark it untrusted: the next confirmed
        // observation seeds silently instead of firing a second forced wake
        // against a baseline from the wrong side of the suspend.
        this.baselineTrusted = false;
      }
      this.rebaselineActive = false;
    });
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
