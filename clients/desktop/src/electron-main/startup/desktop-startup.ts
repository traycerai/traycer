import { app, nativeImage } from "electron";
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
import {
  canReachHostWebsocketUrl,
  HostLifecycle,
  type HostStartupError,
} from "../host/host-lifecycle";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
} from "../host/host-controller";
import { getHostFsLayout, labelForEnvironment } from "../host/host-paths";
import {
  refreshRegistryUpdateState,
  setActiveEnvironment,
} from "../ipc/host-management-ipc";
import { onHostControllerStatusBroadcast } from "../ipc/host-controller-status-broadcast";
import {
  QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS,
  runUpdateInstallQuitSequence,
} from "./update-install-quit";
import { RunnerIpcBridge } from "../ipc/register-runner-ipc";
import {
  applyHostUpdateMenuState,
  refreshHostRegistryIfNotRemoved,
  runLaunchHostConvergeReconcile,
  type HostUpdateMenuSurface,
} from "./host-launch-converge";
import type { IpcHostController } from "../ipc/runner-ipc-bridge";
import { respawnIfDown } from "./host-health-respawn";
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
import {
  WindowRegistry,
  type RegistryManagedWindow,
} from "../windows/window-registry";
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
import { suppressWslKernelCoreDumps } from "../app/core-dump-guard";
import { pruneStaleCrashDumps } from "../app/crash-dump-prune";
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
import {
  getRegisteredAccelerator,
  initGlobalShortcutsRegistry,
  onGlobalShortcutsChange,
  reconcileGlobalShortcuts,
  type ShortcutTargetWindow,
} from "../app/shortcuts";
import { hydrateGlobalShortcutIntents } from "../app/global-shortcuts-preferences";
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
import { startPendingLoginItemRevisionMonitor } from "../host/pending-login-item-revision-monitor";
import { hostManagesHostLoginItem } from "../app/host-login-item";
import { DESKTOP_APP_NAME } from "../../config";

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
  const testHooks = desktopStartupTestHooks;
  const deferredPlan =
    testHooks === null
      ? await runProductionStartupPhases()
      : await runTestStartupPhases(testHooks);

  // There is deliberately one startup → deferred handoff. Tests may replace
  // expensive Electron phases, but they never get a separate convergence
  // branch: removing this production call therefore leaves the composition
  // test red rather than silently exercising a test-only equivalent.
  runDeferred(deferredPlan.state, deferredPlan.services, () =>
    deferredPlan.runBackground(),
  );
}

interface BootState {
  readonly config: DesktopConfig;
  // Set when a browser-return deep link arrives before the bridge is installed;
  // drained once the window phase exposes a renderer. Coalesced - the signal is
  // a payload-free nudge, so repeated cold-start arrivals collapse.
  pendingAuthReturnSignal: boolean;
  bridge: RunnerIpcBridge | null;
}

export interface DesktopStartupTestHooks {
  readonly config: DesktopConfig;
  runPreReady(): void;
  whenReady(): Promise<void>;
  runOnReady(): Promise<void>;
  runWindowPhase(): Promise<{
    readonly hostController: IpcHostController;
    readonly menu: HostUpdateMenuSurface;
  }>;
  runDeferredBackground(): void;
}

let desktopStartupTestHooks: DesktopStartupTestHooks | null = null;

/** Test-only phase replacement used to exercise `runDesktopStartup`'s real
 * handoff into `runDeferred` without constructing an Electron window. */
export function __setDesktopStartupTestHooks(
  hooks: DesktopStartupTestHooks | null,
): void {
  desktopStartupTestHooks = hooks;
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
  readonly hostController: HostController;
  readonly menu: MenuController;
  readonly windowRegistry: WindowRegistry;
  readonly zoomController: WindowZoomController;
}

interface DeferredStartupPlan {
  readonly state: BootState;
  readonly services: {
    readonly hostController: IpcHostController;
    readonly menu: HostUpdateMenuSurface;
  };
  runBackground(): void;
}

async function runTestStartupPhases(
  testHooks: DesktopStartupTestHooks,
): Promise<DeferredStartupPlan> {
  initLogger();
  const state: BootState = {
    config: testHooks.config,
    pendingAuthReturnSignal: false,
    bridge: null,
  };
  testHooks.runPreReady();
  await testHooks.whenReady();
  await testHooks.runOnReady();
  const services = await testHooks.runWindowPhase();
  return {
    state,
    services,
    runBackground: testHooks.runDeferredBackground,
  };
}

async function runProductionStartupPhases(): Promise<DeferredStartupPlan> {
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
  return {
    state,
    services,
    runBackground: () => runDeferredBackground(state, services),
  };
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
// (two documented sync-filesystem exceptions: the GPU preference read in
// app/gpu-acceleration.ts and the memory-backed /proc write in
// app/core-dump-guard.ts, which must land before Chromium spawns children).
function runPreReady(state: BootState): void {
  trimUnusedChromiumFeatures();
  configureV8HeapSize();
  applyHardwareAccelerationPreference();
  registerAppScheme();
  suppressWslKernelCoreDumps();
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
    timed("on-ready", "crash-dump-prune", () => pruneStaleCrashDumps()),
    timed("on-ready", "global-shortcuts-preferences", () =>
      hydrateGlobalShortcutIntents().then(() => undefined),
    ),
  ]);
}

// Window phase - inherently sequential + stateful: build the services,
// create + load the window (first paint), install the IPC bridge + menu,
// and wire app-lifecycle handlers. No host work here; the host is
// provisioned post-auth via the ensure IPC.
async function runWindowPhase(state: BootState): Promise<AppServices> {
  const { config } = state;
  const appDisplayName = app.getName();
  const devWindowTitle =
    appDisplayName === DESKTOP_APP_NAME ? null : appDisplayName;

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
        devWindowTitle,
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
  // Single main-process owner of every host-lifecycle mutation (Host Update
  // Layer Redesign Tech Plan, "Desktop main: HostController"). `host`
  // (`HostLifecycle`) stays the read side - metadata-first discovery,
  // reachability, the renderer-facing snapshot - `hostController` owns every
  // write.
  const hostController = new HostController({
    environment: config.environment,
    hostLifecycle: host,
    reachabilityProbe: canReachHostWebsocketUrl,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
  const support = new DesktopSupportService({
    appName: appDisplayName,
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
    hostController,
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
    appName: appDisplayName,
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
    hostController,
    menu,
    windowRegistry,
    bridge,
    tray,
    desktopStateStore,
    windowGeometryPersistence,
    quitState: shellQuitState,
  });

  return {
    host,
    hostController,
    menu,
    windowRegistry,
    zoomController: createdZoomController,
  };
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

// The non-converge deferred work is separate so `runDeferred` below remains
// the narrow production entry point for the launch host-convergence policy.
// It schedules this background work first (preserving the boot ordering),
// then always schedules the real launch reconciliation through that entry
// point. The generic boundary keeps the production types intact while letting
// the startup composition test drive the entry point with a focused fake.
function runDeferredBackground(state: BootState, services: AppServices): void {
  startRendererMemorySampler();
  if (state.bridge !== null) {
    const bridge = state.bridge;
    bridge.disposeFns.push(
      onHostControllerStatusBroadcast(bridge, (status) => {
        applyHostUpdateMenuState(services.menu, status);
      }),
    );
  }

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

  // All-platform watchdog for a host that dies without rewriting pid.json
  // (external kill/crash): the pid-file watcher never fires for those, so the
  // cached snapshot stays "reachable" against a dead endpoint forever. On
  // Windows it also owns auto-respawn (the Scheduled Task cannot
  // restart-on-failure - its hidden-launcher action detaches the host and
  // exits, so the task completes long before the host can die). On
  // macOS/Linux the service manager (launchd KeepAlive / systemd Restart)
  // respawns crashes itself, but the SUPERVISOR cannot fix the desktop's
  // stale snapshot when the respawned host binds a new port and the watcher
  // edge is missed - the monitor's reload-first convergence covers exactly
  // that, and only falls back to `HostController.recoverIfDown()` when the
  // disk still names an unreachable host. Started after bootstrap so the
  // initial 60s readiness wait can't register as an outage.
  void hostReady.then(() => {
    const healthMonitor = startHostHealthMonitor({
      host: services.host,
      intervalMs: undefined,
      probe: undefined,
      readMetadata: undefined,
      respawn: () => respawnIfDown(services.hostController),
    });
    state.bridge?.disposeFns.push(() => healthMonitor.dispose());
  });

  // macOS-only: guarantees a busy-preserved install's pending LaunchAgent
  // revision (see `desktop-install-cloud.js`'s marker +
  // `HostController.applyPendingLoginItemRevisionIfIdle`) gets applied
  // within this running session once the host goes idle, not only at the
  // next relaunch - a renderer-triggered `convergeReady` only gets one shot
  // at it per app launch. Gated on `hostManagesHostLoginItem()` since a
  // non-macOS build, a dev build, or a build without the in-bundle plist
  // never has SMAppService registration (or a marker) to refresh in the
  // first place.
  if (process.platform === "darwin") {
    void hostReady.then(async () => {
      if (state.bridge === null) return;
      if (!(await hostManagesHostLoginItem())) return;
      const revisionMonitor = startPendingLoginItemRevisionMonitor({
        hostController: services.hostController,
        intervalMs: undefined,
      });
      state.bridge?.disposeFns.push(() => revisionMonitor.dispose());
    });
  }

  void timed("deferred", "registry-probe", async () => {
    // `force: true` - matches the app's own `checkForUpdatesNow` on launch
    // (app/updater.ts): always a real probe, never a cache read, so a
    // relaunch shortly after a release still sees it immediately.
    const result = await refreshRegistryUpdateState(services.hostController, {
      force: true,
      maxAgeMs: null,
    });
    // The registry probe's own result only carries version-comparison state
    // (no activation domain) - the menu label is derived from a fresh
    // `getStatus()` read taken right after, since the probe's background
    // `stageLatest()` may have just changed `stagedVersion`.
    const status = await services.hostController.getStatus();
    applyHostUpdateMenuState(services.menu, status);
    log.debug("[host-registry] launch probe complete", {
      reachable: result.reachable,
      latestVersion: result.latestVersion,
      installedVersion: result.installedVersion,
      updateAvailable: result.updateAvailable,
    });
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

  void timed("deferred", "global-shortcuts", async () => {
    const shortcutTargetWindow = createMruWindowProxy(services.windowRegistry);
    initGlobalShortcutsRegistry(() => shortcutTargetWindow);
    const applyTrayAccelerator = (): void => {
      state.bridge?.options.tray?.setSummonAccelerator(
        getRegisteredAccelerator("summon"),
      );
    };
    // The tray's accelerator display and the IPC fan-out (`global-shortcuts-ipc.ts`)
    // are independent subscribers to the same reconcile() output - decoupled the
    // same way host-registry updates reach both the menu/tray and the renderer.
    state.bridge?.disposeFns.push(
      onGlobalShortcutsChange(applyTrayAccelerator),
    );
    const snapshot = await reconcileGlobalShortcuts({});
    applyTrayAccelerator();
    if (snapshot.statuses.summon.status === "rejected") {
      log.warn("[global-shortcuts] summon shortcut refused at launch", {
        effectiveChord: snapshot.statuses.summon.effectiveChord,
      });
    }
  });

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
        void refreshHostRegistryIfNotRemoved(
          services.hostController,
          services.menu,
          { force: true, maxAgeMs: null },
        );
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
    void refreshHostRegistryIfNotRemoved(
      services.hostController,
      services.menu,
      {
        force: false,
        maxAgeMs: HOST_REGISTRY_PERIODIC_MAX_AGE_MS,
      },
    );
  }, HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS);
}

// Deferred, fire-and-forget launch convergence. This is deliberately a
// production entry point rather than a controller-level policy test: its
// caller is `runDesktopStartup`, and it invokes the real reconciliation that
// determines whether a launch is allowed to apply, activate, or do nothing.
export function runDeferred<
  TState,
  TServices extends {
    readonly hostController: IpcHostController;
    readonly menu: HostUpdateMenuSurface;
  },
>(
  state: TState,
  services: TServices,
  runBackground: (state: TState, services: TServices) => void,
): void {
  runBackground(state, services);
  void timed("deferred", "host-launch-converge", () =>
    runLaunchHostConvergeReconcile(services.hostController, services.menu),
  );
}

interface LifecycleServices {
  readonly host: HostLifecycle;
  readonly hostController: HostController;
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
      // No .catch: the store's write chain never rejects (persist failures
      // are retried once, then surrendered with an error log inside it).
      services.desktopStateStore.flush(),
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
      // First pass: never START a new host mutation this late - only drain
      // whatever `HostController` mutation is already in flight (bounded),
      // so the desktop doesn't swap its own bytes out from under a
      // subprocess mid-swap. Drain the renderer's freshest per-window
      // projection into the state store, then re-quit. Fail-open at every
      // step - a wedged mutation, failure, or the bounded drain timeout all
      // fall through to the quit; the launch-time `applyStaged` reconcile is
      // the guaranteed fallback either way.
      quitTimeHostUpdateStarted = true;
      event.preventDefault();
      log.info(
        "[desktop] before-quit - install pending; draining any in-flight host mutation first",
      );
      void runUpdateInstallQuitSequence({
        drainHostMutation: () =>
          services.hostController.awaitMutationLaneIdle(
            QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS,
          ),
        isInstallPending: isInstallingUpdate,
        drainRendererProjection: () =>
          activeBridge.requestFreshUnsyncedSnapshot(
            QUIT_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS,
          ),
        authorizeQuitAfterFlush,
        stayOpen: () => {
          // Re-arm the first-pass sequence: leaving the flag set would make
          // the NEXT Restart-to-install take the second-pass shortcut above,
          // skipping the host reconcile, the renderer drain, AND the shell
          // flush for that quit.
          quitTimeHostUpdateStarted = false;
          services.quitState.resetQuitting();
        },
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

// Shared by the tray (`TrayManagedWindow`) and the global-shortcuts registry
// (`ShortcutTargetWindow`, decision 10 in the tech plan: the summon action
// resolves via `focusMru()` rather than the registry's first-inserted
// record) - both just need "the window the user last used", so one proxy
// backs both call sites. Exported so tests can exercise this exact proxy
// against a real `WindowRegistry` instead of a hand-rolled copy. Generic over
// `TWindow` (rather than hardcoding the default `BrowserWindow`) so a test's
// `WindowRegistry<FakeRegistryWindow>` can be passed directly - the bound is
// exactly the surface this function actually calls, nothing Electron-specific.
export function createMruWindowProxy<
  TWindow extends RegistryManagedWindow & {
    isMinimized(): boolean;
    restore(): void;
  },
>(registry: WindowRegistry<TWindow>): TrayManagedWindow & ShortcutTargetWindow {
  const current = (): TWindow | null => registry.getMruRecord()?.window ?? null;
  return {
    isDestroyed: () => {
      const window = current();
      return window === null || window.isDestroyed();
    },
    isVisible: () => current()?.isVisible() ?? false,
    isMinimized: () => current()?.isMinimized() ?? false,
    show: () => {
      const window = current();
      if (window === null || window.isDestroyed()) {
        return;
      }
      window.show();
    },
    restore: () => {
      const window = current();
      if (window === null || window.isDestroyed()) {
        return;
      }
      window.restore();
    },
    focus: () => {
      registry.focusMru();
    },
  };
}

async function configureAppIdentity(iconPath: string): Promise<void> {
  configureNativeAboutPanel(app.getName(), iconPath);
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
