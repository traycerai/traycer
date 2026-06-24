import type { Disposable } from "../../platform/uri-callback";
import type {
  AuthCallbackResult,
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
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
  TrayEpic,
  TrayIndicatorState,
} from "../../platform/runner-host";
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
  }> = [];
  readonly secureStorageEntries: Map<string, string> = new Map();
  readonly tokenStoreEntries: Map<string, StoredAuthTokens> = new Map();
  workspaceFolderPickerPaths: readonly string[];
  hosts: readonly HostDirectoryEntry[];

  private readonly authCallbackHandlers = new Set<
    (result: AuthCallbackResult) => void
  >();
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
  };
  readonly service: null = null;
  readonly traycerCli: ITraycerCli | null;
  readonly migration: null = null;
  readonly hostManagement: IHostManagement | null;
  readonly hostTray: null = null;

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

  /** Last (code, verifier) passed to exchangeAuthCode, for test assertions. */
  lastExchange: { code: string; codeVerifier: string } | null = null;

  async exchangeAuthCode(
    code: string,
    codeVerifier: string,
  ): Promise<StoredAuthTokens | null> {
    this.lastExchange = { code, codeVerifier };
    // Deterministic test double: treat the code as the bearer so a test that
    // emits `{ code: "X" }` ends up signed in with token "X" (the same shape
    // the pre-PKCE `{ token: "X" }` callback produced). The real HTTP exchange
    // is covered by the shared/authn tests.
    return { token: code, refreshToken: `${code}-refresh` };
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

  onAuthCallback(handler: (result: AuthCallbackResult) => void): Disposable {
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
    ): Promise<void> => {
      this.notificationsSent.push({ title, body, payload });
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

  // Test convenience: `refreshToken` defaults so existing `{ token }` call sites
  // stay valid while the real `AuthCallbackResult` requires both fields.
  emitAuthCallback(result: AuthCallbackResult): void {
    for (const handler of this.authCallbackHandlers) {
      handler(result);
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
  detectedShells: readonly TraycerDetectedShell[] = [
    { name: "zsh", path: "/bin/zsh", isDefault: true },
    { name: "bash", path: "/bin/bash", isDefault: false },
  ];
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

  async shellConfigSet(input: TraycerShellConfigSetInput): Promise<void> {
    this.shellConfig = {
      path: input.path ?? this.shellConfig.path,
      args: input.args !== null ? input.args : this.shellConfig.args,
      synthesised: false,
    };
  }

  async shellConfigReset(): Promise<void> {
    this.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
  }

  async shellListDetected(): Promise<readonly TraycerDetectedShell[]> {
    return this.detectedShells;
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
