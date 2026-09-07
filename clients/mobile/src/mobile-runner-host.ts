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
  ISystemBackHost,
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
  /** OS push lifecycle owner, or `null` where pushes cannot exist (the dev web entry, tests). */
  readonly pushRegistration: MobilePushRegistration | null;
  /**
   * Jumps to this app's notification page in the OS Settings app - the only repair path once the OS has remembered a refusal.
   */
  readonly openPushSettings: (() => Promise<void>) | null;
  /**
   * `null` where no scheme is registered (the dev web entry, tests) - firing `traycer://` from a plain browser tab would launch an installed production app instead.
   */
  readonly returnScheme: string | null;
  /**
   * Overrides where the selection authority's fleet membership comes from, or `null` for the production answer (the registry list under the stored bearer).
   * Resolves to the fleet's host ids, or `null` on a transient failure (the current fleet is retained - a blip must not read as "you own no hosts").
   */
  readonly fleetHostIds: (() => Promise<readonly string[] | null>) | null;
  /**
   * Native QR scanner for link-login sign-in, or `null` where no camera exists (the dev web entry, tests).
   */
  readonly linkCodeScanner: ILinkCodeScanner | null;
  /** Native device self-description for the approver's prompt, or `null` on the web entry. */
  readonly deviceDescriber: IDeviceDescriber | null;
  /**
   * OS-delivered link-login codes (a QR scanned by the system camera), or `null` on the web entry, which no OS opens URLs into.
   * Constructed and started by the entry point: the capture has to be listening before this host is even built, since a cold launch delivers the URL once.
   */
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null;
  /**
   * Native save route for everything the gui exports (artifact markdown, the usage image, a Mermaid png, a chat image), or `null` where the plugins it needs have no implementation - the dev web entry, tests.
   */
  readonly fileSave: IFileSaveHost | null;
  /**
   * Whether this install's WebView actually puts an image on the system clipboard - see `IRunnerHost.canCopyImages`.
   * Decided by the entry point rather than here, for the same reason as the members above: which platform this shell runs on is the entry's business, and nothing downstream of it may branch on the answer.
   */
  readonly canCopyImages: boolean;
  /** The OS back request, or `null` where the OS raises none - see `IRunnerHost.systemBack`. */
  readonly systemBack: ISystemBackHost | null;
}

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

interface RetainedStepUpCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * The phone shell's `IRunnerHost`.
 * Nothing here reimplements a request: every member below delegates to the helper the desktop's main process also uses, so the two boundaries cannot drift.
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
  readonly canCopyImages: boolean;
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
  /** The phone's own notification switch. */
  readonly pushPermission: IPushPermissionHost | null;
  readonly systemBack: ISystemBackHost | null;
  private retainedStepUpCredential: RetainedStepUpCredential | null = null;
  // One evidence pair per platform - see `resumeEvidenceModeFor` and the MobileSystemResume class doc for why the same Capacitor event names mean different things on iOS, Android, and Web.
  private readonly systemResume = new MobileSystemResume(
    resumeEvidenceModeFor(Capacitor.getPlatform()),
  );
  private readonly networkPath = new MobileNetworkPathWatcher(
    this.systemResume,
  );
  /**
   * The in-window selection authority (the "shell with no main process" binding the contract names): the same engine desktop mounts in Electron main, behind the in-process adapter, fed by the three ports below.
   * The phone has no local host and cannot provision one, so the ensure port refuses and the outage signal is inert - derivation only ever lands on a remote host or on ∅.
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
    this.canCopyImages = options.canCopyImages;
    this.systemBack = options.systemBack;
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
      // Refusing (rather than deferring) is what makes the engine's ∅ definition come out right on a shell that can never provision: no usable lease and no ensure available.
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      preferredStore: this.selectionPreferredStore,
      clock: systemAuthorityClock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });
    this.selectionAuthority = this.selectionAuthorityMount.client;
    // The identity port follows the token store: the stored credential IS the phone's signed-in identity (there is no separate auth-session process).
    // The generation advances only when the user changes - `syncSelectionId` compares ids before setting - so a routine token rotation never wipes the authority's evidence.
    this.tokenStore.subscribe((change) => {
      this.syncSelectionIdentity(change.userId);
    });
    // Seed both ports from whatever credential survived the last launch; the fleet publish rides behind the identity so its generation stamp is the seeded one, not the initial null's.
    void this.tokenStore.get().then((stored) => {
      this.syncSelectionIdentity(stored?.user.id ?? null);
      if (stored === null) {
        void this.refreshHostFleet();
      }
    });
  }

  /**
   * Advances the identity port when the signed-in user actually changed, and re-reads the fleet under the new identity - the same "identity change refreshes the fleet" edge the engine's own doc names.
   */
  private syncSelectionIdentity(userId: string | null): void {
    if (this.selectionIdentity.current().identityKey === userId) {
      return;
    }
    this.selectionIdentity.set(userId);
    void this.refreshHostFleet();
  }

  /**
   * `IRunnerHost.refreshHostFleet`: re-reads fleet membership and publishes it atomically.
   * Callers are the membership mutations (a deregistration, a fresh registration observed by the directory's poll) plus the identity edge above; a duplicate call costs one refetch and can never publish something false.
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
   * `null`: this shell owns no registry cadence - the directory keeps its own poll timer, exactly as the browser/dev topology does.
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
    // Access-only (tech plan §3): a stale token comes back `rejected` and the caller routes the refresh spend through the locked `tokenStore.rotate`, so validation can never consume a refresh token.
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
    // Registry-only write, same vantage as the version policy above: the phone talks to authn directly (no Electron-main cors detour) and can remove any registered host by id.
    return deregisterHostViaHttp(this.authnBaseUrl, bearerToken, hostId);
  }

  async getLastKnownLocalHostId(): Promise<string | null> {
    // A phone never runs a host, so there is no pid metadata to read and no
    // "my own host, currently down" case to disambiguate.
    return null;
  }

  async openExternalLink(url: string): Promise<void> {
    // The device-flow sign-in has no redirect leg (the app polls), so leaving the app costs nothing - and the user's own browser brings their sessions, password manager and passkeys.
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

  async openFullDiskAccessSettings(): Promise<void> {
    // No Full Disk Access pane, and no login import, on mobile.
  }

  onAuthCallback(handler: () => void): Disposable {
    // The browser-return signal is the app coming back to the foreground, not a parsed callback URL.
    // Resume, and not the App plugin's `appUrlOpen`, because resume also covers the manual return - the user switching back by hand after the manual-code page, where no deep link is fired at all.
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
    // Nothing on the phone can restart a host: the machine running it owns its lifecycle.
    // `declined` carries that back as a normal outcome the calling surface renders - the lane never rejects.
    return {
      kind: "declined",
      message: "Restart this host from the machine running it.",
    };
  }
}

// The client kind this app signs in as.
const DEVICE_FLOW_CLIENT_ID: DeviceClientId = "mobile";

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

// Must not be "traycer.token"/"traycer.refresh-token": AuthService owns those as the retired legacy per-window slots and wipes them at startup after its migration pre-step, which would destroy this store's credentials.
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

  // Self-writes notify on a microtask so the caller's apply path finishes before the change event lands, matching the watcher-after-write ordering the shared AuthService expects (see mock-runner-host.ts).
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
    // `show` stays a no-op ON purpose: OS-level notifications on the phone arrive as remote pushes from the cloud fan-out, not from the renderer's display path - a foregrounded app shows its in-app surfaces instead.
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
      // Not `undeliverable`: on the phone an alert surface does exist - the cloud push fan-out owns the OS banner and the foregrounded app owns its in-app surfaces - so the caller's fallback cue would double the push sound.
      return "presented";
    },
    // The click sink is real here: tapped pushes re-enter the gui through the same channel a desktop native-notification click uses, buffered across cold start by the push-registration module.
    onClick: (handler) =>
      push === null ? disposable() : push.onClick(handler),
    onForegroundDisplay: (handler) => {
      // The cross-window relay exists because a desktop shell can have another Traycer window focused.
      void handler;
      return disposable();
    },
  };
}

function disposable(): Disposable {
  return { dispose: () => undefined };
}

/**
 * Both halves of the capability or none of it.
 * The two inputs come from independent platform branches in `main.tsx` (the registration target and the settings opener), so the agreement between them is asserted here, once, instead of being assumed twice.
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
 * `IRunnerHost.pushPermission` on the phone: a thin adapter over the object that already owns the plugin and the registration guard (`MobilePushRegistration`) plus the shell's own resume edge.
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
    // Always a real jump: this object only exists where an opener was injected, so a rejection here means the OS refused, which is exactly what the caller's error toast is for.
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
 * On this platform "the machine woke up" is not a power event - it is the app coming back to the foreground.
 */

type ResumeEvidenceMode = "ios-lifecycle" | "android-app-state" | "dom";

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
   * Ownership token for the native pair.
   * Without this there is a real interval with two owners: a late partial `pause` could stamp numeric state under DOM ownership, sticking the network gate or making the null-dwell fallback report a number.
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

  /** Invoked synchronously on every background -> foreground transition, before any resume handler runs. */
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
   * The DOM pair - the `dom` mode's whole tracker, and the exclusive fallback when native registration fails.
   */
  private installDomPair(): void {
    if (document.visibilityState === "hidden") {
      this.noteBackground(false);
    }
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

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
      // Ownership changes first, synchronously with learning of the failure: every native callback above is inert from this line on, however long the handle removals below take and whatever the bridge already queued.
      this.nativeOwnerToken += 1;
      // Reset anything a partial native callback wrote before retirement - the DOM pair must seed from a clean slate, and a native-stamped number must never ride out through the null-dwell fallback.
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
 * The OS migrates the route out from under the socket and the enum never passes through "offline", so every other trigger stays silent while sends quietly die.
 */
class MobileNetworkPathWatcher {
  private readonly handlers = new Set<() => void>();
  private lastStatus: ConnectionStatus | null = null;
  /** `null` once bootstrap has reconciled and callbacks flow straight through. */
  private preSeedObservations: Array<{
    readonly status: ConnectionStatus;
    readonly backgrounded: boolean;
  }> | null = [];
  /**
   * Bumped on every callback arrival, buffered or live.
   * A snapshot may be adopted as a baseline only if it resolved with no intervening callback (its captured value could otherwise be older than an already-delivered observation - the native read races the event stream).
   */
  private callbackRevision = 0;
  /** Whether a resume completed while bootstrap was still reconciling. */
  private bootstrapSawResume = false;
  /** True from a resume event until the post-resume rebaseline read settles. */
  private rebaselineActive = false;
  /**
   * The single commit owner for live confirmations.
   * Bumped on every live callback arrival and on every resume boundary; a confirmation may only commit (write the baseline, fire the wake) if the sequence it captured at arrival is still current when its read settles.
   */
  private liveCommitSeq = 0;
  /**
   * Whether `lastStatus` was established by a confirmed read (a quiet snapshot or a confirmed commit) rather than a raw callback adopted when confirmation was unavailable.
   * An untrusted baseline may be superseded but never serve as the predecessor of a forced wake: the next confirmed status seeds from it silently.
   */
  private baselineTrusted = true;
  /**
   * Which resume owns the current rebaseline read.
   * A second resume during the read supersedes the first: only the newest generation may adopt the post-resume baseline and close the quarantine window.
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
   * Applies one live observation with confirmation: the observed status is validated against a revision-guarded current read before it may change the baseline or force a redial.
   * Confirmation is universal rather than scoped to a could-still-be-stale window because no callback-side property bounds that window; the cost is one native round trip per (rare) network event.
   */
  private async confirmAndApply(
    observed: ConnectionStatus,
    commitSeq: number,
  ): Promise<void> {
    const confirmed = await this.settleQuietRead();
    if (commitSeq !== this.liveCommitSeq) {
      // A newer callback - or a resume boundary - owns the commit now.
      // This confirmation writes nothing: committing here would either double the wake (both raced confirmations comparing the same stale baseline) or let an older observation overwrite a newer one after its quiet reads ran out.
      return;
    }
    if (confirmed === null) {
      // No quiet read - but the ownership check above just proved this IS the newest observation, so it may move the baseline.
      // It moves it as untrusted: an unconfirmed raw callback must never become the predecessor a later confirmed status fires against.
      this.lastStatus = observed;
      this.baselineTrusted = false;
      return;
    }
    // `previous` is read AT commit, not at arrival: an arrival-time capture is exactly what let two overlapping confirmations both see the old baseline.
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
    this.systemResume.setEpochBoundaryListener(() => {
      this.onResumed();
    });
    this.systemResume.ensureTracking();
    // Failure-isolated read-listen-read bootstrap; see the class doc.
    // The rejection handler attaches to snapshot A immediately - a listener registration failure must not leave A as an unhandled rejection.
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
          // Bootstrap has not reconciled - hold the observation, tagged with the lifecycle state it arrived under, instead of letting it become the baseline.
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
      // Snapshot B exists to close the A-to-registration gap, so it is attempted whenever the listener actually installed - independent of whether A failed.
      // A quiet read (no callback landing during its round trip) is required before its value may serve as an ordering anchor.
      const snapshotB = listenerInstalled ? await this.settleQuietRead() : null;
      this.reconcileBootstrap(snapshotA, snapshotB);
    })();
  }

  /**
   * Bounds the quiet-read retry loop: after this many reads that each raced a callback, the newest callback is simply the freshest observation there is, and it becomes the baseline instead.
   */
  private static readonly QUIET_READ_ATTEMPTS = 3;

  /**
   * Reads the current status until one read completes with NO callback arriving during its native round trip, or the attempt bound is hit (`null` - the caller falls back to the newest buffered/live callback).
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
   * The single bootstrap walk: chain the observations in order (snapshot A, every buffered callback, quiet snapshot B), emit at most one recovery signal, and adopt the newest observation as the live baseline.
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
      // Nothing observed at all (reads failed, no callbacks): the first live callback will seed the baseline, exactly as an unbuffered listener would have.
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
      // The newest observation still places the baseline, but only as untrusted, and the post-resume rebaseline (deferred until this walk placed its baseline) establishes the trusted one.
      this.baselineTrusted = false;
      this.beginRebaseline();
      return;
    }
    // Trust follows provenance: a snapshot tail (quiet B, or A with nothing after it) is a confirmed read; a buffered-callback tail is raw, so the first live confirmation re-seeds from it silently.
    this.baselineTrusted = snapshotB !== null || buffered.length === 0;
    if (!sawForegroundRecovery || this.systemResume.isBackgrounded()) {
      return;
    }
    this.emitPathChanged();
  }

  private onResumed(): void {
    // Every resume is a commit boundary: confirmations already in flight belong to the epoch the app just left and must not commit against the post-resume world.
    this.liveCommitSeq += 1;
    this.resumeGeneration += 1;
    if (this.preSeedObservations !== null) {
      // Bootstrap is still reconciling: record the epoch handoff.
      this.bootstrapSawResume = true;
      return;
    }
    this.beginRebaseline();
  }

  /**
   * Starts the generation-owned post-resume rebaseline read.
   * The newest resume generation owns both the adopted baseline and the closing of the quarantine window; a superseded read does neither.
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
        // The read never went quiet (or failed).
        // Mark it untrusted: the next confirmed observation seeds silently instead of firing a second forced wake against a baseline from the wrong side of the suspend.
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
 * Identity-bucketed preferred-host persistence for the in-window authority, durable across launches via `localStorage` (the WebView's storage survives app restarts; only an uninstall clears it).
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
