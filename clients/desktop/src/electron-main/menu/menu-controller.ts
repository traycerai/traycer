import { Menu, app, type BaseWindow } from "electron";
import { canOpenDevTools, isDevBuild } from "../../config";
import { safelyOpenExternal } from "../app/security";
import type {
  DesktopAuthSessionSnapshot,
  MenuCommandId,
  PerWindowSnapshot,
  WindowSummary,
} from "../../ipc-contracts/window-types";
import type {
  DesktopTrayAccount,
  DesktopTrayAuthStatus,
  DesktopTrayController,
} from "../tray/tray";
import type {
  IpcHostLifecycle,
  IpcDesktopAuthSession,
  IpcPerWindowState,
} from "../ipc/runner-ipc-bridge";
import { buildApplicationMenu } from "./menu-builder";
import { toMenuHostPresentation, type MenuState } from "./menu-state";
import { log } from "../app/logger";

export interface MenuManagedWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  setMenu(menu: Electron.Menu): void;
}

export interface MenuWindowRecord {
  readonly windowId: string;
  readonly window: MenuManagedWindow;
}

export interface MenuWindowRegistry {
  create(options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string>;
  closeById(windowId: string): Promise<void>;
  minimizeById(windowId: string): Promise<void>;
  zoomById(windowId: string): Promise<void>;
  focusById(windowId: string): boolean;
  list(): readonly WindowSummary[];
  records(): readonly MenuWindowRecord[];
  mostRecentlyFocusedId(): string | null;
  on(event: "change", listener: () => void): void;
  off(event: "change", listener: () => void): void;
}

export interface MenuZoomController {
  zoomIn(): Promise<number>;
  zoomOut(): Promise<number>;
  reset(): Promise<number>;
}

export interface MenuControllerOptions {
  readonly appName: string;
  readonly platform: NodeJS.Platform;
  readonly windowRegistry: MenuWindowRegistry;
  readonly host: IpcHostLifecycle;
  readonly authSession: IpcDesktopAuthSession;
  readonly perWindowState: IpcPerWindowState;
  readonly tray: DesktopTrayController | null;
  readonly zoomController: MenuZoomController;
  readonly dispatchRendererCommand: (command: MenuCommandId) => boolean;
  readonly checkForUpdates: () => Promise<void>;
}

export class MenuController {
  private readonly options: MenuControllerOptions;
  private readonly disposers: Array<() => void> = [];
  private hostUpdateAvailableVersion: string | null = null;

  constructor(options: MenuControllerOptions) {
    this.options = options;
  }

  install(): void {
    this.options.tray?.setCommandHandler((command) => {
      this.handleCommand(command, null);
    });
    const onWindowChange = (): void => {
      this.rebuild();
    };
    const onHostChange = (): void => {
      this.rebuild();
    };
    const onAuthChange = (_snapshot: DesktopAuthSessionSnapshot): void => {
      this.rebuild();
    };
    const onPerWindowStateChange = (): void => {
      this.rebuild();
    };
    this.options.windowRegistry.on("change", onWindowChange);
    this.options.host.on("change", onHostChange);
    this.options.authSession.on("change", onAuthChange);
    this.options.perWindowState.on("change", onPerWindowStateChange);
    this.disposers.push(() => {
      this.options.windowRegistry.off("change", onWindowChange);
    });
    this.disposers.push(() => {
      this.options.host.off("change", onHostChange);
    });
    this.disposers.push(() => {
      this.options.authSession.off("change", onAuthChange);
    });
    this.disposers.push(() => {
      this.options.perWindowState.off("change", onPerWindowStateChange);
    });
    this.rebuild();
  }

  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.options.tray?.setCommandHandler(null);
    Menu.setApplicationMenu(null);
  }

  rebuild(): void {
    const state = this.buildState();
    const menu = buildApplicationMenu(state, {
      command: (command, senderWindow) =>
        this.handleCommand(command, senderWindow),
      focusWindow: (windowId) => {
        this.options.windowRegistry.focusById(windowId);
      },
      openExternal: (url) => {
        void safelyOpenExternal(url);
      },
    });
    Menu.setApplicationMenu(menu);
    if (this.options.platform !== "darwin") {
      for (const record of this.options.windowRegistry.records()) {
        record.window.setMenu(menu);
      }
    }
    this.options.tray?.setPresentation({
      ...buildTrayAccount(state.authSession),
      canCheckForUpdates: state.canCheckForUpdates,
      hostUpdateAvailableVersion: state.hostUpdateAvailableVersion,
    });
  }

  /**
   * Update the cached host-update version surfaced through the tray
   * (Flow 6). The launch-time registry probe in `main-process.ts` calls
   * this with the latest registry version when an upgrade is available;
   * `null` clears the tray row.
   */
  setHostUpdateAvailableVersion(version: string | null): void {
    this.hostUpdateAvailableVersion = version;
    this.rebuild();
  }

  private buildState(): MenuState {
    const focusedWindowId = resolveFocusedWindowId(this.options.windowRegistry);
    return {
      appName: this.options.appName,
      platform: this.options.platform,
      authSession: this.options.authSession.get(),
      host: toMenuHostPresentation(this.options.host.getSnapshot()),
      windows: this.options.windowRegistry.list(),
      focusedWindowId,
      canCloseTab:
        focusedWindowId !== null &&
        canCloseTab(this.options.perWindowState.get(focusedWindowId)),
      // Updates only apply to shipped builds; the dev slot has no update
      // feed (the updater is disabled there).
      canCheckForUpdates: !isDevBuild,
      canOpenDevTools,
      hostUpdateAvailableVersion: this.hostUpdateAvailableVersion,
    };
  }

  // Menu/tray commands are invoked synchronously by Electron off the AppKit
  // action path (including keyboard accelerators). An exception escaping here
  // - or an un-`.catch()`'d rejection from a dispatched promise below - has no
  // caller to absorb it and fatally aborts the main process. Wrap dispatch so
  // a single broken command degrades to a log line instead of a SIGTRAP.
  private handleCommand(
    command: MenuCommandId,
    senderWindow: BaseWindow | null,
  ): void {
    try {
      this.dispatchCommand(command, senderWindow);
    } catch (err) {
      log.warn("[menu] command threw", { command, err });
    }
  }

  private dispatchCommand(
    command: MenuCommandId,
    senderWindow: BaseWindow | null,
  ): void {
    if (command === "app.quit") {
      app.quit();
      return;
    }
    if (command === "app.checkForUpdates") {
      void this.options.checkForUpdates().catch((err) => {
        log.warn("[menu] app.checkForUpdates failed", err);
      });
      return;
    }
    if (command === "host.restart") {
      // The renderer owns the confirmation modal. Once confirmed, it calls
      // runnerHost.requestHostRespawn(), which routes back through the shared
      // main-process respawn entrypoint.
      if (this.options.dispatchRendererCommand(command)) return;

      void this.options.windowRegistry
        .create({
          initialRoute: null,
          beforeLoad: null,
        })
        .then(() => {
          if (!this.options.dispatchRendererCommand(command)) {
            log.warn(
              "[menu] host.restart had no renderer after opening window",
              {
                command,
              },
            );
          }
        })
        .catch((err) => {
          log.warn("[menu] host.restart window creation failed", err);
        });
      return;
    }
    if (command === "host.installUpdate") {
      // The tray's "Update available: <ver> - Install" row dispatches
      // here. The renderer owns the actual CLI invocation (via the
      // host-management bridge), so we forward the command and let
      // the existing TanStack Query mutation run `traycer host
      // update`. Tray clicks can occur with no focused renderer (e.g.
      // another app is foregrounded), so the IPC dispatcher treats
      // `host.installUpdate` as dialog-hosted and falls back to the
      // MRU window - focusing it before delivering the command - so
      // the install does not no-op. Only emits the diagnostic when
      // there really is no window at all.
      const dispatched = this.options.dispatchRendererCommand(command);
      if (!dispatched) {
        log.warn(
          "[menu] host.installUpdate ignored - no renderer window available",
          {},
        );
      }
      return;
    }
    if (command === "epic.newWindow") {
      void this.options.windowRegistry
        .create({
          initialRoute: null,
          beforeLoad: null,
        })
        .catch((err) => {
          log.warn("[menu] epic.newWindow failed", err);
        });
      return;
    }
    if (command === "app.about") {
      app.showAboutPanel();
      return;
    }
    if (command === "window.minimizeWindow") {
      const windowId = resolveSenderFocusedOrMruWindowId(
        this.options.windowRegistry,
        senderWindow,
      );
      if (windowId === null) {
        log.warn("[menu] minimize-window command had no target", {});
        return;
      }
      void this.options.windowRegistry.minimizeById(windowId).catch((err) => {
        log.warn("[menu] window.minimizeWindow failed", err);
      });
      return;
    }
    if (command === "view.zoomIn") {
      void this.options.zoomController.zoomIn().catch((err) => {
        log.warn("[menu] view.zoomIn failed", err);
      });
      return;
    }
    if (command === "view.zoomOut") {
      void this.options.zoomController.zoomOut().catch((err) => {
        log.warn("[menu] view.zoomOut failed", err);
      });
      return;
    }
    if (command === "view.resetZoom") {
      void this.options.zoomController.reset().catch((err) => {
        log.warn("[menu] view.resetZoom failed", err);
      });
      return;
    }
    if (command === "window.zoomWindow") {
      const windowId = resolveSenderFocusedOrMruWindowId(
        this.options.windowRegistry,
        senderWindow,
      );
      if (windowId === null) {
        log.warn("[menu] zoom-window command had no target", {});
        return;
      }
      void this.options.windowRegistry.zoomById(windowId).catch((err) => {
        log.warn("[menu] window.zoomWindow failed", err);
      });
      return;
    }
    if (command === "window.closeWindow") {
      const windowId = resolveSenderFocusedOrMruWindowId(
        this.options.windowRegistry,
        senderWindow,
      );
      if (windowId === null) {
        log.warn("[menu] close-window command had no target", {});
        return;
      }
      void this.options.windowRegistry.closeById(windowId).catch((err) => {
        log.warn("[menu] window.closeWindow failed", err);
      });
      return;
    }
    if (isRendererHostedCommand(command)) {
      if (!this.options.dispatchRendererCommand(command)) {
        log.warn("[menu] renderer-hosted command had no target", { command });
      }
      return;
    }
    log.warn("[menu] command is disabled or not implemented", { command });
  }
}

function resolveFocusedWindowId(registry: MenuWindowRegistry): string | null {
  return (
    registry
      .records()
      .find(
        (record) => record.window.isFocused() && !record.window.isDestroyed(),
      )?.windowId ?? null
  );
}

function isRendererHostedCommand(command: MenuCommandId): boolean {
  return (
    command === "app.openSettings" ||
    command === "app.signIn" ||
    command === "app.signOut" ||
    command === "app.openLogs" ||
    command === "app.aboutDetails" ||
    command === "app.reportIssue" ||
    command === "epic.openInNewWindow" ||
    command === "epic.closeTab" ||
    command === "view.findInPage" ||
    command === "view.findNext" ||
    command === "view.findPrevious"
  );
}

function resolveSenderFocusedOrMruWindowId(
  registry: MenuWindowRegistry,
  senderWindow: BaseWindow | null,
): string | null {
  if (senderWindow !== null) {
    const senderRecord = registry
      .records()
      .find(
        (record) =>
          record.window === senderWindow && !record.window.isDestroyed(),
      );
    if (senderRecord !== undefined) {
      return senderRecord.windowId;
    }
  }
  return resolveFocusedWindowId(registry) ?? registry.mostRecentlyFocusedId();
}

function canCloseTab(snapshot: PerWindowSnapshot): boolean {
  return snapshot.activeTabId !== null || snapshot.landingDrafts.length > 0;
}

function buildTrayAccount(snapshot: DesktopAuthSessionSnapshot): {
  authStatus: DesktopTrayAuthStatus;
  account: DesktopTrayAccount | null;
} {
  if (snapshot.status === "signed-in" && snapshot.profile !== null) {
    const name = snapshot.profile.userName.trim();
    return {
      authStatus: "signed-in",
      account: {
        name: name.length > 0 ? name : null,
        email: snapshot.profile.email,
      },
    };
  }
  if (snapshot.status === "signing-in") {
    return { authStatus: "signing-in", account: null };
  }
  return { authStatus: "signed-out", account: null };
}
