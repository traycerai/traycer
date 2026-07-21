import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { describeLogError, log } from "../app/logger";
import type { DesktopTrayController } from "../tray/tray";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { ZoomPercent } from "../../ipc-contracts/zoom-types";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  QuitDecision,
  UnsyncedEditsSnapshot,
} from "../../ipc-contracts/app-lifecycle-types";
import type {
  DesktopAuthSessionSnapshot,
  MenuCommandId,
  MenuCommandPayload,
  OwnershipClaimResult,
  OwnershipEntry,
  PerWindowLandingDraft,
  PerWindowSnapshot,
  PerWindowStatePatch,
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
  WindowSummary,
} from "../../ipc-contracts/window-types";
import { DesktopAuthSession } from "../auth/desktop-auth-session";
import {
  createEmptyPerWindowSnapshot,
  type PerWindowStateChange,
} from "../windows/per-window-state";
import {
  isMruFallbackMenuCommand,
  readEpicId,
  readSenderWebContentsId,
} from "./ipc-parsers";
import {
  uniqueLandingDrafts,
  uniquePerWindowTabs,
} from "./landing-draft-helpers";
import { registerAuthIpc } from "./auth-ipc";
import { registerDeviceFlowIpc } from "./device-flow-ipc";
import { registerTrayIpc } from "./tray-ipc";
import { registerWindowsIpc } from "./windows-ipc";
import { registerOwnershipIpc } from "./ownership-ipc";
import { registerPerWindowStateIpc } from "./per-window-state-ipc";
import { registerHostIpc } from "./host-ipc";
import { registerHostManagementIpc } from "./host-management-ipc";
import { registerHostControllerStatusBroadcast } from "./host-controller-status-broadcast";
import { registerMigrationIpc } from "./migration-ipc";
import { registerSupportIpc } from "./support-ipc";
import { registerTraycerCliIpc } from "./traycer-cli-ipc";
import { registerPlatformIpc } from "./platform-ipc";
import { registerPowerIpc } from "./power-ipc";
import { registerAppUpdateIpc } from "./app-update-ipc";
import { registerGlobalShortcutsIpc } from "./global-shortcuts-ipc";
import { registerZoomIpc } from "./zoom-ipc";
import { getAppUpdateSnapshot } from "../app/updater";
import type { HostTrayCommand } from "../../ipc-contracts/host-management-types";
import {
  aggregateUnsyncedSnapshots,
  registerLifecycleIpc,
} from "./lifecycle-ipc";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  HostControllerStatus,
  InstallVersionOk,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../host/host-controller-types";

/**
 * Minimal window surface the bridge needs. Declaring it structurally lets
 * unit tests pass a plain double without constructing a `BrowserWindow`.
 */
export interface IpcManagedWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  show(): void;
  focus(): void;
  readonly webContents: {
    send(channel: string, payload: unknown): void;
  };
}

export interface IpcWindowRecord {
  readonly windowId: string;
  readonly webContentsId: number;
  readonly window: IpcManagedWindow;
}

type IpcWindowRegistryChangeListener = () => void;

export interface IpcWindowRegistry {
  create(options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string>;
  closeById(windowId: string): Promise<void>;
  forceCloseById(windowId: string): Promise<void>;
  focusMru(): boolean;
  focusById(windowId: string): boolean;
  list(): readonly WindowSummary[];
  records(): readonly IpcWindowRecord[];
  getRecordById(windowId: string): IpcWindowRecord | null;
  getRecordByWebContentsId(webContentsId: number): IpcWindowRecord | null;
  getMruRecord(): IpcWindowRecord | null;
  mostRecentlyFocusedId(): string | null;
  on(event: "change", listener: IpcWindowRegistryChangeListener): void;
  off(event: "change", listener: IpcWindowRegistryChangeListener): void;
}

type IpcOwnershipChangeListener = (snapshot: readonly OwnershipEntry[]) => void;

export interface IpcEpicWindowOwnership {
  getOwner(tabId: string): string | null;
  getOwnerForEpic(epicId: string): string | null;
  getOwnedTabs(windowId: string): readonly string[];
  claim(tabId: string, epicId: string, windowId: string): OwnershipClaimResult;
  release(tabId: string, windowId: string): void;
  releaseWindow(windowId: string): void;
  transfer(tabId: string, fromWindowId: string, toWindowId: string): void;
  snapshot(): readonly OwnershipEntry[];
  on(event: "change", listener: IpcOwnershipChangeListener): void;
  off(event: "change", listener: IpcOwnershipChangeListener): void;
}

export interface IpcPerWindowState {
  get(windowId: string): PerWindowSnapshot;
  update(windowId: string, patch: PerWindowStatePatch): void;
  clear(windowId: string): void;
  on(event: "change", listener: (change: PerWindowStateChange) => void): void;
  off(event: "change", listener: (change: PerWindowStateChange) => void): void;
}

/**
 * Read-only view of the shell's quit lifecycle. The concrete `ShellQuitState`
 * (main-process startup) structurally satisfies this. The windows registry-change
 * listener consults it so a `closed` event that is part of a quit does not prune
 * the per-window restore snapshot.
 */
export interface IpcShellQuitState {
  isQuitting(): boolean;
}

type IpcAuthSessionChangeListener = (
  snapshot: DesktopAuthSessionSnapshot,
) => void;

export interface IpcDesktopAuthSession {
  get(): DesktopAuthSessionSnapshot;
  set(snapshot: DesktopAuthSessionSnapshot): void;
  on(event: "change", listener: IpcAuthSessionChangeListener): void;
  off(event: "change", listener: IpcAuthSessionChangeListener): void;
}

export interface IpcZoomController {
  getZoomPercent(): ZoomPercent;
  zoomIn(): Promise<ZoomPercent>;
  zoomOut(): Promise<ZoomPercent>;
  reset(): Promise<ZoomPercent>;
  setZoomPercent(percent: number): Promise<ZoomPercent>;
  onChange(listener: (percent: ZoomPercent) => void): () => void;
}

export interface IpcSupportService {
  getSnapshot(): SupportSnapshot;
  revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult>;
  submitReport(
    form: SupportSubmitReportRequest,
  ): Promise<SupportSubmitReportResult>;
  tailLog(input: {
    readonly target: SupportLogTarget;
    readonly tailLines: number;
  }): Promise<SupportLogTailResult>;
}

type HostChangeListener = (snapshot: DesktopLocalHostSnapshot | null) => void;

export const QUIT_REQUEST_SERVICE_ACK_TIMEOUT_MS = 1_000;

export interface QuitDecisionWaiter {
  readonly requestId: string;
  readonly windowId: string;
  readonly resolve: (decision: QuitDecision) => void;
  readonly reject: (error: Error) => void;
  readonly serviceTimer: NodeJS.Timeout;
}

/**
 * Minimal host-lifecycle surface the bridge needs. The real
 * `HostLifecycle` structurally satisfies this interface.
 *
 * The legacy service-control passthroughs (install / uninstall / start / stop
 * / restart / upgrade / enableLinger) have been removed in favor of the
 * `traycer-cli`-driven host-management IPC handlers; only the metadata-first
 * status read and the log tail used by Doctor/support remain.
 */
export interface IpcHostLifecycle {
  getSnapshot(): DesktopLocalHostSnapshot | null;
  on(event: "change", listener: HostChangeListener): void;
  off(event: "change", listener: HostChangeListener): void;
  /**
   * Used by `HostController`'s packaged-macOS activation cycle to mark the
   * host as "down" from the renderer's perspective before driving the
   * SMAppService re-register cycle, without going through a full mutation
   * round-trip first.
   */
  notifyRespawning(): void;
  /**
   * Absolute path of the pid-metadata file the lifecycle's watcher is
   * bound to. Exposed so the SMAppService respawn handler polls the same
   * source of truth.
   */
  readonly pidMetadataFile: string;
  /**
   * Whether the lifecycle has been torn down. The respawn handler reads
   * this between awaits so it doesn't drive SMAppService mutations
   * against a disposed instance during shutdown.
   */
  readonly isDisposed: boolean;
  /**
   * Force a fresh pid.json read + emit. The SMAppService respawn
   * handler calls this after `waitForHostReady` resolves so the
   * renderer's host snapshot is guaranteed populated on return -
   * fs.watch coalescing on macOS occasionally drops the create event
   * after a pid.json replacement. Returns the snapshot THIS read derived
   * (null when no reachable, compatible host is on disk), so the
   * host-busy surfacing can judge off the reload's own result rather than a
   * `getSnapshot()` a concurrent reload may not have assigned yet.
   */
  reloadSnapshotFromDisk(): Promise<DesktopLocalHostSnapshot | null>;
  /**
   * Idempotent (re-)install of the pid-metadata watcher. The respawn
   * handler calls this to recover from a watcher that was silently
   * torn down by an FSEvents stream reset earlier in the session.
   */
  ensureWatcherInstalled(): void;
  getRecentLogTail(maxLines: number): Promise<string | null>;
}

/**
 * Structural surface of `HostController` (Host Update Layer Redesign Tech
 * Plan, "Desktop main: HostController") that IPC handlers and background
 * monitors depend on. Declared here - not imported from `host-controller.ts`
 * - so tests can pass a lightweight double instead of constructing the real
 * class, the same pattern `IpcHostLifecycle` already uses for `HostLifecycle`.
 * The real `HostController` satisfies this structurally; no explicit
 * `implements` needed.
 */
export interface IpcHostController {
  getStatus(): Promise<HostControllerStatus>;
  convergeReady(force: boolean): Promise<MutationOutcome<ConvergeReadyOk>>;
  stageLatest(): Promise<void>;
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
  registerService(): Promise<MutationOutcome<ServiceRegistrationOk>>;
  deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>>;
  respawn(): Promise<MutationOutcome<ActivateInstalledOk>>;
  recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  >;
  freePortAndRestart(
    pid: number | null,
    port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>>;
  uninstallHost(all: boolean): Promise<MutationOutcome<UninstallOk>>;
  removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>>;
  isPendingRevisionRefreshQuarantined(): boolean;
  onMutationProgress(
    listener: (progress: MutationProgress) => void,
  ): () => void;
}

export interface RunnerIpcOptions {
  readonly host: IpcHostLifecycle;
  readonly hostController: IpcHostController;
  readonly authnBaseUrl: string;
  // Dev loopback redirect_uri; null when the build uses the custom-scheme
  // deep link (staging/prod). Snapshotted by the renderer to compose sign-in.
  readonly authRedirectUri: string | null;
  readonly tray: DesktopTrayController | null;
  readonly window: IpcManagedWindow;
  readonly zoomController: IpcZoomController | undefined;
}

export interface RunnerIpcRegistryOptions {
  readonly host: IpcHostLifecycle;
  readonly hostController: IpcHostController;
  readonly authnBaseUrl: string;
  readonly authRedirectUri: string | null;
  readonly tray: DesktopTrayController | null;
  readonly windowRegistry: IpcWindowRegistry;
  readonly ownership: IpcEpicWindowOwnership;
  readonly perWindowState: IpcPerWindowState;
  readonly authSession: IpcDesktopAuthSession;
  readonly support?: IpcSupportService;
  readonly zoomController: IpcZoomController | undefined;
  readonly quitState?: IpcShellQuitState;
}

export type RunnerIpcBridgeOptions =
  RunnerIpcOptions | RunnerIpcRegistryOptions;

interface FreshSnapshotWaiter {
  readonly windowId: string;
  readonly resolve: (snapshot: UnsyncedEditsSnapshot) => void;
}

/**
 * Installs `ipcMain.handle` endpoints that back the preload `contextBridge`
 * surface. Each handler mirrors the shape of `IRunnerHost` from
 * `@traycer-clients/shared/platform/runner-host` - the bridge does not re-type
 * the interface, it only passes serializable payloads.
 */
export class RunnerIpcBridge {
  readonly options: RunnerIpcBridgeOptions;
  readonly windowRegistry: IpcWindowRegistry;
  readonly ownership: IpcEpicWindowOwnership;
  readonly perWindowState: IpcPerWindowState;
  readonly authSession: IpcDesktopAuthSession;
  readonly support: IpcSupportService;
  readonly zoomController: IpcZoomController;
  readonly quitState: IpcShellQuitState;
  readonly disposeFns: Array<() => void> = [];
  private readonly syncListeners: Array<{
    channel: string;
    listener: (event: IpcMainEvent, ...args: unknown[]) => void;
  }> = [];
  private hostPickerOpen = false;
  // Set when a browser-return deep link arrives before any renderer window
  // exists; drained to the MRU window once one registers. Coalesced to a single
  // flag - the signal is a payload-free nudge, so repeated arrivals collapse.
  pendingAuthReturnSignal = false;
  readonly appLifecycleReadyWindowIds = new Set<string>();
  readonly unsyncedEditsSnapshots = new Map<string, UnsyncedEditsSnapshot>();
  /**
   * Pending quit-decision resolvers. Each quit request carries a requestId so
   * late acknowledgements or decisions from a previous attempt cannot service
   * a newer retry.
   */
  readonly quitDecisionWaiters: QuitDecisionWaiter[] = [];
  /**
   * In-flight fresh-snapshot waiters keyed by `requestId`. Only the response
   * whose id matches resolves the corresponding promise - ambient
   * `setUnsyncedEditsSnapshot` pushes during the wait do NOT settle these.
   */
  readonly freshSnapshotWaiters = new Map<string, FreshSnapshotWaiter>();

  constructor(options: RunnerIpcBridgeOptions) {
    this.options = options;
    if ("windowRegistry" in options) {
      this.windowRegistry = options.windowRegistry;
      this.ownership = options.ownership;
      this.perWindowState = options.perWindowState;
      this.authSession = options.authSession;
      this.support = options.support ?? new NullSupportService();
      this.zoomController = options.zoomController ?? new NullZoomController();
      this.quitState = options.quitState ?? new NeverQuittingShellState();
    } else {
      this.windowRegistry = new SingleWindowRegistry(options.window);
      this.ownership = new NullEpicWindowOwnership();
      this.perWindowState = new NullPerWindowState();
      this.authSession = new DesktopAuthSession();
      this.support = new NullSupportService();
      this.zoomController = options.zoomController ?? new NullZoomController();
      this.quitState = new NeverQuittingShellState();
    }
  }

  install(): void {
    registerAuthIpc(this);
    registerDeviceFlowIpc(this);
    registerTrayIpc(this);
    registerLifecycleIpc(this);
    registerWindowsIpc(this);
    registerOwnershipIpc(this);
    registerPerWindowStateIpc(this);
    registerSupportIpc(this);
    registerHostIpc(this);
    registerHostManagementIpc(this);
    registerHostControllerStatusBroadcast(this);
    registerMigrationIpc(this);
    registerTraycerCliIpc(this);
    // Platform IPC (recent docs, window effects, diagnostics, etc.) is wired
    // in here so `dispose()` also tears it down via the shared
    // `disposeFns` / `ipcMain.removeHandler` sweep.
    registerPlatformIpc(this);
    registerAppUpdateIpc(this);
    registerGlobalShortcutsIpc(this);
    registerZoomIpc(this);
    // Power IPC (renderer-driven sleep prevention) registers a `disposeFn`
    // that releases the OS power-save blocker on teardown.
    registerPowerIpc(this);
  }

  /**
   * Broadcasts a host-scoped tray command to every renderer window. Wired
   * to the tray controller's host submenu so a tray click deep-links into
   * Settings / Doctor without main reaching across the renderer surface.
   */
  dispatchHostTrayCommand(command: HostTrayCommand): void {
    this.fanOut(RunnerHostEvent.hostTrayCommand, command);
  }

  /**
   * Handles a browser-return deep link: focuses the MRU renderer (so the user
   * lands back in the app) and forwards the payload-free return signal so the
   * renderer nudges its in-flight device poll. Targets the MRU window because
   * the signal is process-global, not Epic-scoped. If no window exists yet, the
   * signal is coalesced into a pending flag and drained on the next registry
   * change. It carries no token - that always arrives over the device poll.
   */
  deliverAuthReturnSignal(): void {
    const target = this.windowRegistry.getMruRecord();
    if (target === null) {
      this.pendingAuthReturnSignal = true;
      return;
    }
    if (!target.window.isFocused()) {
      this.windowRegistry.focusById(target.windowId);
    }
    this.safeSendToWindow(
      target.windowId,
      RunnerHostEvent.authCallback,
      undefined,
    );
  }

  deliverNotificationClick(payload: unknown): void {
    this.deliverToOwnedOrMru(
      readEpicId(payload),
      RunnerHostEvent.notificationClick,
      payload,
    );
  }

  /**
   * Forwards a tray epic-click epicId to the renderer so the mounted
   * `gui-app` can open the selected epic. Routes to the window that already
   * owns the epic when there is one, else the MRU window. Called by the tray
   * controller through the handler installed in `install()`.
   */
  deliverTrayEpicSelected(epicId: string): void {
    this.deliverToOwnedOrMru(epicId, RunnerHostEvent.trayEpicSelected, epicId);
  }

  dispatchMenuCommand(command: MenuCommandId): boolean {
    const target = this.resolveRendererHostedCommandTarget(command);
    if (target === null) {
      return false;
    }
    if (isMruFallbackMenuCommand(command) && !target.window.isFocused()) {
      this.windowRegistry.focusById(target.windowId);
    }
    return this.safeSendToWindow(target.windowId, RunnerHostEvent.menuCommand, {
      command,
      windowId: target.windowId,
    } satisfies MenuCommandPayload);
  }

  /**
   * Synchronous check used by the main `before-quit` handler to decide
   * whether to intercept the quit. Returns true iff at least one entry in
   * the most-recent snapshot is flagged `isDirty`. The `isDirty` flag is
   * authoritative - an Epic may have `queueSize === 0` yet still be dirty
   * (awaiting a flush) or `queueSize > 0` yet not dirty (already synced).
   */
  hasUnsyncedEdits(): boolean {
    for (const entry of this.getUnsyncedEditsSnapshot()) {
      if (entry.isDirty === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Current snapshot of unsynced edits as most recently pushed by the
   * renderer. The `before-quit` path forwards this to the renderer verbatim
   * so the "Saving - please wait" dialog can display the exact Epics that
   * were dirty at the moment the intercept fired.
   */
  getUnsyncedEditsSnapshot(): UnsyncedEditsSnapshot {
    return aggregateUnsyncedSnapshots(
      Array.from(this.unsyncedEditsSnapshots.values()),
    );
  }

  /**
   * Mints a `requestId`, asks the renderer for a fresh registry snapshot via
   * `getFreshUnsyncedSnapshot`, and resolves with the matching
   * `freshUnsyncedSnapshotResponse`. On timeout the cached ambient snapshot
   * (most-recent `setUnsyncedEditsSnapshot` push) is returned as a fallback
   * and the cache is left untouched. On a fresh reply the cache is replaced
   * so follow-up `hasUnsyncedEdits()` / `getUnsyncedEditsSnapshot()` reads
   * see the authoritative state.
   */
  requestFreshUnsyncedSnapshot(
    timeoutMs: number,
  ): Promise<UnsyncedEditsSnapshot> {
    const requests = this.windowRegistry.records().map((record) => {
      return this.requestFreshUnsyncedSnapshotForWindow(record, timeoutMs);
    });
    return Promise.all(requests).then(() => this.getUnsyncedEditsSnapshot());
  }

  /**
   * Sends a `quitRequested` event to the renderer and resolves with the
   * renderer's decision. Used by the `before-quit` handler to coordinate the
   * "Saving - please wait" modal with the Electron shutdown sequence. The
   * caller provides the already-aggregated snapshot; this method only targets
   * the MRU renderer and fails closed when that renderer is not ready, cannot
   * receive the event, or never acknowledges that it has started servicing it.
   */
  requestQuitDecision(snapshot: UnsyncedEditsSnapshot): Promise<QuitDecision> {
    const target = this.windowRegistry.getMruRecord();
    if (target === null) {
      return Promise.reject(
        new Error("No renderer window is available for quit interception"),
      );
    }
    if (!this.appLifecycleReadyWindowIds.has(target.windowId)) {
      return Promise.reject(
        new Error("MRU renderer has not advertised app-lifecycle readiness"),
      );
    }
    this.rejectQuitDecisionWaitersForWindow(
      target.windowId,
      new Error("Quit interception superseded by a newer quit attempt"),
    );
    const requestId = randomUUID();
    return new Promise<QuitDecision>((resolve, reject) => {
      const serviceTimer = setTimeout(() => {
        const waiter = this.removeQuitDecisionWaiter(requestId);
        if (waiter === null) {
          return;
        }
        waiter.reject(
          new Error(
            "MRU renderer received quit interception but did not acknowledge servicing it",
          ),
        );
      }, QUIT_REQUEST_SERVICE_ACK_TIMEOUT_MS);
      this.quitDecisionWaiters.push({
        requestId,
        windowId: target.windowId,
        resolve,
        reject,
        serviceTimer,
      });
      if (
        this.safeSendToWindow(target.windowId, RunnerHostEvent.quitRequested, {
          requestId,
          snapshot,
        })
      ) {
        return;
      }
      const waiter = this.removeQuitDecisionWaiter(requestId);
      if (waiter !== null) {
        waiter.reject(
          new Error("MRU renderer cannot receive quit interception"),
        );
      }
    });
  }

  dispose(): void {
    if (this.options.tray !== null) {
      this.options.tray.setEpicSelectedHandler(null);
    }
    for (const fn of this.disposeFns) {
      try {
        fn();
      } catch (err) {
        log.warn("[runner-ipc] dispose error", err);
      }
    }
    this.disposeFns.length = 0;
    for (const channel of Object.values(RunnerHostInvoke)) {
      ipcMain.removeHandler(channel);
    }
    for (const { channel, listener } of this.syncListeners) {
      ipcMain.removeListener(channel, listener);
    }
    this.syncListeners.length = 0;
    this.rejectAllQuitDecisionWaiters(
      new Error("Runner IPC bridge disposed before quit decision resolved"),
    );
  }

  getHostPickerOpen(): boolean {
    return this.hostPickerOpen;
  }

  setHostPickerOpen(next: boolean): void {
    if (this.hostPickerOpen === next) {
      return;
    }
    this.hostPickerOpen = next;
    this.fanOut(RunnerHostEvent.hostPickerChange, next);
  }

  handleInvoke(
    channel: string,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown | Promise<unknown>,
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!this.isTrustedIpcSender(event)) {
        log.warn("[ipc] rejected untrusted sender", {
          channel,
          senderUrl: event.senderFrame?.url,
        });
        throw new Error(`IPC sender not trusted for channel ${channel}`);
      }
      try {
        return Promise.resolve(handler(event, ...args)).catch(
          (err: unknown) => {
            log.warn("[runner-ipc] invoke handler failed", {
              channel,
              error: describeLogError(err),
            });
            throw err;
          },
        );
      } catch (err) {
        log.warn("[runner-ipc] invoke handler threw", {
          channel,
          error: describeLogError(err),
        });
        throw err;
      }
    });
  }

  /**
   * Defense-in-depth: rejects IPC invokes from webContents not registered
   * in `WindowRegistry` - devtools extensions, hostile pages reached via
   * a compromised renderer navigation, etc. Top-frame-only check pairs
   * with the CSP `frame-src 'none'` policy. Enforced uniformly across
   * packaged and unpackaged builds - tests must supply a `senderFrame`
   * shape and a `sender.id` registered with the configured window
   * registry.
   */
  private isTrustedIpcSender(
    event: IpcMainInvokeEvent | IpcMainEvent,
  ): boolean {
    const senderFrame = event.senderFrame;
    if (senderFrame === null || senderFrame === undefined) return false;
    if (senderFrame.parent !== null) return false;
    return (
      this.windowRegistry.getRecordByWebContentsId(event.sender.id) !== null
    );
  }

  handleSync(
    channel: string,
    compute: (event: IpcMainEvent, ...args: unknown[]) => unknown,
  ): void {
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!this.isTrustedIpcSender(event)) {
        log.warn("[ipc] rejected untrusted sender (sync)", {
          channel,
          senderUrl: event.senderFrame?.url,
        });
        event.returnValue = null;
        return;
      }
      try {
        event.returnValue = compute(event, ...args);
      } catch (err) {
        log.warn("[runner-ipc] sync handler failed", { channel, err });
        event.returnValue = null;
      }
    };
    ipcMain.on(channel, listener);
    this.syncListeners.push({ channel, listener });
  }

  resolveSenderWindowId(
    event: IpcMainInvokeEvent | IpcMainEvent,
  ): string | null {
    const senderId = readSenderWebContentsId(event);
    if (senderId !== null) {
      return (
        this.windowRegistry.getRecordByWebContentsId(senderId)?.windowId ?? null
      );
    }
    const records = this.windowRegistry.records();
    return records.length === 1 ? records[0].windowId : null;
  }

  requestFreshUnsyncedSnapshotForWindow(
    record: IpcWindowRecord,
    timeoutMs: number,
  ): Promise<UnsyncedEditsSnapshot> {
    const requestId = randomUUID();
    return new Promise<UnsyncedEditsSnapshot>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.freshSnapshotWaiters.delete(requestId);
        log.warn("[runner-ipc] fresh unsynced snapshot timed out", {
          windowId: record.windowId,
          timeoutMs,
          fallbackCount:
            this.unsyncedEditsSnapshots.get(record.windowId)?.length ?? 0,
        });
        resolve(this.unsyncedEditsSnapshots.get(record.windowId) ?? []);
      }, timeoutMs);
      this.freshSnapshotWaiters.set(requestId, {
        windowId: record.windowId,
        resolve: (snapshot) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(snapshot);
        },
      });
      if (
        !this.safeSendToWindow(
          record.windowId,
          RunnerHostEvent.getFreshUnsyncedSnapshot,
          {
            requestId,
          },
        )
      ) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.freshSnapshotWaiters.delete(requestId);
        log.warn("[runner-ipc] fresh unsynced snapshot request not delivered", {
          windowId: record.windowId,
          fallbackCount:
            this.unsyncedEditsSnapshots.get(record.windowId)?.length ?? 0,
        });
        resolve(this.unsyncedEditsSnapshots.get(record.windowId) ?? []);
      }
    });
  }

  safeSendToWindow(
    windowId: string,
    channel: string,
    payload: unknown,
  ): boolean {
    const record = this.windowRegistry.getRecordById(windowId);
    if (record === null || record.window.isDestroyed()) {
      return false;
    }
    try {
      record.window.webContents.send(channel, payload);
      return true;
    } catch (err) {
      log.warn("[runner-ipc] webContents.send failed", {
        channel,
        err,
        windowId,
      });
      return false;
    }
  }

  fanOut(channel: string, payload: unknown): void {
    for (const record of this.windowRegistry.records()) {
      this.safeSendToWindow(record.windowId, channel, payload);
    }
  }

  flushPendingAuthReturnSignal(): void {
    if (!this.pendingAuthReturnSignal) {
      return;
    }
    const target = this.windowRegistry.getMruRecord();
    if (target === null) {
      return;
    }
    this.pendingAuthReturnSignal = false;
    if (!target.window.isFocused()) {
      this.windowRegistry.focusById(target.windowId);
    }
    this.safeSendToWindow(
      target.windowId,
      RunnerHostEvent.authCallback,
      undefined,
    );
  }

  replayCurrentStateToWindow(windowId: string): void {
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.localHostChange,
      this.options.host.getSnapshot(),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.windowsChange,
      this.windowRegistry.list(),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.ownershipChange,
      this.ownership.snapshot(),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.perWindowStateChange,
      this.perWindowState.get(windowId),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.authSessionChange,
      this.authSession.get(),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.appUpdateChange,
      getAppUpdateSnapshot(),
    );
    this.safeSendToWindow(
      windowId,
      RunnerHostEvent.zoomChange,
      this.zoomController.getZoomPercent(),
    );
  }

  deliverToOwnedOrMru(
    epicId: string | null,
    channel: string,
    payload: unknown,
  ): void {
    const ownerWindowId =
      epicId === null ? null : this.ownership.getOwnerForEpic(epicId);
    const target =
      ownerWindowId === null
        ? this.windowRegistry.getMruRecord()
        : this.windowRegistry.getRecordById(ownerWindowId);
    if (target === null) {
      log.warn("[runner-ipc] no renderer target for event", {
        channel,
        hasEpicId: epicId !== null,
        ownerWindowId,
      });
      return;
    }
    this.windowRegistry.focusById(target.windowId);
    if (!this.safeSendToWindow(target.windowId, channel, payload)) {
      log.warn("[runner-ipc] renderer event delivery failed", {
        channel,
        windowId: target.windowId,
      });
    }
  }

  private resolveRendererHostedCommandTarget(
    command: MenuCommandId,
  ): IpcWindowRecord | null {
    const focused = this.windowRegistry
      .records()
      .find(
        (record) => record.window.isFocused() && !record.window.isDestroyed(),
      );
    if (focused !== undefined) {
      return focused;
    }
    if (isMruFallbackMenuCommand(command)) {
      return this.windowRegistry.getMruRecord();
    }
    return null;
  }

  pruneClosedWindowState(): void {
    const liveWindowIds = new Set(
      this.windowRegistry.records().map((record) => record.windowId),
    );
    for (const windowId of this.unsyncedEditsSnapshots.keys()) {
      if (!liveWindowIds.has(windowId)) {
        this.unsyncedEditsSnapshots.delete(windowId);
      }
    }
    for (const windowId of this.appLifecycleReadyWindowIds) {
      if (!liveWindowIds.has(windowId)) {
        this.appLifecycleReadyWindowIds.delete(windowId);
      }
    }
    this.rejectQuitDecisionWaiters(
      (waiter) => !liveWindowIds.has(waiter.windowId),
      new Error("Quit interception window closed before resolving"),
    );
  }

  removeQuitDecisionWaiter(requestId: string): QuitDecisionWaiter | null {
    const waiterIndex = this.quitDecisionWaiters.findIndex(
      (entry) => entry.requestId === requestId,
    );
    if (waiterIndex === -1) {
      return null;
    }
    const waiter = this.quitDecisionWaiters.splice(waiterIndex, 1)[0];
    clearTimeout(waiter.serviceTimer);
    return waiter;
  }

  private rejectQuitDecisionWaitersForWindow(
    windowId: string,
    error: Error,
  ): void {
    this.rejectQuitDecisionWaiters(
      (waiter) => waiter.windowId === windowId,
      error,
    );
  }

  private rejectAllQuitDecisionWaiters(error: Error): void {
    this.rejectQuitDecisionWaiters(() => true, error);
  }

  private rejectQuitDecisionWaiters(
    predicate: (waiter: QuitDecisionWaiter) => boolean,
    error: Error,
  ): void {
    const retained: QuitDecisionWaiter[] = [];
    for (const waiter of this.quitDecisionWaiters) {
      if (!predicate(waiter)) {
        retained.push(waiter);
        continue;
      }
      clearTimeout(waiter.serviceTimer);
      waiter.reject(error);
    }
    this.quitDecisionWaiters.length = 0;
    this.quitDecisionWaiters.push(...retained);
  }
}

class SingleWindowRegistry implements IpcWindowRegistry {
  private readonly record: IpcWindowRecord;

  constructor(window: IpcManagedWindow) {
    this.record = {
      windowId: "primary",
      webContentsId: 0,
      window,
    };
  }

  create(_options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    return Promise.resolve(this.record.windowId);
  }

  closeById(_windowId: string): Promise<void> {
    return Promise.resolve();
  }

  forceCloseById(_windowId: string): Promise<void> {
    return Promise.resolve();
  }

  focusMru(): boolean {
    return this.focusById(this.record.windowId);
  }

  focusById(windowId: string): boolean {
    if (windowId !== this.record.windowId || this.record.window.isDestroyed()) {
      return false;
    }
    if (!this.record.window.isVisible()) {
      this.record.window.show();
    }
    this.record.window.focus();
    return true;
  }

  list(): readonly WindowSummary[] {
    return [
      {
        windowId: this.record.windowId,
        title: "Traycer",
        isFocused: this.record.window.isFocused(),
        isVisible: this.record.window.isVisible(),
      },
    ];
  }

  records(): readonly IpcWindowRecord[] {
    return [this.record];
  }

  getRecordById(windowId: string): IpcWindowRecord | null {
    return windowId === this.record.windowId ? this.record : null;
  }

  getRecordByWebContentsId(_webContentsId: number): IpcWindowRecord | null {
    return this.record;
  }

  getMruRecord(): IpcWindowRecord | null {
    return this.record;
  }

  mostRecentlyFocusedId(): string | null {
    return this.record.windowId;
  }

  on(_event: "change", _listener: IpcWindowRegistryChangeListener): void {}

  off(_event: "change", _listener: IpcWindowRegistryChangeListener): void {}
}

// Default quit-state for the single-window `window:` bridge variant (and any
// registry-mode caller that omits `quitState`): the shell is never quitting, so
// the registry-change listener falls back to the "last remaining window"
// heuristic alone.
class NeverQuittingShellState implements IpcShellQuitState {
  isQuitting(): boolean {
    return false;
  }
}

class NullEpicWindowOwnership implements IpcEpicWindowOwnership {
  getOwner(_tabId: string): string | null {
    return null;
  }

  getOwnerForEpic(_epicId: string): string | null {
    return null;
  }

  getOwnedTabs(_windowId: string): readonly string[] {
    return [];
  }

  claim(
    _tabId: string,
    _epicId: string,
    _windowId: string,
  ): OwnershipClaimResult {
    return { ok: true };
  }

  release(_tabId: string, _windowId: string): void {}

  releaseWindow(_windowId: string): void {}

  transfer(_tabId: string, _fromWindowId: string, _toWindowId: string): void {}

  snapshot(): readonly OwnershipEntry[] {
    return [];
  }

  on(_event: "change", _listener: IpcOwnershipChangeListener): void {}

  off(_event: "change", _listener: IpcOwnershipChangeListener): void {}
}

class NullPerWindowState implements IpcPerWindowState {
  private readonly snapshots = new Map<string, PerWindowSnapshot>();

  get(windowId: string): PerWindowSnapshot {
    return this.snapshots.get(windowId) ?? createEmptyPerWindowSnapshot();
  }

  update(windowId: string, patch: PerWindowStatePatch): void {
    const current = this.get(windowId);
    const landingDrafts =
      "landingDrafts" in patch
        ? uniqueLandingDrafts(patch.landingDrafts ?? [])
        : uniqueLandingDrafts(current.landingDrafts);
    const activeLandingDraftId =
      "activeLandingDraftId" in patch
        ? (patch.activeLandingDraftId ?? null)
        : current.activeLandingDraftId;
    this.snapshots.set(windowId, {
      epicTabs:
        "epicTabs" in patch
          ? uniquePerWindowTabs(patch.epicTabs ?? [])
          : uniquePerWindowTabs(current.epicTabs),
      activeTabId:
        "activeTabId" in patch
          ? (patch.activeTabId ?? null)
          : current.activeTabId,
      canvasByTabId:
        "canvasByTabId" in patch
          ? { ...current.canvasByTabId, ...(patch.canvasByTabId ?? {}) }
          : current.canvasByTabId,
      landingDrafts,
      activeLandingDraftId,
    });
  }

  clear(windowId: string): void {
    this.snapshots.delete(windowId);
  }

  on(
    _event: "change",
    _listener: (change: PerWindowStateChange) => void,
  ): void {}

  off(
    _event: "change",
    _listener: (change: PerWindowStateChange) => void,
  ): void {}
}

class NullSupportService implements IpcSupportService {
  getSnapshot(): SupportSnapshot {
    return {
      appName: "Traycer",
      appVersion: "0.0.0",
      platform: process.platform,
      arch: process.arch,
      user: {
        status: "signed-out",
        userName: null,
        email: null,
      },
      versions: {
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        node: process.versions.node,
      },
      host: {
        status: "starting",
        version: null,
        pid: null,
        hostId: null,
      },
      logs: [],
      links: [],
      supportEmail: "",
    };
  }

  revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult> {
    return Promise.resolve({ target, path: "" });
  }

  submitReport(
    _form: SupportSubmitReportRequest,
  ): Promise<SupportSubmitReportResult> {
    return Promise.resolve({ reportId: "" });
  }

  tailLog(input: {
    readonly target: SupportLogTarget;
    readonly tailLines: number;
  }): Promise<SupportLogTailResult> {
    return Promise.resolve({
      target: input.target,
      path: "",
      lines: [],
      truncated: false,
    });
  }
}

class NullZoomController implements IpcZoomController {
  private zoomPercent: ZoomPercent = 100;

  getZoomPercent(): ZoomPercent {
    return this.zoomPercent;
  }

  zoomIn(): Promise<ZoomPercent> {
    return this.setZoomPercent(this.zoomPercent);
  }

  zoomOut(): Promise<ZoomPercent> {
    return this.setZoomPercent(this.zoomPercent);
  }

  reset(): Promise<ZoomPercent> {
    return this.setZoomPercent(100);
  }

  setZoomPercent(percent: number): Promise<ZoomPercent> {
    this.zoomPercent = percent === 100 ? 100 : this.zoomPercent;
    return Promise.resolve(this.zoomPercent);
  }

  onChange(_listener: (percent: ZoomPercent) => void): () => void {
    return () => undefined;
  }
}
