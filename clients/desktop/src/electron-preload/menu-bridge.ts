import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DesktopRuntimePlatform,
  DesktopTopLevelMenuId,
  MenuCommandPayload,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface MenuBridgeSurface {
  menu: {
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
