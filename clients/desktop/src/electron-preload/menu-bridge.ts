import { RunnerHostEvent } from "../ipc-contracts/ipc-channels";
import type { MenuCommandPayload } from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface MenuBridgeSurface {
  menu: {
    onCommand(handler: Listener<MenuCommandPayload>): Disposable;
  };
}

export function buildMenuBridge(): MenuBridgeSurface {
  return {
    menu: {
      onCommand: (handler) =>
        subscribe<MenuCommandPayload>(RunnerHostEvent.menuCommand, handler),
    },
  };
}
