import { BrowserWindow, Menu } from "electron";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  desktopTopLevelMenuItemId,
  isDesktopTopLevelMenuId,
} from "../../ipc-contracts/window-types";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * Opens a submenu from Electron's canonical application menu for the visible
 * menu labels drawn inside the Windows frameless title bar.
 */
export function registerMenuIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.menuOpenTopLevel,
    (event, menuId: unknown, anchorX: unknown, anchorY: unknown) => {
      if (process.platform !== "win32") return;
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
  const safeZoomFactor =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(Math.max(0, value) * safeZoomFactor);
}

function readMenuAnchor(value: unknown, axis: "x" | "y"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`menu.openTopLevel requires a finite ${axis} coordinate`);
  }
  return value;
}
