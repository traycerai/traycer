import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopLocalHostSnapshot } from "../../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  MenuCommandId,
  WindowSummary,
} from "../../../ipc-contracts/window-types";
import type {
  IpcHostLifecycle,
  IpcPerWindowState,
} from "../../ipc/runner-ipc-bridge";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { PerWindowState } from "../../windows/per-window-state";
import type {
  MenuManagedWindow,
  MenuWindowRecord,
  MenuWindowRegistry,
  MenuZoomController,
} from "../menu-controller";

interface CapturedMenuItem {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly submenu?: readonly CapturedMenuItem[];
  readonly click?: (menuItem: unknown, browserWindow: unknown) => void;
}

const electronState = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  lastTemplate: null as readonly CapturedMenuItem[] | null,
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: readonly CapturedMenuItem[]) => {
      electronState.lastTemplate = template;
      return { template };
    },
    setApplicationMenu: electronState.setApplicationMenu,
  },
  app: {
    isPackaged: false,
    quit: vi.fn(),
    showAboutPanel: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
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

import { app } from "electron";
import log from "electron-log";
import { MenuController } from "../menu-controller";

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

  setSnapshot(snapshot: DesktopLocalHostSnapshot | null): void {
    this.snapshot = snapshot;
    this.emit("change", snapshot);
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

class FakeWindow implements MenuManagedWindow {
  menus: Electron.Menu[] = [];
  focused = true;
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    return this.focused;
  }

  setMenu(menu: Electron.Menu): void {
    this.menus.push(menu);
  }
}

class FakeWindowRegistry extends EventEmitter implements MenuWindowRegistry {
  readonly window = new FakeWindow();
  readonly closeRequests: string[] = [];
  readonly minimizeRequests: string[] = [];
  readonly zoomRequests: string[] = [];
  readonly createRequests: Array<{
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }> = [];

  async create(options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    this.createRequests.push(options);
    return "window-created";
  }

  closeById(windowId: string): Promise<void> {
    this.closeRequests.push(windowId);
    return Promise.resolve();
  }

  minimizeById(windowId: string): Promise<void> {
    this.minimizeRequests.push(windowId);
    return Promise.resolve();
  }

  zoomById(windowId: string): Promise<void> {
    this.zoomRequests.push(windowId);
    return Promise.resolve();
  }

  focusById(_windowId: string): boolean {
    this.window.focused = true;
    return true;
  }

  list(): readonly WindowSummary[] {
    return [
      {
        windowId: "window-a",
        title: "Window A",
        isFocused: this.window.focused,
        isVisible: true,
      },
    ];
  }

  records(): readonly MenuWindowRecord[] {
    return [
      {
        windowId: "window-a",
        window: this.window,
      },
    ];
  }

  mostRecentlyFocusedId(): string | null {
    return "window-a";
  }

  emitChange(): void {
    this.emit("change");
  }
}

class FakeZoomController implements MenuZoomController {
  readonly requests: string[] = [];

  zoomIn(): Promise<number> {
    this.requests.push("in");
    return Promise.resolve(110);
  }

  zoomOut(): Promise<number> {
    this.requests.push("out");
    return Promise.resolve(90);
  }

  reset(): Promise<number> {
    this.requests.push("reset");
    return Promise.resolve(100);
  }
}

class EmptyWindowRegistry extends EventEmitter implements MenuWindowRegistry {
  readonly createRequests: Array<{
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }> = [];
  private readonly createError: Error | null;

  constructor(createError: Error | null) {
    super();
    this.createError = createError;
  }

  async create(options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    this.createRequests.push(options);
    if (this.createError !== null) {
      throw this.createError;
    }
    return "window-created";
  }

  closeById(_windowId: string): Promise<void> {
    return Promise.resolve();
  }

  minimizeById(_windowId: string): Promise<void> {
    return Promise.resolve();
  }

  zoomById(_windowId: string): Promise<void> {
    return Promise.resolve();
  }

  focusById(_windowId: string): boolean {
    return false;
  }

  list(): readonly WindowSummary[] {
    return [];
  }

  records(): readonly MenuWindowRecord[] {
    return [];
  }

  mostRecentlyFocusedId(): string | null {
    return null;
  }
}

class MultiWindowRegistry extends EventEmitter implements MenuWindowRegistry {
  readonly windowA = new FakeWindow();
  readonly windowB = new FakeWindow();
  readonly closeRequests: string[] = [];
  readonly minimizeRequests: string[] = [];
  readonly zoomRequests: string[] = [];

  constructor() {
    super();
    this.windowA.focused = true;
    this.windowB.focused = false;
  }

  async create(_options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    return "window-created";
  }

  closeById(windowId: string): Promise<void> {
    this.closeRequests.push(windowId);
    return Promise.resolve();
  }

  minimizeById(windowId: string): Promise<void> {
    this.minimizeRequests.push(windowId);
    return Promise.resolve();
  }

  zoomById(windowId: string): Promise<void> {
    this.zoomRequests.push(windowId);
    return Promise.resolve();
  }

  focusById(windowId: string): boolean {
    if (windowId === "window-a") {
      this.windowA.focused = true;
      this.windowB.focused = false;
      return true;
    }
    if (windowId === "window-b") {
      this.windowA.focused = false;
      this.windowB.focused = true;
      return true;
    }
    return false;
  }

  list(): readonly WindowSummary[] {
    return this.records().map((record) => ({
      windowId: record.windowId,
      title: record.windowId,
      isFocused: record.window.isFocused(),
      isVisible: true,
    }));
  }

  records(): readonly MenuWindowRecord[] {
    return [
      {
        windowId: "window-a",
        window: this.windowA,
      },
      {
        windowId: "window-b",
        window: this.windowB,
      },
    ];
  }

  mostRecentlyFocusedId(): string | null {
    return "window-b";
  }
}

function createController(options: {
  readonly registry: MenuWindowRegistry;
  readonly host: FakeHost;
  readonly authSession: DesktopAuthSession;
  readonly perWindowState: IpcPerWindowState;
  readonly dispatchRendererCommand: (
    command: MenuCommandId,
    hostUpdateVersion: string | null,
  ) => boolean;
}): MenuController {
  return new MenuController({
    appName: "Traycer",
    platform: "darwin",
    windowRegistry: options.registry,
    host: options.host,
    authSession: options.authSession,
    perWindowState: options.perWindowState,
    tray: null,
    zoomController: new FakeZoomController(),
    dispatchRendererCommand: options.dispatchRendererCommand,
    checkForUpdates: () => Promise.resolve(),
  });
}

function menuItem(label: string): CapturedMenuItem {
  return menuItemInTopLevel("File", label);
}

function windowMenuItem(label: string): CapturedMenuItem {
  return menuItemInTopLevel("Window", label);
}

function menuItemInTopLevel(
  topLevelLabel: string,
  label: string,
): CapturedMenuItem {
  const template = electronState.lastTemplate;
  if (template === null) {
    throw new Error("menu template missing");
  }
  const topLevel = template.find((item) => item.label === topLevelLabel);
  const item = topLevel?.submenu?.find((entry) => entry.label === label);
  if (item === undefined) {
    throw new Error(`menu item ${topLevelLabel}/${label} missing`);
  }
  return item;
}

function runControllerCommand(
  controller: MenuController,
  command: MenuCommandId,
  senderWindow: MenuManagedWindow | null,
  hostUpdateVersion: string | null,
): void {
  const handleCommand = Reflect.get(controller, "handleCommand");
  if (typeof handleCommand !== "function") {
    throw new Error("handleCommand missing");
  }
  handleCommand.call(controller, command, senderWindow, hostUpdateVersion);
}

describe("MenuController", () => {
  beforeEach(() => {
    electronState.setApplicationMenu.mockClear();
    electronState.lastTemplate = null;
  });

  it("rebuilds when window, auth, host, or per-window state changes", () => {
    const registry = new FakeWindowRegistry();
    const host = new FakeHost();
    const authSession = new DesktopAuthSession();
    const perWindowState = new PerWindowState(null);
    const controller = createController({
      registry,
      host,
      authSession,
      perWindowState,
      dispatchRendererCommand: () => true,
    });

    controller.install();
    expect(electronState.setApplicationMenu).toHaveBeenCalledTimes(1);

    registry.emitChange();
    host.setSnapshot({
      hostId: "host-a",
      websocketUrl: "ws://127.0.0.1:9000/rpc",
      version: "0.1.0",
      pid: 123,
      systemHostName: "host-a",
      displayName: "host-a",
    });
    authSession.set({
      status: "signed-in",
      token: "token",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    } satisfies DesktopAuthSessionSnapshot);
    perWindowState.update("window-a", {
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
    });

    expect(electronState.setApplicationMenu).toHaveBeenCalledTimes(5);
    controller.dispose();
  });

  it("dispatches Close Tab through the renderer command path", () => {
    const perWindowState = new PerWindowState(null);
    perWindowState.update("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry: new FakeWindowRegistry(),
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState,
      dispatchRendererCommand,
    });

    controller.install();
    const closeTab = menuItem("Close Tab");
    expect(closeTab.enabled).toBe(true);
    closeTab.click?.(null, null);

    expect(dispatchRendererCommand).toHaveBeenCalledWith("epic.closeTab", null);
    controller.dispose();
  });

  // Cold-review #3 / review finding 5: the version dispatched with
  // `host.installUpdate` is the value captured into the tray item callback
  // when the row was labelled - not live MenuController state - so a stale
  // open-menu click after presentation moves on still pins the version the
  // user saw.
  it("dispatches host.installUpdate with the version captured by the tray item callback", () => {
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry: new FakeWindowRegistry(),
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });
    controller.install();
    // Live controller state may already disagree with the captured click.
    controller.setHostUpdateAvailableVersion("1.7.0-rc.9");

    runControllerCommand(controller, "host.installUpdate", null, "1.6.0-rc.1");

    expect(dispatchRendererCommand).toHaveBeenCalledWith(
      "host.installUpdate",
      "1.6.0-rc.1",
    );
    controller.dispose();
  });

  it("dispatches host.installUpdate with null when the item callback captured no version", () => {
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry: new FakeWindowRegistry(),
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });
    controller.install();
    controller.setHostUpdateAvailableVersion("1.6.0-rc.1");

    runControllerCommand(controller, "host.installUpdate", null, null);

    expect(dispatchRendererCommand).toHaveBeenCalledWith(
      "host.installUpdate",
      null,
    );
    controller.dispose();
  });

  // Stale open-menu capture of version A after presentation moves to B is
  // covered end-to-end at the tray boundary in tray.test.ts (DesktopTrayController
  // private fields make a real tray fixture impractical here). The cases above
  // prove MenuController dispatches the callback-captured version rather than
  // live hostUpdateAvailableVersion.

  it("dispatches Restart Host through the renderer confirmation path", () => {
    const host = new FakeHost();
    const registry = new FakeWindowRegistry();
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host,
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    runControllerCommand(controller, "host.restart", null, null);

    expect(dispatchRendererCommand).toHaveBeenCalledWith("host.restart", null);
    expect(host.respawnCalls).toBe(0);
    expect(registry.createRequests).toEqual([]);
    controller.dispose();
  });

  it("opens a window and retries Restart Host when no renderer is available", async () => {
    const host = new FakeHost();
    const registry = new EmptyWindowRegistry(null);
    const dispatchRendererCommand = vi
      .fn<(_command: MenuCommandId) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const controller = createController({
      registry,
      host,
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    runControllerCommand(controller, "host.restart", null, null);
    await Promise.resolve();

    expect(registry.createRequests).toEqual([
      { initialRoute: null, beforeLoad: null },
    ]);
    expect(dispatchRendererCommand).toHaveBeenCalledTimes(2);
    expect(dispatchRendererCommand).toHaveBeenNthCalledWith(
      1,
      "host.restart",
      null,
    );
    expect(dispatchRendererCommand).toHaveBeenNthCalledWith(
      2,
      "host.restart",
      null,
    );
    expect(host.respawnCalls).toBe(0);
    controller.dispose();
  });

  it("logs when Restart Host opens a window but still has no renderer target", async () => {
    const host = new FakeHost();
    const registry = new EmptyWindowRegistry(null);
    const dispatchRendererCommand = vi.fn(() => false);
    const controller = createController({
      registry,
      host,
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    vi.mocked(log.warn).mockClear();
    runControllerCommand(controller, "host.restart", null, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.createRequests).toEqual([
      { initialRoute: null, beforeLoad: null },
    ]);
    expect(dispatchRendererCommand).toHaveBeenCalledTimes(2);
    expect(dispatchRendererCommand).toHaveBeenNthCalledWith(
      1,
      "host.restart",
      null,
    );
    expect(dispatchRendererCommand).toHaveBeenNthCalledWith(
      2,
      "host.restart",
      null,
    );
    expect(host.respawnCalls).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      "[menu] host.restart had no renderer after opening window",
      { command: "host.restart" },
    );
    controller.dispose();
  });

  it("logs when Restart Host cannot open a renderer window", async () => {
    const createError = new Error("create failed");
    const host = new FakeHost();
    const registry = new EmptyWindowRegistry(createError);
    const dispatchRendererCommand = vi.fn(() => false);
    const controller = createController({
      registry,
      host,
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    vi.mocked(log.warn).mockClear();
    runControllerCommand(controller, "host.restart", null, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.createRequests).toEqual([
      { initialRoute: null, beforeLoad: null },
    ]);
    expect(dispatchRendererCommand).toHaveBeenCalledTimes(1);
    expect(dispatchRendererCommand).toHaveBeenCalledWith("host.restart", null);
    expect(host.respawnCalls).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      "[menu] host.restart window creation failed",
      createError,
    );
    controller.dispose();
  });

  it("uses the main-process close path for Close Window", () => {
    const registry = new FakeWindowRegistry();
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    runControllerCommand(
      controller,
      "window.closeWindow",
      registry.window,
      null,
    );

    expect(registry.closeRequests).toEqual(["window-a"]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("uses main-process paths for Minimize and Zoom", () => {
    const registry = new FakeWindowRegistry();
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    runControllerCommand(
      controller,
      "window.minimizeWindow",
      registry.window,
      null,
    );
    runControllerCommand(
      controller,
      "window.zoomWindow",
      registry.window,
      null,
    );

    expect(registry.minimizeRequests).toEqual(["window-a"]);
    expect(registry.zoomRequests).toEqual(["window-a"]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("routes View zoom commands through the zoom controller", async () => {
    const zoomController = new FakeZoomController();
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = new MenuController({
      appName: "Traycer",
      platform: "darwin",
      windowRegistry: new FakeWindowRegistry(),
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      tray: null,
      zoomController,
      dispatchRendererCommand,
      checkForUpdates: () => Promise.resolve(),
    });

    controller.install();
    runControllerCommand(controller, "view.zoomIn", null, null);
    runControllerCommand(controller, "view.zoomOut", null, null);
    runControllerCommand(controller, "view.resetZoom", null, null);
    await Promise.resolve();

    expect(zoomController.requests).toEqual(["in", "out", "reset"]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("opens fresh windows without an explicit route override", () => {
    const registry = new FakeWindowRegistry();
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand: () => true,
    });

    controller.install();
    runControllerCommand(controller, "epic.newWindow", null, null);

    expect(
      registry.createRequests.map((request) => request.initialRoute),
    ).toEqual([null]);
    controller.dispose();
  });

  it("disables renderer focused-window commands when no window is focused", () => {
    const registry = new FakeWindowRegistry();
    registry.window.focused = false;
    const perWindowState = new PerWindowState(null);
    perWindowState.update("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState,
      dispatchRendererCommand,
    });

    controller.install();

    expect(menuItem("Close Tab").enabled).toBe(false);
    expect(windowMenuItem("Close Window").enabled).toBe(true);

    expect(registry.closeRequests).toEqual([]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("falls back to the MRU window for Window menu actions without a focused sender", () => {
    const registry = new FakeWindowRegistry();
    registry.window.focused = false;
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    runControllerCommand(controller, "window.minimizeWindow", null, null);
    runControllerCommand(controller, "window.zoomWindow", null, null);
    runControllerCommand(controller, "window.closeWindow", null, null);

    expect(registry.minimizeRequests).toEqual(["window-a"]);
    expect(registry.zoomRequests).toEqual(["window-a"]);
    expect(registry.closeRequests).toEqual(["window-a"]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("swallows a synchronous command failure instead of aborting the process", () => {
    const controller = createController({
      registry: new FakeWindowRegistry(),
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand: () => true,
    });

    controller.install();
    vi.mocked(log.warn).mockClear();
    vi.mocked(app.showAboutPanel).mockImplementationOnce(() => {
      throw new Error("about panel boom");
    });

    expect(() =>
      runControllerCommand(controller, "app.about", null, null),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      "[menu] command threw",
      expect.objectContaining({ command: "app.about" }),
    );
    controller.dispose();
  });

  it("absorbs a rejected dispatch promise without an unhandled rejection", async () => {
    const registry = new FakeWindowRegistry();
    registry.create = () => Promise.reject(new Error("create boom"));
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand: () => true,
    });

    controller.install();
    vi.mocked(log.warn).mockClear();
    runControllerCommand(controller, "epic.newWindow", null, null);
    // Flush the microtask that runs the attached `.catch`.
    await Promise.resolve();

    expect(log.warn).toHaveBeenCalledWith(
      "[menu] epic.newWindow failed",
      expect.any(Error),
    );
    controller.dispose();
  });

  it("preserves Electron sender-window targeting for Window menu actions", () => {
    const registry = new MultiWindowRegistry();
    const dispatchRendererCommand = vi.fn(() => true);
    const controller = createController({
      registry,
      host: new FakeHost(),
      authSession: new DesktopAuthSession(),
      perWindowState: new PerWindowState(null),
      dispatchRendererCommand,
    });

    controller.install();
    expect(windowMenuItem("Close Window").enabled).toBe(true);
    runControllerCommand(
      controller,
      "window.minimizeWindow",
      registry.windowB,
      null,
    );
    runControllerCommand(
      controller,
      "window.zoomWindow",
      registry.windowB,
      null,
    );
    runControllerCommand(
      controller,
      "window.closeWindow",
      registry.windowB,
      null,
    );

    expect(registry.minimizeRequests).toEqual(["window-b"]);
    expect(registry.zoomRequests).toEqual(["window-b"]);
    expect(registry.closeRequests).toEqual(["window-b"]);
    expect(dispatchRendererCommand).not.toHaveBeenCalled();
    controller.dispose();
  });
});
