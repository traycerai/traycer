import {
  readApplicationMenuSnapshot,
  executeApplicationMenuItem,
} from "../menu/application-menu-snapshot";
import { BrowserWindow, Menu } from "electron";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  desktopTopLevelMenuItemId,
  isDesktopTopLevelMenuId,
} from "../../ipc-contracts/window-types";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { cssPixelsToWindowDips } from "../windows/css-pixel-scale";

/**
 * Renderer menubars reuse Electron's canonical menu definitions and actions.
 * The native popup entry point remains available to existing desktop callers.
 */
export function registerMenuIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.menuGetSnapshot, (event) => {
    if (process.platform !== "win32" && process.platform !== "linux")
      return { revision: 0, menus: [] };
    return readApplicationMenuSnapshot(event.sender);
  });
  bridge.handleInvoke(
    RunnerHostInvoke.menuExecuteItem,
    (event, revision: unknown, itemId: unknown) => {
      if (process.platform !== "win32" && process.platform !== "linux") return;
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        typeof itemId !== "string"
      ) {
        throw new Error("menu.executeItem requires a revision and item id");
      }
      executeApplicationMenuItem(event.sender, revision, itemId);
    },
  );
  bridge.handleInvoke(
    RunnerHostInvoke.menuOpenTopLevel,
    (event, menuId: unknown, anchorX: unknown, anchorY: unknown) => {
      if (process.platform !== "win32" && process.platform !== "linux") return;
      if (!isDesktopTopLevelMenuId(menuId)) {
        throw new Error("menu.openTopLevel requires a known menu id");
      }
      const x = readMenuAnchor(anchorX, "x");
      const y = readMenuAnchor(anchorY, "y");
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window.isDestroyed()) return;

      const applicationMenu = Menu.getApplicationMenu();
      const submenu = applicationMenu?.getMenuItemById(
        desktopTopLevelMenuItemId(menuId),
      )?.submenu;
      if (submenu === undefined) return;

      // DOMRect coordinates are CSS pixels. BrowserWindow popup coordinates
      // are device-independent screen pixels, so account for page zoom before
      // anchoring the native submenu beneath its renderer label.
      const zoomFactor = window.webContents.getZoomFactor();
      submenu.popup({
        window,
        x: scaleMenuAnchor(x, zoomFactor),
        y: scaleMenuAnchor(y, zoomFactor),
      });
    },
  );
}

export function scaleMenuAnchor(value: number, zoomFactor: number): number {
  return cssPixelsToWindowDips(Math.max(0, value), zoomFactor);
}

function readMenuAnchor(value: unknown, axis: "x" | "y"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`menu.openTopLevel requires a finite ${axis} coordinate`);
  }
  return value;
}
