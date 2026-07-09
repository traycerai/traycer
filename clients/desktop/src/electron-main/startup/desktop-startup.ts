import { app, nativeImage, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { initLogger, log } from "../app/logger";
import { configureNativeAboutPanel } from "../app/about";
import {
  findJumplistCommandInArgv,
  registerJumplistCommandHandling,
} from "../app/jumplist-commands";
import { registerDeepLinkHandling } from "../auth/deep-link";
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
  onHostRegistryUpdateStateChange,
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
import {
  createWindowZoomController,
  loadInitialZoomPercentSync,
  zoomPercentToFactor,
  type WindowZoomController,
} from "../windows/window-zoom";
import {
  createWindowGeometryPersistence,
  createWindowGeometryStore,
  installPrimaryWindowGeometryPersistence,
  loadInitialWindowGeometrySync,
  resolvePrimaryWindowPlacement,
  resolveSecondaryWindowPlacement,
  type WindowGeometryPersistence,
} from "../windows/window-geometry";
import { EpicWindowOwnership } from "../windows/epic-window-ownership";
import { PerWindowState } from "../windows/per-window-state";
import { DesktopAuthSession } from "../auth/desktop-auth-session";
import { DesktopSupportService } from "../app/support";
import { MenuController } from "../menu/menu-controller";
import { initialRouteForWindowSnapshot } from "./window-initial-route";
import { ShellQuitState } from "./shell-quit-state";
import { planActivateWithoutLiveWindow } from "./activate-window-plan";
import type { RestorableWindowEntry } from "../windows/desktop-state-store";
import { readResolutionTestDisplay } from "../windows/resolution-test-env";
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
import {
  installScreenMonitor,
  readDisplayTopology,
} from "../app/screen-monitor";
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
import { startHostHealthMonitor } from "../host/host-health-monitor";
import { DESKTOP_APP_NAME } from "../../config";

const APP_DISPLAY_NAME = DESKTOP_APP_NAME;

// Per-window fresh-snapshot query budget during `before-quit`. Each renderer,
// on receiving `getFreshUnsyncedSnapshot`, first AWAITS its debounced per-window
// projection flush (open epic tabs / pane layout / drafts -> main's
// `PerWindowState`) and only then replies. So by the time this query resolves,
// main's per-window state - and thus the subsequent `desktopStateStore.flush()`
// - already reflects the latest layout. 200ms comfortably covers the two local
// IPC round-trips (projection `update`, then the fresh-snapshot reply) a
// responsive renderer needs - they are same-machine calls over a small JSON
// payload, typically well under ~20ms combined. It is deliberately NOT larger:
// the ceiling exists to bound how long quit hangs when a renderer is frozen
// (where no timeout would help), and the cached ambient snapshot is the
// fail-safe fallback on timeout.
const QUIT_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS = 200;

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
    pendingAuthReturnSignal: false,
    bridge: null,
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
  // Set when a browser-return deep link arrives before the bridge is installed;
  // drained once the window phase exposes a renderer. Coalesced - the signal is
  // a payload-free nudge, so repeated cold-start arrivals collapse.
  pendingAuthReturnSignal: boolean;
  bridge: RunnerIpcBridge | null;
}

// Single delivery path for the browser-return signal: focus + nudge the
// renderer's device poll if the bridge is ready, otherwise mark it pending for
// the window phase to drain. Payload-free - the token arrives over the poll.
function deliverAuthReturnSignal(state: BootState): void {
  if (state.bridge !== null) {
    state.bridge.deliverAuthReturnSignal();
  } else {
    state.pendingAuthReturnSignal = true;
  }
}

interface AppServices {
  readonly host: HostLifecycle;
  readonly menu: MenuController;
  readonly windowRegistry: WindowRegistry;
  readonly zoomController: WindowZoomController;
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
    log.debug("[startup] step", {
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

  registerDeepLinkHandling(() => deliverAuthReturnSignal(state));
}

// Post-ready configuration. These steps are independent of one another, so
// they run concurrently - each individually timed.
async function runOnReady(state: BootState): Promise<void> {
  // Pin the active host environment before the bridge (and its
  // host-management / ensure handlers) is installed in the window phase.
  // Synchronous and ordering-sensitive, so done first.
  setActiveEnvironment(state.config.environment);

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

  const launchDisplay =
    readResolutionTestDisplay(process.env) ??
    readDisplayTopology().displays.find((display) => display.primary) ??
    null;
  const initialZoomPercent = loadInitialZoomPercentSync(launchDisplay ?? null);
  let currentWindowGeometry = loadInitialWindowGeometrySync();
  const windowGeometryStore = createWindowGeometryStore();
  const windowGeometryPersistence =
    createWindowGeometryPersistence(windowGeometryStore);
  let zoomController: WindowZoomController | null = null;
  let windowRegistry: WindowRegistry | null = null;
  windowRegistry = new WindowRegistry({
    createWindow: (request) => {
      const zoomFactor =
        zoomController?.getZoomFactor() ??
        zoomPercentToFactor(initialZoomPercent);
      const sourceWindow = windowRegistry?.getMruRecord()?.window ?? null;
      const isPrimaryWindow = sourceWindow === null;
      const placement =
        sourceWindow === null
          ? resolvePrimaryWindowPlacement({
              saved: currentWindowGeometry,
              topology: readDisplayTopology(),
            })
          : resolveSecondaryWindowPlacement({
              sourceWindow,
              topology: readDisplayTopology(),
            });
      const createdWindow = createMainWindow({
        preloadPath: config.preloadPath,
        windowId: request.windowId,
        initialRoute: request.initialRoute,
        zoomFactor,
        placement,
      });
      if (isPrimaryWindow) {
        installPrimaryWindowGeometryPersistence(
          createdWindow,
          windowGeometryPersistence,
          (state) => {
            currentWindowGeometry = state;
          },
        );
      }
      return createdWindow;
    },
    loadWindow: (createdWindow) => loadMainWindow(createdWindow),
  });
  const createdZoomController = createWindowZoomController(
    windowRegistry,
    initialZoomPercent,
  );
  zoomController = createdZoomController;

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

  // Flipped once `before-quit` fires (any quit path). The windows registry-change
  // listener reads it so a `closed` event that is part of a quit never prunes the
  // per-window restore snapshot.
  const shellQuitState = new ShellQuitState();

  log.debug("[desktop] authn base URL", { authnBaseUrl: config.authnBaseUrl });
  const bridge = new RunnerIpcBridge({
    host,
    authnBaseUrl: config.authnBaseUrl,
    // Device flow is the only login - there is no loopback redirect_uri to
    // snapshot - so the renderer always falls back to the custom-scheme
    // sign-in URL composition.
    authRedirectUri: null,
    tray,
    windowRegistry,
    ownership,
    perWindowState,
    authSession,
    support,
    zoomController: createdZoomController,
    quitState: shellQuitState,
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
    zoomController: createdZoomController,
    dispatchRendererCommand: (command) =>
      bridge.dispatchMenuCommand(command) ?? false,
    checkForUpdates: () =>
      checkForUpdatesNow(config.isDev, "manual").then(() => undefined),
  });
  menu.install();

  registerJumplistCommandHandling({
    dispatch: (command) => menu.dispatchShellCommand(command),
    focusMainWindow: () => {
      const record = windowRegistry.getMruRecord();
      if (record !== null) {
        windowRegistry.focusById(record.windowId);
      }
    },
  });
  // Cold-start jump-list launch: `--new-epic` is satisfied by the window
  // startup opens anyway; `--open-settings` must wait for the first renderer
  // to load before it can host the settings surface.
  if (findJumplistCommandInArgv(process.argv) === "app.openSettings") {
    const settingsTarget = windowRegistry.records()[0];
    settingsTarget?.window.webContents.once("did-finish-load", () => {
      menu.dispatchShellCommand("app.openSettings");
    });
  }

  // Drain a browser-return signal captured before the bridge was ready, once
  // the first startup renderer has installed its listeners.
  if (state.pendingAuthReturnSignal) {
    state.pendingAuthReturnSignal = false;
    const deepLinkTarget = windowRegistry.records()[0];
    deepLinkTarget?.window.webContents.once("did-finish-load", () => {
      bridge.deliverAuthReturnSignal();
    });
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
    windowGeometryPersistence,
    quitState: shellQuitState,
  });

  return { host, menu, windowRegistry, zoomController: createdZoomController };
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

// Auto-check-for-updates gap (Ticket: host-update-race-conditions): the
// launch probe used to be gated by the full 24h `REGISTRY_CACHE_TTL_MS`, so a
// relaunch shortly after a release, or a machine waking from sleep, could
// still read a stale cache and never notice the update without a manual
// "Check for updates" click. This mirrors the desktop APP's own update check
// (`app/updater.ts`) exactly: `checkForUpdatesNow` fires unconditionally on
// launch and `checkForUpdatesAfterResume` fires unconditionally on resume
// (debounced only against a rapid double-fire, never against staleness) -
// there is no cache to wait out. The host registry check now does the same:
// launch and resume force a real probe every time; only the periodic
// backstop (for a session that never relaunches or sleeps) uses a threshold,
// and that threshold matches its own poll interval so it never becomes a
// second long-lived cache. All three stay refresh-only (no auto-install):
// the coordinated auto-update stays tied to the launch/quit lifecycle above,
// since silently swapping host bytes mid-session on a background timer is a
// bigger behavior change than "make the banner appear on time."
const HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const HOST_REGISTRY_PERIODIC_MAX_AGE_MS =
  HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS;
// Mirrors `AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS` in app/updater.ts - collapses
// macOS firing both `onResume` and `onUnlockScreen` for one wake into a
// single probe, without gating on how stale the cache is.
const HOST_REGISTRY_RESUME_DEBOUNCE_MS = 30_000;
let lastHostRegistryResumeCheckMs = 0;

// Shared by the launch probe, the periodic timer, and the resume trigger.
// `refreshRegistryUpdateState` never throws and is internally serialized
// (`registryRefreshQueue`), so overlapping calls are safe.
async function refreshHostRegistryIfNotRemoved(
  services: AppServices,
  opts: { readonly force: boolean; readonly maxAgeMs: number | null },
): Promise<void> {
  if (await isHostRemovedByUser()) return;
  const result = await refreshRegistryUpdateState(opts);
  applyHostUpdateMenuState(services.menu, result);
}

// Deferred, fire-and-forget work - runs after the window is loading and
// never blocks first paint.
function runDeferred(state: BootState, services: AppServices): void {
  startRendererMemorySampler();
  state.bridge?.disposeFns.push(
    onHostRegistryUpdateStateChange((result) => {
      applyHostUpdateMenuState(services.menu, result);
    }),
  );

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

  // Windows-only watchdog for a host that dies without rewriting pid.json
  // (external kill/crash): the pid-file watcher never fires for those, and
  // the Scheduled Task cannot restart-on-failure (its hidden-launcher action
  // detaches the host and exits, so the task completes long before the host
  // can die). On macOS/Linux the service manager itself supervises the host
  // (launchd KeepAlive / systemd Restart) and respawns it within seconds -
  // a desktop-side watchdog there would be redundant at best and, on macOS,
  // could auto-fire the SMAppService re-register cycle. Started after
  // bootstrap so the initial 60s readiness wait can't register as an outage.
  if (process.platform === "win32") {
    void hostReady.then(() => {
      const healthMonitor = startHostHealthMonitor({ host: services.host });
      state.bridge?.disposeFns.push(() => healthMonitor.dispose());
    });
  }

  void timed("deferred", "registry-probe", async () => {
    // `force: true` - matches the app's own `checkForUpdatesNow` on launch
    // (app/updater.ts): always a real probe, never a cache read, so a
    // relaunch shortly after a release still sees it immediately.
    const result = await refreshRegistryUpdateState({
      force: true,
      maxAgeMs: null,
    });
    applyHostUpdateMenuState(services.menu, result);
    log.debug("[host-registry] launch probe complete", {
      reachable: result.reachable,
      latestVersion: result.latestVersion,
      installedVersion: result.installedVersion,
      updateAvailable: result.updateAvailable,
    });
    // Coordinated host auto-update: the relaunch after a desktop self-update
    // lands here, so an idle host tracks the app instead of drifting behind.
    // Idle-gated and fail-open - a busy/failed attempt just retries next time.
    // Skipped entirely once the user removed the host on this device, so a
    // stray update probe never reinstalls what they uninstalled. Also
    // skipped if the bridge somehow isn't installed yet (it always is by
    // this deferred phase in practice) since the reconciler needs it to
    // broadcast operation status.
    const bridge = state.bridge;
    if (
      result.updateAvailable &&
      bridge !== null &&
      !(await isHostRemovedByUser())
    ) {
      const outcome = await reconcileHostAutoUpdate(
        "launch",
        defaultHostAutoUpdateDeps(
          services.host,
          LAUNCH_HOST_UPDATE_TIMEOUT_MS,
          () => hostReady,
          bridge,
        ),
      );
      log.info("[host-auto-update] launch reconcile complete", { outcome });
      if (outcome === "updated") {
        applyHostUpdateMenuState(
          services.menu,
          await refreshRegistryUpdateState({ force: false, maxAgeMs: null }),
        );
      }
    }
  });

  void timed("deferred", "cli-reconcile", async () => {
    const outcome = await runLaunchTimeCliReconciliation({
      isDevDesktop: state.config.environment === "dev",
      deps: defaultReconcileCliDeps(),
    });
    log.debug("[cli-reconcile] launch outcome", { kind: outcome.kind });
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
      // `force: true` - matches `checkForUpdatesAfterResume` above: a real
      // probe on every wake, gated only by the debounce below (not by cache
      // age), so waking from sleep sees a release that shipped during sleep
      // immediately instead of waiting out a staleness threshold.
      const nowMs = Date.now();
      if (
        nowMs - lastHostRegistryResumeCheckMs >=
        HOST_REGISTRY_RESUME_DEBOUNCE_MS
      ) {
        lastHostRegistryResumeCheckMs = nowMs;
        void refreshHostRegistryIfNotRemoved(services, {
          force: true,
          maxAgeMs: null,
        });
      }
    }),
  );

  // Process-lifetime timer - Electron main is a single long-lived process
  // with no natural unmount point, so this is intentionally never cleared;
  // it dies with the process. Backstop only: launch and resume above already
  // force a real probe, so this only matters for a session that neither
  // relaunches nor sleeps for an extended stretch. `maxAgeMs` matches the
  // poll interval, so it only skips a network hit when a launch/resume probe
  // already refreshed the cache more recently than this tick's own cadence.
  setInterval(() => {
    void refreshHostRegistryIfNotRemoved(services, {
      force: false,
      maxAgeMs: HOST_REGISTRY_PERIODIC_MAX_AGE_MS,
    });
  }, HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS);
}

interface LifecycleServices {
  readonly host: HostLifecycle;
  readonly menu: MenuController;
  readonly windowRegistry: WindowRegistry;
  readonly bridge: RunnerIpcBridge;
  readonly tray: DesktopTrayController | null;
  readonly desktopStateStore: DesktopStateStore;
  readonly windowGeometryPersistence: WindowGeometryPersistence;
  readonly quitState: ShellQuitState;
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
    // No live window to focus (e.g. macOS red-light close of the last window
    // left the app running). Restore the preserved window snapshot(s) rather
    // than minting a blank window, so a close-then-reopen keeps the user's tabs,
    // canvas, and drafts. Falls back to a blank window when nothing restorable
    // survives.
    const plan = planActivateWithoutLiveWindow(
      services.desktopStateStore.getRestorableWindowEntries(),
    );
    if (plan.kind === "restore") {
      for (const entry of plan.entries) {
        restorePreservedWindowOnActivate(services, entry);
      }
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

  const flushShellState = async (): Promise<void> => {
    await Promise.all([
      services.desktopStateStore.flush().catch((err) => {
        log.warn("[desktop] desktop-state flush failed", err);
      }),
      services.windowGeometryPersistence.flushLatest().catch((err) => {
        log.warn("[desktop] window-geometry flush failed", err);
      }),
    ]);
  };

  const teardownShellObservers = (): void => {
    log.info("[desktop] before-quit - disposing bridge and tray");
    services.menu.dispose();
    services.bridge.dispose();
    services.tray?.dispose();
  };

  const authorizeQuitAfterFlush = (): void => {
    void flushShellState().finally(() => {
      quitAuthorized = true;
      app.quit();
    });
  };

  app.on("before-quit", (event) => {
    // Mark the shell as quitting on the FIRST pass, before any preventDefault or
    // async work, so the windows registry-change listener preserves every
    // closing window's restore snapshot for the remainder of the quit - even the
    // non-last windows a Cmd+Q closes. Idempotent across the multi-pass quit.
    services.quitState.markQuitting();
    if (quitAuthorized) {
      teardownShellObservers();
      return;
    }
    const activeBridge = state.bridge;
    if (activeBridge === null) {
      event.preventDefault();
      authorizeQuitAfterFlush();
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
          services.bridge,
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
            services.quitState.resetQuitting();
            return;
          }
          authorizeQuitAfterFlush();
        });
      return;
    }

    event.preventDefault();
    void activeBridge
      .requestFreshUnsyncedSnapshot(QUIT_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS)
      .then((snapshot) => {
        if (!activeBridge.hasUnsyncedEdits()) {
          log.info(
            "[desktop] before-quit - no unsynced edits after fresh query",
            { affectedEpics: snapshot.length },
          );
          authorizeQuitAfterFlush();
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
            authorizeQuitAfterFlush();
          })
          .catch((err) => {
            log.warn("[desktop] quit decision failed - staying alive", err);
            services.quitState.resetQuitting();
          });
      })
      .catch((err) => {
        log.warn("[desktop] fresh-snapshot query failed - staying alive", err);
        services.quitState.resetQuitting();
      });
  });
}

// Recreate a preserved window on macOS `activate`, reusing its original id so
// the in-memory + on-disk per-window snapshot rebinds to it (the renderer reads
// its snapshot by window id). Mirrors the startup restore path.
function restorePreservedWindowOnActivate(
  services: LifecycleServices,
  entry: RestorableWindowEntry,
): void {
  services.windowRegistry.createWithId({
    windowId: entry.windowId,
    initialRoute: initialRouteForWindowSnapshot(entry.snapshot),
    beforeLoad: null,
  });
  void services.windowRegistry.loadById(entry.windowId).catch((err) => {
    log.warn("[desktop] activate restore window load failed", {
      windowId: entry.windowId,
      err,
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
  log.debug("[desktop] configured app identity", {
    appName: app.getName(),
    iconPath,
  });
}
