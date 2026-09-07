import { app, nativeImage } from "electron";
import type { Event as ElectronEvent } from "electron";
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
import {
  cliLockPath,
  getHostFsLayout,
  labelForEnvironment,
  smAppServiceAgentLabelId,
} from "../host/host-paths";
import { backfillSubstrateOwnerAtLaunch } from "../host/substrate-backfill-contender";
import { readPublishedHostProcessLiveness } from "../host/host-process-liveness";
import { createHostRecoveryGovernor } from "../host/host-recovery-governor";
import {
  refreshRegistryUpdateState,
  setActiveEnvironment,
} from "../ipc/host-management-ipc";
import { onHostControllerStatusBroadcast } from "../ipc/host-controller-status-broadcast";
import {
  QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS,
  runUpdateInstallQuitSequence,
} from "./update-install-quit";
import { applyQuitDecision } from "./quit-decision";
import { RunnerIpcBridge } from "../ipc/register-runner-ipc";
import {
  applyHostUpdateMenuState,
  armLocalHostBootOnSignIn,
  refreshHostRegistryIfNotRemoved,
  runLaunchHostConvergeReconcile,
  signedInGateFromAuthSession,
  type HostUpdateMenuSurface,
  type SignedInGate,
} from "./host-launch-converge";
import type { IpcHostController } from "../ipc/runner-ipc-bridge";
import { respawnIfDown } from "./host-health-respawn";
import { bootstrapHostWithInstallState } from "./host-install-state";
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
import { FileTokenStore } from "../auth/file-token-store";
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
import {
  browserSavedLoginsFilePath,
  initBrowserSavedLogins,
} from "../browser-view/storage/browser-saved-logins";
import {
  browserForgetLedgerFilePath,
  initBrowserForgetLedger,
} from "../browser-view/storage/browser-forget-ledger";
import { installProductionProxyAuthHandler } from "../app/proxy-auth";
import {
  installDesktopHostKeyPins,
  setHostKeyPinMismatchEmitter,
} from "../host/host-key-pins";
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
import { retireCompetingCliRegistrationWithContender } from "../host/launch-repair-contender";
import { DESKTOP_APP_NAME } from "../../config";

const QUIT_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS = 200;

/** The desktop never registers OS services or calls launchctl - the CLI owns the host's entire lifecycle. */
export async function runDesktopStartup(): Promise<void> {
  const testHooks = desktopStartupTestHooks;
  const deferredPlan =
    testHooks === null
      ? await runProductionStartupPhases()
      : await runTestStartupPhases(testHooks);

  // Tests may replace expensive Electron phases, but they never get a separate convergence branch: removing this production call therefore leaves the composition test red rather than.
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
    readonly signedIn: SignedInGate;
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
  /** Consent gate for booting the local host; see `armLocalHostBootOnSignIn`. */
  readonly signedIn: SignedInGate;
}

interface DeferredStartupPlan {
  readonly state: BootState;
  readonly services: {
    readonly hostController: IpcHostController;
    readonly menu: HostUpdateMenuSurface;
    readonly signedIn: SignedInGate;
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

export function runPreReady(state: BootState): void {
  trimUnusedChromiumFeatures();
  configureV8HeapSize();
  // No `setWebRTCIPHandlingPolicy` call, deliberately - full write-up in
  // `traycer-host`'s `BROWSER_CAPTURE_HELPER_PERMISSIONS`
  // (browser-capture-helper.ts).
  applyHardwareAccelerationPreference();
  suppressWslKernelCoreDumps();
  // `initCrashReporter()` must run before `registerAppScheme()`.
  // Electron keeps only the last RAW call, so registering `app` first (before Sentry) gets silently discarded.
  initCrashReporter();
  installGlobalErrorHandlers();
  registerAppScheme();
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
    // One file read: whether this machine saves browser logins. On by default.
    timed("on-ready", "browser-saved-logins", () =>
      initBrowserSavedLogins(browserSavedLoginsFilePath()),
    ),
    timed("on-ready", "browser-forget-ledger", () =>
      initBrowserForgetLedger(browserForgetLedgerFilePath()),
    ),
    timed("on-ready", "spell-check", () => enableSpellCheck()),
    timed("on-ready", "notification-handler", () =>
      installNotificationActivationHandler(),
    ),
    timed("on-ready", "proxy-auth", () => installProductionProxyAuthHandler()),
    timed("on-ready", "cert-handler", () => installCertificateErrorHandler()),
    // Before any host list is fetched: an unbacked pin store is a pass-through,
    // and a registry answer that slipped through before the install would pin
    // (or admit) a key nothing checked.
    timed("on-ready", "host-key-pins", () => installDesktopHostKeyPins()),
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
  // Set on the first before-quit pass. Ordinary window close remains a
  // separate lifecycle and takes one final browser capture first.
  const shellQuitState = new ShellQuitState();
  const closingWindowIds = new Set<string>();
  let zoomController: WindowZoomController | null = null;
  let windowRegistry: WindowRegistry | null = null;
  function onWindowClose(windowId: string, event: ElectronEvent): void {
    const bridge = state.bridge;
    const registry = windowRegistry;
    if (bridge === null || registry === null) return;
    if (
      shellQuitState.isQuitting() ||
      !bridge.needsFinalBrowserCaptureForWindow(windowId)
    ) {
      return;
    }
    event.preventDefault();
    if (closingWindowIds.has(windowId)) return;
    closingWindowIds.add(windowId);
    void bridge
      .prepareBrowserWindowClose(windowId)
      .catch((error: unknown) => {
        log.warn("[desktop] final browser capture failed during window close", {
          windowId,
          error,
        });
      })
      .finally(() => {
        closingWindowIds.delete(windowId);
        void registry.forceCloseById(windowId);
      });
  }
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
      createdWindow.on("close", (event) => {
        onWindowClose(request.windowId, event);
      });
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
  // Owner of the single machine-local credentials file (tech plan §3). ENV-scoped
  // (shared across dev slots + the CLI), never slot-scoped. The bridge disposes it.
  const authTokenStore = new FileTokenStore({
    environment: config.environment,
    authnBaseUrl: config.authnBaseUrl,
    watchImpl: undefined,
  });

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
  const hostController = new HostController({
    environment: config.environment,
    hostLifecycle: host,
    reachabilityProbe: async (websocketUrl: string): Promise<boolean> => {
      const answered = await canReachHostWebsocketUrl(websocketUrl);
      if (answered) host.noteEndpointAnswered();
      return answered;
    },
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
  // Wired here, at the one place that owns both objects, rather than handing the lifecycle a controller it must not otherwise touch.
  hostController.onMutationProgress(() => {
    host.notifyProvisioningActivity();
  });
  const support = new DesktopSupportService({
    appName: appDisplayName,
    host,
    authSession,
    hostLayout,
  });

  const tray = await createTraySafe(createMruWindowProxy(windowRegistry));

  log.debug("[desktop] authn base URL", { authnBaseUrl: config.authnBaseUrl });
  const bridge = new RunnerIpcBridge({
    host,
    hostController,
    authnBaseUrl: config.authnBaseUrl,
    authTokenStore,
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
  setHostKeyPinMismatchEmitter((entry) => {
    bridge.fanOut(RunnerHostEvent.hostKeyPinMismatch, entry);
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
    signedIn: signedInGateFromAuthSession(authSession),
  };
}

const HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const HOST_REGISTRY_PERIODIC_MAX_AGE_MS =
  HOST_REGISTRY_PERIODIC_CHECK_INTERVAL_MS;
// Mirrors `AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS` in app/updater.ts - collapses
// macOS firing both `onResume` and `onUnlockScreen` for one wake into a
// single probe, without gating on how stale the cache is.
const HOST_REGISTRY_RESUME_DEBOUNCE_MS = 30_000;
let lastHostRegistryResumeCheckMs = 0;

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

  const hostReady = timed("deferred", "host-watcher", () => {
    services.host.on("error", (err: HostStartupError) => {
      log.error("[desktop] host startup error", err);
    });
    return bootstrapHostWithInstallState(
      services.host,
      services.hostController,
    );
  });

  // All-platform watchdog for a host that dies without rewriting pid.json (external kill/crash): the pid-file watcher never fires for those, so the cached snapshot stays "reachable".
  // On Windows it also owns auto-respawn (the Scheduled Task cannot restart-on-failure.
  void hostReady.then(() => {
    // It re-reads pid.json itself inside `requestRespawn` so the "never kill a live host" rule can't be bypassed by adding another caller later.
    const recoveryGovernor = createHostRecoveryGovernor({
      now: undefined,
      readLiveness: () =>
        readPublishedHostProcessLiveness(services.host.pidMetadataFile),
    });
    const healthMonitor = startHostHealthMonitor({
      host: services.host,
      intervalMs: undefined,
      probe: undefined,
      readMetadata: undefined,
      respawn: () => respawnIfDown(services.hostController),
      governor: recoveryGovernor,
      readLiveness: undefined,
    });
    state.bridge?.disposeFns.push(() => healthMonitor.dispose());
  });

  // `substrate.json` is the only durable answer to "who owns launchd for this host", and on the installed base it has never been written.
  // Fail-open by construction: every refusal path leaves the record untouched and the projection at `unknown`, which is fail-closed for service mutation and never resolves to.
  const substrateBackfilled: Promise<void> =
    process.platform === "darwin"
      ? timed("deferred", "substrate-owner-backfill", async () => {
          if (!(await hostManagesHostLoginItem())) return;
          const launchLayout = getHostFsLayout(state.config.environment);
          const cliLabelId = labelForEnvironment(state.config.environment).id;
          const outcome = await backfillSubstrateOwnerAtLaunch({
            layout: launchLayout,
            lockPath: cliLockPath(state.config.environment),
            waitMs: DESKTOP_LOCK_WAIT_MS,
            pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
            agentLabelId: smAppServiceAgentLabelId(cliLabelId),
            cliLabelId,
          });
          log.debug("[host-owner] launch substrate backfill outcome", {
            outcome,
          });
        }).then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();

  // Gated on `hostManagesHostLoginItem()` since a non-macOS build, a dev build, or a build without the in-bundle plist never has SMAppService registration (or a marker) to refresh in.
  if (process.platform === "darwin") {
    void hostReady.then(async () => {
      if (state.bridge === null) return;
      if (!(await hostManagesHostLoginItem())) return;
      await substrateBackfilled;
      if (state.bridge === null) return;
      const revisionMonitor = startPendingLoginItemRevisionMonitor({
        hostController: services.hostController,
        intervalMs: undefined,
      });
      state.bridge?.disposeFns.push(() => revisionMonitor.dispose());
    });
  }

  // A machine that acquired a competing `~/Library/LaunchAgents/<cli-label>.plist` during the v1.1.7 window starts two hosts against one data dir at every login, and nothing else.
  // Deliberately not gated on `hostReady` - the repair is about what starts at the NEXT login and must still run on a launch whose host never becomes ready.
  if (process.platform === "darwin") {
    void timed("deferred", "competing-registration-repair", async () => {
      await substrateBackfilled;
      const launchLayout = getHostFsLayout(state.config.environment);
      const outcome = await retireCompetingCliRegistrationWithContender({
        hostHomeDir: launchLayout.rootDir,
        lockPath: cliLockPath(state.config.environment),
        waitMs: DESKTOP_LOCK_WAIT_MS,
        pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
      });
      log.debug("[host-login-item] launch repair outcome", { outcome });
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
      // Derived lazily so it reflects the live location (e.g. after the relocation prompt) rather than a value frozen at install time.
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
    installHostWakeRecovery(services.host, installPowerMonitorListeners, () => {
      state.bridge?.fanOut(RunnerHostEvent.systemResumed, undefined);
      checkForUpdatesAfterResume(state.config.isDev);
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

  // Process-lifetime timer - Electron main is a single long-lived process with no natural unmount point, so this is intentionally never cleared; it dies with the process.
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

// This is deliberately a production entry point rather than a controller-level policy test: its caller is `runDesktopStartup`, and it invokes the real reconciliation that determines.
export function runDeferred<
  // Constrained to what the teardown registration below needs, and no more:
  // the generic exists so a test can hand this a light state object, and
  // `BootState` satisfies this shape structurally.
  TState extends {
    readonly bridge: { readonly disposeFns: Array<() => void> } | null;
  },
  TServices extends {
    readonly hostController: IpcHostController;
    readonly menu: HostUpdateMenuSurface;
    readonly signedIn: SignedInGate;
  },
>(
  state: TState,
  services: TServices,
  runBackground: (state: TState, services: TServices) => void,
): void {
  runBackground(state, services);
  // The reconciler settles the debt of a host that exists, once.
  // The timers are `unref`ed and so can never hold the process open; this is about not leaving a subscription running through teardown.
  const disposeLocalHostBoot = armLocalHostBootOnSignIn(
    services.hostController,
    services.signedIn,
  );
  state.bridge?.disposeFns.push(disposeLocalHostBoot);
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
        log.warn("[desktop] per-window state flush failed", err);
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
    const finalBrowserCapture =
      state.bridge?.captureFinalBrowserState() ?? Promise.resolve();
    void Promise.all([
      flushShellState(),
      finalBrowserCapture.catch((error) => {
        log.warn(
          "[desktop] final browser capture failed - quitting anyway",
          error,
        );
      }),
    ])
      .then(() => {
        quitAuthorized = true;
        app.quit();
      })
      .catch((error) => {
        log.error(
          "[desktop] failed to authorize quit after state flush",
          error,
        );
      });
  };

  app.on("before-quit", (event) => {
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

    // `quitAndInstall` drives this quit after the user chose "Restart" to install an update.
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
      // First pass: never START a new host mutation this late.
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
            applyQuitDecision(decision, {
              authorizeQuitAfterFlush,
              stayOpen: () => {
                services.quitState.resetQuitting();
              },
            });
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
