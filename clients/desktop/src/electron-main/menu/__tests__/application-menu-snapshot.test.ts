import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMenuItem {
  readonly label: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly type: "normal" | "separator" | "checkbox" | "radio" | "submenu";
  readonly checked: boolean;
  readonly accelerator: string | null;
  readonly submenu: FakeMenu | null | undefined;
  readonly click: (...args: readonly unknown[]) => void;
}

interface FakeMenu {
  readonly items: readonly FakeMenuItem[];
  readonly getMenuItemById: (id: string) => FakeMenuItem | null;
}

const electronState = vi.hoisted(() => ({
  applicationMenu: null as FakeMenu | null,
  focusedWebContents: null as object | null,
  windowsByWebContents: new Map<object, object>(),
  browserWindow: {
    isDestroyed: () => false,
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (contents: object) =>
      electronState.windowsByWebContents.get(contents) ?? null,
  },
  Menu: {
    getApplicationMenu: () => electronState.applicationMenu,
  },
  webContents: {
    getFocusedWebContents: () => electronState.focusedWebContents,
  },
}));

import {
  executeApplicationMenuItem,
  readApplicationMenuSnapshot,
} from "../application-menu-snapshot";

function menuItem(
  label: string,
  type: FakeMenuItem["type"],
  options: {
    readonly enabled: boolean;
    readonly visible: boolean;
    readonly checked: boolean;
    readonly submenu?: FakeMenu;
    readonly click?: (...args: readonly unknown[]) => void;
  },
): FakeMenuItem {
  const base = {
    label,
    type,
    enabled: options.enabled,
    visible: options.visible,
    checked: options.checked,
    accelerator: null,
    submenu: options.submenu ?? null,
    click: options.click ?? (() => undefined),
  };
  return base;
}

function createMenu(topLevel: ReadonlyMap<string, FakeMenuItem>): FakeMenu {
  return {
    items: [...topLevel.values()],
    getMenuItemById: (id) => topLevel.get(id) ?? null,
  };
}

function buildApplicationMenu(click: (...args: readonly unknown[]) => void): {
  readonly menu: FakeMenu;
  readonly enabledItem: FakeMenuItem;
  readonly disabledItem: FakeMenuItem;
  readonly hiddenItem: FakeMenuItem;
} {
  const fileSubmenu = createMenu(new Map<string, FakeMenuItem>());
  const enabledItem = menuItem("New File", "normal", {
    enabled: true,
    visible: true,
    checked: false,
    click,
  });
  const disabledItem = menuItem("Disabled", "normal", {
    enabled: false,
    visible: true,
    checked: false,
  });
  const hiddenItem = menuItem("Hidden", "normal", {
    enabled: true,
    visible: false,
    checked: false,
  });
  const fileItems = [
    enabledItem,
    menuItem("Checked", "checkbox", {
      enabled: true,
      visible: true,
      checked: true,
    }),
    menuItem("Divider", "separator", {
      enabled: true,
      visible: true,
      checked: false,
    }),
    disabledItem,
    hiddenItem,
  ];
  const populatedFileSubmenu: FakeMenu = {
    items: fileItems,
    getMenuItemById: () => null,
  };
  const topLevel = new Map<string, FakeMenuItem>();
  const topLabels = [
    ["file", "File"],
    ["edit", "Edit"],
    ["view", "View"],
    ["window", "Window"],
    ["help", "Help"],
  ] as const;
  for (const [id, label] of topLabels) {
    topLevel.set(
      `traycer.top-level-menu.${id}`,
      menuItem(label, "submenu", {
        enabled: true,
        visible: true,
        checked: false,
        submenu: id === "file" ? populatedFileSubmenu : fileSubmenu,
      }),
    );
  }
  return {
    menu: createMenu(topLevel),
    enabledItem,
    disabledItem,
    hiddenItem,
  };
}

const sender = {} as WebContents;

beforeEach(() => {
  electronState.applicationMenu = null;
  electronState.focusedWebContents = sender;
  electronState.windowsByWebContents.clear();
  electronState.windowsByWebContents.set(sender, electronState.browserWindow);
});

describe("application menu snapshots", () => {
  it("projects visible roles, labels, and checked state with a revision", () => {
    const application = buildApplicationMenu(() => undefined);
    electronState.applicationMenu = application.menu;

    const snapshot = readApplicationMenuSnapshot(sender);
    const file = snapshot.menus.find((menu) => menu.id === "file");

    expect(snapshot.revision).toBeGreaterThan(0);
    expect(snapshot.menus.map((menu) => menu.label)).toEqual([
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    expect(file?.items.map((item) => item.type)).toEqual([
      "normal",
      "checkbox",
      "separator",
      "normal",
    ]);
    expect(file?.items[1]).toMatchObject({
      label: "Checked",
      checked: true,
      enabled: true,
    });
    expect(file?.items.some((item) => item.label === "Hidden")).toBe(false);
  });

  it("projects and executes a normal entry whose submenu is null", () => {
    const click = vi.fn();
    const application = buildApplicationMenu(click);
    electronState.applicationMenu = application.menu;
    const snapshot = readApplicationMenuSnapshot(sender);

    expect(snapshot.menus[0]?.items[0]).toMatchObject({
      id: "file/0",
      label: "New File",
      type: "normal",
      children: [],
    });
    executeApplicationMenuItem(sender, snapshot.revision, "file/0");
    expect(click).toHaveBeenCalledOnce();
  });

  it("rejects stale revisions and menu identities after a rebuild", () => {
    const first = buildApplicationMenu(() => undefined);
    electronState.applicationMenu = first.menu;
    const snapshot = readApplicationMenuSnapshot(sender);

    expect(() =>
      executeApplicationMenuItem(sender, snapshot.revision + 1, "file/0"),
    ).toThrow("application menu changed");

    electronState.applicationMenu = buildApplicationMenu(() => undefined).menu;
    expect(() =>
      executeApplicationMenuItem(sender, snapshot.revision, "file/0"),
    ).toThrow("application menu changed");
  });

  it("rejects hidden and disabled entries without executing them", () => {
    const click = vi.fn();
    const application = buildApplicationMenu(click);
    electronState.applicationMenu = application.menu;
    const snapshot = readApplicationMenuSnapshot(sender);

    expect(() =>
      executeApplicationMenuItem(sender, snapshot.revision, "file/3"),
    ).toThrow("action is unavailable");
    expect(() =>
      executeApplicationMenuItem(sender, snapshot.revision, "file/4"),
    ).toThrow("action is unavailable");
    expect(click).not.toHaveBeenCalled();
  });

  it("executes a current item against the focused contents in the owning window", () => {
    const click = vi.fn();
    const application = buildApplicationMenu(click);
    electronState.applicationMenu = application.menu;
    const snapshot = readApplicationMenuSnapshot(sender);

    executeApplicationMenuItem(sender, snapshot.revision, "file/0");

    expect(click).toHaveBeenCalledWith({}, electronState.browserWindow, sender);
  });

  it("uses a focused guest's host contents when it belongs to the sender window", () => {
    const click = vi.fn();
    const application = buildApplicationMenu(click);
    electronState.applicationMenu = application.menu;
    const guestHostContents = {} as WebContents;
    const focusedGuest = { hostWebContents: guestHostContents } as WebContents;
    electronState.windowsByWebContents.set(
      guestHostContents,
      electronState.browserWindow,
    );
    electronState.focusedWebContents = focusedGuest;
    const snapshot = readApplicationMenuSnapshot(sender);

    executeApplicationMenuItem(sender, snapshot.revision, "file/0");

    expect(click).toHaveBeenCalledWith(
      {},
      electronState.browserWindow,
      focusedGuest,
    );
  });

  it("keeps the sender as the click target for a focused guest in another window", () => {
    const click = vi.fn();
    const application = buildApplicationMenu(click);
    electronState.applicationMenu = application.menu;
    const foreignWindow = { isDestroyed: () => false };
    const foreignHostContents = {} as WebContents;
    const focusedGuest = {
      hostWebContents: foreignHostContents,
    } as WebContents;
    electronState.windowsByWebContents.set(foreignHostContents, foreignWindow);
    electronState.focusedWebContents = focusedGuest;
    const snapshot = readApplicationMenuSnapshot(sender);

    executeApplicationMenuItem(sender, snapshot.revision, "file/0");

    expect(click).toHaveBeenCalledWith({}, electronState.browserWindow, sender);
  });
});
