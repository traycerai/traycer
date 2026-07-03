import {
  Menu,
  type BaseWindow,
  type MenuItemConstructorOptions,
} from "electron";
import type { MenuCommandId } from "../../ipc-contracts/window-types";
import {
  TRAYCER_DOCUMENTATION_URL,
  TRAYCER_RELEASE_NOTES_URL,
} from "../app/support-links";
import type { MenuState } from "./menu-state";

export interface MenuBuildActions {
  command(command: MenuCommandId, senderWindow: BaseWindow | null): void;
  focusWindow(windowId: string): void;
  openExternal(url: string): void;
}

export function buildApplicationMenu(
  state: MenuState,
  actions: MenuBuildActions,
): Electron.Menu {
  return Menu.buildFromTemplate(
    [
      ...buildAppMenu(state, actions),
      buildFileMenu(state, actions),
      buildEditMenu(actions),
      buildViewMenu(state, actions),
      buildWindowMenu(state, actions),
      buildHelpMenu(state, actions),
    ].filter(isMenuItem),
  );
}

function buildAppMenu(
  state: MenuState,
  actions: MenuBuildActions,
): readonly MenuItemConstructorOptions[] {
  if (state.platform !== "darwin") {
    return [];
  }
  return [
    {
      label: state.appName,
      submenu: [
        {
          label: `About ${state.appName}`,
          click: (_item, browserWindow) =>
            actions.command("app.aboutDetails", browserWindow ?? null),
        },
        { type: "separator" },
        settingsItem(actions),
        authItem(state, actions),
        { type: "separator" },
        restartHostItem(actions),
        checkForUpdatesItem(state, actions),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
}

function buildFileMenu(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  const nonMacAccountItems =
    state.platform === "darwin"
      ? []
      : [
          settingsItem(actions),
          authItem(state, actions),
          { type: "separator" } satisfies MenuItemConstructorOptions,
        ];
  return {
    label: "File",
    submenu: [
      {
        label: "New Window",
        accelerator: "CmdOrCtrl+Shift+N",
        click: (_item, browserWindow) =>
          actions.command("epic.newWindow", browserWindow ?? null),
      },
      {
        label: "Open Epic in New Window...",
        accelerator: "CmdOrCtrl+Shift+O",
        enabled: state.windows.length > 0,
        click: (_item, browserWindow) =>
          actions.command("epic.openInNewWindow", browserWindow ?? null),
      },
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        enabled: state.canCloseTab,
        click: (_item, browserWindow) =>
          actions.command("epic.closeTab", browserWindow ?? null),
      },
      ...nonMacAccountItems,
      ...(state.platform === "darwin"
        ? []
        : [{ role: "quit" } satisfies MenuItemConstructorOptions]),
    ],
  };
}

function buildEditMenu(actions: MenuBuildActions): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Find",
        accelerator: "CommandOrControl+F",
        click: (_menuItem, browserWindow) =>
          actions.command("view.findInPage", browserWindow ?? null),
      },
      {
        label: "Find Next",
        accelerator: "CommandOrControl+G",
        click: (_menuItem, browserWindow) =>
          actions.command("view.findNext", browserWindow ?? null),
      },
      {
        label: "Find Previous",
        accelerator: "Shift+CommandOrControl+G",
        click: (_menuItem, browserWindow) =>
          actions.command("view.findPrevious", browserWindow ?? null),
      },
    ],
  };
}

function buildViewMenu(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  const fullscreenSection =
    state.platform === "darwin"
      ? []
      : [
          { type: "separator" } satisfies MenuItemConstructorOptions,
          { role: "togglefullscreen" } satisfies MenuItemConstructorOptions,
        ];
  const submenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    { type: "separator" },
    {
      label: "Actual Size",
      click: (_item, browserWindow) =>
        actions.command("view.resetZoom", browserWindow ?? null),
    },
    {
      label: "Zoom In",
      click: (_item, browserWindow) =>
        actions.command("view.zoomIn", browserWindow ?? null),
    },
    {
      label: "Zoom Out",
      click: (_item, browserWindow) =>
        actions.command("view.zoomOut", browserWindow ?? null),
    },
    // macOS injects a native full screen item into the View menu; adding the
    // Electron role here creates duplicate "Toggle Full Screen" rows.
    ...fullscreenSection,
  ];
  return {
    label: "View",
    submenu,
  };
}

function buildWindowMenu(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  const windowItems = state.windows.map((entry) => ({
    label: entry.title,
    type: "checkbox" as const,
    checked: entry.windowId === state.focusedWindowId,
    click: () => actions.focusWindow(entry.windowId),
  }));
  return {
    label: "Window",
    submenu: [
      {
        label: "Minimize",
        accelerator: "CmdOrCtrl+M",
        enabled: state.windows.length > 0,
        click: (_item, browserWindow) =>
          actions.command("window.minimizeWindow", browserWindow ?? null),
      },
      ...(state.platform === "darwin"
        ? [
            {
              label: "Zoom",
              enabled: state.windows.length > 0,
              click: (_item, browserWindow) =>
                actions.command("window.zoomWindow", browserWindow ?? null),
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      { type: "separator" },
      ...windowItems,
      { type: "separator" },
      state.platform === "darwin"
        ? {
            label: "Close Window",
            enabled: state.windows.length > 0,
            click: (_item, browserWindow) =>
              actions.command("window.closeWindow", browserWindow ?? null),
          }
        : { role: "close" },
    ],
  };
}

function buildHelpMenu(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  return {
    label: "Help",
    role: "help",
    submenu: [
      {
        label: "Documentation",
        click: () => actions.openExternal(TRAYCER_DOCUMENTATION_URL),
      },
      {
        label: "Release Notes",
        click: () => actions.openExternal(TRAYCER_RELEASE_NOTES_URL),
      },
      {
        label: "Report Issue",
        click: (_item, browserWindow) =>
          actions.command("app.reportIssue", browserWindow ?? null),
      },
      { type: "separator" },
      // DevTools are available in non-production builds. Production drops the
      // menu role so an end-user can't open a privileged inspector against the
      // renderer.
      // (`Ctrl+Shift+I` / `Cmd+Opt+I` accelerators land on the same role and
      // are filtered out by Electron when the menu item is absent.)
      ...(state.canOpenDevTools
        ? [{ role: "toggleDevTools" } satisfies MenuItemConstructorOptions]
        : []),
      {
        label: "Open Logs",
        click: (_item, browserWindow) =>
          actions.command("app.openLogs", browserWindow ?? null),
      },
      restartHostItem(actions),
      checkForUpdatesItem(state, actions),
      { type: "separator" },
      {
        label: "About Traycer",
        click: (_item, browserWindow) =>
          actions.command("app.aboutDetails", browserWindow ?? null),
      },
    ],
  };
}

function settingsItem(actions: MenuBuildActions): MenuItemConstructorOptions {
  return {
    label: "Settings...",
    accelerator: "CmdOrCtrl+,",
    click: (_item, browserWindow) =>
      actions.command("app.openSettings", browserWindow ?? null),
  };
}

function authItem(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  if (state.authSession.status === "signed-in") {
    return {
      label: "Sign Out",
      click: (_item, browserWindow) =>
        actions.command("app.signOut", browserWindow ?? null),
    };
  }
  return {
    label: "Sign In",
    enabled: state.authSession.status !== "signing-in",
    click: (_item, browserWindow) =>
      actions.command("app.signIn", browserWindow ?? null),
  };
}

function restartHostItem(
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  return {
    label: "Restart Host",
    click: (_item, browserWindow) =>
      actions.command("host.restart", browserWindow ?? null),
  };
}

function checkForUpdatesItem(
  state: MenuState,
  actions: MenuBuildActions,
): MenuItemConstructorOptions {
  return {
    label: "Check for Updates",
    enabled: state.canCheckForUpdates,
    click: (_item, browserWindow) =>
      actions.command("app.checkForUpdates", browserWindow ?? null),
  };
}

function isMenuItem(
  item: MenuItemConstructorOptions | false,
): item is MenuItemConstructorOptions {
  return item !== false;
}
