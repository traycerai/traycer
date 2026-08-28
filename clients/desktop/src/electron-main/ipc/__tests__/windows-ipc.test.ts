import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../../ipc-contracts/host-types";
import type {
  IpcHostController,
  IpcManagedWindow,
  IpcWindowRecord,
  IpcWindowRegistry,
} from "../runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  HostControllerStatus,
  LifecycleAdmissionBlock,
  InstallVersionOk,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../../host/host-controller-types";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { EpicWindowOwnership } from "../../windows/epic-window-ownership";
import { PerWindowState } from "../../windows/per-window-state";
import type {
  PerWindowLandingDraft,
  WindowSummary,
} from "../../../ipc-contracts/window-types";
import { shouldPreserveClosedWindowSnapshot } from "../windows-ipc";

describe("shouldPreserveClosedWindowSnapshot", () => {
  it("prunes a deliberate mid-session close (not quitting, other windows remain)", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: false,
        remainingWindowCount: 2,
      }),
    ).toBe(false);
  });

  it("preserves the last-window close (Win/Linux window-all-closed race, macOS red-light close)", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: false,
        remainingWindowCount: 0,
      }),
    ).toBe(true);
  });

  it("preserves every closing window while quitting, even when others remain", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: true,
        remainingWindowCount: 2,
      }),
    ).toBe(true);
  });

  it("preserves a quit that also happens to close the last window", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: true,
        remainingWindowCount: 0,
      }),
    ).toBe(true);
  });
});

/**
 * `openDraftInNewWindow` (`RunnerHostInvoke.windowsRequestOpenDraftInNewWindow`)
 * coverage. Harness style copied verbatim from `runner-ipc.test.ts`'s Epic
 * open-in-new-window suite (`FakeWindowRegistry`, `buildWindow`, `sender`,
 * `FakeHost`/`FakeHostController` doubles, the `electron` module mock) - that
 * is the established pattern for driving `RunnerIpcBridge.install()` handlers
 * without a real Electron runtime, and the draft move is structurally the
 * same handler shape (source snapshot read, `windowRegistry.create` with a
 * `beforeLoad` seed, source patch, rollback-on-throw).
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
}

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "1.0.0",
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
    on: (_event: string, _listener: unknown): void => undefined,
    off: (_event: string, _listener: unknown): void => undefined,
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (_value: string): Buffer => Buffer.from("", "utf8"),
    decryptString: (_buf: Buffer): string => "",
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve("")),
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

class FakeHost {
  private snapshot: DesktopPublishedHostSnapshot | null = null;
  pidMetadataFile = "/tmp/fake-traycer-host-windows-ipc/pid.json";
  identityEnrollmentFile =
    "/tmp/fake-traycer-host-windows-ipc/identity/enrollment.json";
  isDisposed = false;
  private readonly listeners = new Set<
    (snapshot: DesktopPublishedHostSnapshot | null) => void
  >();

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return this.snapshot;
  }
  on(
    _event: "change",
    listener: (snapshot: DesktopPublishedHostSnapshot | null) => void,
  ): void {
    this.listeners.add(listener);
  }
  off(
    _event: "change",
    listener: (snapshot: DesktopPublishedHostSnapshot | null) => void,
  ): void {
    this.listeners.delete(listener);
  }
  noteEndpointAnswered(): void {}
  notifyRespawning(): void {}
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return this.snapshot;
  }
  ensureWatcherInstalled(): void {}
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

const FAKE_HOST_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.0.0",
  latestVersion: "1.0.0",
  stagedVersion: null,
  installedRuntimeVersion: "1.0.0",
  runningRuntimeVersion: "1.0.0",
  updateReady: false,
  activation: "activated",
  reachable: true,
  removedByUser: false,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Structural double for `IpcHostController` - this suite exercises the
 * bridge's windows IPC surface, not `HostController` itself, so every
 * method just resolves a plausible "ok" outcome.
 */
class FakeHostController implements IpcHostController {
  readonly lifecycleAdmissionBlock: LifecycleAdmissionBlock | null = null;
  async getStatus(): Promise<HostControllerStatus> {
    return FAKE_HOST_CONTROLLER_STATUS;
  }
  async convergeReady(
    _force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return { kind: "ok", value: { running: true, version: "1.0.0" } };
  }
  async stageLatest(): Promise<void> {}
  async applyStaged(
    _trigger: ApplyStagedTrigger,
    _force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return {
      kind: "ok",
      value: { appliedVersion: "1.0.0", runningActivated: true },
    };
  }
  async activateInstalled(
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async installVersion(
    pin: string,
    _force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return {
      kind: "ok",
      value: { installedVersion: pin, runningActivated: true },
    };
  }
  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: true } };
  }
  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: false } };
  }
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    return { kind: "suppressed" };
  }
  async freePortAndRestart(
    _pid: number | null,
    _port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async uninstallHost(_all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return {
      kind: "ok",
      value: {
        removedInstallDir: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
      },
    };
  }
  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    return {
      kind: "ok",
      value: {
        removedHost: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
        removedLoginItem: false,
      },
    };
  }
  isPendingRevisionRefreshQuarantined(): boolean {
    return false;
  }
  onMutationProgress(
    _listener: (progress: MutationProgress) => void,
  ): () => void {
    return () => undefined;
  }
}

function buildWindow(): CapturingWindow {
  const messages: SentMessage[] = [];
  return {
    sentMessages: messages,
    isDestroyed: () => false,
    isFocused: () => false,
    isVisible: () => true,
    show: () => undefined,
    focus: () => undefined,
    webContents: {
      send: (channel: string, payload: unknown): void => {
        messages.push({ channel, payload });
      },
    },
  };
}

/** Mirrors `runner-ipc.test.ts`'s `FakeWindowRegistry`, including the
 * `createFailure` knob the destination-throw test needs: `create()` always
 * runs `beforeLoad` (matching the real registry seeding the destination
 * BEFORE the window finishes loading) and only rejects afterward. */
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
    senderFrame: { parent: null },
  };
}

function buildDraft(id: string): PerWindowLandingDraft {
  return {
    id,
    content: { type: "doc" },
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: null,
    workspace: null,
  };
}

async function buildBridge(registry: FakeWindowRegistry) {
  const mod = await import("../register-runner-ipc");
  const perWindowState = new PerWindowState(null);
  const bridge = new mod.RunnerIpcBridge({
    host: new FakeHost(),
    hostController: new FakeHostController(),
    authnBaseUrl: "http://localhost:5005",
    authRedirectUri: null,
    tray: null,
    zoomController: undefined,
    authTokenStore: undefined,
    windowRegistry: registry,
    ownership: new EpicWindowOwnership(null),
    perWindowState,
    authSession: new DesktopAuthSession(),
    quitState: undefined,
  });
  return { bridge, perWindowState };
}

function draftOpenHandler(): InvokeHandler {
  const handler = ipcMainState.handlers.get(
    RunnerHostInvoke.windowsRequestOpenDraftInNewWindow,
  );
  if (handler === undefined) {
    throw new Error("open-draft-in-new-window handler missing");
  }
  return handler;
}

beforeEach(() => {
  ipcMainState.handlers.clear();
  ipcMainState.syncListeners.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("openDraftInNewWindow (windowsRequestOpenDraftInNewWindow)", () => {
  it("moves the draft into a freshly created window, seeding it before the source is pruned", async () => {
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const { bridge, perWindowState } = await buildBridge(registry);
    const draftA = buildDraft("draft-a");
    const draftB = buildDraft("draft-b");
    perWindowState.update("window-a", {
      landingDrafts: [draftA, draftB],
      activeLandingDraftId: "draft-a",
    });
    bridge.install();

    const handler = draftOpenHandler();

    await expect(
      Promise.resolve(handler(sender(101), "draft-a")),
    ).resolves.toEqual({ result: "moved", windowId: "created-1" });

    expect(registry.initialRoutes).toEqual(["/draft/draft-a"]);
    expect(registry.mostRecentlyFocusedId()).toBe("created-1");

    // Source: the moved draft is pruned and the active pointer (which named
    // it) is nulled; the other draft is untouched.
    expect(perWindowState.get("window-a")).toMatchObject({
      landingDrafts: [draftB],
      activeLandingDraftId: null,
    });

    // Destination: seeded exactly per the epic-move sibling shape, minus
    // ownership - epicTabs/canvasByTabId/activeTabId are the empty defaults,
    // and the moved draft is the sole landing draft, active.
    expect(perWindowState.get("created-1")).toEqual({
      revision: 1,
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [draftA],
      activeLandingDraftId: "draft-a",
      tabStripLayout: null,
      activeRoute: null,
    });
    bridge.dispose();
  });

  it("does not null the source's active-draft pointer when a DIFFERENT draft stayed active", async () => {
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const { bridge, perWindowState } = await buildBridge(registry);
    const draftA = buildDraft("draft-a");
    const draftB = buildDraft("draft-b");
    perWindowState.update("window-a", {
      landingDrafts: [draftA, draftB],
      activeLandingDraftId: "draft-b",
    });
    bridge.install();

    await expect(
      Promise.resolve(draftOpenHandler()(sender(101), "draft-a")),
    ).resolves.toEqual({ result: "moved", windowId: "created-1" });

    expect(perWindowState.get("window-a")).toMatchObject({
      landingDrafts: [draftB],
      activeLandingDraftId: "draft-b",
    });
    bridge.dispose();
  });

  it("returns not-found and creates no window when the draft is absent from the source snapshot", async () => {
    const registry = new FakeWindowRegistry();
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const { bridge, perWindowState } = await buildBridge(registry);
    perWindowState.update("window-a", {
      landingDrafts: [buildDraft("draft-a")],
      activeLandingDraftId: "draft-a",
    });
    bridge.install();

    await expect(
      Promise.resolve(
        draftOpenHandler()(sender(101), "draft-that-does-not-exist"),
      ),
    ).resolves.toEqual({ result: "not-found", windowId: "" });

    expect(registry.createCount).toBe(0);
    // Source is untouched - a refused move never mutates anything.
    expect(perWindowState.get("window-a")).toMatchObject({
      landingDrafts: [{ id: "draft-a" }],
      activeLandingDraftId: "draft-a",
    });
    bridge.dispose();
  });

  it("clears and force-closes the seeded destination and rethrows when window creation fails", async () => {
    const registry = new FakeWindowRegistry();
    registry.createFailure = new Error("load failed");
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    const { bridge, perWindowState } = await buildBridge(registry);
    const draftA = buildDraft("draft-a");
    perWindowState.update("window-a", {
      landingDrafts: [draftA],
      activeLandingDraftId: "draft-a",
    });
    bridge.install();

    await expect(
      Promise.resolve(draftOpenHandler()(sender(101), "draft-a")),
    ).rejects.toThrow("load failed");

    // The destination was seeded during `beforeLoad` (before the create
    // promise rejected), so it must be explicitly unwound: cleared and
    // force-closed, never left as an orphaned window record or a leftover
    // per-window snapshot.
    expect(registry.closeRequests).toEqual([]);
    expect(registry.forceCloseRequests).toEqual(["created-1"]);
    expect(registry.getRecordById("created-1")).toBeNull();
    expect(perWindowState.get("created-1")).toEqual({
      revision: 0,
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
      tabStripLayout: null,
      activeRoute: null,
    });

    // The move never got past the failed create, so the source snapshot -
    // which is only patched AFTER the destination is confirmed - is untouched.
    expect(perWindowState.get("window-a")).toEqual({
      revision: 1,
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [draftA],
      activeLandingDraftId: "draft-a",
      tabStripLayout: null,
      activeRoute: null,
    });
    bridge.dispose();
  });
});
