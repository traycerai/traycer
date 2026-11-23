import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  hostSignInKey,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { mintHostTokenViaHttp } from "@traycer-clients/shared/host-transport/remote/grant-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import {
  makeStubSocketFactory,
  type StubStreamWebSocket,
} from "@traycer-clients/shared/host-transport/__testing__/stub-stream-socket";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  WindowRegistry,
  type RegistryManagedWindow,
} from "../../windows/window-registry";

// `createMruWindowProxy` is the real, exported production proxy that backs
// both the tray ("Open Traycer") and the global summon shortcut (decision 10
// in the tech plan: the summon action resolves via `focusMru()`, not the
// registry's first-inserted record). Prior review coverage rebuilt an
// identical-looking copy of this proxy rather than importing it, so breaking
// the real wiring or the real proxy wouldn't have failed that test. This
// suite imports the genuine `desktop-startup.ts` module and drives the real
// proxy against a real `WindowRegistry`.
//
// `desktop-startup.ts` is the Electron main-process boot sequence: importing
// it pulls in ~40 sibling modules (tray, updater, host lifecycle, IPC,
// crash reporting, ...) that are only ever called from inside
// `runDesktopStartup`/`runOnReady`/`runWindowPhase`/`runDeferred`/`runPreReady`,
// none of which this suite invokes end-to-end (the "runPreReady - scheme/
// crash-reporter ordering" suite below calls the real `runPreReady()`
// directly, but only to assert call order on two already-stubbed sibling
// mocks). Every one of those sibling imports is stubbed below so the module
// loads without touching real Electron APIs, real filesystem state, or
// third-party SDKs (e.g. `@sentry/electron`, pulled in transitively by
// `../app/diagnostics`) - only `electron` itself and
// `../windows/window-registry` need to behave like the real thing, and
// `window-registry` is left completely real.

vi.mock("electron", () => ({
  app: {
    getName: () => "Traycer",
    getPath: () => "/tmp",
    getVersion: () => "0.0.0-test",
    on: () => undefined,
    exit: () => undefined,
    whenReady: () => Promise.resolve(),
    dock: null,
  },
  dialog: {
    showErrorBox: () => undefined,
    showMessageBox: () => Promise.resolve({ response: 0 }),
  },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
}));

vi.mock("../../app/about", () => ({
  configureNativeAboutPanel: () => undefined,
}));
vi.mock("../../app/jumplist-commands", () => ({
  findJumplistCommandInArgv: () => null,
  registerJumplistCommandHandling: () => undefined,
}));
vi.mock("../../auth/deep-link", () => ({
  registerDeepLinkHandling: () => undefined,
}));
vi.mock("../../windows/window-factory", () => ({
  createMainWindow: () => ({
    on: () => undefined,
    webContents: { id: 1 },
  }),
  loadMainWindow: () => Promise.resolve(),
}));
vi.mock("../../tray/tray", () => ({
  DesktopTrayController: class {},
  resolveTrayIconPath: () => "",
  buildTrayAssetContext: () => ({}),
  loadTrayIconImage: () => Promise.resolve({}),
}));
vi.mock("../../host/host-lifecycle", () => ({
  HostLifecycle: class {
    on(): void {}
    bootstrap(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock("../../host/host-paths", () => ({
  getHostFsLayout: () => ({}),
  labelForEnvironment: () => "",
}));
vi.mock("../../ipc/host-management-ipc", () => ({
  onHostRegistryUpdateStateChange: () => () => undefined,
  refreshRegistryUpdateState: () => Promise.resolve({}),
  setActiveEnvironment: () => undefined,
}));
vi.mock("../../host/host-auto-update", () => ({
  defaultHostAutoUpdateDeps: () => ({}),
  reconcileHostAutoUpdate: () => Promise.resolve("noop"),
  LAUNCH_HOST_UPDATE_TIMEOUT_MS: 1000,
  QUIT_HOST_UPDATE_TIMEOUT_MS: 1000,
}));
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => Promise.resolve(false),
}));
vi.mock("../update-install-quit", () => ({
  runUpdateInstallQuitSequence: () => undefined,
}));
vi.mock("../../ipc/register-runner-ipc", () => ({
  RunnerIpcBridge: class {
    disposeFns: Array<() => void> = [];
    install(): void {}
    fanOut(): void {}
    dispose(): void {}
  },
}));
vi.mock("../../app/updater", () => ({
  checkForUpdatesAfterResume: () => undefined,
  checkForUpdatesNow: () => Promise.resolve(),
  installAutoUpdater: () => Promise.resolve(),
  isInstallingUpdate: () => false,
}));
vi.mock("../../app/relocate-to-applications", () => ({
  isUpdateBlockedByLocation: () => false,
  maybePromptRelocateToApplications: () => Promise.resolve(),
  UPDATE_BLOCKED_LOCATION_REASON: "blocked",
}));
vi.mock("../../windows/desktop-state-store", () => ({
  DesktopStateStore: class {
    load(): Promise<void> {
      return Promise.resolve();
    }
    getRestorableWindowEntries(): ReadonlyArray<unknown> {
      return [];
    }
  },
  resolveDesktopStateFilePath: () => "/tmp/state.json",
}));
vi.mock("../../windows/window-zoom", () => ({
  createWindowZoomController: () => ({ getZoomFactor: () => 1 }),
  loadInitialZoomPercentSync: () => 100,
  zoomPercentToFactor: () => 1,
}));
vi.mock("../../windows/window-geometry", () => ({
  createWindowGeometryPersistence: () => ({
    flushLatest: () => Promise.resolve(),
  }),
  createWindowGeometryStore: () => ({}),
  installPrimaryWindowGeometryPersistence: () => undefined,
  loadInitialWindowGeometrySync: () => null,
  resolvePrimaryWindowPlacement: () => ({}),
  resolveSecondaryWindowPlacement: () => ({}),
}));
vi.mock("../../windows/epic-window-ownership", () => ({
  EpicWindowOwnership: class {},
}));
vi.mock("../../windows/per-window-state", () => ({
  PerWindowState: class {},
}));
interface StartupAuthSnapshot {
  readonly status: "signed-in" | "signed-out" | "signing-in" | "unverified";
  readonly token: string | null;
  readonly profile: {
    readonly userId: string;
    readonly userName: string;
    readonly email: string;
  } | null;
}

const capturedAuthSessions = vi.hoisted(() => {
  const sessions: Array<{
    set(snapshot: StartupAuthSnapshot): void;
    setVerified(snapshot: StartupAuthSnapshot, generation: number): boolean;
    beginSet(): number;
  }> = [];
  return { sessions };
});

// The sources `runDesktopStartup` built, and whether the next startup builds
// its credentials store (so it runs on to the lifecycle policy store) or
// stops at it, as every other case here wants.
const startupWiring = vi.hoisted(() => ({
  hostTokenSources: [] as Array<
    import("@traycer-clients/shared/auth/host-token-source").HostTokenSource
  >,
  constructCredentialsStore: false,
}));

vi.mock("../../auth/desktop-auth-session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auth/desktop-auth-session")>();
  return {
    ...actual,
    DesktopAuthSession: class extends actual.DesktopAuthSession {
      constructor() {
        super();
        capturedAuthSessions.sessions.push(this);
      }
    },
  };
});
vi.mock("../../app/support", () => ({
  DesktopSupportService: class {},
}));
vi.mock("../../menu/menu-controller", () => ({
  MenuController: class {
    install(): void {}
    dispose(): void {}
  },
}));
vi.mock("../window-initial-route", () => ({
  initialRouteForWindowSnapshot: () => null,
}));
vi.mock("../shell-quit-state", () => ({
  ShellQuitState: class {
    markQuitting(): void {}
    resetQuitting(): void {}
  },
}));
vi.mock("../activate-window-plan", () => ({
  planActivateWithoutLiveWindow: () => ({ kind: "blank" }),
}));
vi.mock("../../windows/resolution-test-env", () => ({
  readResolutionTestDisplay: () => null,
}));
vi.mock("../../notifications", () => ({
  installNotificationActivationHandler: () => undefined,
}));
vi.mock("../../app/crash-reporter", () => ({
  initCrashReporter: vi.fn(),
  installGlobalErrorHandlers: () => undefined,
  installProcessGoneListeners: () => undefined,
  logGpuInfo: () => undefined,
}));
vi.mock("../../app/core-dump-guard", () => ({
  suppressWslKernelCoreDumps: () => undefined,
}));
vi.mock("../../app/crash-dump-prune", () => ({
  pruneStaleCrashDumps: () => Promise.resolve(),
}));
vi.mock("../../app/diagnostics", () => ({
  startRendererMemorySampler: () => undefined,
}));
vi.mock("../../app/lifecycle", () => ({
  configureAppUserModelId: () => undefined,
  configureV8CodeCache: () => undefined,
  configureV8HeapSize: () => undefined,
  installPowerMonitorListeners: () => undefined,
  trimUnusedChromiumFeatures: () => undefined,
}));
vi.mock("../../app/proxy-auth", () => ({
  installProductionProxyAuthHandler: () => undefined,
}));
vi.mock("../../app/cert-trust", () => ({
  installCertificateErrorHandler: () => undefined,
  setPendingCertificateEmitter: () => undefined,
}));
vi.mock("../../app/app-protocol", () => ({
  installAppProtocolHandler: () => undefined,
  registerAppScheme: vi.fn(),
}));
vi.mock("../../app/sandbox-protocol", () => ({
  installSandboxProtocolHandler: () => undefined,
}));
vi.mock("../../app/gpu-acceleration", () => ({
  applyHardwareAccelerationPreference: () => undefined,
}));
vi.mock("../../app/host-resolver", () => ({
  configureHostResolverDoH: () => undefined,
}));
vi.mock("../../app/network", () => ({
  configureUserAgent: () => undefined,
  preconnectTraycerHosts: () => undefined,
}));
vi.mock("../../app/screen-monitor", () => ({
  installScreenMonitor: () => undefined,
  readDisplayTopology: () => ({ displays: [] }),
}));
vi.mock("../../app/security", () => ({
  hardenDefaultSession: () => undefined,
}));
vi.mock("../../app/shortcuts", () => ({
  getRegisteredAccelerator: () => null,
  initGlobalShortcutsRegistry: () => undefined,
  onGlobalShortcutsChange: () => () => undefined,
  reconcileGlobalShortcuts: () =>
    Promise.resolve({ sequence: 0, statuses: {} }),
}));
vi.mock("../../app/global-shortcuts-preferences", () => ({
  hydrateGlobalShortcutIntents: () => Promise.resolve({}),
}));
vi.mock("../../app/spell-check", () => ({
  enableSpellCheck: () => undefined,
}));
vi.mock("../../app/recent-documents", () => ({
  installWindowsJumplistTasks: () => undefined,
}));
vi.mock("../../app/resilience", () => ({
  installAccessibilityThemeForwarder: () => undefined,
  installDownloadObserver: () => undefined,
}));
vi.mock("../../cli/cli-reconcile", () => ({
  defaultReconcileCliDeps: () => ({}),
  runLaunchTimeCliReconciliation: () => Promise.resolve({ kind: "noop" }),
}));
vi.mock("../../../ipc-contracts/ipc-channels", () => ({
  RunnerHostEvent: {},
}));
vi.mock("../../config/desktop-config", () => ({
  resolveDesktopConfig: () => ({
    environment: "dev",
    isDev: true,
    iconPath: "",
    preloadPath: "",
    authnBaseUrl: "",
  }),
}));
vi.mock("../host-wake-recovery", () => ({
  installHostWakeRecovery: () => undefined,
}));
vi.mock("../../host/host-health-monitor", () => ({
  startHostHealthMonitor: () => ({ dispose: () => undefined }),
}));
vi.mock("../../host/pending-login-item-revision-monitor", () => ({
  startPendingLoginItemRevisionMonitor: () => ({ dispose: () => undefined }),
}));
vi.mock("../../app/host-login-item", () => ({
  hostManagesHostLoginItem: () => Promise.resolve(false),
}));
vi.mock("../../../config", () => ({
  DESKTOP_APP_NAME: "Traycer",
  isDevBuild: true,
}));
vi.mock("../../app/update-preferences", () => ({
  hydrateUpdatePreferences: () => Promise.resolve({}),
}));
vi.mock("@traycer-clients/shared/host-lock/data-migration-admission", () => ({
  admitClientProcess: () => Promise.resolve({ kind: "admitted" }),
}));
vi.mock("@traycer/protocol/config/data-root", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer/protocol/config/data-root")>();
  return {
    ...actual,
    currentDataRootResolution: () => ({
      kind: "default" as const,
      root: "/tmp/traycer-test-data-root",
    }),
  };
});
vi.mock(
  "@traycer/protocol/config/data-root-default-check",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer/protocol/config/data-root-default-check")
      >();
    return {
      ...actual,
      inspectDefaultDataRoot: () => ({ kind: "none" as const }),
    };
  },
);
vi.mock("../../auth/file-token-store", () => ({
  FileTokenStore: class {
    constructor() {
      if (!startupWiring.constructCredentialsStore) {
        throw new Error("stop-after-released-host-listener");
      }
    }
  },
}));
vi.mock("../../host/host-lifecycle-policy", () => ({
  HostLifecyclePolicyStore: class {
    constructor() {
      throw new Error("stop-after-host-token-source");
    }
  },
}));
vi.mock(
  "@traycer-clients/shared/auth/host-token-source",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-source")
      >();
    return {
      ...actual,
      createHostTokenSource: (
        deps: Parameters<typeof actual.createHostTokenSource>[0],
      ) => {
        const source = actual.createHostTokenSource(deps);
        startupWiring.hostTokenSources.push(source);
        return source;
      },
    };
  },
);
vi.mock("@traycer-clients/shared/auth/host-token-file", async () => {
  const { createMemoryHostTokenPersistence } =
    await import("@traycer-clients/shared/auth/host-token-source");
  return { createHostTokenFilePersistence: createMemoryHostTokenPersistence };
});
vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return { ...actual, mintHostTokenViaHttp: vi.fn() };
  },
);
vi.mock("../../browser-view/storage/browser-saved-logins", () => ({
  browserSavedLoginsFilePath: () => "/tmp/browser-saved-logins.json",
  initBrowserSavedLogins: () => Promise.resolve(),
}));
vi.mock("../../browser-view/storage/browser-forget-ledger", () => ({
  browserForgetLedgerFilePath: () => "/tmp/browser-forget-ledger.json",
  initBrowserForgetLedger: () => Promise.resolve(),
}));
vi.mock("../../host/host-key-pins", () => ({
  installDesktopHostKeyPins: () => undefined,
  setHostKeyPinMismatchEmitter: () => undefined,
}));

class FakeRegistryWindow implements RegistryManagedWindow {
  readonly webContents: { readonly id: number };
  private readonly listeners = new Map<string, Set<() => void>>();
  private destroyed = false;
  private visible = false;
  private minimized = false;
  focusCalls = 0;
  showCalls = 0;
  restoreCalls = 0;

  constructor(webContentsId: number) {
    this.webContents = { id: webContentsId };
  }

  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }
  focus(): void {
    this.focusCalls += 1;
    this.emit("focus");
  }
  getTitle(): string {
    return "";
  }
  isMaximized(): boolean {
    return false;
  }
  minimize(): void {
    this.minimized = true;
  }
  maximize(): void {}
  unmaximize(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFocused(): boolean {
    return false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  show(): void {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }
  restore(): void {
    this.restoreCalls += 1;
    this.minimized = false;
  }
  on(event: string, listener: () => void): void {
    const bucket = this.listeners.get(event) ?? new Set<() => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }
  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

describe("createMruWindowProxy (decision 10) - real production proxy", () => {
  let createMruWindowProxy: (typeof import("../desktop-startup"))["createMruWindowProxy"];

  // The first import of `desktop-startup` loads its whole sibling module
  // graph, which can outlast the default 5 s test timeout on a loaded machine
  // (about 160 ms unloaded). 30 s is roughly 200x the unloaded load, so only
  // a hung import, not machine load, can reach it.
  beforeAll(async () => {
    ({ createMruWindowProxy } = await import("../desktop-startup"));
  }, 30_000);

  it("focuses the most-recently-used window, not the first- or last-inserted one", async () => {
    let nextWebContentsId = 1;
    const created: FakeRegistryWindow[] = [];
    const registry = new WindowRegistry<FakeRegistryWindow>({
      createWindow: () => {
        const window = new FakeRegistryWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async () => undefined,
    });

    const windowA = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    const windowC = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    const windowB = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    const [fakeA, fakeC, fakeB] = created;

    // Insertion order is A (first), C, B (last). Focus A, then B, then C
    // last, so the final MRU is C - neither the first-inserted window (A)
    // nor the last-inserted one (B), so only real MRU tracking explains
    // focusing C here.
    registry.focusById(windowA);
    registry.focusById(windowB);
    registry.focusById(windowC);
    expect(registry.mostRecentlyFocusedId()).toBe(windowC);

    const proxy = createMruWindowProxy(registry);

    const focusCallsBefore = {
      a: fakeA.focusCalls,
      b: fakeB.focusCalls,
      c: fakeC.focusCalls,
    };
    proxy.focus();

    expect(fakeC.focusCalls).toBe(focusCallsBefore.c + 1);
    expect(fakeA.focusCalls).toBe(focusCallsBefore.a);
    expect(fakeB.focusCalls).toBe(focusCallsBefore.b);
  });

  it("reflects the current MRU window's live visibility/minimized state and reports destroyed once nothing is registered", async () => {
    let nextWebContentsId = 100;
    const registry = new WindowRegistry<FakeRegistryWindow>({
      createWindow: () => {
        const window = new FakeRegistryWindow(nextWebContentsId);
        nextWebContentsId += 1;
        return window;
      },
      loadWindow: async () => undefined,
    });

    const proxy = createMruWindowProxy(registry);
    expect(proxy.isDestroyed()).toBe(true);

    const windowId = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    expect(proxy.isDestroyed()).toBe(false);
    expect(proxy.isVisible()).toBe(false);

    proxy.show();
    expect(proxy.isVisible()).toBe(true);

    await registry.closeById(windowId);
    expect(proxy.isDestroyed()).toBe(true);
  });
});

describe("runPreReady - scheme/crash-reporter ordering", () => {
  it("registers the crash reporter before the app scheme, so Sentry's raw protocol.registerSchemesAsPrivileged call cannot discard app's privileges", async () => {
    const { runPreReady } = await import("../desktop-startup");
    const { initCrashReporter } = await import("../../app/crash-reporter");
    const { registerAppScheme } = await import("../../app/app-protocol");
    const { SandboxArtifactServer } =
      await import("../../app/sandbox-artifact-server");
    // Other cases in this file run the real startup, which calls both too.
    vi.mocked(initCrashReporter).mockClear();
    vi.mocked(registerAppScheme).mockClear();

    runPreReady({
      sandboxArtifacts: new SandboxArtifactServer(() => false),
      config: {
        environment: "dev",
        isDev: true,
        iconPath: "",
        preloadPath: "",
        authnBaseUrl: "",
      },
      pendingAuthReturnSignal: false,
      bridge: null,
    });

    expect(initCrashReporter).toHaveBeenCalledTimes(1);
    expect(registerAppScheme).toHaveBeenCalledTimes(1);
    const crashReporterOrder =
      vi.mocked(initCrashReporter).mock.invocationCallOrder[0];
    const appSchemeOrder =
      vi.mocked(registerAppScheme).mock.invocationCallOrder[0];
    expect(crashReporterOrder).toBeLessThan(appSchemeOrder);
  });
});

const RELEASED_HOST_ID = "desktop-startup-released-host";
const PROBE_DECLINE_HOST_ID = "desktop-startup-probe-decline-host";
const RELEASED_USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const RELEASED_HOST_TOKEN = "desktop-host-token";
const RELEASED_SIGN_IN = "desktop-person-sign-in";
const RELEASED_WAIT = { timeout: 2_000, interval: 10 };
const startupClients: WsStreamClient<typeof hostStreamRpcRegistry>[] = [];

function startupReleasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function startupProbeDeclined(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "the host has not admitted this sign-in",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function readStartupFrame(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frame was not an object");
  }
  const frame: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    frame[key] = entry;
  }
  return frame;
}

function openStartupStream(
  hostToken: string | null,
  hostId: string,
): {
  readonly sockets: StubStreamWebSocket[];
  readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
} {
  const { factory, sockets } = makeStubSocketFactory();
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => ({
      hostId,
      websocketUrl: "ws://127.0.0.1:9/rpc",
    }),
    hostId,
    bearer: () =>
      hostToken === null
        ? null
        : new MutableBearerLease(hostToken, RELEASED_USER_ID),
    userId: RELEASED_USER_ID,
    releasedSignOn: {
      signIn: () => new MutableBearerLease(RELEASED_SIGN_IN, RELEASED_USER_ID),
      recovery: null,
      hostTokenUnobtainable: () => hostToken === null,
      ownerSignInEligible: () => hostToken === null,
      heldTokenRefused: () => false,
      forgetHeldRefusal: () => undefined,
      mayPresentSignIn: () => true,
      hosts: processReleasedHosts,
    },
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
  startupClients.push(client);
  client.subscribe("git.subscribeStatus", {
    hostId,
    runningDir: "/repo",
    ignoreWhitespace: false,
    freshNonce: null,
  });
  return { sockets, client };
}

async function openStartupFrame(
  socket: StubStreamWebSocket,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThan(0),
    RELEASED_WAIT,
  );
  return readStartupFrame(socket.textSent[0]);
}

async function admitStartupSignIn(): Promise<void> {
  const { sockets } = openStartupStream(RELEASED_HOST_TOKEN, RELEASED_HOST_ID);
  await vi.waitFor(
    () => expect(sockets.length).toBeGreaterThanOrEqual(1),
    RELEASED_WAIT,
  );
  const first = sockets[0];
  if (first === undefined) throw new Error("host-token dial missing");
  const refused = await openStartupFrame(first);
  expect(refused.token).toBe(RELEASED_HOST_TOKEN);
  first.fireText(startupReleasedRefusal());
  await vi.waitFor(
    () => expect(sockets.length).toBeGreaterThanOrEqual(2),
    RELEASED_WAIT,
  );
  const second = sockets[1];
  if (second === undefined) throw new Error("sign-in dial missing");
  const admitted = await openStartupFrame(second);
  expect(admitted.token).toBe(RELEASED_SIGN_IN);
  second.fireText({
    kind: "openAck",
    manifest: admitted.manifest,
    capabilities: ["credentialUpdate"],
  });
}

async function firstStartupOpenToken(): Promise<unknown> {
  const { sockets } = openStartupStream(RELEASED_HOST_TOKEN, RELEASED_HOST_ID);
  await vi.waitFor(
    () => expect(sockets.length).toBeGreaterThanOrEqual(1),
    RELEASED_WAIT,
  );
  const socket = sockets[0];
  if (socket === undefined) throw new Error("dial missing");
  const opened = await openStartupFrame(socket);
  return opened.token;
}

describe("released host memory across a desktop sign-out", () => {
  afterEach(() => {
    for (const client of startupClients.splice(0)) client.close("test-done");
    processReleasedHosts.forgetAll();
    capturedAuthSessions.sessions.splice(0);
    resetNegotiatedStreamVersions();
    resetNegotiatedManifests();
    vi.useRealTimers();
  });

  it("starts the next dial with the host-only token after the auth session signs out", async () => {
    await admitStartupSignIn();
    const startup = import("../desktop-startup").then((mod) =>
      mod.runDesktopStartup(),
    );
    await expect(startup).rejects.toThrow("stop-after-released-host-listener");
    const session = capturedAuthSessions.sessions[0];
    if (session === undefined) throw new Error("auth session missing");
    session.set({
      status: "signed-in",
      token: RELEASED_SIGN_IN,
      profile: {
        userId: RELEASED_USER_ID,
        userName: "person",
        email: "person@example.com",
      },
    });
    session.set({ status: "signed-out", token: null, profile: null });
    expect(await firstStartupOpenToken()).toBe(RELEASED_HOST_TOKEN);
  });

  it("probes again after auth-session sign-out clears a declined probe", async () => {
    const first = openStartupStream(null, PROBE_DECLINE_HOST_ID);
    await vi.waitFor(
      () => expect(first.sockets).toHaveLength(1),
      RELEASED_WAIT,
    );
    const initialProbe = first.sockets[0];
    if (initialProbe === undefined) throw new Error("probe dial missing");
    const initialOpen = await openStartupFrame(initialProbe);
    expect(initialOpen.token).toBe(NO_HOST_TOKEN_PROBE);
    initialProbe.fireText(startupProbeDeclined());
    await vi.waitFor(() =>
      expect(
        processReleasedHosts.probeDeclined(
          RELEASED_USER_ID,
          PROBE_DECLINE_HOST_ID,
        ),
      ).toBe(true),
    );
    first.client.close("probe declined");

    const startup = import("../desktop-startup").then((mod) =>
      mod.runDesktopStartup(),
    );
    await expect(startup).rejects.toThrow("stop-after-released-host-listener");
    const session = capturedAuthSessions.sessions[0];
    if (session === undefined) throw new Error("auth session missing");
    session.set({
      status: "signed-in",
      token: RELEASED_SIGN_IN,
      profile: {
        userId: RELEASED_USER_ID,
        userName: "person",
        email: "person@example.com",
      },
    });
    session.set({ status: "signed-out", token: null, profile: null });
    expect(
      processReleasedHosts.probeDeclined(
        RELEASED_USER_ID,
        PROBE_DECLINE_HOST_ID,
      ),
    ).toBe(false);
    const next = openStartupStream(null, PROBE_DECLINE_HOST_ID);
    await vi.waitFor(() => expect(next.sockets).toHaveLength(1), RELEASED_WAIT);
    const nextSocket = next.sockets[0];
    if (nextSocket === undefined) throw new Error("post-sign-out dial missing");
    expect((await openStartupFrame(nextSocket)).token).toBe(
      NO_HOST_TOKEN_PROBE,
    );
  });
});

describe("the sign-in main's host token source mints with", () => {
  const SIGN_IN = "desktop-main-verified-sign-in";
  const HOST_ID = "desktop-main-sign-in-host";
  const signedIn: StartupAuthSnapshot = {
    status: "signed-in",
    token: SIGN_IN,
    profile: {
      userId: RELEASED_USER_ID,
      userName: "person",
      email: "person@example.com",
    },
  };

  afterEach(() => {
    startupWiring.constructCredentialsStore = false;
    startupWiring.hostTokenSources.splice(0);
    capturedAuthSessions.sessions.splice(0);
    vi.mocked(mintHostTokenViaHttp).mockReset();
  });

  async function startMain(): Promise<{
    readonly session: (typeof capturedAuthSessions.sessions)[number];
    readonly source: HostTokenSource;
  }> {
    startupWiring.constructCredentialsStore = true;
    vi.mocked(mintHostTokenViaHttp).mockResolvedValue({
      kind: "ok",
      token: { token: "minted-host-token", expiresAtMs: Date.now() + 600_000 },
    });
    const { runDesktopStartup } = await import("../desktop-startup");
    await expect(runDesktopStartup()).rejects.toThrow(
      "stop-after-host-token-source",
    );
    const session = capturedAuthSessions.sessions[0];
    const source = startupWiring.hostTokenSources[0];
    if (session === undefined || source === undefined) {
      throw new Error("startup did not build the auth session and the source");
    }
    return { session, source };
  }

  const ask = { signal: null, owner: null } as const;

  it("is the sign-in main verified for that person, and the mint sends it", async () => {
    const { session, source } = await startMain();
    session.setVerified(signedIn, session.beginSet());

    expect(source.signInKey(RELEASED_USER_ID)).toBe(hostSignInKey(SIGN_IN));
    await source.obtain(RELEASED_USER_ID, HOST_ID, true, ask);
    expect(vi.mocked(mintHostTokenViaHttp).mock.calls).toEqual([
      ["", HOST_ID, SIGN_IN, null],
    ]);
  });

  it("is none for a sign-in main has not verified, and no mint is sent", async () => {
    const { session, source } = await startMain();
    session.set(signedIn);

    expect(source.signInKey(RELEASED_USER_ID)).toBeNull();
    await expect(
      source.obtain(RELEASED_USER_ID, HOST_ID, true, ask),
    ).resolves.toEqual({ kind: "no-sign-in" });
    expect(mintHostTokenViaHttp).not.toHaveBeenCalled();
  });

  it("is none for another person than the one main verified", async () => {
    const { session, source } = await startMain();
    session.setVerified(signedIn, session.beginSet());

    expect(source.signInKey("another-user")).toBeNull();
    await expect(
      source.obtain("another-user", HOST_ID, true, ask),
    ).resolves.toEqual({ kind: "no-sign-in" });
    expect(mintHostTokenViaHttp).not.toHaveBeenCalled();
  });
});
