import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DesktopRuntimePlatform,
  DesktopMenuSnapshot,
  DesktopTopLevelMenuId,
  MenuCommandPayload,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface MenuBridgeSurface {
  menu: {
    getSnapshot(): Promise<DesktopMenuSnapshot>;
    executeItem(revision: number, itemId: string): Promise<void>;

    readonly platform: DesktopRuntimePlatform;
    onCommand(handler: Listener<MenuCommandPayload>): Disposable;
    openTopLevel(
      menuId: DesktopTopLevelMenuId,
      anchorX: number,
      anchorY: number,
    ): Promise<void>;
  };
}

export function buildMenuBridge(): MenuBridgeSurface {
  return {
    menu: {
      platform: readDesktopRuntimePlatform(),
      getSnapshot: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.menuGetSnapshot,
        ) as Promise<DesktopMenuSnapshot>,
      executeItem: (revision, itemId) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.menuExecuteItem,
          revision,
          itemId,
        ) as Promise<void>,
      onCommand: (handler) =>
        subscribe<MenuCommandPayload>(RunnerHostEvent.menuCommand, handler),
      openTopLevel: (menuId, anchorX, anchorY) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.menuOpenTopLevel,
          menuId,
          anchorX,
          anchorY,
        ) as Promise<void>,
    },
  };
}

function readDesktopRuntimePlatform(): DesktopRuntimePlatform {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  return "linux";
}
