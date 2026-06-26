import { app, nativeImage, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { initLogger, log } from "../app/logger";
import { configureNativeAboutPanel } from "../app/about";
import {
  registerDeepLinkHandling,
  type AuthCallbackParseResult,
} from "../auth/deep-link";
import {
  startLoopbackCallbackServer,
  type LoopbackCallbackServer,
} from "../auth/loopback-callback-server";
import { createMainWindow, loadMainWindow } from "../windows/window-factory";
import {
  DesktopTrayController,
  resolveTrayIconPath,
  buildTrayAssetContext,
  loadTrayIconImage,
  type TrayManagedWindow,
} from "../tray/tray";
import { HostLifecycle, type HostStartupError } from "../host/host-lifecycle";
import type { HostRegistryUpdateState } from "../../ipc-contracts/host-management-types";
import { getHostFsLayout, labelForEnvironment } from "../host/host-paths";
import {
  refreshRegistryUpdateState,
  setActiveEnvironment,
} from "../ipc/host-management-ipc";
import {
  defaultHostAutoUpdateDeps,
  reconcileHostAutoUpdate,
  LAUNCH_HOST_UPDATE_TIMEOUT_MS,
  QUIT_HOST_UPDATE_TIMEOUT_MS,
} from "../host/host-auto-update";
import { isHostRemovedByUser } from "../host/host-removal-state";
import { RunnerIpcBridge } from "../ipc/register-runner-ipc";
import {
  checkForUpdatesAfterResume,
  checkForUpdatesNow,
  installAutoUpdater,
  isInstallingUpdate,
} from "../app/updater";
import {
  isUpdateBlockedByLocation,
  maybePromptRelocateToApplications,
  UPDATE_BLOCKED_LOCATION_REASON,
} from "../app/relocate-to-applications";
import { WindowRegistry } from "../windows/window-registry";
import {
  DesktopStateStore,
  resolveDesktopStateFilePath,
} from "../windows/desktop-state-store";
import { EpicWindowOwnership } from "../windows/epic-window-ownership";
import { PerWindowState } from "../windows/per-window-state";
import { DesktopAuthSession } from "../auth/desktop-auth-session";
import { DesktopSupportService } from "../app/support";
import { MenuController } from "../menu/menu-controller";
import { initialRouteForWindowSnapshot } from "./window-initial-route";
import { installNotificationActivationHandler } from "../notifications";
import {
  initCrashReporter,
  installGlobalErrorHandlers,
  installProcessGoneListeners,
  logGpuInfo,
} from "../app/crash-reporter";
import { startRendererMemorySampler } from "../app/diagnostics";
import {
  configureAppUserModelId,
  configureV8CodeCache,
  configureV8HeapSize,
  installPowerMonitorListeners,
  trimUnusedChromiumFeatures,
} from "../app/lifecycle";
import { installProductionProxyAuthHandler } from "../app/proxy-auth";
import {
  installCertificateErrorHandler,
  setPendingCertificateEmitter,
} from "../app/cert-trust";
import {
  installAppProtocolHandler,
  registerAppScheme,
} from "../app/app-protocol";
import { applyHardwareAccelerationPreference } from "../app/gpu-acceleration";
import { configureHostResolverDoH } from "../app/host-resolver";
import { configureUserAgent, preconnectTraycerHosts } from "../app/network";
import { installScreenMonitor } from "../app/screen-monitor";
import { hardenDefaultSession } from "../app/security";
import { registerGlobalShortcuts } from "../app/shortcuts";
import { enableSpellCheck } from "../app/spell-check";
import { installWindowsJumplistTasks } from "../app/recent-documents";
import {
  installAccessibilityThemeForwarder,
  installDownloadObserver,
} from "../app/resilience";
import {
  defaultReconcileCliDeps,
  runLaunchTimeCliReconciliation,
} from "../cli/cli-reconcile";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import {
  resolveDesktopConfig,
  type DesktopConfig,
} from "../config/desktop-config";
import { installHostWakeRecovery } from "./host-wake-recovery";
import { DESKTOP_APP_NAME } from "../../config";

const APP_DISPLAY_NAME = DESKTOP_APP_NAME;

/**
 * Phased desktop boot.
 *
 * The phases map to Electron's real lifecycle seams and to the auth-first
 * model: the window + sign-in UI render as early as possible, and ALL
 * host/CLI/updater work is deferred or moves behind the post-auth
 * `host ensure` IPC. The desktop never registers OS services or calls
 * launchctl - the CLI owns the host's entire lifecycle.
 *
 * Every step is timed (`[startup] step { phase, step, ms }`) so a future
 * regression like the old ~10s launchctl stall is caught immediately in
 * the logs.
 */
export async function runDesktopStartup(): Promise<void> {
  initLogger();
  const config = resolveDesktopConfig();

  const state: BootState = {
    config,
    pendingDeepLinks: [],
    bridge: null,
    authRedirectUri: null,
    loopbackServer: null,
  };

  runPreReady(state);

  await app.whenReady();

  await runOnReady(state);
  log.info("[desktop] app ready", {
    platform: process.platform,
    environment: config.environment,
  });

  const services = await runWindowPhase(state);

  runDeferred(state, services);
}

interface BootState {
  readonly config: DesktopConfig;
  readonly pendingDeepLinks: AuthCallbackParseResult[];
  bridge: RunnerIpcBridge | null;
  // Dev-only: the loopback redirect_uri the renderer must use instead of the
  // (unregistrable) `traycer-dev://` scheme. Null on staging/prod, where the
  // custom-scheme deep link is the callback path.
  authRedirectUri: string | null;
  loopbackServer: LoopbackCallbackServer | null;
}

// Single delivery path for a parsed auth callback, shared by the custom-scheme
// deep link and the dev loopback server: hand it to the bridge if the renderer
// is ready, otherwise queue it for the window phase to drain.
function deliverAuthCallback(
  state: BootState,
  result: AuthCallbackParseResult,
): void {
  if (state.bridge !== null) {
    state.bridge.deliverAuthCallback(result);
  } else {
    state.pendingDeepLinks.push(result);
    log.info("[auth] callback queued before IPC bridge was ready", {
      resultKind: "code" in result ? "code" : "error",
      pendingCount: state.pendingDeepLinks.length,
    });
  }
}

interface AppServices {
  readonly host: HostLifecycle;
  readonly menu: MenuController;
  readonly windowRegistry: WindowRegistry;
}

// Wrap a step in timing + a best-effort boundary. A non-fatal step throwing
// must not abort boot; the failure is logged and the next step proceeds.
async function timed(
  phase: string,
  step: string,
  run: () => void | Promise<void>,
): Promise<void> {
  const start = performance.now();
  try {
    await run();
  } catch (err) {
    log.warn("[startup] step failed", { phase, step, err });
  } finally {
    log.info("[startup] step", {
      phase,
      step,
      ms: Math.round(performance.now() - start),
    });
  }
}

// Pre-ready: command-line switches, scheme registration, hardware
// acceleration toggle, V8 heap, and crash collection all run before
// Chromium initializes. These are synchronous in-process Electron calls
// (the one sync filesystem read - the GPU preference - is documented as the
// required pre-`whenReady` exception in app/gpu-acceleration.ts).
function runPreReady(state: BootState): void {
  trimUnusedChromiumFeatures();
  configureV8HeapSize();
  applyHardwareAccelerationPreference();
  registerAppScheme();
  initCrashReporter();
  installGlobalErrorHandlers();
  installProcessGoneListeners();

  registerDeepLinkHandling((result) => deliverAuthCallback(state, result));
}

// Post-ready configuration. These steps are independent of one another, so
// they run concurrently - each individually timed.
async function runOnReady(state: BootState): Promise<void> {
  // Pin the active host environment before the bridge (and its
  // host-management / ensure handlers) is installed in the window phase.
  // Synchronous and ordering-sensitive, so done first.
  setActiveEnvironment(state.config.environment);

  // Dev builds can't receive a `traycer-dev://` deep link (unpackaged → no OS
  // scheme registration), so stand up the loopback HTTP callback before the
  // window/bridge so its redirect_uri is ready when preload snapshots it. The
  // server is dev-only; staging/prod keep the custom-scheme deep link.
  if (state.config.isDev) {
    await timed("on-ready", "loopback-callback", async () => {
      const server = await startLoopbackCallbackServer((result) =>
        deliverAuthCallback(state, result),
      );
      state.loopbackServer = server;
      state.authRedirectUri = server.redirectUri;
    });
  }

  await Promise.all([
    timed("on-ready", "app-protocol", () => installAppProtocolHandler()),
    timed("on-ready", "app-identity", () =>
      configureAppIdentity(state.config.iconPath),
    ),
    timed("on-ready", "app-user-model-id", () => configureAppUserModelId()),
    timed("on-ready", "v8-code-cache", () => configureV8CodeCache()),
    timed("on-ready", "user-agent", () => configureUserAgent()),
    timed("on-ready", "host-resolver-doh", () => configureHostResolverDoH()),
    timed("on-ready", "harden-session", () => hardenDefaultSession()),
    timed("on-ready", "spell-check", () => enableSpellCheck()),
    timed("on-ready", "notification-handler", () =>
      installNotificationActivationHandler(),
    ),
    timed("on-ready", "proxy-auth", () => installProductionProxyAuthHandler()),
    timed("on-ready", "cert-handler", () => installCertificateErrorHandler()),
    timed("on-ready", "jumplist", () => installWindowsJumplistTasks()),
    timed("on-ready", "download-observer", () => installDownloadObserver()),
    timed("on-ready", "preconnect", () => preconnectTraycerHosts()),
    timed("on-ready", "gpu-info", () => logGpuInfo()),
  ]);
}

// Window phase - inherently sequential + stateful: build the services,
// create + load the window (first paint), install the IPC bridge + menu,
// and wire app-lifecycle handlers. No host work here; the host is
// provisioned post-auth via the ensure IPC.
async function runWindowPhase(state: BootState): Promise<AppServices> {
  const { config } = state;

  const desktopStateStore = new DesktopStateStore({
    filePath: resolveDesktopStateFilePath(),
    logger: log,
  });
  await desktopStateStore.load();

  const windowRegistry = new WindowRegistry({
    createWindow: (request) =>
      createMainWindow({
        preloadPath: config.preloadPath,
        windowId: request.windowId,
        initialRoute: request.initialRoute,
      }),
    loadWindow: (createdWindow) => loadMainWindow(createdWindow),
  });

  const restorableWindowEntries =
    desktopStateStore.getRestorableWindowEntries();
  if (restorableWindowEntries.length > 0) {
    const reconciliation = desktopStateStore.reconcileRestoredWindows({
      liveWindowIds: restorableWindowEntries.map((entry) => entry.windowId),
    });
    log.info("[desktop-state] reconciled startup state to live windows", {
      restoredWindowIds: reconciliation.restoredWindowIds,
      restoredEpicCount: reconciliation.restoredEpicIds.length,
      prunedOwnershipCount: reconciliation.prunedOwnershipCount,
      removedDuplicateTabCount: reconciliation.removedDuplicateTabCount,
    });
    for (const entry of desktopStateStore.getRestorableWindowEntries()) {
      windowRegistry.createWithId({
        windowId: entry.windowId,
        initialRoute: initialRouteForWindowSnapshot(entry.snapshot),
        beforeLoad: null,
      });
    }
  } else {
    windowRegistry.createWithId({
      windowId: randomUUID(),
      initialRoute: null,
      beforeLoad: null,
    });
  }

  const ownership = new EpicWindowOwnership(desktopStateStore);
  const perWindowState = new PerWindowState(desktopStateStore);
  const authSession = new DesktopAuthSession();

  const hostLabel = labelForEnvironment(config.environment);
  const hostLayout = getHostFsLayout(config.environment);
  // Desktop never bundles or supervises the host binary - the CLI is the
  // lifecycle authority. This lifecycle is metadata-first: it watches the
  // environment-scoped pid.json and connects.
  const host = new HostLifecycle({
    layout: hostLayout,
    bundledBinaryPath: null,
    label: hostLabel,
    readyTimeoutMs: undefined,
    reachabilityProbe: undefined,
  });
  const support = new DesktopSupportService({
    appName: APP_DISPLAY_NAME,
    host,
    authSession,
    hostLayout,
  });

  const tray = await createTraySafe(createMruWindowProxy(windowRegistry));

  log.info("[desktop] authn base URL", { authnBaseUrl: config.authnBaseUrl });
  const bridge = new RunnerIpcBridge({
    host,
    authnBaseUrl: config.authnBaseUrl,
    authRedirectUri: state.authRedirectUri,
    tray,
    windowRegistry,
    ownership,
    perWindowState,
    authSession,
    support,
  });
  bridge.install();
  state.bridge = bridge;

  installAccessibilityThemeForwarder((snapshot) => {
    bridge.fanOut(RunnerHostEvent.accessibilityThemeChange, snapshot);
  });
  setPendingCertificateEmitter((entry) => {
    bridge.fanOut(RunnerHostEvent.certificateErrorPending, entry);
  });
  installScreenMonitor((reason, topology) => {
    bridge.fanOut(RunnerHostEvent.displayTopologyChange, { reason, topology });
  });

  const menu = new MenuController({
    appName: APP_DISPLAY_NAME,
    platform: process.platform,
    windowRegistry,
    host,
    authSession,
    perWindowState,
    tray,
    dispatchRendererCommand: (command) =>
      bridge.dispatchMenuCommand(command) ?? false,
    checkForUpdates: () =>
      checkForUpdatesNow(config.isDev, "manual").then(() => undefined),
  });
  menu.install();

  // Drain any deep links captured before the bridge was ready, once the
  // first startup renderer has installed its listeners.
  if (state.pendingDeepLinks.length > 0) {
    const deepLinkTarget = windowRegistry.records()[0];
    if (deepLinkTarget === undefined) {
      log.warn("[auth] startup callbacks pending with no renderer window", {
        pendingCount: state.pendingDeepLinks.length,
      });
    } else {
      deepLinkTarget.window.webContents.once("did-finish-load", () => {
        const pendingCount = state.pendingDeepLinks.length;
        for (const result of state.pendingDeepLinks.splice(0)) {
          bridge.deliverAuthCallback(result);
        }
        log.info("[auth] startup callbacks drained after first renderer load", {
          pendingCount,
          windowId: deepLinkTarget.windowId,
        });
      });
    }
  }

  for (const record of windowRegistry.records()) {
    void windowRegistry.loadById(record.windowId).catch((err) => {
      log.warn("[desktop] restored window load failed", {
        windowId: record.windowId,
        err,
      });
    });
  }

  wireAppLifecycle(state, {
    host,
    menu,
    windowRegistry,
    bridge,
    tray,
    desktopStateStore,
  });

  return { host, menu, windowRegistry };
}

// Reflects the host update availability into the app menu's "Update host"
// affordance. Shared by the launch probe and the post-auto-update refresh so
// both keep the menu in lockstep with the cached registry state.
function applyHostUpdateMenuState(
  menu: MenuController,
  state: HostRegistryUpdateState,
): void {
  if (state.updateAvailable && state.latestVersion !== null) {
    menu.setHostUpdateAvailableVersion(state.latestVersion);
  } else {
    menu.setHostUpdateAvailableVersion(null);
  }
}

// Deferred, fire-and-forget work - runs after the window is loading and
// never blocks first paint.
function runDeferred(state: BootState, services: AppServices): void {
  startRendererMemorySampler();

  // Captured (not just fire-and-forget) so the host auto-update idle gate can
  // wait for discovery to settle before trusting the host snapshot - `timed`
  // resolves void and never rejects, so awaiting it just blocks until bootstrap
  // finishes.
  const hostReady = timed("deferred", "host-watcher", () => {
    services.host.on("error", (err: HostStartupError) => {
      log.error("[desktop] host startup error", err);
    });
    return services.host.bootstrap();
  });

  void timed("deferred", "registry-probe", async () => {
    const result = await refreshRegistryUpdateState({ force: false });
    applyHostUpdateMenuState(services.menu, result);
    log.info("[host-registry] launch probe complete", {
      reachable: result.reachable,
      latestVersion: result.latestVersion,
      installedVersion: result.installedVersion,
      updateAvailable: result.updateAvailable,
    });
    // Coordinated host auto-update: the relaunch after a desktop self-update
    // lands here, so an idle host tracks the app instead of drifting behind.
    // Idle-gated and fail-open - a busy/failed attempt just retries next time.
    // Skipped entirely once the user removed the host on this device, so a
    // stray update probe never reinstalls what they uninstalled.
    if (result.updateAvailable && !(await isHostRemovedByUser())) {
      const outcome = await reconcileHostAutoUpdate(
        "launch",
        defaultHostAutoUpdateDeps(
          services.host,
          LAUNCH_HOST_UPDATE_TIMEOUT_MS,
          () => hostReady,
        ),
      );
      log.info("[host-auto-update] launch reconcile complete", { outcome });
      if (outcome === "updated") {
        applyHostUpdateMenuState(
          services.menu,
          await refreshRegistryUpdateState({ force: false }),
        );
      }
    }
  });

  void timed("deferred", "cli-reconcile", async () => {
    const outcome = await runLaunchTimeCliReconciliation({
      isDevDesktop: state.config.environment === "dev",
      deps: defaultReconcileCliDeps(),
    });
    log.info("[cli-reconcile] launch outcome", { kind: outcome.kind });
  });

  void timed("deferred", "auto-updater", () =>
    installAutoUpdater(state.config.isDev, {
      isAnyWindowFocused: () =>
        services.windowRegistry
          .records()
          .some(
            (record) =>
              !record.window.isDestroyed() && record.window.isFocused(),
          ),
      focusPrimaryWindow: () => {
        services.windowRegistry.focusMru();
      },
      // Updates can't apply from a read-only location: tell the renderer so it
      // disables the download affordance with an explanation. Derived lazily so
      // it reflects the live location (e.g. after the relocation prompt) rather
      // than a value frozen at install time.
      installBlockedReason: () =>
        isUpdateBlockedByLocation() ? UPDATE_BLOCKED_LOCATION_REASON : null,
    }),
  );

  void timed("deferred", "relocate-prompt", () =>
    maybePromptRelocateToApplications(),
  );

  void timed("deferred", "global-shortcuts", () =>
    registerGlobalShortcuts(() => {
      const records = services.windowRegistry.records();
      if (records.length === 0) return null;
      return records[0].window;
    }),
  );

  void timed("deferred", "power-monitor", () =>
    // Bridge the OS wake pulse to every renderer so it force-reconnects its
    // host streams (re-registering the live request context the host needs
    // to mint cloud tokens) within seconds of wake, instead of waiting out the
    // ~60s stream heartbeat. The fan-out fires on resume AND screen-unlock
    // (either may be the user-visible moment depending on lock state); the
    // renderer coalesces them, and a frozen/hidden renderer queues the IPC
    // until it unfreezes - i.e. it fires the moment the user views the window.
    installHostWakeRecovery(services.host, installPowerMonitorListeners, () => {
      state.bridge?.fanOut(RunnerHostEvent.systemResumed, undefined);
      checkForUpdatesAfterResume(state.config.isDev);
    }),
  );
}

interface LifecycleServices {
  readonly host: HostLifecycle;
  readonly menu: MenuController;
  readonly windowRegistry: WindowRegistry;
  readonly bridge: RunnerIpcBridge;
  readonly tray: DesktopTrayController | null;
  readonly desktopStateStore: DesktopStateStore;
}

function wireAppLifecycle(state: BootState, services: LifecycleServices): void {
  app.on("window-all-closed", () => {
    // macOS: keep the app alive so the dock / tray stays responsive.
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (services.windowRegistry.focusMru()) {
      return;
    }
    void services.windowRegistry.create({
      initialRoute: null,
      beforeLoad: null,
    });
  });

  // Flag flipped once the renderer authorizes the quit. Subsequent
  // `before-quit` fires short-circuit so `app.quit()` can complete.
  let quitAuthorized = false;
  // Guards the one-shot quit-time host update so our own re-`quit()` (after the
  // attempt settles) doesn't re-enter the attempt.
  let quitTimeHostUpdateStarted = false;

  const teardownShellObservers = (): void => {
    log.info("[desktop] before-quit - disposing bridge and tray");
    services.menu.dispose();
    services.bridge.dispose();
    services.tray?.dispose();
    state.loopbackServer?.close();
    void services.desktopStateStore.flush().catch((err) => {
      log.warn("[desktop] desktop-state flush failed", err);
    });
  };

  app.on("before-quit", (event) => {
    if (quitAuthorized) {
      teardownShellObservers();
      return;
    }
    const activeBridge = state.bridge;
    if (activeBridge === null) {
      quitAuthorized = true;
      teardownShellObservers();
      return;
    }

    // `quitAndInstall` drives this quit after the user chose "Restart" to
    // install an update. Let it through - intercepting with the unsynced-edits
    // prompt would silently swallow the install. State is still flushed via
    // `teardownShellObservers`.
    if (isInstallingUpdate()) {
      // Second pass: our quit-time host update settled and re-fired `quit()`.
      // Let it through.
      if (quitTimeHostUpdateStarted) {
        log.info(
          "[desktop] before-quit - update install in progress, allowing quit",
        );
        quitAuthorized = true;
        teardownShellObservers();
        return;
      }
      // First pass: attempt a coordinated, idle-gated host update before the
      // desktop swaps its own bytes, then re-quit. Fail-open - a busy host,
      // failure, or the bounded CLI timeout all fall through to the quit, with
      // the next-launch reconcile as the guaranteed fallback. The host update
      // runs as a subprocess that would die with us, so we must hold the quit
      // until it settles rather than racing it.
      quitTimeHostUpdateStarted = true;
      event.preventDefault();
      log.info(
        "[desktop] before-quit - install pending; attempting idle host update first",
      );
      void reconcileHostAutoUpdate(
        "quit-install",
        defaultHostAutoUpdateDeps(
          services.host,
          QUIT_HOST_UPDATE_TIMEOUT_MS,
          // The host was discovered long ago - no need to wait at quit time.
          () => Promise.resolve(),
        ),
      )
        .then((outcome) =>
          log.info("[host-auto-update] quit reconcile complete", { outcome }),
        )
        .catch((err) =>
          log.warn("[host-auto-update] quit reconcile threw", err),
        )
        .finally(() => {
          // If `quitAndInstall` failed in the meantime (e.g. read-only volume),
          // `isInstallingUpdate()` is now false and the failure was surfaced as
          // an error - don't quit out from under the user; let them read it and
          // retry. Only the still-pending install proceeds to quit.
          if (!isInstallingUpdate()) {
            log.info(
              "[desktop] before-quit - install failed during reconcile, staying open",
            );
            return;
          }
          quitAuthorized = true;
          app.quit();
        });
      return;
    }

    event.preventDefault();
    void activeBridge
      .requestFreshUnsyncedSnapshot(200)
      .then((snapshot) => {
        if (!activeBridge.hasUnsyncedEdits()) {
          log.info(
            "[desktop] before-quit - no unsynced edits after fresh query",
            { affectedEpics: snapshot.length },
          );
          quitAuthorized = true;
          app.quit();
          return;
        }
        log.info(
          "[desktop] before-quit intercepted - awaiting renderer decision",
          { affectedEpics: snapshot.length },
        );
        return activeBridge
          .requestQuitDecision(snapshot)
          .then((decision) => {
            log.info("[desktop] quit decision resolved", { decision });
            quitAuthorized = true;
            app.quit();
          })
          .catch((err) => {
            log.warn("[desktop] quit decision failed - staying alive", err);
          });
      })
      .catch((err) => {
        log.warn("[desktop] fresh-snapshot query failed - staying alive", err);
      });
  });
}

async function createTraySafe(
  window: TrayManagedWindow,
): Promise<DesktopTrayController | null> {
  try {
    const asset = resolveTrayIconPath(buildTrayAssetContext());
    const image = await loadTrayIconImage(asset);
    return new DesktopTrayController(window, image, {
      onEpicSelected: null,
      onCommand: null,
    });
  } catch (err) {
    log.warn("[desktop] failed to create tray - continuing without tray", err);
    return null;
  }
}

function createMruWindowProxy(registry: WindowRegistry): TrayManagedWindow {
  const current = (): BrowserWindow | null =>
    registry.getMruRecord()?.window ?? null;
  return {
    isDestroyed: () => {
      const window = current();
      return window === null || window.isDestroyed();
    },
    isVisible: () => current()?.isVisible() ?? false,
    show: () => {
      const window = current();
      if (window === null || window.isDestroyed()) {
        return;
      }
      window.show();
    },
    focus: () => {
      registry.focusMru();
    },
  };
}

async function configureAppIdentity(iconPath: string): Promise<void> {
  configureNativeAboutPanel(APP_DISPLAY_NAME, iconPath);
  if (process.platform !== "darwin") {
    return;
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(iconPath);
  } catch (err) {
    log.warn("[desktop] app icon missing or unreadable", { iconPath, err });
    return;
  }
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    log.warn("[desktop] app icon decoded empty", { iconPath });
    return;
  }
  app.dock?.setIcon(image);
  log.info("[desktop] configured app identity", {
    appName: app.getName(),
    iconPath,
  });
}
