import type {
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
  CliInstallManifestSnapshot,
  DeviceFlowSession,
  IDeviceFlowHost,
  HostAvailableSnapshot,
  HostAvailableVersionsInput,
  HostDoctorReport,
  HostEnsureResult,
  HostInstallResult,
  HostInstalledRecord,
  HostLogsTailResult,
  HostNameSettings,
  HostOperationStatus,
  HostProgressEvent,
  HostRegistryUpdateState,
  HostRemovalState,
  HostTrayCommand,
  HostUninstallResult,
  TraycerUninstallResult,
  FreePortAndRestartInput,
  IHostManagement,
  IHostPicker,
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
  ServiceStatusSnapshot,
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

/**
 * Single logical entry inside the renderer-side encrypted localStorage.
 * Mirrors the prior `DESKTOP_AUTH_TOKEN_STORAGE_KEY = "traycer.token"` so
 * existing dev installs keep their token across the upgrade.
 */
// The bearer and refresh token are stored in SEPARATE encrypted slots, each a
// plain string. Do NOT pack them as JSON into one slot: `encrypt-storage`'s
// `getItem` deserializes its value, so a stored JSON string round-trips back to
// an object and `readEncryptedItem` (which only returns strings) yields null -
// dropping the whole session on every restart. A raw-string slot round-trips
// exactly (the pre-cutover behavior), which is why the bearer must stay a string.
const DESKTOP_AUTH_TOKEN_KEY = "traycer.token";
const DESKTOP_AUTH_REFRESH_TOKEN_KEY = "traycer.refresh-token";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
} from "../ipc-contracts/app-update-types";
import type {
  DesktopAuthSessionSnapshot,
  MenuCommandPayload,
  OpenEpicInNewWindowResult,
  OwnershipClaimResult,
  OwnershipEntry,
  PerWindowSnapshot,
  PerWindowStatePatch,
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
  // Runtime redirect_uri from main (dev loopback). Empty string when the build
  // uses the compile-time custom-scheme redirect (staging/prod).
  readonly authRedirectUri: string;
  readonly initialRoute: string | null;
  readonly sentryRendererDsn: string;
  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult>;
  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult>;
  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult>;
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
    ): Promise<void>;
    onClick(handler: (payload: unknown) => void): { dispose: () => void };
  };
  onLocalHostChange(handler: (snapshot: LocalHostSnapshot | null) => void): {
    dispose: () => void;
  };
  onSystemResumed(handler: () => void): { dispose: () => void };
  requestHostRespawn(): Promise<void>;
  trayState: {
    setEpics(epics: readonly TrayEpic[]): Promise<void>;
    setIndicator(state: TrayIndicatorState): Promise<void>;
    onEpicSelected(handler: (epicId: string) => void): {
      dispose: () => void;
    };
  };
  hostPicker: {
    requestOpen(): Promise<void>;
    requestClose(): Promise<void>;
    onChange(handler: (isOpen: boolean) => void): { dispose: () => void };
  };
  workspaceFolders: {
    pickFolders(): Promise<readonly string[]>;
  };
  fileDrops: DesktopFileDropsBridge;
  menu: DesktopMenuBridge;
  appUpdates: DesktopAppUpdatesBridge;
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
  installHost(input: {
    readonly version: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<HostInstallResult>;
  updateHost(input: {
    readonly expectedVersion: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<HostInstallResult>;
  uninstallHost(input: { readonly all: boolean }): Promise<HostUninstallResult>;
  uninstallTraycer(): Promise<TraycerUninstallResult>;
  getRemovalState(): Promise<HostRemovalState>;
  clearRemoval(): Promise<void>;
  restartHost(): Promise<void>;
  getHostLogs(input: {
    readonly tailLines: number;
  }): Promise<HostLogsTailResult>;
  runDoctor(): Promise<HostDoctorReport>;
  availableVersions(
    input: HostAvailableVersionsInput,
  ): Promise<HostAvailableSnapshot>;
  installedRecord(): Promise<HostInstalledRecord | null>;
  registerService(input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<void>;
  ensureHost(input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
    readonly force: boolean;
  }): Promise<HostEnsureResult>;
  deregisterService(): Promise<void>;
  registryCheck(input: {
    readonly force: boolean;
  }): Promise<HostRegistryUpdateState>;
  onRegistryUpdateState(handler: (state: HostRegistryUpdateState) => void): {
    dispose: () => void;
  };
  getOperationStatus(): Promise<HostOperationStatus | null>;
  onOperationStatus(handler: (status: HostOperationStatus | null) => void): {
    dispose: () => void;
  };
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

export interface DesktopHostRegistryUpdatesBridge {
  onChange(handler: (state: HostRegistryUpdateState) => void): {
    dispose: () => void;
  };
}

export interface DesktopHostOperationStatusBridge {
  onChange(handler: (status: HostOperationStatus | null) => void): {
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
  cliLogin(input: {
    readonly token: string;
    readonly refreshToken: string;
  }): Promise<void>;
  cliLogout(): Promise<void>;
}

export interface DesktopServiceBridge {
  status(): Promise<ServiceStatusSnapshot>;
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
  onCommand(handler: (payload: MenuCommandPayload) => void): {
    dispose: () => void;
  };
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
    update(patch: PerWindowStatePatch): Promise<void>;
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
  readonly hasLocalHost: boolean = true;

  readonly secureStorage: ISecureStorage;
  readonly tokenStore: ITokenStore;
  readonly notifications: INotificationHost;
  readonly tray: ITrayState;
  readonly hostPicker: IHostPicker;
  readonly workspaceFolders: IWorkspaceFoldersHost;
  readonly fileDrops: IFileDropHost;
  readonly windows: DesktopWindowsBridge;
  readonly menu: DesktopMenuBridge;
  readonly appUpdates: DesktopAppUpdatesBridge;
  readonly support: DesktopSupportBridge;
  readonly service: IServiceHost;
  readonly traycerCli: ITraycerCli;
  readonly migration: IMigrationHost;
  readonly platform: DesktopPlatformBridge;
  readonly power: DesktopPowerBridge;
  readonly zoom: IZoomHost;
  readonly hostManagement: IHostManagement;
  readonly hostTray: IHostTray;
  readonly hostRegistryUpdates: DesktopHostRegistryUpdatesBridge;
  readonly hostOperationStatus: DesktopHostOperationStatusBridge;
  readonly deviceFlow: IDeviceFlowHost;

  private readonly bridge: DesktopPreloadBridge;
  private cachedLocalHost: LocalHostSnapshot | null = null;
  private readonly localHostHandlers = new Set<
    (snapshot: LocalHostSnapshot | null) => void
  >();
  private readonly bridgeSubscriptions: Disposable[] = [];

  constructor(options: DesktopRunnerHostOptions) {
    this.bridge = options.bridge;
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.bridge.authnBaseUrl;
    this.windows = options.bridge.windows;
    this.menu = options.bridge.menu;
    this.appUpdates = options.bridge.appUpdates;
    this.support = options.bridge.support;
    this.platform = options.bridge.platform;
    this.power = options.bridge.power;
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
    );

    // Credentials never round-trip through Electron main any more - the
    // renderer reads/writes them directly via `encrypt-storage` on top of
    // `window.localStorage`. See `secure-local-storage.ts` for the full
    // rationale; the short version is "no OS-keychain prompt on first
    // launch" while still avoiding plaintext-on-disk for casual snooping.
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

    this.tokenStore = {
      get: () => {
        const token = readEncryptedItem(DESKTOP_AUTH_TOKEN_KEY);
        if (token === null || token.length === 0) {
          return Promise.resolve(null);
        }
        const refreshToken =
          readEncryptedItem(DESKTOP_AUTH_REFRESH_TOKEN_KEY) ?? "";
        return Promise.resolve({ token, refreshToken });
      },
      set: (tokens) => {
        writeEncryptedItem(DESKTOP_AUTH_TOKEN_KEY, tokens.token);
        // An empty slot reads back as null, so clear rather than store "".
        if (tokens.refreshToken.length > 0) {
          writeEncryptedItem(
            DESKTOP_AUTH_REFRESH_TOKEN_KEY,
            tokens.refreshToken,
          );
        } else {
          removeEncryptedItem(DESKTOP_AUTH_REFRESH_TOKEN_KEY);
        }
        return Promise.resolve();
      },
      delete: () => {
        removeEncryptedItem(DESKTOP_AUTH_TOKEN_KEY);
        removeEncryptedItem(DESKTOP_AUTH_REFRESH_TOKEN_KEY);
        return Promise.resolve();
      },
    };

    this.notifications = {
      show: (title, body, payload, replaceKey, deliveryKey) =>
        this.bridge.notifications.show(
          title,
          body,
          payload,
          replaceKey,
          deliveryKey,
        ),
      onClick: (handler) =>
        toDisposable(this.bridge.notifications.onClick(handler)),
    };

    this.tray = {
      setEpics: (epics) => this.bridge.trayState.setEpics(epics),
      setIndicator: (state) => this.bridge.trayState.setIndicator(state),
      onEpicSelected: (handler) =>
        toDisposable(this.bridge.trayState.onEpicSelected(handler)),
    };

    this.hostPicker = this.buildHostPicker();
    this.workspaceFolders = {
      pickFolders: () => this.bridge.workspaceFolders.pickFolders(),
    };
    this.fileDrops = buildDesktopFileDrops(this.bridge.fileDrops);
    this.service = {
      status: () => this.bridge.service.status(),
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
      cliLogin: (token, refreshToken) =>
        this.bridge.traycerCli.cliLogin({ token, refreshToken }),
      cliLogout: () => this.bridge.traycerCli.cliLogout(),
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
      installHost: (input) => managementBridge.installHost(input),
      updateHost: (input) => managementBridge.updateHost(input),
      uninstallHost: (input) => managementBridge.uninstallHost(input),
      uninstallTraycer: () => managementBridge.uninstallTraycer(),
      getRemovalState: () => managementBridge.getRemovalState(),
      clearRemoval: () => managementBridge.clearRemoval(),
      restartHost: () => managementBridge.restartHost(),
      getHostLogs: (input) => managementBridge.getHostLogs(input),
      runDoctor: () => managementBridge.runDoctor(),
      availableVersions: (input) => managementBridge.availableVersions(input),
      installedRecord: () => managementBridge.installedRecord(),
      registerService: (input) => managementBridge.registerService(input),
      ensureHost: (input) => managementBridge.ensureHost(input),
      deregisterService: () => managementBridge.deregisterService(),
      registryCheck: (input) => managementBridge.registryCheck(input),
      getOperationStatus: () => managementBridge.getOperationStatus(),
      freePortAndRestart: (input) => managementBridge.freePortAndRestart(input),
      cliManifest: () => managementBridge.cliManifest(),
      getHostName: () => managementBridge.getHostName(),
      setHostName: (input) => managementBridge.setHostName(input),
    };
    this.hostRegistryUpdates = {
      onChange: (handler) => managementBridge.onRegistryUpdateState(handler),
    };
    this.hostOperationStatus = {
      onChange: (handler) => managementBridge.onOperationStatus(handler),
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

  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult> {
    return this.bridge.validateAuthToken(token, refreshToken);
  }

  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult> {
    return this.bridge.validateAuthTokenIdentity(token, refreshToken);
  }

  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult> {
    return this.bridge.refreshAuthToken(token, refreshToken);
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

  onSystemResumed(handler: () => void): Disposable {
    // Pure pass-through to the preload bridge's per-event subscription; the
    // caller owns the returned Disposable (unlike `onLocalHostChange`, there
    // is no cached snapshot to replay on subscribe).
    return toDisposable(this.bridge.onSystemResumed(handler));
  }

  requestHostRespawn(): Promise<void> {
    return this.bridge.requestHostRespawn();
  }

  dispose(): void {
    while (this.bridgeSubscriptions.length > 0) {
      const subscription = this.bridgeSubscriptions.pop();
      subscription?.dispose();
    }
    this.localHostHandlers.clear();
  }

  private buildHostPicker(): IHostPicker {
    const state: { open: boolean } = { open: false };
    const handlers = new Set<(isOpen: boolean) => void>();
    this.bridgeSubscriptions.push(
      this.bridge.hostPicker.onChange((next) => {
        state.open = next;
        for (const handler of handlers) {
          handler(next);
        }
      }),
    );
    const bridge = this.bridge;
    return {
      get isOpen(): boolean {
        return state.open;
      },
      requestOpen(): void {
        void bridge.hostPicker.requestOpen();
      },
      requestClose(): void {
        void bridge.hostPicker.requestClose();
      },
      onChange(handler: (isOpen: boolean) => void): Disposable {
        handlers.add(handler);
        return {
          dispose: () => {
            handlers.delete(handler);
          },
        };
      },
    };
  }
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
