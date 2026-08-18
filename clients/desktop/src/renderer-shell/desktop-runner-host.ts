import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  CliInstallManifestSnapshot,
  ConvergeReadyOk,
  DeviceFlowSession,
  IDeviceFlowHost,
  HostAvailableSnapshot,
  HostAvailableVersionsInput,
  HostControllerStatus,
  HostDoctorReport,
  HostInstalledRecord,
  HostLogsTailResult,
  HostNameSettings,
  HostRegistryUpdateState,
  HostRemovalState,
  HostTrayCommand,
  HostUninstallResult,
  HostRestartRequestResult,
  InstallVersionOk,
  MutationOutcome,
  NotificationFeedSource,
  NotificationForegroundAppLocal,
  NotificationForegroundDisplay,
  NotificationShowOutcome,
  ServiceRegistrationOk,
  TraycerUninstallResult,
  FreePortAndRestartInput,
  IHostManagement,
  IHostTray,
  IFileDropHost,
  IMigrationHost,
  INotificationHost,
  IRunnerHost,
  ISecureStorage,
  IServiceHost,
  ITokenStore,
  ITrayState,
  ITraycerCli,
  IWorkspaceFoldersHost,
  IZoomHost,
  LocalHostSnapshot,
  MigrationRunningSnapshot,
  RegisteredHostsChange,
  TrayEpic,
  TrayIndicatorState,
  TraycerHostStatusSnapshot,
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
  TraycerShellProbeResult,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  AccessibilityThemeSnapshot,
  BackgroundMaterial,
  DisplaySnapshot,
  DisplayTopology,
  FileSaveInput,
  InstalledFont,
  PendingCertificateError,
  ProcessMetricsSnapshot,
  TrustedCertificateEntry,
  Vibrancy,
} from "../ipc-contracts/platform-types";
import {
  readEncryptedItem,
  removeEncryptedItem,
  writeEncryptedItem,
} from "./secure-local-storage";

export type {
  AccessibilityThemeSnapshot,
  BackgroundMaterial as DesktopBackgroundMaterial,
  DisplaySnapshot,
  DisplayTopology,
  PendingCertificateError,
  ProcessMetricsSnapshot,
  TrustedCertificateEntry,
  Vibrancy as DesktopVibrancy,
};

import type { SelectionAuthorityClient } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  ListUserSessionsFetchResult,
  MintHostCredentialFetchResult,
  RevokeAllSessionsFetchResult,
  RevokeUserSessionFetchResult,
  StepUpChallengeFetchResult,
  RetainedStepUpVerifyFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import type { MintHostCredentialRequest } from "@traycer/protocol/auth/devices-sessions";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
} from "../ipc-contracts/app-update-types";
import type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutsSnapshot,
  GlobalShortcutStatus,
} from "../ipc-contracts/global-shortcuts-types";
import type {
  DesktopAuthSessionSnapshot,
  DesktopRuntimePlatform,
  DesktopTopLevelMenuId,
  MenuCommandPayload,
  OpenEpicInNewWindowResult,
  OwnershipClaimResult,
  OwnershipEntry,
  PerWindowSnapshot,
  PerWindowStateCapabilities,
  PerWindowStatePatch,
  PerWindowStateUpdateAcknowledgement,
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSnapshot,
  WindowSummary,
} from "../ipc-contracts/window-types";
import type { ZoomPercent } from "../ipc-contracts/zoom-types";

/**
 * Shape of the `window.runnerHost` object installed by the Electron preload
 * bridge. The preload hands back plain structured-clone-safe values, so the
 * shape here matches the preload bridge output exactly.
 */
export interface DesktopPreloadBridge {
  readonly authnBaseUrl: string;
  readonly relayBaseUrl: string;
  // Runtime redirect_uri from main (dev loopback). Empty string when the build
  // uses the compile-time custom-scheme redirect (staging/prod).
  readonly authRedirectUri: string;
  readonly initialRoute: string | null;
  readonly sentryRendererDsn: string;
  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult>;
  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult>;
  updateHostVersionPolicy(
    bearerToken: string,
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult>;
  deregisterHostFromAccount(
    bearerToken: string,
    hostId: string,
  ): Promise<DeregisterHostFetchResult>;
  // Credentials-file token store (tech plan §3): an IPC client of the main
  // `FileTokenStore`. Replaces the renderer-local encrypt-storage token slots.
  tokenStore: ITokenStore;
  listUserSessions(bearerToken: string): Promise<ListUserSessionsFetchResult>;
  revokeUserSession(
    bearerToken: string,
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult>;
  revokeAllSessions(bearerToken: string): Promise<RevokeAllSessionsFetchResult>;
  mintHostCredential(
    bearerToken: string,
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult>;
  requestStepUpChallenge(
    bearerToken: string,
  ): Promise<StepUpChallengeFetchResult>;
  verifyStepUpChallenge(
    bearerToken: string,
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult>;
  openExternalLink(url: string): Promise<void>;
  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]>;
  requestMicrophoneAccess(): Promise<"granted" | "denied">;
  openMicrophoneSettings(): Promise<void>;
  beginAuthAttempt(): void;
  onAuthCallback(handler: () => void): {
    dispose: () => void;
  };
  deviceFlow: {
    start(): Promise<DeviceFlowSession | null>;
  };
  notifications: {
    show(
      title: string,
      body: string,
      payload: unknown,
      replaceKey: string | null,
      deliveryKey: string | null,
      feedSource: NotificationFeedSource | null,
      foregroundAppLocal: NotificationForegroundAppLocal | null,
    ): Promise<NotificationShowOutcome>;
    onClick(handler: (payload: unknown) => void): { dispose: () => void };
    onForegroundDisplay(
      handler: (display: NotificationForegroundDisplay) => void,
    ): { dispose: () => void };
  };
  onLocalHostChange(handler: (snapshot: LocalHostSnapshot | null) => void): {
    dispose: () => void;
  };
  onRegisteredHostsChange(handler: (push: RegisteredHostsChange) => void): {
    dispose: () => void;
  };
  onSystemResumed(handler: () => void): { dispose: () => void };
  requestHostRespawn(): Promise<HostRestartRequestResult>;
  getLastKnownLocalHostId(): Promise<string | null>;
  trayState: {
    setEpics(epics: readonly TrayEpic[]): Promise<void>;
    setIndicator(state: TrayIndicatorState): Promise<void>;
    onEpicSelected(handler: (epicId: string) => void): {
      dispose: () => void;
    };
  };
  workspaceFolders: {
    pickFolders(): Promise<readonly string[]>;
  };
  fileDrops: DesktopFileDropsBridge;
  menu: DesktopMenuBridge;
  appUpdates: DesktopAppUpdatesBridge;
  globalShortcuts: DesktopGlobalShortcutsBridge;
  support: DesktopSupportBridge;
  windows: DesktopWindowsBridge;
  service: DesktopServiceBridge;
  traycerCli: DesktopTraycerCliBridge;
  migration: DesktopMigrationBridge;
  platform: DesktopPlatformBridge;
  power: DesktopPowerBridge;
  zoom: DesktopZoomBridge;
  hostManagement: DesktopHostManagementBridge;
  hostTray: DesktopHostTrayBridge;
  hostControllerStatus: DesktopHostControllerStatusBridge;
  /**
   * The preload-built client of the main-process selection authority. It
   * already carries this load's engine-issued `attachSeq` and its own
   * buffering, so the renderer only has to attach and subscribe.
   */
  selectionAuthority: SelectionAuthorityClient;
  refreshSelectionFleet: () => Promise<void>;
}

export interface DesktopFileDropsBridge {
  getPathForFile(file: File): string;
  writeTemporaryFile(input: {
    readonly name: string;
    readonly type: string;
    readonly bytes: ArrayBuffer;
  }): Promise<string>;
  copyTemporaryFiles(paths: readonly string[]): Promise<readonly string[]>;
  readNativeClipboardFilePaths(): Promise<readonly string[]>;
  saveFile(input: FileSaveInput): Promise<string | null>;
}

/**
 * Preload-exposed host-management surface. Mirrors `IHostManagement`
 * exactly so `DesktopRunnerHost` can hand it through without re-wrapping
 * every method. The desktop preload composes this via
 * `buildHostManagementBridge()`.
 */
export interface DesktopHostManagementBridge {
  getHostControllerStatus(): Promise<HostControllerStatus>;
  convergeReady(force: boolean): Promise<MutationOutcome<ConvergeReadyOk>>;
  applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>>;
  activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>>;
  installVersion(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>>;
  uninstallHost(input: { readonly all: boolean }): Promise<HostUninstallResult>;
  uninstallTraycer(): Promise<TraycerUninstallResult>;
  getRemovalState(): Promise<HostRemovalState>;
  clearRemoval(): Promise<void>;
  restartHost(): Promise<HostRestartRequestResult>;
  getHostLogs(input: {
    readonly tailLines: number;
  }): Promise<HostLogsTailResult>;
  runDoctor(): Promise<HostDoctorReport>;
  availableVersions(
    input: HostAvailableVersionsInput,
  ): Promise<HostAvailableSnapshot>;
  installedRecord(): Promise<HostInstalledRecord | null>;
  registerService(): Promise<MutationOutcome<ServiceRegistrationOk>>;
  deregisterService(): Promise<void>;
  registryCheck(input: {
    readonly force: boolean;
  }): Promise<HostRegistryUpdateState>;
  freePortAndRestart(
    input: FreePortAndRestartInput,
  ): Promise<FreePortAndRestartInput>;
  cliManifest(): Promise<CliInstallManifestSnapshot | null>;
  getHostName(): Promise<HostNameSettings>;
  setHostName(input: {
    readonly customName: string | null;
  }): Promise<HostNameSettings>;
}

export interface DesktopHostTrayBridge {
  onCommand(handler: (command: HostTrayCommand) => void): {
    dispose: () => void;
  };
}

export interface DesktopHostControllerStatusBridge {
  onChange(handler: (status: HostControllerStatus) => void): {
    dispose: () => void;
  };
}

export interface DesktopMigrationBridge {
  announceRunning(snapshot: MigrationRunningSnapshot): Promise<void>;
  getSnapshot(): Promise<MigrationRunningSnapshot>;
  onChange(handler: (snapshot: MigrationRunningSnapshot) => void): {
    dispose: () => void;
  };
}

export interface DesktopPlatformBridge {
  clipboard?: {
    writeImage(input: {
      readonly type: string;
      readonly bytes: ArrayBuffer;
    }): Promise<void>;
  };
  recentDocuments: {
    add(path: string): Promise<void>;
  };
  window: {
    flashFrame(shouldFlash: boolean): Promise<void>;
    setProgressBar(value: number): Promise<void>;
    setRepresentedFilename(path: string): Promise<void>;
    setDocumentEdited(edited: boolean): Promise<void>;
    setContentProtection(enabled: boolean): Promise<void>;
    setVibrancy(vibrancy: Vibrancy | null): Promise<void>;
    setBackgroundMaterial(material: BackgroundMaterial): Promise<void>;
    setVisibleOnAllWorkspaces(visible: boolean): Promise<void>;
  };
  app: {
    setBadge(text: string): Promise<void>;
  };
  diagnostics: {
    getMetrics(): Promise<ProcessMetricsSnapshot>;
    takeHeapSnapshot(): Promise<string | null>;
    traceStart(): Promise<boolean>;
    traceStop(): Promise<string | null>;
  };
  systemPreferences: {
    getAccentColor(): Promise<string | null>;
    getAppearance(): Promise<"dark" | "light" | null>;
    getAccessibilityTheme(): Promise<AccessibilityThemeSnapshot>;
    onAccessibilityThemeChange(
      handler: (snapshot: AccessibilityThemeSnapshot) => void,
    ): { dispose: () => void };
  };
  touchId: {
    isAvailable(): Promise<boolean>;
    prompt(reason: string): Promise<boolean>;
  };
  proxyAuth: {
    list(): Promise<
      ReadonlyArray<{ readonly key: string; readonly username: string }>
    >;
    save(
      host: string,
      realm: string,
      username: string,
      password: string,
    ): Promise<boolean>;
    clear(host: string, realm: string): Promise<void>;
  };
  proxy: {
    setConfig(config: unknown): Promise<void>;
    resolve(url: string): Promise<string>;
  };
  certTrust: {
    list(): Promise<ReadonlyArray<TrustedCertificateEntry>>;
    trust(hostname: string, certificate: unknown): Promise<unknown>;
    untrust(fingerprint: string, hostname: string): Promise<void>;
    listPending(): Promise<ReadonlyArray<PendingCertificateError>>;
    dismissPending(id: string): Promise<void>;
    showSystemDialog(certificate: unknown, message: string): Promise<boolean>;
    onPending(handler: (entry: PendingCertificateError) => void): {
      dispose: () => void;
    };
  };
  display: {
    list(): Promise<DisplayTopology>;
    onTopologyChange(
      handler: (event: {
        readonly reason:
          "display-added" | "display-removed" | "display-metrics-changed";
        readonly topology: DisplayTopology;
      }) => void,
    ): { dispose: () => void };
  };
  gpu: {
    getAccelerationEnabled(): Promise<boolean>;
    setAccelerationEnabled(enabled: boolean): Promise<boolean>;
  };
  fonts: {
    list(): Promise<readonly InstalledFont[]>;
  };
  windowEx: {
    setOverlayIcon(image: string | null, description: string): Promise<void>;
    setTitleBarOverlay(color: string, symbolColor: string): Promise<void>;
  };
}

export interface DesktopPowerBridge {
  setSleepBlocked(blocked: boolean): Promise<void>;
}

export interface DesktopZoomBridge {
  readonly ladder: readonly ZoomPercent[];
  get(): Promise<ZoomPercent>;
  set(percent: number): Promise<ZoomPercent>;
  stepIn(): Promise<ZoomPercent>;
  stepOut(): Promise<ZoomPercent>;
  reset(): Promise<ZoomPercent>;
  onChange(handler: (percent: ZoomPercent) => void): {
    dispose: () => void;
  };
}

export interface DesktopTraycerCliBridge {
  hostStatus(): Promise<TraycerHostStatusSnapshot>;
  shellConfigGet(): Promise<TraycerShellConfig>;
  shellConfigSet(input: TraycerShellConfigSetInput): Promise<void>;
  shellConfigReset(): Promise<void>;
  shellConfigAdd(input: { readonly path: string }): Promise<void>;
  shellConfigRemove(input: { readonly path: string }): Promise<void>;
  shellRevertArgs(input: { readonly path: string }): Promise<void>;
  shellProbe(input: {
    readonly path: string;
  }): Promise<TraycerShellProbeResult>;
  pickShellProgramFile(): Promise<string | null>;
  shellListDetected(): Promise<readonly TraycerDetectedShell[]>;
  envOverrideList(): Promise<readonly TraycerEnvOverride[]>;
  envOverrideSet(input: {
    readonly key: string;
    readonly value: string | null;
  }): Promise<void>;
  envOverrideDelete(input: { readonly key: string }): Promise<void>;
}

export interface DesktopServiceBridge {
  install(): Promise<void>;
  uninstall(purge: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  upgrade(): Promise<void>;
  enableLinger(): Promise<void>;
  getLogTail(maxLines: number): Promise<string | null>;
}

export interface DesktopMenuBridge {
  readonly platform: DesktopRuntimePlatform;
  onCommand(handler: (payload: MenuCommandPayload) => void): {
    dispose: () => void;
  };
  openTopLevel(
    menuId: DesktopTopLevelMenuId,
    anchorX: number,
    anchorY: number,
  ): Promise<void>;
}

export interface DesktopAppUpdatesBridge {
  getSnapshot(): Promise<DesktopAppUpdateSnapshot>;
  checkForUpdates(
    intent: DesktopAppUpdateCheckIntent,
  ): Promise<DesktopAppUpdateSnapshot>;
  setAllowPrerelease(
    allowPrerelease: boolean,
  ): Promise<DesktopAppUpdateSnapshot>;
  downloadUpdate(): Promise<DesktopAppUpdateSnapshot>;
  installUpdate(): Promise<DesktopAppUpdateSnapshot>;
  onChange(handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose: () => void;
  };
}

export interface DesktopGlobalShortcutsBridge {
  getSnapshot(): Promise<GlobalShortcutsSnapshot>;
  set(
    id: GlobalShortcutId,
    intent: GlobalShortcutIntent,
  ): Promise<GlobalShortcutStatus>;
  onChange(handler: (snapshot: GlobalShortcutsSnapshot) => void): {
    dispose: () => void;
  };
}

export interface DesktopSupportBridge {
  getSnapshot(): Promise<SupportSnapshot>;
  revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult>;
  tailLog(input: {
    readonly target: SupportLogTarget;
    readonly tailLines: number;
  }): Promise<SupportLogTailResult>;
}

export interface DesktopWindowsBridge {
  readonly windowId: string;
  list(): Promise<readonly WindowSummary[]>;
  onChange(handler: (windows: readonly WindowSummary[]) => void): {
    dispose: () => void;
  };
  requestNew(initialRoute: string | null): Promise<void>;
  requestFocus(windowId: string): Promise<void>;
  requestClose(windowId: string): Promise<void>;
  requestOpenEpicInNewWindow(
    epicId: string,
    title: string,
    tabId: string,
  ): Promise<OpenEpicInNewWindowResult>;
  ownership: {
    snapshot(): Promise<readonly OwnershipEntry[]>;
    claim(tabId: string, epicId: string): Promise<OwnershipClaimResult>;
    release(tabId: string): Promise<void>;
    onChange(handler: (entries: readonly OwnershipEntry[]) => void): {
      dispose: () => void;
    };
  };
  perWindowState: {
    get(): Promise<PerWindowSnapshot>;
    capabilities?(): Promise<PerWindowStateCapabilities>;
    update(
      patch: PerWindowStatePatch,
    ): Promise<PerWindowStateUpdateAcknowledgement | void>;
    clear(): Promise<void>;
    onChange(handler: (snapshot: PerWindowSnapshot) => void): {
      dispose: () => void;
    };
  };
  authSession: {
    get(): Promise<DesktopAuthSessionSnapshot>;
    set(snapshot: DesktopAuthSessionSnapshot): Promise<void>;
    onChange(handler: (snapshot: DesktopAuthSessionSnapshot) => void): {
      dispose: () => void;
    };
  };
}

export interface DesktopRunnerHostOptions {
  readonly bridge: DesktopPreloadBridge;
  readonly signInUrl: string;
}

/**
 * Concrete `IRunnerHost` for the Electron desktop shell.
 *
 * Constructed synchronously in the renderer entry as a closure over
 * `window.runnerHost` (installed by `src/preload/index.ts`). All async
 * methods forward straight through to the bridge; subscriptions are
 * normalised to shared `Disposable`s so `gui-app` consumes a platform-neutral
 * contract.
 *
 * `signInUrl` is pre-composed by the caller with
 * `redirect_uri=traycer://auth/callback` so `gui-app` treats it as an opaque,
 * browser-safe URL. `authnBaseUrl` is resolved in preload from the Electron
 * process environment, so it is already a plain string when we read it here.
 */
export class DesktopRunnerHost implements IRunnerHost {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly relayBaseUrl: string;
  readonly hasLocalHost: boolean = true;

  readonly secureStorage: ISecureStorage;
  readonly tokenStore: ITokenStore;
  readonly notifications: INotificationHost;
  readonly tray: ITrayState;
  readonly workspaceFolders: IWorkspaceFoldersHost;
  readonly fileDrops: IFileDropHost;
  readonly windows: DesktopWindowsBridge;
  readonly menu: DesktopMenuBridge;
  readonly appUpdates: DesktopAppUpdatesBridge;
  readonly globalShortcuts: DesktopGlobalShortcutsBridge;
  readonly support: DesktopSupportBridge;
  readonly service: IServiceHost;
  readonly traycerCli: ITraycerCli;
  readonly migration: IMigrationHost;
  readonly platform: DesktopPlatformBridge;
  readonly power: DesktopPowerBridge;
  readonly zoom: IZoomHost;
  readonly hostManagement: IHostManagement;
  readonly hostTray: IHostTray;
  readonly hostControllerStatus: DesktopHostControllerStatusBridge;
  readonly selectionAuthority: SelectionAuthorityClient;
  private readonly refreshSelectionFleet: () => Promise<void>;
  readonly deviceFlow: IDeviceFlowHost;

  private readonly bridge: DesktopPreloadBridge;
  private cachedLocalHost: LocalHostSnapshot | null = null;
  private readonly localHostHandlers = new Set<
    (snapshot: LocalHostSnapshot | null) => void
  >();
  private readonly systemResumedHandlers = new Set<() => void>();
  private readonly bridgeSubscriptions: Disposable[] = [];

  constructor(options: DesktopRunnerHostOptions) {
    this.bridge = options.bridge;
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.bridge.authnBaseUrl;
    this.relayBaseUrl = options.bridge.relayBaseUrl;
    this.windows = options.bridge.windows;
    this.menu = options.bridge.menu;
    this.appUpdates = options.bridge.appUpdates;
    this.globalShortcuts = options.bridge.globalShortcuts;
    this.support = options.bridge.support;
    this.platform = options.bridge.platform;
    this.power = options.bridge.power;
    // Passed straight through: the client instance, its issued attach
    // generation and its buffering all belong to the preload load, so
    // re-wrapping it here could only add a second identity for the same
    // generation.
    this.selectionAuthority = options.bridge.selectionAuthority;
    this.refreshSelectionFleet = options.bridge.refreshSelectionFleet;
    this.zoom = {
      ladder: options.bridge.zoom.ladder,
      get: () => options.bridge.zoom.get(),
      set: (percent) => options.bridge.zoom.set(percent),
      stepIn: () => options.bridge.zoom.stepIn(),
      stepOut: () => options.bridge.zoom.stepOut(),
      reset: () => options.bridge.zoom.reset(),
      onChange: (handler) =>
        toDisposable(options.bridge.zoom.onChange(handler)),
    };

    this.bridgeSubscriptions.push(
      this.bridge.onLocalHostChange((snapshot) => {
        this.cachedLocalHost = snapshot;
        for (const handler of this.localHostHandlers) {
          handler(snapshot);
        }
      }),
      this.bridge.onSystemResumed(() => {
        for (const handler of this.systemResumedHandlers) {
          handler();
        }
      }),
    );

    // `secureStorage` stays renderer-local encrypted localStorage (no
    // OS-keychain prompt on first launch, and it has non-token consumers). See
    // `secure-local-storage.ts` for the full rationale.
    this.secureStorage = {
      get: (key) => Promise.resolve(readEncryptedItem(key)),
      set: (key, value) => {
        writeEncryptedItem(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        removeEncryptedItem(key);
        return Promise.resolve();
      },
    };

    // Credentials-file token store (tech plan §3): the auth token store now
    // round-trips through Electron main - it is the single machine-local
    // credentials file owned by `FileTokenStore` (lock + WAL), shared with the
    // CLI and read by the host, reached here over IPC. The old renderer-local
    // encrypted-localStorage token slots are retired (their migration is §6).
    this.tokenStore = options.bridge.tokenStore;

    this.notifications = {
      show: (
        title,
        body,
        payload,
        replaceKey,
        deliveryKey,
        feedSource,
        foregroundAppLocal,
      ) =>
        this.bridge.notifications.show(
          title,
          body,
          payload,
          replaceKey,
          deliveryKey,
          feedSource,
          foregroundAppLocal,
        ),
      onClick: (handler) =>
        toDisposable(this.bridge.notifications.onClick(handler)),
      onForegroundDisplay: (handler) =>
        toDisposable(this.bridge.notifications.onForegroundDisplay(handler)),
    };

    this.tray = {
      setEpics: (epics) => this.bridge.trayState.setEpics(epics),
      setIndicator: (state) => this.bridge.trayState.setIndicator(state),
      onEpicSelected: (handler) =>
        toDisposable(this.bridge.trayState.onEpicSelected(handler)),
    };

    this.workspaceFolders = {
      canPickNatively: true,
      pickFolders: () => this.bridge.workspaceFolders.pickFolders(),
    };
    this.fileDrops = buildDesktopFileDrops(this.bridge.fileDrops);
    this.service = {
      install: () => this.bridge.service.install(),
      uninstall: (purge) => this.bridge.service.uninstall(purge),
      start: () => this.bridge.service.start(),
      stop: () => this.bridge.service.stop(),
      restart: () => this.bridge.service.restart(),
      upgrade: () => this.bridge.service.upgrade(),
      enableLinger: () => this.bridge.service.enableLinger(),
      getLogTail: (maxLines) => this.bridge.service.getLogTail(maxLines),
    };
    this.traycerCli = {
      hostStatus: () => this.bridge.traycerCli.hostStatus(),
      shellConfigGet: () => this.bridge.traycerCli.shellConfigGet(),
      shellConfigSet: (input) => this.bridge.traycerCli.shellConfigSet(input),
      shellConfigReset: () => this.bridge.traycerCli.shellConfigReset(),
      shellConfigAdd: (input) => this.bridge.traycerCli.shellConfigAdd(input),
      shellConfigRemove: (input) =>
        this.bridge.traycerCli.shellConfigRemove(input),
      shellRevertArgs: (input) => this.bridge.traycerCli.shellRevertArgs(input),
      shellProbe: (input) => this.bridge.traycerCli.shellProbe(input),
      // Desktop always ships the native file dialog, so this capability is
      // present here (non-desktop hosts leave `traycerCli` null entirely).
      pickShellProgramFile: () => this.bridge.traycerCli.pickShellProgramFile(),
      shellListDetected: () => this.bridge.traycerCli.shellListDetected(),
      envOverrideList: () => this.bridge.traycerCli.envOverrideList(),
      envOverrideSet: (input) => this.bridge.traycerCli.envOverrideSet(input),
      envOverrideDelete: (input) =>
        this.bridge.traycerCli.envOverrideDelete(input),
    };
    this.migration = {
      announceRunning: (snapshot) =>
        this.bridge.migration.announceRunning(snapshot),
      getSnapshot: () => this.bridge.migration.getSnapshot(),
      onChange: (handler) =>
        toDisposable(this.bridge.migration.onChange(handler)),
    };
    const managementBridge = this.bridge.hostManagement;
    this.hostManagement = {
      getHostControllerStatus: () => managementBridge.getHostControllerStatus(),
      convergeReady: (force) => managementBridge.convergeReady(force),
      applyStaged: (trigger, force) =>
        managementBridge.applyStaged(trigger, force),
      activateInstalled: (force) => managementBridge.activateInstalled(force),
      installVersion: (pin, force) =>
        managementBridge.installVersion(pin, force),
      uninstallHost: (input) => managementBridge.uninstallHost(input),
      uninstallTraycer: () => managementBridge.uninstallTraycer(),
      getRemovalState: () => managementBridge.getRemovalState(),
      clearRemoval: () => managementBridge.clearRemoval(),
      restartHost: () => managementBridge.restartHost(),
      getHostLogs: (input) => managementBridge.getHostLogs(input),
      runDoctor: () => managementBridge.runDoctor(),
      availableVersions: (input) => managementBridge.availableVersions(input),
      installedRecord: () => managementBridge.installedRecord(),
      registerService: () => managementBridge.registerService(),
      deregisterService: () => managementBridge.deregisterService(),
      registryCheck: (input) => managementBridge.registryCheck(input),
      freePortAndRestart: (input) => managementBridge.freePortAndRestart(input),
      cliManifest: () => managementBridge.cliManifest(),
      getHostName: () => managementBridge.getHostName(),
      setHostName: (input) => managementBridge.setHostName(input),
    };
    this.hostControllerStatus = {
      onChange: (handler) => this.bridge.hostControllerStatus.onChange(handler),
    };
    this.hostTray = {
      onCommand: (handler) =>
        toDisposable(this.bridge.hostTray.onCommand(handler)),
    };
    // The preload bridge already returns a `DeviceFlowSession`-shaped handle
    // (authorize result + per-attempt `onResult` + `cancel`), so this forwards
    // straight through - the CORS-safe authorize + poll loop lives in main.
    this.deviceFlow = {
      start: () => this.bridge.deviceFlow.start(),
    };
  }

  requestMicrophoneAccess(): Promise<"granted" | "denied"> {
    return this.bridge.requestMicrophoneAccess();
  }

  refreshHostFleet(): Promise<void> {
    return this.refreshSelectionFleet();
  }

  /**
   * Desktop OWNS the registry cadence, so this is never null here: main runs
   * one `GET /api/v3/hosts` for the whole app and fans the rows out (P4.1/F22).
   */
  onRegisteredHostsChange(
    handler: (push: RegisteredHostsChange) => void,
  ): Disposable | null {
    return toDisposable(this.bridge.onRegisteredHostsChange(handler));
  }

  openMicrophoneSettings(): Promise<void> {
    return this.bridge.openMicrophoneSettings();
  }

  openExternalLink(url: string): Promise<void> {
    return this.bridge.openExternalLink(url);
  }

  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]> {
    return this.bridge.getRegisteredUrlSchemes(schemes);
  }

  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    return this.bridge.validateAuthTokenIdentity(token);
  }

  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult> {
    return this.bridge.listRegisteredHosts(bearerToken);
  }

  listUserSessions(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<ListUserSessionsFetchResult> {
    return settleOnAbort(
      () => this.bridge.listUserSessions(bearerToken),
      signal,
    );
  }

  revokeUserSession(
    bearerToken: string,
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult> {
    return this.bridge.revokeUserSession(
      bearerToken,
      familyId,
      useStepUpCredential,
    );
  }

  revokeAllSessions(
    bearerToken: string,
  ): Promise<RevokeAllSessionsFetchResult> {
    return this.bridge.revokeAllSessions(bearerToken);
  }

  mintHostCredential(
    bearerToken: string,
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult> {
    return this.bridge.mintHostCredential(bearerToken, request);
  }

  requestStepUpChallenge(
    bearerToken: string,
  ): Promise<StepUpChallengeFetchResult> {
    return this.bridge.requestStepUpChallenge(bearerToken);
  }

  verifyStepUpChallenge(
    bearerToken: string,
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult> {
    return this.bridge.verifyStepUpChallenge(bearerToken, code);
  }

  updateHostVersionPolicy(
    bearerToken: string,
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult> {
    return this.bridge.updateHostVersionPolicy(bearerToken, hostId, input);
  }

  deregisterHostFromAccount(
    bearerToken: string,
    hostId: string,
  ): Promise<DeregisterHostFetchResult> {
    return this.bridge.deregisterHostFromAccount(bearerToken, hostId);
  }

  beginAuthAttempt(): void {
    this.bridge.beginAuthAttempt();
  }

  onAuthCallback(handler: () => void): Disposable {
    return toDisposable(this.bridge.onAuthCallback(handler));
  }

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    this.localHostHandlers.add(handler);
    handler(this.cachedLocalHost);
    return {
      dispose: () => {
        this.localHostHandlers.delete(handler);
      },
    };
  }

  getLastKnownLocalHostId(): Promise<string | null> {
    return this.bridge.getLastKnownLocalHostId();
  }

  onSystemResumed(handler: () => void): Disposable {
    this.systemResumedHandlers.add(handler);
    return {
      dispose: () => {
        this.systemResumedHandlers.delete(handler);
      },
    };
  }

  requestHostRespawn(): Promise<HostRestartRequestResult> {
    return this.bridge.requestHostRespawn();
  }

  dispose(): void {
    while (this.bridgeSubscriptions.length > 0) {
      const subscription = this.bridgeSubscriptions.pop();
      subscription?.dispose();
    }
    this.localHostHandlers.clear();
    this.systemResumedHandlers.clear();
  }
}

/**
 * Runs `start()` and settles as soon as `signal` aborts, without waiting for
 * the request it began.
 *
 * An `AbortSignal` is not cloneable across the context bridge, so the request
 * itself lives in Electron main and cannot be cancelled from the renderer; it
 * stays bounded by the fetcher's own 10s timeout and its reply is dropped. That
 * is an acceptable amount of waste for an idempotent GET - what is NOT
 * acceptable is the caller continuing. `AuthService.fetchUserSessions()` can
 * follow a list with a repair that spends a single-use refresh rotation, so
 * cancellation has to reach it promptly rather than 10s later.
 */
function settleOnAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // A thunk, not a promise: an already-cancelled read should not put a request
  // on the wire at all, and an argument would have been evaluated by now.
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const pending = start();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function toDisposable(subscription: { dispose: () => void }): Disposable {
  return { dispose: subscription.dispose };
}

/**
 * Whether a dropped file's resolved path points at an OS-ephemeral staging
 * location rather than a durable file. macOS writes drag-promised files (the
 * screenshot thumbnail, and other promise-backed drags) under
 * `…/T/TemporaryItems/…`, frequently via a `screencaptureui_*` directory, and
 * reclaims them shortly after the drag completes. Such a path is invalid by the
 * time a host-side terminal program reads it, so the caller materializes the
 * File's bytes into a stable copy instead of pasting this path.
 */
function isEphemeralDropPath(filePath: string): boolean {
  return (
    /[\\/]TemporaryItems[\\/]/i.test(filePath) ||
    /screencaptureui/i.test(filePath)
  );
}

function buildDesktopFileDrops(bridge: DesktopFileDropsBridge): IFileDropHost {
  return {
    resolveDroppedFilePaths: async (
      files: readonly File[],
    ): Promise<readonly string[]> => {
      const resolved = await Promise.all(
        files.map(async (file) => {
          const existingPath = bridge.getPathForFile(file);
          // A stable on-disk path (Finder drag) is pasted as-is so the agent
          // sees the user's real file. But macOS stages drag-promised files -
          // notably the floating screenshot thumbnail - under an ephemeral
          // `…/TemporaryItems/…screencaptureui_…` path that the OS reclaims
          // moments after the drag. Pasting that path lets the terminal program
          // read it only after it is gone. Since the drop carries the File's
          // bytes, materialize them into a durable temp copy instead.
          if (existingPath.length > 0 && !isEphemeralDropPath(existingPath)) {
            return existingPath;
          }
          return bridge.writeTemporaryFile({
            name: file.name,
            type: file.type,
            bytes: await file.arrayBuffer(),
          });
        }),
      );
      return resolved.filter((path) => path.length > 0);
    },
    copyDroppedFilePaths: async (
      paths: readonly string[],
    ): Promise<readonly string[]> => {
      const resolved = await Promise.all(
        paths.map(async (sourcePath) => {
          if (!isEphemeralDropPath(sourcePath)) return sourcePath;
          const copied = await bridge.copyTemporaryFiles([sourcePath]);
          return copied.at(0) ?? sourcePath;
        }),
      );
      return resolved.filter((path) => path.length > 0);
    },
    readNativeClipboardFilePaths: () => bridge.readNativeClipboardFilePaths(),
  };
}
