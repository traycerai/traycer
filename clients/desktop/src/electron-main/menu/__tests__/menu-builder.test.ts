import { describe, expect, it, vi } from "vitest";
import type { MenuCommandId } from "../../../ipc-contracts/window-types";
import type { MenuState } from "../menu-state";

interface CapturedMenuItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly accelerator?: string;
  readonly enabled?: boolean;
  readonly submenu?: readonly CapturedMenuItem[];
  readonly click?: (menuItem: unknown, browserWindow: unknown) => void;
}

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: {
    buildFromTemplate: (template: readonly CapturedMenuItem[]) => ({
      template,
    }),
  },
}));

import { buildApplicationMenu } from "../menu-builder";
import {
  TRAYCER_DOCUMENTATION_URL,
  TRAYCER_RELEASE_NOTES_URL,
} from "../../app/support-links";

function buildState(platform: NodeJS.Platform): MenuState {
  return {
    appName: "Traycer",
    platform,
    authSession: {
      status: "signed-in",
      token: "token",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    },
    host: { status: "ready", version: "0.1.0" },
    windows: [
      {
        windowId: "window-a",
        title: "Main",
        isFocused: true,
        isVisible: true,
      },
    ],
    focusedWindowId: "window-a",
    canCloseTab: true,
    canCheckForUpdates: true,
    canOpenDevTools: true,
    hostUpdateAvailableVersion: null,
  };
}

function template(menu: Electron.Menu): readonly CapturedMenuItem[] {
  const value = Reflect.get(menu, "template");
  if (!Array.isArray(value)) {
    throw new Error("captured menu template missing");
  }
  return value.filter(isCapturedMenuItem);
}

function isCapturedMenuItem(value: unknown): value is CapturedMenuItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function menuByLabel(
  items: readonly CapturedMenuItem[],
  label: string,
): CapturedMenuItem {
  const item = items.find((entry) => entry.label === label);
  if (item === undefined) {
    throw new Error(`missing menu ${label}`);
  }
  return item;
}

describe("buildApplicationMenu", () => {
  it("maps macOS app and Help About to the rich details command", () => {
    const commands: MenuCommandId[] = [];
    const externalUrls: string[] = [];
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (command) => {
          commands.push(command);
        },
        focusWindow: () => undefined,
        openExternal: (url) => {
          externalUrls.push(url);
        },
      }),
    );

    const appMenu = menuByLabel(items, "Traycer").submenu ?? [];
    const appAbout = menuByLabel(appMenu, "About Traycer");
    const helpMenu = menuByLabel(items, "Help").submenu ?? [];
    const documentation = menuByLabel(helpMenu, "Documentation");
    const releaseNotes = menuByLabel(helpMenu, "Release Notes");
    const helpAbout = menuByLabel(helpMenu, "About Traycer");
    expect(appAbout.role).toBeUndefined();
    appAbout.click?.(null, null);
    documentation.click?.(null, null);
    releaseNotes.click?.(null, null);
    helpAbout.click?.(null, null);
    expect(commands).toEqual(["app.aboutDetails", "app.aboutDetails"]);
    expect(externalUrls).toEqual([
      TRAYCER_DOCUMENTATION_URL,
      TRAYCER_RELEASE_NOTES_URL,
    ]);
  });

  it("maps Windows and Linux Help About to the rich details command", () => {
    for (const platform of ["win32", "linux"] as const) {
      const commands: MenuCommandId[] = [];
      const items = template(
        buildApplicationMenu(buildState(platform), {
          command: (command) => {
            commands.push(command);
          },
          focusWindow: () => undefined,
          openExternal: () => undefined,
        }),
      );
      const helpMenu = menuByLabel(items, "Help").submenu ?? [];
      const about = menuByLabel(helpMenu, "About Traycer");
      about.click?.(null, null);
      expect(commands).toEqual(["app.aboutDetails"]);
    }
  });

  it("routes the File menu Epic picker through the renderer command path", () => {
    const commands: MenuCommandId[] = [];
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (command) => {
          commands.push(command);
        },
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];
    const item = menuByLabel(fileMenu, "Open Epic in New Window...");
    expect(item.enabled).toBe(true);
    item.click?.(null, null);
    expect(commands).toEqual(["epic.openInNewWindow"]);
  });

  it("enables and dispatches File Close Tab when the state has a closable tab", () => {
    const commands: MenuCommandId[] = [];
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (command) => {
          commands.push(command);
        },
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];
    const item = menuByLabel(fileMenu, "Close Tab");
    expect(item.enabled).toBe(true);
    expect(item.accelerator).toBe("CmdOrCtrl+W");
    item.click?.(null, null);
    expect(commands).toEqual(["epic.closeTab"]);
  });

  it("omits the obsolete Switch Host file menu item", () => {
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: () => undefined,
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];

    expect(fileMenu.some((item) => item.label === "Switch Host...")).toBe(
      false,
    );
  });

  it("lets macOS provide the native View fullscreen item", () => {
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: () => undefined,
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const viewMenu = menuByLabel(items, "View").submenu ?? [];

    expect(
      viewMenu.filter((item) => item.role === "togglefullscreen"),
    ).toHaveLength(0);
    expect(viewMenu.at(-1)?.type).not.toBe("separator");
  });

  it("keeps the View fullscreen role on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const items = template(
        buildApplicationMenu(buildState(platform), {
          command: () => undefined,
          focusWindow: () => undefined,
          openExternal: () => undefined,
        }),
      );
      const viewMenu = menuByLabel(items, "View").submenu ?? [];

      expect(
        viewMenu.filter((item) => item.role === "togglefullscreen"),
      ).toHaveLength(1);
    }
  });

  it("routes View zoom items through app-specific commands without native accelerators", () => {
    const commands: MenuCommandId[] = [];
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (command) => {
          commands.push(command);
        },
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const viewMenu = menuByLabel(items, "View").submenu ?? [];
    const actualSize = menuByLabel(viewMenu, "Actual Size");
    const zoomIn = menuByLabel(viewMenu, "Zoom In");
    const zoomOut = menuByLabel(viewMenu, "Zoom Out");

    expect(viewMenu.some((item) => item.role === "resetZoom")).toBe(false);
    expect(viewMenu.some((item) => item.role === "zoomIn")).toBe(false);
    expect(viewMenu.some((item) => item.role === "zoomOut")).toBe(false);
    expect(actualSize.accelerator).toBeUndefined();
    expect(zoomIn.accelerator).toBeUndefined();
    expect(zoomOut.accelerator).toBeUndefined();

    actualSize.click?.(null, null);
    zoomIn.click?.(null, null);
    zoomOut.click?.(null, null);
    expect(commands).toEqual(["view.resetZoom", "view.zoomIn", "view.zoomOut"]);
  });

  it("routes macOS Window actions through app-specific commands", () => {
    const commands: MenuCommandId[] = [];
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (command) => {
          commands.push(command);
        },
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];
    const windowMenu = menuByLabel(items, "Window").submenu ?? [];
    const closeTab = menuByLabel(fileMenu, "Close Tab");
    const minimize = menuByLabel(windowMenu, "Minimize");
    const zoom = menuByLabel(windowMenu, "Zoom");
    const closeWindow = menuByLabel(windowMenu, "Close Window");

    expect(fileMenu.some((item) => item.role === "close")).toBe(false);
    expect(windowMenu.some((item) => item.role === "minimize")).toBe(false);
    expect(windowMenu.some((item) => item.role === "zoom")).toBe(false);
    expect(windowMenu.some((item) => item.role === "front")).toBe(false);
    expect(closeTab.accelerator).toBe("CmdOrCtrl+W");
    expect(minimize.accelerator).toBe("CmdOrCtrl+M");
    expect(closeWindow.accelerator).toBeUndefined();
    expect(minimize.enabled).toBe(true);
    expect(zoom.enabled).toBe(true);
    expect(closeWindow.enabled).toBe(true);

    closeTab.click?.(null, null);
    minimize.click?.(null, null);
    zoom.click?.(null, null);
    closeWindow.click?.(null, null);
    expect(commands).toEqual([
      "epic.closeTab",
      "window.minimizeWindow",
      "window.zoomWindow",
      "window.closeWindow",
    ]);
  });

  it("keeps macOS window actions enabled without focus when an MRU window exists", () => {
    const state = {
      ...buildState("darwin"),
      focusedWindowId: null,
      canCloseTab: false,
      windows: [
        {
          windowId: "window-a",
          title: "Main",
          isFocused: false,
          isVisible: false,
        },
      ],
    };
    const items = template(
      buildApplicationMenu(state, {
        command: () => undefined,
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];
    const windowMenu = menuByLabel(items, "Window").submenu ?? [];

    expect(menuByLabel(fileMenu, "Open Epic in New Window...").enabled).toBe(
      true,
    );
    expect(menuByLabel(fileMenu, "Close Tab").enabled).toBe(false);
    expect(menuByLabel(windowMenu, "Minimize").enabled).toBe(true);
    expect(menuByLabel(windowMenu, "Zoom").enabled).toBe(true);
    expect(menuByLabel(windowMenu, "Close Window").enabled).toBe(true);
  });

  it("disables app-specific macOS Window actions when no windows exist", () => {
    const state = {
      ...buildState("darwin"),
      focusedWindowId: null,
      windows: [],
    };
    const items = template(
      buildApplicationMenu(state, {
        command: () => undefined,
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const windowMenu = menuByLabel(items, "Window").submenu ?? [];

    expect(menuByLabel(windowMenu, "Minimize").enabled).toBe(false);
    expect(menuByLabel(windowMenu, "Zoom").enabled).toBe(false);
    expect(menuByLabel(windowMenu, "Close Window").enabled).toBe(false);
  });

  it("forwards Electron's sender window to app-specific command handlers", () => {
    const senderWindows: unknown[] = [];
    const senderWindow = { marker: "focused-window" };
    const items = template(
      buildApplicationMenu(buildState("darwin"), {
        command: (_command, browserWindow) => {
          senderWindows.push(browserWindow);
        },
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const windowMenu = menuByLabel(items, "Window").submenu ?? [];

    menuByLabel(windowMenu, "Minimize").click?.(null, senderWindow);
    menuByLabel(windowMenu, "Zoom").click?.(null, senderWindow);
    menuByLabel(windowMenu, "Close Window").click?.(null, senderWindow);

    expect(senderWindows).toEqual([senderWindow, senderWindow, senderWindow]);
  });

  it("keeps Windows and Linux native close and quit roles", () => {
    for (const platform of ["win32", "linux"] as const) {
      const items = template(
        buildApplicationMenu(buildState(platform), {
          command: () => undefined,
          focusWindow: () => undefined,
          openExternal: () => undefined,
        }),
      );
      const fileMenu = menuByLabel(items, "File").submenu ?? [];
      const windowMenu = menuByLabel(items, "Window").submenu ?? [];

      expect(menuByLabel(fileMenu, "Close Tab").accelerator).toBe(
        "CmdOrCtrl+W",
      );
      expect(fileMenu.some((item) => item.role === "quit")).toBe(true);
      expect(fileMenu.some((item) => item.role === "close")).toBe(false);
      expect(windowMenu.some((item) => item.role === "minimize")).toBe(false);
      expect(menuByLabel(windowMenu, "Minimize").accelerator).toBe(
        "CmdOrCtrl+M",
      );
      expect(windowMenu.some((item) => item.role === "close")).toBe(true);
      expect(windowMenu.some((item) => item.label === "Close Window")).toBe(
        false,
      );
    }
  });

  it("disables File Close Tab when no target window tab is closable", () => {
    const state = { ...buildState("darwin"), canCloseTab: false };
    const items = template(
      buildApplicationMenu(state, {
        command: () => undefined,
        focusWindow: () => undefined,
        openExternal: () => undefined,
      }),
    );
    const fileMenu = menuByLabel(items, "File").submenu ?? [];
    expect(menuByLabel(fileMenu, "Close Tab").enabled).toBe(false);
  });

  it("exposes DevTools when the non-production policy allows it", () => {
    const items = template(
      buildApplicationMenu(
        { ...buildState("darwin"), canOpenDevTools: true },
        {
          command: () => undefined,
          focusWindow: () => undefined,
          openExternal: () => undefined,
        },
      ),
    );
    const helpMenu = menuByLabel(items, "Help").submenu ?? [];

    expect(helpMenu.some((item) => item.role === "toggleDevTools")).toBe(true);
  });

  it("omits DevTools when the production policy disables it", () => {
    const items = template(
      buildApplicationMenu(
        { ...buildState("darwin"), canOpenDevTools: false },
        {
          command: () => undefined,
          focusWindow: () => undefined,
          openExternal: () => undefined,
        },
      ),
    );
    const helpMenu = menuByLabel(items, "Help").submenu ?? [];

    expect(helpMenu.some((item) => item.role === "toggleDevTools")).toBe(false);
  });
});
