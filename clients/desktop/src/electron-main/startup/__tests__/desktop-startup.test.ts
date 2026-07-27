import { describe, expect, it, vi } from "vitest";
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
// `runDesktopStartup`/`runOnReady`/`runWindowPhase`/`runDeferred`, none of
// which this suite invokes. Every one of those sibling imports is stubbed
// below so the module loads without touching real Electron APIs, real
// filesystem state, or third-party SDKs (e.g. `@sentry/electron`, pulled in
// transitively by `../app/diagnostics`) - only `electron` itself and
// `../windows/window-registry` need to behave like the real thing, and
// `window-registry` is left completely real.

vi.mock("electron", () => ({
  app: {
    getName: () => "Traycer",
    getPath: () => "/tmp",
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    dock: null,
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
  createMainWindow: () => ({}),
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
vi.mock("../../auth/desktop-auth-session", () => ({
  DesktopAuthSession: class {},
}));
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
  initCrashReporter: () => undefined,
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
  registerAppScheme: () => undefined,
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
}));
vi.mock("../../app/update-preferences", () => ({
  hydrateUpdatePreferences: () => Promise.resolve({}),
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
  it("focuses the most-recently-used window, not the first- or last-inserted one", async () => {
    const { createMruWindowProxy } = await import("../desktop-startup");

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
    const { createMruWindowProxy } = await import("../desktop-startup");

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
