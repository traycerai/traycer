import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import log from "electron-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../../../ipc-contracts/host-types";
import type {
  IpcHostLifecycle,
  IpcManagedWindow,
  IpcWindowRecord,
  IpcWindowRegistry,
} from "../runner-ipc-bridge";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { EpicWindowOwnership } from "../../windows/epic-window-ownership";
import { PerWindowState } from "../../windows/per-window-state";
import type {
  DesktopAuthSessionSnapshot,
  WindowSummary,
} from "../../../ipc-contracts/window-types";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";

/**
 * Runner-IPC bridge tests. We mock `electron` so the bridge can install its
 * handlers against a plain-JS `ipcMain` double, then drive the host and
 * tray dependencies directly to assert the event/invoke surface the preload
 * bridge depends on.
 */

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type SyncHandler = (
  event: { returnValue: unknown },
  ...args: unknown[]
) => void;

const ipcMainState = {
  handlers: new Map<string, InvokeHandler>(),
  syncListeners: new Map<string, Set<SyncHandler>>(),
};

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

interface CapturingWindow extends IpcManagedWindow {
  readonly sentMessages: SentMessage[];
  setDestroyed(value: boolean): void;
  setFocused(value: boolean): void;
}

const sentMessages: SentMessage[] = [];

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "1.0.0",
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (_value: string): Buffer => Buffer.from("", "utf8"),
    decryptString: (_buf: Buffer): string => "",
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  Notification: {
    isSupported: (): boolean => false,
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler): void => {
      ipcMainState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string): void => {
      ipcMainState.handlers.delete(channel);
    },
    on: (channel: string, listener: SyncHandler): void => {
      let set = ipcMainState.syncListeners.get(channel);
      if (set === undefined) {
        set = new Set();
        ipcMainState.syncListeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener: (channel: string, listener: SyncHandler): void => {
      ipcMainState.syncListeners.get(channel)?.delete(listener);
    },
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class FakeHost extends EventEmitter implements IpcHostLifecycle {
  private snapshot: DesktopLocalHostSnapshot | null = null;
  respawnCalls = 0;
  notifyRespawningCalls = 0;
  reloadSnapshotCalls = 0;
  ensureWatcherCalls = 0;
  readonly pidMetadataFile = "/tmp/fake-traycer-host/pid.json";
  isDisposed = false;

  getSnapshot(): DesktopLocalHostSnapshot | null {
    return this.snapshot;
  }

  setSnapshot(next: DesktopLocalHostSnapshot | null): void {
    this.snapshot = next;
    this.emit("change", next);
  }

  async respawn(): Promise<void> {
    this.respawnCalls += 1;
  }
  notifyRespawning(): void {
    this.notifyRespawningCalls += 1;
    this.snapshot = null;
    this.emit("change", null);
  }
  async reloadSnapshotFromDisk(): Promise<DesktopLocalHostSnapshot | null> {
    this.reloadSnapshotCalls += 1;
    return this.getSnapshot();
  }
  ensureWatcherInstalled(): void {
    this.ensureWatcherCalls += 1;
  }
  async getServiceStatus(): Promise<{
    state: "running" | "stopped" | "not-installed";
    version: string | null;
    listenUrl: string | null;
    pid: number | null;
  }> {
    return { state: "running", version: null, listenUrl: null, pid: null };
  }
  async installService(): Promise<void> {}
  async uninstallService(_purge: boolean): Promise<void> {}
  async startService(): Promise<void> {}
  async stopService(): Promise<void> {}
  async restartService(): Promise<void> {}
  async upgradeService(): Promise<void> {}
  async enableLinger(): Promise<void> {}
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

function buildWindow(): CapturingWindow {
  return buildWindowWithDestroyed(false);
}

function buildDestroyedWindow(): CapturingWindow {
  return buildWindowWithDestroyed(true);
}

function buildWindowWithDestroyed(initialDestroyed: boolean): CapturingWindow {
  let destroyed = initialDestroyed;
  let focused = false;
  const messages: SentMessage[] = [];
  return {
    sentMessages: messages,
    setDestroyed: (value) => {
      destroyed = value;
    },
    setFocused: (value) => {
      focused = value;
    },
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isVisible: () => true,
    show: () => undefined,
    focus: () => {
      focused = true;
    },
    webContents: {
      send: (channel: string, payload: unknown): void => {
        const message = { channel, payload };
        messages.push(message);
        sentMessages.push(message);
      },
    },
  };
}

class FakeWindowRegistry implements IpcWindowRegistry {
  private readonly recordsByWindowId = new Map<string, IpcWindowRecord>();
  private readonly windowIdByWebContentsId = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private mruWindowId: string | null = null;
  createCount = 0;
  closeRequests: string[] = [];
  forceCloseRequests: string[] = [];
  initialRoutes: Array<string | null> = [];
  createFailure: Error | null = null;

  add(windowId: string, webContentsId: number, window: IpcManagedWindow): void {
    this.recordsByWindowId.set(windowId, { windowId, webContentsId, window });
    this.windowIdByWebContentsId.set(webContentsId, windowId);
    this.mruWindowId = windowId;
    this.emitChange();
  }

  create(options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    this.createCount += 1;
    this.initialRoutes.push(options.initialRoute);
    const windowId = `created-${this.createCount}`;
    this.add(windowId, 1000 + this.createCount, buildWindow());
    options.beforeLoad?.(windowId);
    if (this.createFailure !== null) {
      return Promise.reject(this.createFailure);
    }
    return Promise.resolve(windowId);
  }

  closeById(windowId: string): Promise<void> {
    this.closeRequests.push(windowId);
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined) {
      return Promise.resolve();
    }
    this.recordsByWindowId.delete(windowId);
    this.windowIdByWebContentsId.delete(record.webContentsId);
    if (this.mruWindowId === windowId) {
      this.mruWindowId = this.records().at(-1)?.windowId ?? null;
    }
    this.emitChange();
    return Promise.resolve();
  }

  forceCloseById(windowId: string): Promise<void> {
    this.forceCloseRequests.push(windowId);
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined) {
      return Promise.resolve();
    }
    this.recordsByWindowId.delete(windowId);
    this.windowIdByWebContentsId.delete(record.webContentsId);
    if (this.mruWindowId === windowId) {
      this.mruWindowId = this.records().at(-1)?.windowId ?? null;
    }
    this.emitChange();
    return Promise.resolve();
  }

  focusMru(): boolean {
    return this.mruWindowId !== null && this.focusById(this.mruWindowId);
  }

  focusById(windowId: string): boolean {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined || record.window.isDestroyed()) {
      return false;
    }
    if (!record.window.isVisible()) {
      record.window.show();
    }
    record.window.focus();
    this.mruWindowId = windowId;
    this.emitChange();
    return true;
  }

  list(): readonly WindowSummary[] {
    return Array.from(this.recordsByWindowId.values()).map((record) => ({
      windowId: record.windowId,
      title: record.windowId,
      isFocused: record.windowId === this.mruWindowId,
      isVisible: record.window.isVisible(),
    }));
  }

  records(): readonly IpcWindowRecord[] {
    return Array.from(this.recordsByWindowId.values());
  }

  getRecordById(windowId: string): IpcWindowRecord | null {
    return this.recordsByWindowId.get(windowId) ?? null;
  }

  getRecordByWebContentsId(webContentsId: number): IpcWindowRecord | null {
    const windowId = this.windowIdByWebContentsId.get(webContentsId);
    return windowId === undefined ? null : this.getRecordById(windowId);
  }

  getMruRecord(): IpcWindowRecord | null {
    return this.mruWindowId === null
      ? null
      : this.getRecordById(this.mruWindowId);
  }

  mostRecentlyFocusedId(): string | null {
    return this.mruWindowId;
  }

  on(_event: "change", listener: () => void): void {
    this.listeners.add(listener);
  }

  off(_event: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sender(webContentsId: number): {
  readonly sender: { readonly id: number };
  readonly senderFrame: { readonly parent: null };
} {
  return {
    sender: { id: webContentsId },
    // The bridge's IPC trust check rejects requests without a top-frame
    // `senderFrame`. Real Electron events always populate this; tests
    // must too so the same code path runs unmodified across dev / prod
    // / test invocations.
    senderFrame: { parent: null },
  };
}

// Convenience for tests that use `SingleWindowRegistry` (constructed
// via the `window:` constructor variant). That registry permissively
// resolves any `event.sender.id` to its sole record, so passing `0` is
// equivalent to "any sender".
function bareEvent(): {
  readonly sender: { readonly id: number };
  readonly senderFrame: { readonly parent: null };
} {
  return sender(0);
}

function readQuitRequestId(message: SentMessage | undefined): string {
  if (message === undefined) {
    throw new Error("quitRequested message missing");
  }
  if (message.payload === null || typeof message.payload !== "object") {
    throw new Error("quitRequested payload is not an object");
  }
  const payload = message.payload as Record<string, unknown>;
  if (typeof payload.requestId !== "string") {
    throw new Error("quitRequested payload is missing requestId");
  }
  return payload.requestId;
}

interface SyncEvent {
  returnValue: unknown;
}

function invokeSync(channel: string): unknown {
  const listeners = ipcMainState.syncListeners.get(channel);
  if (listeners === undefined || listeners.size === 0) {
    throw new Error(`no sync listener registered for ${channel}`);
  }
  // Match the trusted-sender shape (`sender.id` registered in the window
  // registry + a top-frame `senderFrame`) so the bridge's
  // `isTrustedIpcSender` guard accepts the sync invocation. `SingleWindowRegistry`
  // resolves `sender.id` permissively, so `0` is equivalent to "any sender".
  const event: SyncEvent & {
    readonly sender: { readonly id: number };
    readonly senderFrame: { readonly parent: null };
  } = {
    returnValue: undefined,
    sender: { id: 0 },
    senderFrame: { parent: null },
  };
  for (const listener of listeners) {
    listener(event);
  }
  return event.returnValue;
}

function invokeSyncWithSender(channel: string, webContentsId: number): unknown {
  return invokeSyncWithSenderAndArgs(channel, webContentsId);
}

function invokeSyncWithSenderAndArgs(
  channel: string,
  webContentsId: number,
  ...args: unknown[]
): unknown {
  const listeners = ipcMainState.syncListeners.get(channel);
  if (listeners === undefined || listeners.size === 0) {
    throw new Error(`no sync listener registered for ${channel}`);
  }
  const event: {
    returnValue: unknown;
    sender: { id: number };
    senderFrame: { parent: null };
  } = {
    returnValue: undefined,
    sender: { id: webContentsId },
    senderFrame: { parent: null },
  };
  for (const listener of listeners) {
    listener(event, ...args);
  }
  return event.returnValue;
}

beforeEach(() => {
  ipcMainState.handlers.clear();
  ipcMainState.syncListeners.clear();
  sentMessages.length = 0;
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("RunnerIpcBridge", () => {
  it("registers the refreshed IRunnerHost invoke channels", async () => {
    const mod = await import("../register-runner-ipc");
    const host = new FakeHost();
    const bridge = new mod.RunnerIpcBridge({
      host,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const channels = Array.from(ipcMainState.handlers.keys()).sort();
    expect(channels).toEqual(
      [
        RunnerHostInvoke.hostPickerRequestClose,
        RunnerHostInvoke.hostPickerRequestOpen,
        RunnerHostInvoke.workspaceFoldersPick,
        RunnerHostInvoke.validateAuthToken,
        RunnerHostInvoke.validateAuthTokenIdentity,
        RunnerHostInvoke.deviceFlowStart,
        RunnerHostInvoke.deviceFlowPollNow,
        RunnerHostInvoke.deviceFlowCancel,
        RunnerHostInvoke.refreshAuthToken,
        RunnerHostInvoke.notificationShow,
        RunnerHostInvoke.openExternalLink,
        RunnerHostInvoke.getRegisteredUrlSchemes,
        RunnerHostInvoke.requestMicrophoneAccess,
        RunnerHostInvoke.openMicrophoneSettings,
        RunnerHostInvoke.requestHostRespawn,
        RunnerHostInvoke.traySetIndicator,
        RunnerHostInvoke.traySetEpics,
        RunnerHostInvoke.setUnsyncedEditsSnapshot,
        RunnerHostInvoke.appLifecycleQuit,
        RunnerHostInvoke.acknowledgeQuitRequest,
        RunnerHostInvoke.respondToQuitRequest,
        RunnerHostInvoke.freshUnsyncedSnapshotResponse,
        RunnerHostInvoke.appUpdateCheck,
        RunnerHostInvoke.appUpdateDownload,
        RunnerHostInvoke.appUpdateGetSnapshot,
        RunnerHostInvoke.appUpdateInstall,
        RunnerHostInvoke.windowsList,
        RunnerHostInvoke.windowsRequestNew,
        RunnerHostInvoke.windowsRequestFocus,
        RunnerHostInvoke.windowsRequestClose,
        RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
        RunnerHostInvoke.ownershipSnapshot,
        RunnerHostInvoke.ownershipClaim,
        RunnerHostInvoke.ownershipRelease,
        RunnerHostInvoke.perWindowStateGet,
        RunnerHostInvoke.perWindowStateUpdate,
        RunnerHostInvoke.perWindowStateClear,
        RunnerHostInvoke.authSessionGet,
        RunnerHostInvoke.authSessionSet,
        RunnerHostInvoke.supportSnapshotGet,
        RunnerHostInvoke.supportRevealLog,
        RunnerHostInvoke.supportSubmitReport,
        RunnerHostInvoke.supportTailLog,
        RunnerHostInvoke.powerSetSleepBlocked,
        // Legacy `runnerHost:service:*` install/uninstall/start/stop/restart/
        // upgrade/enableLinger/status/getLogTail channels have been removed
        // in favor of the `traycer-cli`-driven host-management handlers
        // (`traycerHost*`). The bridge no longer registers them.
        RunnerHostInvoke.traycerHostStatus,
        RunnerHostInvoke.traycerConfigShellGet,
        RunnerHostInvoke.traycerConfigShellList,
        RunnerHostInvoke.traycerConfigShellSet,
        RunnerHostInvoke.traycerConfigShellReset,
        RunnerHostInvoke.traycerConfigEnvList,
        RunnerHostInvoke.traycerConfigEnvSet,
        RunnerHostInvoke.traycerConfigEnvDelete,
        RunnerHostInvoke.traycerCliLogin,
        RunnerHostInvoke.traycerCliLogout,
        RunnerHostInvoke.migrationAnnounceRunning,
        RunnerHostInvoke.migrationGetRunningSnapshot,
        // Native-packaging host-management bridge (Flow 4 / Flow 6).
        // These channels are registered by `registerHostManagementIpc`
        // which the bridge invokes during `install()`.
        RunnerHostInvoke.traycerHostInstall,
        RunnerHostInvoke.traycerHostEnsure,
        RunnerHostInvoke.traycerHostUpdate,
        RunnerHostInvoke.traycerHostUninstall,
        RunnerHostInvoke.traycerAppUninstall,
        RunnerHostInvoke.traycerHostRemovalGet,
        RunnerHostInvoke.traycerHostRemovalClear,
        RunnerHostInvoke.traycerHostRestart,
        RunnerHostInvoke.traycerHostLogs,
        RunnerHostInvoke.traycerHostDoctor,
        RunnerHostInvoke.traycerHostAvailable,
        RunnerHostInvoke.traycerHostInstalled,
        RunnerHostInvoke.traycerHostNameGet,
        RunnerHostInvoke.traycerHostNameSet,
        RunnerHostInvoke.traycerServiceRegister,
        RunnerHostInvoke.traycerServiceDeregister,
        RunnerHostInvoke.traycerRegistryCheck,
        RunnerHostInvoke.traycerHostOperationStatusGet,
        RunnerHostInvoke.traycerFreePortAndRestart,
        RunnerHostInvoke.traycerCliManifestRead,
        // Platform IPC channels installed by `registerPlatformIpc(bridge)`,
        // which is now invoked from `RunnerIpcBridge.install()` rather than
        // wired by the host. They cover recent docs, window effects, GPU,
        // proxies, certificates, diagnostics, displays, and TouchID.
        RunnerHostInvoke.recentDocumentAdd,
        RunnerHostInvoke.windowFlashFrame,
        RunnerHostInvoke.windowSetProgressBar,
        RunnerHostInvoke.windowSetBadge,
        RunnerHostInvoke.windowSetRepresentedFilename,
        RunnerHostInvoke.windowSetDocumentEdited,
        RunnerHostInvoke.windowSetContentProtection,
        RunnerHostInvoke.diagnosticsGetMetrics,
        RunnerHostInvoke.diagnosticsTakeHeapSnapshot,
        RunnerHostInvoke.diagnosticsTraceStart,
        RunnerHostInvoke.diagnosticsTraceStop,
        RunnerHostInvoke.systemPreferencesAccentColor,
        RunnerHostInvoke.systemPreferencesAppearance,
        RunnerHostInvoke.systemPreferencesAccessibilityTheme,
        RunnerHostInvoke.touchIdAvailable,
        RunnerHostInvoke.touchIdPrompt,
        RunnerHostInvoke.windowSetVibrancy,
        RunnerHostInvoke.windowSetBackgroundMaterial,
        RunnerHostInvoke.windowSetVisibleOnAllWorkspaces,
        RunnerHostInvoke.proxyAuthList,
        RunnerHostInvoke.proxyAuthSave,
        RunnerHostInvoke.proxyAuthClear,
        RunnerHostInvoke.proxySetConfig,
        RunnerHostInvoke.proxyResolve,
        RunnerHostInvoke.certTrustList,
        RunnerHostInvoke.certTrustAdd,
        RunnerHostInvoke.certTrustRemove,
        RunnerHostInvoke.certTrustListPending,
        RunnerHostInvoke.certTrustDismissPending,
        RunnerHostInvoke.certTrustSystemDialog,
        RunnerHostInvoke.windowSetOverlayIcon,
        RunnerHostInvoke.displayList,
        RunnerHostInvoke.fileDropWriteTemporary,
        RunnerHostInvoke.fileDropCopyTemporary,
        RunnerHostInvoke.fileSave,
        RunnerHostInvoke.gpuAccelerationGet,
        RunnerHostInvoke.gpuAccelerationSet,
        RunnerHostInvoke.logLevelsGet,
        RunnerHostInvoke.logLevelsSet,
        RunnerHostInvoke.fontsList,
        RunnerHostInvoke.zoomGet,
        RunnerHostInvoke.zoomSet,
        RunnerHostInvoke.zoomStepIn,
        RunnerHostInvoke.zoomStepOut,
        RunnerHostInvoke.zoomReset,
      ].sort(),
    );
    bridge.dispose();
  });

  it("releases sleep prevention when the renderer process disappears", async () => {
    const mod = await import("../register-runner-ipc");
    const electron = await import("electron");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const handler = ipcMainState.handlers.get(
      RunnerHostInvoke.powerSetSleepBlocked,
    );
    if (handler === undefined) {
      throw new Error("power handler missing");
    }
    const webContents = Object.assign(new EventEmitter(), { id: 0 });

    await handler({ sender: webContents, senderFrame: { parent: null } }, true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledWith(
      "prevent-app-suspension",
    );

    webContents.emit(
      "render-process-gone",
      {},
      {
        reason: "crashed",
        exitCode: 1,
      },
    );

    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledWith(1);
    bridge.dispose();
  });

  it("opens the native folder picker with multi-select directory support", async () => {
    const mod = await import("../register-runner-ipc");
    const electron = await import("electron");
    const showOpenDialog = vi.mocked(electron.dialog.showOpenDialog);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/project-a", "/tmp/project-b"],
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const handler = ipcMainState.handlers.get(
      RunnerHostInvoke.workspaceFoldersPick,
    );
    expect(handler).toBeDefined();
    if (handler === undefined) {
      return;
    }

    await expect(handler(bareEvent())).resolves.toEqual([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    });
    bridge.dispose();
  });

  it("saves renderer-provided bytes through the native save dialog", async () => {
    const mod = await import("../register-runner-ipc");
    const electron = await import("electron");
    const dir = await mkdtemp(join(tmpdir(), "traycer-file-save-"));
    const target = join(dir, "diagram.png");
    const showSaveDialog = vi.mocked(electron.dialog.showSaveDialog);
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: target,
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const handler = ipcMainState.handlers.get(RunnerHostInvoke.fileSave);
    if (handler === undefined) {
      throw new Error("file save handler missing");
    }

    await expect(
      handler(bareEvent(), {
        name: "mermaid-diagram.png",
        type: "image/png",
        bytes: new Uint8Array([1, 2, 3]).buffer,
      }),
    ).resolves.toBe("diagram.png");
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "mermaid-diagram.png",
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await rm(dir, { recursive: true, force: true });
    bridge.dispose();
  });

  it("returns null when the native save dialog is cancelled", async () => {
    const mod = await import("../register-runner-ipc");
    const electron = await import("electron");
    const showSaveDialog = vi.mocked(electron.dialog.showSaveDialog);
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const handler = ipcMainState.handlers.get(RunnerHostInvoke.fileSave);
    if (handler === undefined) {
      throw new Error("file save handler missing");
    }

    await expect(
      handler(bareEvent(), {
        name: "mermaid-diagram.png",
        type: "image/png",
        bytes: new Uint8Array([1, 2, 3]).buffer,
      }),
    ).resolves.toBeNull();
    bridge.dispose();
  });

  it("claims and releases epic ownership through sender-scoped IPC", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const ownership = new EpicWindowOwnership(null);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    const claimHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.ownershipClaim,
    );
    const releaseHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.ownershipRelease,
    );
    if (claimHandler === undefined || releaseHandler === undefined) {
      throw new Error("ownership handlers missing");
    }

    expect(
      await Promise.resolve(claimHandler(sender(101), "tab-a", "epic-a")),
    ).toEqual({ ok: true });
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
    ]);
    expect(windowA.sentMessages).toContainEqual({
      channel: RunnerHostEvent.ownershipChange,
      payload: [{ tabId: "tab-a", epicId: "epic-a", windowId: "window-a" }],
    });
    expect(windowB.sentMessages).toContainEqual({
      channel: RunnerHostEvent.ownershipChange,
      payload: [{ tabId: "tab-a", epicId: "epic-a", windowId: "window-a" }],
    });

    expect(
      await Promise.resolve(claimHandler(sender(202), "tab-a", "epic-a")),
    ).toEqual({ ok: false, currentOwner: "window-a" });
    expect(registry.mostRecentlyFocusedId()).toBe("window-a");

    await releaseHandler(sender(202), "tab-a");
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
    ]);

    await releaseHandler(sender(101), "tab-a");
    expect(ownership.snapshot()).toEqual([]);
    expect(windowA.sentMessages).toContainEqual({
      channel: RunnerHostEvent.ownershipChange,
      payload: [],
    });
    bridge.dispose();
  });

  it("removes closed windows from per-window restore state and ownership", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const ownership = new EpicWindowOwnership(null);
    ownership.claim("tab-a", "epic-a", "window-a");
    ownership.claim("tab-b", "epic-b", "window-b");
    const perWindowState = new PerWindowState(null);
    perWindowState.update("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    perWindowState.update("window-b", {
      epicTabs: [{ id: "tab-b", epicId: "epic-b", name: "Beta" }],
      activeTabId: "tab-b",
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState,
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    const closeHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.windowsRequestClose,
    );
    if (closeHandler === undefined) {
      throw new Error("windowsRequestClose handler missing");
    }

    await closeHandler(sender(202), "window-b");

    expect(registry.closeRequests).toEqual(["window-b"]);
    expect(perWindowState.get("window-a")).toMatchObject({
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    expect(perWindowState.get("window-b")).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
    ]);
    expect(windowA.sentMessages).toContainEqual({
      channel: RunnerHostEvent.windowsChange,
      payload: [
        {
          windowId: "window-a",
          title: "window-a",
          isFocused: true,
          isVisible: true,
        },
      ],
    });
    bridge.dispose();
  });

  it("moves an owned Epic into a prepared new window through the canonical open-in-new-window IPC", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const ownership = new EpicWindowOwnership(null);
    const perWindowState = new PerWindowState(null);
    ownership.claim("tab-a", "epic-a", "window-a");
    perWindowState.update("window-a", {
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Alpha" },
        { id: "tab-b", epicId: "epic-b", name: "Beta" },
      ],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { root: null, activeTileId: null } },
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState,
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const openHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
    );
    if (openHandler === undefined) {
      throw new Error("open-in-new-window handler missing");
    }

    await expect(
      Promise.resolve(openHandler(sender(101), "epic-a", "Ignored", "tab-a")),
    ).resolves.toEqual({ result: "moved", windowId: "created-1" });

    expect(registry.initialRoutes).toEqual(["/epics/epic-a/tab-a"]);
    expect(registry.mostRecentlyFocusedId()).toBe("created-1");
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "created-1" },
    ]);
    expect(perWindowState.get("window-a")).toMatchObject({
      epicTabs: [{ id: "tab-b", epicId: "epic-b", name: "Beta" }],
      activeTabId: "tab-b",
    });
    expect(perWindowState.get("window-a").canvasByTabId).toEqual({});
    expect(perWindowState.get("created-1")).toEqual({
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { root: null, activeTileId: null } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    bridge.dispose();
  });

  it("rolls back ownership and destination state when the move destination fails to load", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    registry.createFailure = new Error("load failed");
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const ownership = new EpicWindowOwnership(null);
    const perWindowState = new PerWindowState(null);
    ownership.claim("tab-a", "epic-a", "window-a");
    perWindowState.update("window-a", {
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Alpha" },
        { id: "tab-b", epicId: "epic-b", name: "Beta" },
      ],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { root: null, activeTileId: null } },
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState,
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const openHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
    );
    if (openHandler === undefined) {
      throw new Error("open-in-new-window handler missing");
    }

    await expect(
      Promise.resolve(openHandler(sender(101), "epic-a", "Ignored", "tab-a")),
    ).rejects.toThrow("load failed");

    expect(registry.closeRequests).toEqual([]);
    expect(registry.forceCloseRequests).toEqual(["created-1"]);
    expect(registry.getRecordById("created-1")).toBeNull();
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
    ]);
    expect(perWindowState.get("window-a")).toEqual({
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Alpha" },
        { id: "tab-b", epicId: "epic-b", name: "Beta" },
      ],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { root: null, activeTileId: null } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    expect(perWindowState.get("created-1")).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    bridge.dispose();
  });

  it("focuses the existing owner instead of duplicating an already-open Epic", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const ownership = new EpicWindowOwnership(null);
    ownership.claim("tab-a", "epic-a", "window-b");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const openHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
    );
    if (openHandler === undefined) {
      throw new Error("open-in-new-window handler missing");
    }

    await expect(
      Promise.resolve(openHandler(sender(101), "epic-a", "Alpha", "tab-a")),
    ).resolves.toEqual({ result: "focused", windowId: "window-b" });

    expect(registry.createCount).toBe(0);
    expect(registry.mostRecentlyFocusedId()).toBe("window-b");
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-b" },
    ]);
    bridge.dispose();
  });

  it("delivers the payload-free browser-return signal over the authCallback channel", async () => {
    const mod = await import("../register-runner-ipc");
    const host = new FakeHost();
    const bridge = new mod.RunnerIpcBridge({
      host,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    bridge.deliverAuthReturnSignal();
    bridge.deliverAuthReturnSignal();

    const callbacks = sentMessages.filter(
      (m) => m.channel === RunnerHostEvent.authCallback,
    );
    // The renderer turns each signal into a poll nudge; the channel carries no
    // token or code, so the payload is undefined.
    expect(callbacks).toEqual([
      { channel: RunnerHostEvent.authCallback, payload: undefined },
      { channel: RunnerHostEvent.authCallback, payload: undefined },
    ]);
    bridge.dispose();
  });

  it("routes auth callbacks to the MRU window when a registry is installed", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    registry.focusById("window-a");
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    bridge.deliverAuthReturnSignal();

    expect(windowA.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.authCallback,
        payload: undefined,
      },
    ]);
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.trayEpicSelected,
      ),
    ).toEqual([]);
    bridge.dispose();
  });

  it("routes tray epic selections to the owning window and falls back to MRU", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const ownership = new EpicWindowOwnership(null);
    ownership.claim("tab-owned", "epic-owned", "window-a");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership,
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    registry.focusById("window-b");
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    bridge.deliverTrayEpicSelected("epic-owned");
    expect(registry.mostRecentlyFocusedId()).toBe("window-a");
    expect(
      windowA.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.trayEpicSelected,
      ),
    ).toEqual([
      {
        channel: RunnerHostEvent.trayEpicSelected,
        payload: "epic-owned",
      },
    ]);
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.trayEpicSelected,
      ),
    ).toEqual([]);

    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    registry.focusById("window-b");
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    bridge.deliverTrayEpicSelected("unowned-epic");
    expect(registry.mostRecentlyFocusedId()).toBe("window-b");
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.trayEpicSelected,
      ),
    ).toEqual([
      {
        channel: RunnerHostEvent.trayEpicSelected,
        payload: "unowned-epic",
      },
    ]);
    expect(
      windowA.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.trayEpicSelected,
      ),
    ).toEqual([]);
    bridge.dispose();
  });

  it("falls back to MRU only for renderer-hosted dialog menu commands", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    windowA.setFocused(true);
    windowB.setFocused(false);
    expect(bridge.dispatchMenuCommand("app.openLogs")).toBe(true);
    expect(windowA.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: { command: "app.openLogs", windowId: "window-a" },
      },
    ]);
    expect(windowB.sentMessages).toEqual([]);

    windowA.setFocused(false);
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    expect(bridge.dispatchMenuCommand("app.aboutDetails")).toBe(true);
    expect(registry.mostRecentlyFocusedId()).toBe("window-b");
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.menuCommand,
      ),
    ).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: { command: "app.aboutDetails", windowId: "window-b" },
      },
    ]);
    windowB.setFocused(false);
    windowB.sentMessages.length = 0;
    expect(bridge.dispatchMenuCommand("epic.openInNewWindow")).toBe(true);
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.menuCommand,
      ),
    ).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: { command: "epic.openInNewWindow", windowId: "window-b" },
      },
    ]);
    windowB.sentMessages.length = 0;
    // Tray "Update available: <ver> - Install" can fire with no focused
    // renderer (tray click while another app is foregrounded). The
    // dispatcher must fall back to the MRU renderer so the in-app install
    // mutation still runs.
    expect(bridge.dispatchMenuCommand("host.installUpdate")).toBe(true);
    expect(
      windowB.sentMessages.filter(
        (message) => message.channel === RunnerHostEvent.menuCommand,
      ),
    ).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: {
          command: "host.installUpdate",
          windowId: "window-b",
        },
      },
    ]);
    bridge.dispose();
  });

  it("does not fall back to MRU for focused-window menu commands", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    expect(bridge.dispatchMenuCommand("epic.closeTab")).toBe(false);
    expect(bridge.dispatchMenuCommand("window.closeWindow")).toBe(false);
    expect(bridge.dispatchMenuCommand("app.openSettings")).toBe(false);
    expect(windowA.sentMessages).toEqual([]);
    expect(windowB.sentMessages).toEqual([]);

    windowB.setFocused(true);
    expect(bridge.dispatchMenuCommand("epic.closeTab")).toBe(true);
    expect(windowB.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: { command: "epic.closeTab", windowId: "window-b" },
      },
    ]);
    windowB.sentMessages.length = 0;
    expect(bridge.dispatchMenuCommand("window.closeWindow")).toBe(true);
    expect(windowB.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.menuCommand,
        payload: { command: "window.closeWindow", windowId: "window-b" },
      },
    ]);
    bridge.dispose();
  });

  it("aggregates per-window unsynced snapshots and asks only the MRU window for quit", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const setSnapshotHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.setUnsyncedEditsSnapshot,
    );
    const respondHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.respondToQuitRequest,
    );
    if (setSnapshotHandler === undefined || respondHandler === undefined) {
      throw new Error("appLifecycle handlers missing");
    }

    await setSnapshotHandler(sender(101), [
      { epicId: "epic-a", title: "Alpha", queueSize: 0, isDirty: true },
    ]);
    await setSnapshotHandler(sender(202), [
      { epicId: "epic-b", title: "Beta", queueSize: 2, isDirty: true },
    ]);
    expect(bridge.hasUnsyncedEdits()).toBe(true);
    expect(bridge.getUnsyncedEditsSnapshot()).toEqual([
      { epicId: "epic-a", title: "Alpha", queueSize: 0, isDirty: true },
      { epicId: "epic-b", title: "Beta", queueSize: 2, isDirty: true },
    ]);

    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    registry.focusById("window-b");
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    const decision = bridge.requestQuitDecision(
      bridge.getUnsyncedEditsSnapshot(),
    );

    expect(windowA.sentMessages).toEqual([]);
    expect(windowB.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.quitRequested,
        payload: {
          requestId: expect.any(String),
          snapshot: [
            { epicId: "epic-a", title: "Alpha", queueSize: 0, isDirty: true },
            { epicId: "epic-b", title: "Beta", queueSize: 2, isDirty: true },
          ],
        },
      },
    ]);

    await respondHandler(sender(202), "userConfirmedDiscard");
    await expect(decision).resolves.toBe("userConfirmedDiscard");
    bridge.dispose();
  });

  it("fails closed when dirty snapshots exist but the MRU renderer is not lifecycle-ready", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    registry.add("window-a", 101, buildWindow());
    registry.add("window-b", 202, buildWindow());
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const setSnapshotHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.setUnsyncedEditsSnapshot,
    );
    if (setSnapshotHandler === undefined) {
      throw new Error("setUnsyncedEditsSnapshot handler missing");
    }
    await setSnapshotHandler(sender(101), [
      { epicId: "epic-a", title: "Alpha", queueSize: 1, isDirty: true },
    ]);
    registry.focusById("window-b");

    await expect(
      bridge.requestQuitDecision(bridge.getUnsyncedEditsSnapshot()),
    ).rejects.toThrow(/app-lifecycle readiness/);
    bridge.dispose();
  });

  it("scopes outbound events and host subscriptions to each bridge window", async () => {
    const mod = await import("../register-runner-ipc");
    const hostA = new FakeHost();
    const hostB = new FakeHost();
    const windowA = buildWindow();
    const windowB = buildWindow();
    const bridgeA = new mod.RunnerIpcBridge({
      host: hostA,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: windowA,
    });
    const bridgeB = new mod.RunnerIpcBridge({
      host: hostB,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: windowB,
    });
    bridgeA.install();
    bridgeB.install();
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    bridgeA.deliverAuthReturnSignal();
    bridgeB.deliverNotificationClick({ epicId: "epic-b" });
    hostA.setSnapshot({
      hostId: "host-a",
      websocketUrl: "ws://127.0.0.1:9001/rpc",
      version: "0.1.0",
      pid: 1001,
      systemHostName: "host-a",
      displayName: "host-a",
    });
    hostB.setSnapshot({
      hostId: "host-b",
      websocketUrl: "ws://127.0.0.1:9002/rpc",
      version: "0.1.0",
      pid: 1002,
      systemHostName: "host-b",
      displayName: "host-b",
    });
    bridgeA.deliverTrayEpicSelected("epic-a");

    expect(windowA.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.authCallback,
        payload: undefined,
      },
      {
        channel: RunnerHostEvent.localHostChange,
        payload: {
          hostId: "host-a",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          version: "0.1.0",
          pid: 1001,
          systemHostName: "host-a",
          displayName: "host-a",
        },
      },
      {
        channel: RunnerHostEvent.trayEpicSelected,
        payload: "epic-a",
      },
    ]);
    expect(windowB.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.notificationClick,
        payload: { epicId: "epic-b" },
      },
      {
        channel: RunnerHostEvent.localHostChange,
        payload: {
          hostId: "host-b",
          websocketUrl: "ws://127.0.0.1:9002/rpc",
          version: "0.1.0",
          pid: 1002,
          systemHostName: "host-b",
          displayName: "host-b",
        },
      },
    ]);

    bridgeA.dispose();
    windowA.sentMessages.length = 0;
    hostA.setSnapshot(null);
    expect(windowA.sentMessages).toEqual([]);

    bridgeB.dispose();
  });

  it("emits null on the localHostChange channel when the host disconnects", async () => {
    const mod = await import("../register-runner-ipc");
    const host = new FakeHost();
    host.setSnapshot({
      hostId: "local-1",
      websocketUrl: "ws://127.0.0.1:9000/rpc",
      version: "0.1.0",
      pid: 1234,
      systemHostName: "local-1",
      displayName: "local-1",
    });

    const bridge = new mod.RunnerIpcBridge({
      host,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const initial = sentMessages.find(
      (m) => m.channel === RunnerHostEvent.localHostChange,
    );
    expect(initial?.payload).not.toBeNull();

    sentMessages.length = 0;
    host.setSnapshot(null);

    const afterDisconnect = sentMessages.filter(
      (m) => m.channel === RunnerHostEvent.localHostChange,
    );
    expect(afterDisconnect).toEqual([
      { channel: RunnerHostEvent.localHostChange, payload: null },
    ]);
    bridge.dispose();
  });

  it("serves per-window state by sender and emits changes only to that window", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const getHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.perWindowStateGet,
    );
    const updateHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.perWindowStateUpdate,
    );
    const clearHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.perWindowStateClear,
    );
    if (
      getHandler === undefined ||
      updateHandler === undefined ||
      clearHandler === undefined
    ) {
      throw new Error("perWindowState handlers missing");
    }

    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    await updateHandler(sender(101), {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { layout: "left" } },
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          settings: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    const snapshot = {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { layout: "left" } },
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    };
    expect(await getHandler(sender(101))).toEqual(snapshot);
    expect(await getHandler(sender(202))).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    // window-a's OWN update is not echoed back to it (it already holds the
    // state it just sent); other windows never see it either.
    expect(windowA.sentMessages).toEqual([]);
    expect(windowB.sentMessages).toEqual([]);

    // clear by sender: removes window-a's snapshot, emits an empty snapshot to
    // window-a only, and leaves window-b untouched.
    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    const empty = {
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };
    await clearHandler(sender(101));
    expect(await getHandler(sender(101))).toEqual(empty);
    expect(windowA.sentMessages).toEqual([
      {
        channel: RunnerHostEvent.perWindowStateChange,
        payload: empty,
      },
    ]);
    expect(windowB.sentMessages).toEqual([]);
    bridge.dispose();
  });

  // Regression: a window must NOT receive its own `perWindowState.update`
  // echoed back. Per-window state is authored by the window itself; the window
  // already holds what it just sent. A delayed self-echo is pure staleness: if
  // it lands after a newer local edit it clobbers it - e.g. it resurrects a
  // landing draft the window closed a moment ago (a terminal agent "launches
  // empty", so the launch closes the draft while its create-echo is still in
  // flight, leaving a phantom "New" tab). Main still persists the update and
  // still pushes MAIN-initiated changes (restore, move-tab); it just stops
  // bouncing a window's own writes back at it.
  it("does not echo a window's own per-window update back to that window", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const perWindowState = new PerWindowState(null);
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState,
      authSession: new DesktopAuthSession(),
    });
    bridge.install();

    const getHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.perWindowStateGet,
    );
    const updateHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.perWindowStateUpdate,
    );
    if (getHandler === undefined || updateHandler === undefined) {
      throw new Error("perWindowState handlers missing");
    }

    windowA.sentMessages.length = 0;
    await updateHandler(sender(101), {
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          settings: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    // The window's own write is NOT bounced back to it.
    expect(windowA.sentMessages).toEqual([]);
    // Main still records the update (persistence + reads are unaffected).
    expect(await getHandler(sender(101))).toMatchObject({
      landingDrafts: [{ id: "draft-a" }],
      activeLandingDraftId: "draft-a",
    });
    bridge.dispose();
  });

  it("fans out desktop-global auth-session commits to every window", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    const authSession = new DesktopAuthSession();
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession,
    });
    bridge.install();

    const getHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.authSessionGet,
    );
    const setHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.authSessionSet,
    );
    if (getHandler === undefined || setHandler === undefined) {
      throw new Error("authSession handlers missing");
    }

    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;
    const signedIn: DesktopAuthSessionSnapshot = {
      status: "signed-in",
      token: "jwt",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    };
    await setHandler(sender(101), signedIn);

    expect(await getHandler(sender(202))).toEqual(signedIn);
    expect(authSession.get()).toEqual(signedIn);
    expect(windowA.sentMessages).toEqual([
      { channel: RunnerHostEvent.authSessionChange, payload: signedIn },
    ]);
    expect(windowB.sentMessages).toEqual([
      { channel: RunnerHostEvent.authSessionChange, payload: signedIn },
    ]);
    bridge.dispose();
  });

  it("awaits a terminal quit decision and defaults malformed payloads to proceed", async () => {
    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const respondHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.respondToQuitRequest,
    );
    const freshResponseHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.freshUnsyncedSnapshotResponse,
    );
    if (respondHandler === undefined || freshResponseHandler === undefined) {
      throw new Error("appLifecycle handlers missing");
    }

    const fresh = bridge.requestFreshUnsyncedSnapshot(200);

    const freshRequest = sentMessages.find(
      (m) => m.channel === RunnerHostEvent.getFreshUnsyncedSnapshot,
    );
    if (freshRequest === undefined) {
      throw new Error("getFreshUnsyncedSnapshot was not sent");
    }
    const { requestId } = freshRequest.payload as { requestId: string };
    const snapshot = [
      { epicId: "e-1", title: "Alpha", queueSize: 2, isDirty: true },
    ];
    await freshResponseHandler(bareEvent(), { requestId, snapshot });
    await expect(fresh).resolves.toEqual(snapshot);

    const decision = bridge.requestQuitDecision(snapshot);

    expect(sentMessages).toContainEqual({
      channel: RunnerHostEvent.quitRequested,
      payload: { requestId: expect.any(String), snapshot },
    });

    await respondHandler(bareEvent(), "not-a-quit-decision");

    await expect(decision).resolves.toBe("proceed");
    expect(log.warn).toHaveBeenCalledWith(
      "[runner-ipc] invalid quit decision from renderer; defaulting to proceed",
      { value: "not-a-quit-decision" },
    );
    bridge.dispose();
  });

  it("fails closed when the managed window cannot receive the quit intercept", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("../register-runner-ipc");
      const bridge = new mod.RunnerIpcBridge({
        host: new FakeHost(),
        authnBaseUrl: "http://localhost:5005",
        authRedirectUri: null,
        tray: null,
        zoomController: undefined,
        window: buildDestroyedWindow(),
      });
      bridge.install();

      const setSnapshotHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.setUnsyncedEditsSnapshot,
      );
      const respondHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.respondToQuitRequest,
      );
      if (setSnapshotHandler === undefined || respondHandler === undefined) {
        throw new Error("appLifecycle handlers missing");
      }

      await setSnapshotHandler(bareEvent(), [
        { epicId: "e-1", title: "Alpha", queueSize: 1, isDirty: true },
      ]);

      expect(sentMessages).toEqual([]);
      await expect(
        bridge.requestQuitDecision([
          { epicId: "e-1", title: "Alpha", queueSize: 1, isDirty: true },
        ]),
      ).rejects.toThrow(/cannot receive quit interception/);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the MRU renderer receives quitRequested but never services it", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("../register-runner-ipc");
      const bridge = new mod.RunnerIpcBridge({
        host: new FakeHost(),
        authnBaseUrl: "http://localhost:5005",
        authRedirectUri: null,
        tray: null,
        zoomController: undefined,
        window: buildWindow(),
      });
      bridge.install();

      const setSnapshotHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.setUnsyncedEditsSnapshot,
      );
      if (setSnapshotHandler === undefined) {
        throw new Error("setUnsyncedEditsSnapshot handler missing");
      }
      const snapshot = [
        { epicId: "e-1", title: "Alpha", queueSize: 1, isDirty: true },
      ];
      await setSnapshotHandler(bareEvent(), snapshot);
      sentMessages.length = 0;

      const decision = bridge.requestQuitDecision(snapshot);

      expect(sentMessages).toEqual([
        {
          channel: RunnerHostEvent.quitRequested,
          payload: { requestId: expect.any(String), snapshot },
        },
      ]);

      const rejection = expect(decision).rejects.toThrow(
        /did not acknowledge servicing/,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps acknowledged wait-for-sync requests open and cleans up across retries", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("../register-runner-ipc");
      const bridge = new mod.RunnerIpcBridge({
        host: new FakeHost(),
        authnBaseUrl: "http://localhost:5005",
        authRedirectUri: null,
        tray: null,
        zoomController: undefined,
        window: buildWindow(),
      });
      bridge.install();

      const setSnapshotHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.setUnsyncedEditsSnapshot,
      );
      const acknowledgeHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.acknowledgeQuitRequest,
      );
      const respondHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.respondToQuitRequest,
      );
      if (
        setSnapshotHandler === undefined ||
        acknowledgeHandler === undefined ||
        respondHandler === undefined
      ) {
        throw new Error("appLifecycle handlers missing");
      }
      const snapshot = [
        { epicId: "e-1", title: "Alpha", queueSize: 2, isDirty: true },
      ];
      await setSnapshotHandler(bareEvent(), snapshot);
      sentMessages.length = 0;

      const first = bridge.requestQuitDecision(snapshot);
      const firstRequestId = readQuitRequestId(sentMessages.at(-1));
      await acknowledgeHandler(bareEvent(), firstRequestId);
      await vi.advanceTimersByTimeAsync(5_000);

      const sentinel = Symbol("still-waiting");
      await expect(
        Promise.race([first, Promise.resolve(sentinel)]),
      ).resolves.toBe(sentinel);

      const firstRejection = expect(first).rejects.toThrow(/superseded/);
      const second = bridge.requestQuitDecision(snapshot);
      await firstRejection;
      await respondHandler(bareEvent(), {
        requestId: firstRequestId,
        decision: "userConfirmedDiscard",
      });
      const secondRejection = expect(second).rejects.toThrow(
        /did not acknowledge servicing/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await secondRejection;

      const third = bridge.requestQuitDecision(snapshot);
      const thirdRequestId = readQuitRequestId(sentMessages.at(-1));
      await acknowledgeHandler(bareEvent(), thirdRequestId);
      await respondHandler(bareEvent(), {
        requestId: thirdRequestId,
        decision: "userConfirmedDiscard",
      });
      await expect(third).resolves.toBe("userConfirmedDiscard");
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("correlates freshUnsyncedSnapshotResponse by requestId and ignores ambient pushes", async () => {
    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const freshResponseHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.freshUnsyncedSnapshotResponse,
    );
    const setSnapshotHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.setUnsyncedEditsSnapshot,
    );
    if (
      freshResponseHandler === undefined ||
      setSnapshotHandler === undefined
    ) {
      throw new Error("appLifecycle handlers missing");
    }

    const inFlight = bridge.requestFreshUnsyncedSnapshot(5000);
    const freshRequest = sentMessages.find(
      (m) => m.channel === RunnerHostEvent.getFreshUnsyncedSnapshot,
    );
    if (freshRequest === undefined) {
      throw new Error("getFreshUnsyncedSnapshot was not sent");
    }
    const { requestId } = freshRequest.payload as { requestId: string };

    // An ambient `setUnsyncedEditsSnapshot` push arrives while the request is
    // in flight - it MUST NOT settle the in-flight fresh-snapshot promise.
    await setSnapshotHandler(bareEvent(), [
      { epicId: "ambient", title: "Ambient", queueSize: 1, isDirty: true },
    ]);

    // A reply with a non-matching requestId also MUST NOT resolve the waiter.
    await freshResponseHandler(bareEvent(), {
      requestId: "mismatched-id",
      snapshot: [
        { epicId: "wrong", title: "Wrong", queueSize: 9, isDirty: true },
      ],
    });

    // Race the promise against a microtask - it must still be pending.
    const sentinel = Symbol("pending");
    const raceResult = await Promise.race([
      inFlight,
      Promise.resolve(sentinel),
    ]);
    expect(raceResult).toBe(sentinel);

    // The correct requestId resolves the waiter.
    const authoritative = [
      { epicId: "authoritative", title: "Auth", queueSize: 3, isDirty: true },
    ];
    await freshResponseHandler(bareEvent(), {
      requestId,
      snapshot: authoritative,
    });

    await expect(inFlight).resolves.toEqual(authoritative);
    expect(bridge.getUnsyncedEditsSnapshot()).toEqual(authoritative);
    bridge.dispose();
  });

  it("falls back to the cached ambient snapshot after the fresh-query timeout", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("../register-runner-ipc");
      const bridge = new mod.RunnerIpcBridge({
        host: new FakeHost(),
        authnBaseUrl: "http://localhost:5005",
        authRedirectUri: null,
        tray: null,
        zoomController: undefined,
        window: buildWindow(),
      });
      bridge.install();

      const setSnapshotHandler = ipcMainState.handlers.get(
        RunnerHostInvoke.setUnsyncedEditsSnapshot,
      );
      if (setSnapshotHandler === undefined) {
        throw new Error("setUnsyncedEditsSnapshot handler missing");
      }
      const cached = [
        { epicId: "cached", title: "Cached", queueSize: 0, isDirty: true },
      ];
      await setSnapshotHandler(bareEvent(), cached);

      const inFlight = bridge.requestFreshUnsyncedSnapshot(200);

      await vi.advanceTimersByTimeAsync(200);

      await expect(inFlight).resolves.toEqual(cached);
      // The cached snapshot is left untouched on timeout.
      expect(bridge.getUnsyncedEditsSnapshot()).toEqual(cached);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hasUnsyncedEdits is driven by isDirty, not queueSize", async () => {
    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const setSnapshotHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.setUnsyncedEditsSnapshot,
    );
    if (setSnapshotHandler === undefined) {
      throw new Error("setUnsyncedEditsSnapshot handler missing");
    }

    // queueSize=0 but isDirty=true MUST intercept.
    await setSnapshotHandler(bareEvent(), [
      { epicId: "e-1", title: "Alpha", queueSize: 0, isDirty: true },
    ]);
    expect(bridge.hasUnsyncedEdits()).toBe(true);

    // queueSize>0 but isDirty=false MUST NOT intercept.
    await setSnapshotHandler(bareEvent(), [
      { epicId: "e-2", title: "Beta", queueSize: 5, isDirty: false },
    ]);
    expect(bridge.hasUnsyncedEdits()).toBe(false);

    // Entries missing `isDirty` are rejected by the parser, leaving no dirty
    // entries behind.
    await setSnapshotHandler(bareEvent(), [
      { epicId: "e-3", title: "Gamma", queueSize: 1 },
    ]);
    expect(bridge.hasUnsyncedEdits()).toBe(false);

    bridge.dispose();
  });

  it("debounces host-picker state and only emits on transitions", async () => {
    const mod = await import("../register-runner-ipc");
    const host = new FakeHost();
    const bridge = new mod.RunnerIpcBridge({
      host,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    sentMessages.length = 0;
    const openHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.hostPickerRequestOpen,
    );
    const closeHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.hostPickerRequestClose,
    );
    expect(openHandler).toBeDefined();
    expect(closeHandler).toBeDefined();
    if (openHandler === undefined || closeHandler === undefined) {
      return;
    }

    await openHandler(bareEvent());
    await openHandler(bareEvent());
    await closeHandler(bareEvent());

    const pickerEvents = sentMessages.filter(
      (m) => m.channel === RunnerHostEvent.hostPickerChange,
    );
    expect(pickerEvents).toEqual([
      { channel: RunnerHostEvent.hostPickerChange, payload: true },
      { channel: RunnerHostEvent.hostPickerChange, payload: false },
    ]);
    bridge.dispose();
  });

  it("validates auth tokens through the main-process HTTP helper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                name: "Desktop User",
                providerHandle: "desktop-user",
                email: "desktop@example.com",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const validateHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.validateAuthToken,
    );
    if (validateHandler === undefined) {
      throw new Error("validateAuthToken handler missing");
    }

    await expect(
      validateHandler(bareEvent(), "jwt-abc", "jwt-abc-refresh"),
    ).resolves.toEqual({
      kind: "valid",
      profile: {
        userId: "",
        userName: "Desktop User",
        email: "desktop@example.com",
      },
    });

    bridge.dispose();
  });

  it("validates full auth identities through the main-process HTTP helper", async () => {
    const user = createAuthenticatedUserFixture(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(user), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const validateHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.validateAuthTokenIdentity,
    );
    if (validateHandler === undefined) {
      throw new Error("validateAuthTokenIdentity handler missing");
    }

    await expect(
      validateHandler(bareEvent(), "jwt-identity", "jwt-identity-refresh"),
    ).resolves.toMatchObject({
      kind: "valid",
      user: {
        user: {
          id: "user-fixture-1",
          providerHandle: "testuser",
        },
      },
    });

    bridge.dispose();
  });

  it("routes requestHostRespawn to HostLifecycle.respawn()", async () => {
    const mod = await import("../register-runner-ipc");
    const host = new FakeHost();
    const bridge = new mod.RunnerIpcBridge({
      host,
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    const respawnHandler = ipcMainState.handlers.get(
      RunnerHostInvoke.requestHostRespawn,
    );
    if (respawnHandler === undefined) {
      throw new Error("requestHostRespawn handler missing");
    }
    await respawnHandler(bareEvent());
    await respawnHandler(bareEvent());
    expect(host.respawnCalls).toBe(2);
    bridge.dispose();
  });

  it("serves authnBaseUrl synchronously via ipcMain.on", async () => {
    const mod = await import("../register-runner-ipc");
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "https://authn.example.invalid",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      window: buildWindow(),
    });
    bridge.install();

    expect(invokeSync(RunnerHostSync.authnBaseUrl)).toBe(
      "https://authn.example.invalid",
    );
    bridge.dispose();
    // After dispose the listener is removed - next invocation throws.
    expect(() => invokeSync(RunnerHostSync.authnBaseUrl)).toThrow();
  });

  it("serves windowId synchronously and replays current bridge state to that window", async () => {
    const mod = await import("../register-runner-ipc");
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const perWindowState = new PerWindowState(null);
    perWindowState.update("window-a", {
      activeTabId: "tab-a",
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
    });
    const authSession = new DesktopAuthSession();
    authSession.set({
      status: "signed-in",
      token: "jwt",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    });
    const bridge = new mod.RunnerIpcBridge({
      host: new FakeHost(),
      authnBaseUrl: "https://authn.example.invalid",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      windowRegistry: registry,
      ownership: new EpicWindowOwnership(null),
      perWindowState,
      authSession,
    });
    bridge.install();
    windowA.sentMessages.length = 0;

    expect(invokeSyncWithSender(RunnerHostSync.windowId, 101)).toBe("window-a");

    expect(windowA.sentMessages).toEqual([
      { channel: RunnerHostEvent.localHostChange, payload: null },
      {
        channel: RunnerHostEvent.windowsChange,
        payload: [
          {
            windowId: "window-a",
            title: "window-a",
            isFocused: true,
            isVisible: true,
          },
        ],
      },
      { channel: RunnerHostEvent.ownershipChange, payload: [] },
      {
        channel: RunnerHostEvent.perWindowStateChange,
        payload: {
          epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
          activeTabId: "tab-a",
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        },
      },
      {
        channel: RunnerHostEvent.authSessionChange,
        payload: {
          status: "signed-in",
          token: "jwt",
          profile: {
            userId: "test-user",
            userName: "Test User",
            email: "test@example.com",
          },
        },
      },
      {
        channel: RunnerHostEvent.appUpdateChange,
        payload: {
          sequence: 0,
          status: "idle",
          currentVersion: "1.0.0",
          latestVersion: null,
          downloadProgress: null,
          installBlockedReason: null,
          installGuidance: null,
          errorMessage: null,
          lastCheckedAt: null,
          lastCheckIntent: null,
        },
      },
      { channel: RunnerHostEvent.zoomChange, payload: 100 },
    ]);
    bridge.dispose();
  });
});
