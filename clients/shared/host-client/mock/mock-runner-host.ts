import type { Disposable } from "../../platform/uri-callback";
import type {
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
  DeviceFlowAuthorization,
  DeviceFlowResult,
  DeviceFlowSession,
  IDeviceFlowHost,
  IHostPicker,
  IHostManagement,
  INotificationHost,
  IRunnerHost,
  ISecureStorage,
  ITokenStore,
  ITrayState,
  ITraycerCli,
  IWorkspaceFoldersHost,
  LocalHostSnapshot,
  StoredAuthTokens,
  TraycerHostStatusSnapshot,
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
  TraycerShellProbeResult,
  TrayEpic,
  TrayIndicatorState,
} from "../../platform/runner-host";
import { defaultShellArgs } from "@traycer/protocol/config/shell-family";
import {
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  validateAuthTokenViaHttp,
} from "../../auth/auth-validation";
import type { AuthIdentityValidationResult } from "../../auth/auth-validation-types";
import type { HostDirectoryEntry } from "../host-directory";

export interface MockRunnerHostOptions {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly localHost: LocalHostSnapshot | null;
  readonly hosts: readonly HostDirectoryEntry[];
  readonly workspaceFolderPickerPaths: readonly string[] | undefined;
  /**
   * Mirrors `IRunnerHost.hasLocalHost`. Pass `undefined` to fall back to
   * `true` (desktop-flavoured); mobile-flavoured tests pass `false` to opt
   * out of the signed-in local-host gate and exercise `<MobileHostGate />`.
   */
  readonly hasLocalHost: boolean | undefined;
  /**
   * In-memory `traycerCli` surface. Pass `null` to match mobile/web shells
   * that do not bundle the CLI; pass `undefined` for the same effect to keep
   * call sites terse. Tests that exercise the bootstrap-status failure card
   * or the Shell & environment settings page pass an instance preloaded with
   * deterministic state.
   */
  readonly traycerCli: ITraycerCli | null | undefined;
  readonly hostManagement?: IHostManagement | null;
}

const MOCK_TOKEN_STORE_KEY = "traycer.token";

/** Ordered flag-list equality, for the mock's family-default canonicalisation. */
function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * In-memory `IRunnerHost` used by `gui-app` dev/preview and shared tests.
 *
 * Mirrors the composite surface real desktop and mobile runners hand to
 * `<TraycerApp />` so shared tests and dev shells can exercise the full
 * runtime without a native host attached. All capabilities are always
 * present; capabilities the concrete shell would not implement (tray on
 * mobile, notifications on web preview) install no-op handlers that never
 * fire, matching the production invariant.
 */
export class MockRunnerHost implements IRunnerHost {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hasLocalHost: boolean;
  readonly openedExternalLinks: string[] = [];
  readonly notificationsSent: Array<{
    readonly title: string;
    readonly body: string;
    readonly payload: unknown;
    readonly replaceKey: string | null;
    readonly deliveryKey: string | null;
  }> = [];
  readonly secureStorageEntries: Map<string, string> = new Map();
  readonly tokenStoreEntries: Map<string, StoredAuthTokens> = new Map();
  workspaceFolderPickerPaths: readonly string[];
  hosts: readonly HostDirectoryEntry[];

  private readonly authCallbackHandlers = new Set<() => void>();
  private readonly localHostHandlers = new Set<
    (snapshot: LocalHostSnapshot | null) => void
  >();
  private readonly notificationClickHandlers = new Set<
    (payload: unknown) => void
  >();
  private readonly systemResumedHandlers = new Set<() => void>();
  private localHost: LocalHostSnapshot | null;

  readonly tray: MockTrayState = new MockTrayState();
  readonly hostPicker: MockHostPicker = new MockHostPicker();
  readonly workspaceFolders: IWorkspaceFoldersHost = {
    pickFolders: async (): Promise<readonly string[]> => [
      ...this.workspaceFolderPickerPaths,
    ],
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
    ): Promise<readonly string[]> => {
      return paths;
    },
    readNativeClipboardFilePaths: async (): Promise<readonly string[]> => [],
  };
  readonly service: null = null;
  readonly traycerCli: ITraycerCli | null;
  readonly migration: null = null;
  readonly hostManagement: IHostManagement | null;
  readonly hostTray: null = null;
  readonly zoom: null = null;
  readonly deviceFlow: MockDeviceFlowHost = new MockDeviceFlowHost();

  /**
   * Test/dev counter - how many times `beginAuthAttempt()` has been invoked.
   * Exposed so tests can assert ordering relative to `openExternalLink(...)`
   * without leaking implementation details of the boundary signal.
   */
  beginAuthAttemptCalls = 0;

  /**
   * Test/dev counter - how many times `requestHostRespawn()` has been
   * invoked. Mirrors `beginAuthAttemptCalls` so tests can assert the host
   * Retry UX drove a respawn request without touching a real lifecycle.
   */
  requestHostRespawnCalls = 0;

  constructor(options: MockRunnerHostOptions) {
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.authnBaseUrl;
    this.localHost = options.localHost;
    this.hosts = options.hosts;
    this.workspaceFolderPickerPaths =
      options.workspaceFolderPickerPaths === undefined
        ? []
        : options.workspaceFolderPickerPaths;
    this.hasLocalHost =
      options.hasLocalHost === undefined ? true : options.hasLocalHost;
    this.traycerCli =
      options.traycerCli === undefined ? null : options.traycerCli;
    this.hostManagement =
      options.hostManagement === undefined ? null : options.hostManagement;
  }

  beginAuthAttempt(): void {
    this.beginAuthAttemptCalls += 1;
  }

  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult> {
    return validateAuthTokenViaHttp(this.authnBaseUrl, token, refreshToken);
  }

  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult> {
    return validateAuthTokenIdentityViaHttp(
      this.authnBaseUrl,
      token,
      refreshToken,
    );
  }

  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult> {
    return refreshAuthTokenViaHttp(this.authnBaseUrl, token, refreshToken);
  }

  async openExternalLink(url: string): Promise<void> {
    this.openedExternalLinks.push(url);
  }

  async getRegisteredUrlSchemes(
    _schemes: readonly string[],
  ): Promise<readonly string[]> {
    // In-memory host has no OS scheme registry; report none registered.
    return [];
  }

  async requestMicrophoneAccess(): Promise<"granted" | "denied"> {
    return "granted";
  }

  async openMicrophoneSettings(): Promise<void> {
    // No-op: no OS settings pane in the in-memory host.
  }

  onAuthCallback(handler: () => void): Disposable {
    this.authCallbackHandlers.add(handler);
    return {
      dispose: () => {
        this.authCallbackHandlers.delete(handler);
      },
    };
  }

  readonly secureStorage: ISecureStorage = {
    get: async (key: string): Promise<string | null> => {
      const value = this.secureStorageEntries.get(key);
      return value === undefined ? null : value;
    },
    set: async (key: string, value: string): Promise<void> => {
      this.secureStorageEntries.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      this.secureStorageEntries.delete(key);
    },
  };

  readonly tokenStore: ITokenStore = {
    get: async (): Promise<StoredAuthTokens | null> => {
      const value = this.tokenStoreEntries.get(MOCK_TOKEN_STORE_KEY);
      return value === undefined ? null : value;
    },
    set: async (tokens: StoredAuthTokens): Promise<void> => {
      this.tokenStoreEntries.set(MOCK_TOKEN_STORE_KEY, tokens);
    },
    delete: async (): Promise<void> => {
      this.tokenStoreEntries.delete(MOCK_TOKEN_STORE_KEY);
    },
  };

  async requestHostRespawn(): Promise<void> {
    this.requestHostRespawnCalls += 1;
  }

  readonly notifications: INotificationHost = {
    show: async (
      title: string,
      body: string,
      payload: unknown,
      replaceKey: string | null,
      deliveryKey: string | null,
    ): Promise<void> => {
      this.notificationsSent.push({
        title,
        body,
        payload,
        replaceKey,
        deliveryKey,
      });
    },
    onClick: (handler: (payload: unknown) => void): Disposable => {
      this.notificationClickHandlers.add(handler);
      return {
        dispose: () => {
          this.notificationClickHandlers.delete(handler);
        },
      };
    },
  };

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    handler(this.localHost);
    this.localHostHandlers.add(handler);
    return {
      dispose: () => {
        this.localHostHandlers.delete(handler);
      },
    };
  }

  onSystemResumed(handler: () => void): Disposable {
    this.systemResumedHandlers.add(handler);
    return {
      dispose: () => {
        this.systemResumedHandlers.delete(handler);
      },
    };
  }

  // ---- Test/dev helpers (not part of IRunnerHost) ---------------------- //

  /**
   * Fires the payload-free browser-return signal to every `onAuthCallback`
   * subscriber, modelling the shell delivering the `traycer://` deep link when
   * the user comes back from the device-approval tab.
   */
  emitAuthCallback(): void {
    for (const handler of this.authCallbackHandlers) {
      handler();
    }
  }

  setLocalHost(snapshot: LocalHostSnapshot | null): void {
    this.localHost = snapshot;
    for (const handler of this.localHostHandlers) {
      handler(snapshot);
    }
  }

  /** Test helper: fire the OS-wake signal to every `onSystemResumed` subscriber. */
  emitSystemResumed(): void {
    for (const handler of this.systemResumedHandlers) {
      handler();
    }
  }

  setHosts(hosts: readonly HostDirectoryEntry[]): void {
    this.hosts = hosts;
  }

  setWorkspaceFolderPickerPaths(paths: readonly string[]): void {
    this.workspaceFolderPickerPaths = paths;
  }

  emitNotificationClick(payload: unknown): void {
    for (const handler of this.notificationClickHandlers) {
      handler(payload);
    }
  }
}

/**
 * In-memory `ITrayState`. Always present so `gui-app` never branches on
 * capability. `setEpics` / `setIndicator` record the last value for test
 * assertions, and `emitEpicSelected` is a test/dev helper so shared and
 * gui-app tests can drive a tray click through the mocked surface.
 */
export class MockTrayState implements ITrayState {
  epics: readonly TrayEpic[] = [];
  indicator: TrayIndicatorState = "idle";

  private readonly epicSelectedHandlers = new Set<(epicId: string) => void>();

  async setEpics(epics: readonly TrayEpic[]): Promise<void> {
    this.epics = epics;
  }

  async setIndicator(state: TrayIndicatorState): Promise<void> {
    this.indicator = state;
  }

  onEpicSelected(handler: (epicId: string) => void): Disposable {
    this.epicSelectedHandlers.add(handler);
    return {
      dispose: () => {
        this.epicSelectedHandlers.delete(handler);
      },
    };
  }

  // ---- Test/dev helper (not part of ITrayState) ----------------------- //
  emitEpicSelected(epicId: string): void {
    for (const handler of this.epicSelectedHandlers) {
      handler(epicId);
    }
  }
}

/**
 * In-memory `ITraycerCli` for tests and dev shells. Mirrors what the real
 * desktop CLI surfaces: a host-status snapshot, an effective shell config,
 * and a flat env-override map. Mutations replace the in-memory state in-place
 * - no subprocess, no SQLite - so tests can preload deterministic responses
 * and assert renderer behaviour without standing up a host.
 */
export class MockTraycerCli implements ITraycerCli {
  hostStatusSnapshot: TraycerHostStatusSnapshot = {
    running: false,
    pidMetadata: null,
    bootstrapMarkers: [],
    bootstrapLogPath: "/mock/bootstrap.log",
    bootstrapLogTail: "",
  };
  shellConfig: TraycerShellConfig = {
    path: "/bin/zsh",
    args: ["-i", "-l"],
    synthesised: true,
  };
  envOverrides: TraycerEnvOverride[] = [];
  /**
   * Remembered/customised launch specs, mirroring the store's `shell.entries`.
   * Mutated by `shellConfigAdd`/`Remove`/`Set`; drives the "added" rows and the
   * per-shell flags a pick materialises.
   */
  shellEntries: { path: string; args: readonly string[] | null }[] = [];
  detectedShells: readonly TraycerDetectedShell[] = [
    {
      name: "zsh",
      path: "/bin/zsh",
      isDefault: true,
      source: "detected",
      missing: false,
    },
    {
      name: "bash",
      path: "/bin/bash",
      isDefault: false,
      source: "detected",
      missing: false,
    },
  ];
  /**
   * Filesystem the mock probe answers against - absolute paths mapped to
   * whether they're executable. A missing entry probes as "not found".
   */
  probeFs: ReadonlyMap<string, boolean> = new Map([
    ["/bin/zsh", true],
    ["/bin/bash", true],
    ["/usr/local/bin/nu", true],
    ["/etc/hosts", false],
  ]);
  /** Path the next `pickShellProgramFile` resolves with, or null to cancel. */
  pickedProgramFile: string | null = null;
  /** Last bearer seeded via `cliLogin`, so tests can assert it was forwarded. */
  lastLoginToken: string | null = null;
  /** Last refresh token seeded via `cliLogin`, so tests can assert it too. */
  lastLoginRefreshToken: string | null = null;

  async hostStatus(): Promise<TraycerHostStatusSnapshot> {
    return this.hostStatusSnapshot;
  }

  async shellConfigGet(): Promise<TraycerShellConfig> {
    return this.shellConfig;
  }

  /** The resolved (materialised) args for `path`: its deviation, else default. */
  private resolvedArgsFor(path: string): string[] {
    const deviation = this.shellEntries.find((e) => e.path === path)?.args;
    return deviation != null ? [...deviation] : [...defaultShellArgs(path)];
  }

  /** Upsert an entry, canonicalising family-default args to a null deviation. */
  private upsertEntry(path: string, args: readonly string[] | null): void {
    const canonical =
      args !== null && !sameFlags(args, defaultShellArgs(path))
        ? [...args]
        : null;
    this.shellEntries = [
      ...this.shellEntries.filter((entry) => entry.path !== path),
      { path, args: canonical },
    ];
  }

  async shellConfigSet(input: TraycerShellConfigSetInput): Promise<void> {
    if (input.args !== null) {
      // Flag customisation: upsert the entry for the effective shell. While on
      // the system default (no explicit selection), keep `synthesised` so the
      // System default row stays checked and the login shell inherits the entry.
      const inAutoState = input.path === null && this.shellConfig.synthesised;
      const effectivePath = input.path ?? this.shellConfig.path;
      this.upsertEntry(effectivePath, input.args);
      this.shellConfig = {
        path: effectivePath,
        args: input.args,
        synthesised: inAutoState,
      };
      return;
    }
    if (input.path !== null) {
      // Picking a shell: materialise its args (entry's, else family default),
      // remember nothing new.
      this.shellConfig = {
        path: input.path,
        args: this.resolvedArgsFor(input.path),
        synthesised: false,
      };
    }
  }

  async shellConfigReset(): Promise<void> {
    // Reset only clears the selection - it returns to the login shell and
    // inherits that shell's entry flags. Entries are untouched.
    const loginShell = "/bin/zsh";
    this.shellConfig = {
      path: loginShell,
      args: this.resolvedArgsFor(loginShell),
      synthesised: true,
    };
  }

  async shellConfigAdd(input: { readonly path: string }): Promise<void> {
    // A freshly-added program runs factory flags: canonicalises to a null
    // deviation, while the mirror materialises the resolved default args.
    this.upsertEntry(input.path, defaultShellArgs(input.path));
    this.shellConfig = {
      path: input.path,
      args: [...defaultShellArgs(input.path)],
      synthesised: false,
    };
  }

  async shellConfigRemove(input: { readonly path: string }): Promise<void> {
    const wasAdded = this.shellEntries.some(
      (entry) => entry.path === input.path,
    );
    if (!wasAdded) return;
    const wasSelected = this.shellConfig.path === input.path;
    this.shellEntries = this.shellEntries.filter(
      (entry) => entry.path !== input.path,
    );
    if (wasSelected) await this.shellConfigReset();
  }

  async shellRevertArgs(input: { readonly path: string }): Promise<void> {
    const entry = this.shellEntries.find((e) => e.path === input.path);
    if (entry === undefined) return; // no entry: no-op, remember nothing new
    this.shellEntries = this.shellEntries.map((e) =>
      e.path === input.path ? { path: e.path, args: null } : e,
    );
    // Re-materialise the mirror when the reverted shell is the selected one
    // (preserving `synthesised` so the System default row stays checked).
    if (this.shellConfig.path === input.path) {
      this.shellConfig = {
        ...this.shellConfig,
        args: [...defaultShellArgs(input.path)],
      };
    }
  }

  async shellProbe(input: {
    readonly path: string;
  }): Promise<TraycerShellProbeResult> {
    const executable = this.probeFs.get(input.path);
    return {
      exists: executable !== undefined,
      executable: executable === true,
    };
  }

  pickShellProgramFile: (() => Promise<string | null>) | null = () =>
    Promise.resolve(this.pickedProgramFile);

  async shellListDetected(): Promise<readonly TraycerDetectedShell[]> {
    const added: TraycerDetectedShell[] = this.shellEntries
      .filter(
        (entry) => !this.detectedShells.some((d) => d.path === entry.path),
      )
      .map((entry) => ({
        name: entry.path.split(/[\\/]/).pop() ?? entry.path,
        path: entry.path,
        isDefault: false,
        source: "added" as const,
        // A remembered path whose file is absent from `probeFs` lists as
        // missing, mirroring the protocol store's list-time `F_OK` probe.
        missing: !this.probeFs.has(entry.path),
      }));
    return [...this.detectedShells, ...added];
  }

  async envOverrideList(): Promise<readonly TraycerEnvOverride[]> {
    return this.envOverrides;
  }

  async envOverrideSet(input: {
    readonly key: string;
    readonly value: string | null;
  }): Promise<void> {
    const filtered = this.envOverrides.filter((row) => row.key !== input.key);
    filtered.push({
      key: input.key,
      value: input.value,
    });
    this.envOverrides = filtered;
  }

  async envOverrideDelete(input: { readonly key: string }): Promise<void> {
    this.envOverrides = this.envOverrides.filter(
      (row) => row.key !== input.key,
    );
  }

  async cliLogin(token: string, refreshToken: string): Promise<void> {
    this.lastLoginToken = token;
    this.lastLoginRefreshToken = refreshToken;
  }

  async cliLogout(): Promise<void> {
    this.lastLoginToken = null;
    this.lastLoginRefreshToken = null;
  }
}

/**
 * Default `/device/authorize` response handed back by `MockDeviceFlowHost`.
 * `user_code` is the plan's grouped Crockford shape; the URIs/timings are
 * representative so progress/expiry UI and timeout scoping can be exercised.
 */
const MOCK_DEVICE_AUTHORIZATION: DeviceFlowAuthorization = {
  userCode: "ABCDE-FGHIJ",
  verificationUri: "https://app.traycer.ai/device",
  verificationUriComplete:
    "https://app.traycer.ai/device?user_code=ABCDE-FGHIJ",
  expiresInSeconds: 600,
  intervalSeconds: 5,
};

/**
 * In-memory `IDeviceFlowHost`. `start()` hands back a `MockDeviceFlowSession`
 * carrying `nextAuthorization`; set `nextAuthorization = null` to simulate an
 * authorize failure (the real shell returns `null` on network/5xx). Tests drive
 * the terminal outcome with `emitResult(...)` and assert supersede behaviour via
 * `lastSession.cancelled`.
 */
export class MockDeviceFlowHost implements IDeviceFlowHost {
  startCalls = 0;
  nextAuthorization: DeviceFlowAuthorization | null = MOCK_DEVICE_AUTHORIZATION;
  readonly sessions: MockDeviceFlowSession[] = [];

  async start(): Promise<DeviceFlowSession | null> {
    this.startCalls += 1;
    if (this.nextAuthorization === null) {
      return null;
    }
    const session = new MockDeviceFlowSession(this.nextAuthorization);
    this.sessions.push(session);
    return session;
  }

  get lastSession(): MockDeviceFlowSession | null {
    return this.sessions.length === 0
      ? null
      : this.sessions[this.sessions.length - 1];
  }

  /** Test helper: emit the terminal result to the most recent session. */
  emitResult(result: DeviceFlowResult): void {
    this.lastSession?.emit(result);
  }
}

export class MockDeviceFlowSession implements DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization;
  cancelled = false;
  /** Test counter: how many times the browser-return nudge poked this poll. */
  pollNowCalls = 0;
  // The terminal result is cached for the session's lifetime so every
  // subscriber - late or repeat - replays it, matching the
  // `DeviceFlowSession.onResult` contract (the desktop preload caches likewise).
  private settledResult: DeviceFlowResult | null = null;
  private readonly handlers = new Set<(result: DeviceFlowResult) => void>();

  constructor(authorization: DeviceFlowAuthorization) {
    this.authorization = authorization;
  }

  pollNow(): void {
    this.pollNowCalls += 1;
  }

  onResult(handler: (result: DeviceFlowResult) => void): Disposable {
    // Replay the settled result to a subscription that arrives after the
    // attempt has already concluded (cached, not consumed - a second
    // subscriber still sees it).
    if (this.settledResult !== null) {
      handler(this.settledResult);
      return { dispose: () => undefined };
    }
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.handlers.clear();
  }

  emit(result: DeviceFlowResult): void {
    if (this.cancelled || this.settledResult !== null) {
      return;
    }
    this.settledResult = result;
    for (const handler of this.handlers) {
      handler(result);
    }
    this.handlers.clear();
  }
}

/**
 * In-memory `IHostPicker`. Tracks open/closed state and fires `onChange`
 * on every transition; `gui-app` tests drive open/close via the public
 * request methods, mirroring the real shell contract.
 */
export class MockHostPicker implements IHostPicker {
  private open = false;
  private readonly handlers = new Set<(isOpen: boolean) => void>();

  get isOpen(): boolean {
    return this.open;
  }

  requestOpen(): void {
    if (this.open) {
      return;
    }
    this.open = true;
    this.emit();
  }

  requestClose(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.emit();
  }

  onChange(handler: (isOpen: boolean) => void): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  private emit(): void {
    for (const handler of this.handlers) {
      handler(this.open);
    }
  }
}
