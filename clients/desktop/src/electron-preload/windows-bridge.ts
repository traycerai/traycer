import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  OpenEpicInNewWindowResult,
  WindowSummary,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";
import {
  buildAuthSessionBridge,
  type AuthSessionBridgeSurface,
} from "./auth-bridge";
import {
  buildOwnershipBridge,
  type OwnershipBridgeSurface,
} from "./ownership-bridge";
import {
  buildPerWindowStateBridge,
  type PerWindowStateBridgeSurface,
} from "./per-window-state-bridge";

export interface WindowsBridgeSurface {
  windows: {
    readonly windowId: string;
    list(): Promise<readonly WindowSummary[]>;
    onChange(handler: Listener<readonly WindowSummary[]>): Disposable;
    requestNew(initialRoute: string | null): Promise<void>;
    requestFocus(windowId: string): Promise<void>;
    requestClose(windowId: string): Promise<void>;
    requestOpenEpicInNewWindow(
      epicId: string,
      title: string,
      tabId: string,
    ): Promise<OpenEpicInNewWindowResult>;
    ownership: OwnershipBridgeSurface;
    perWindowState: PerWindowStateBridgeSurface;
    authSession: AuthSessionBridgeSurface;
  };
}

export function buildWindowsBridge(windowId: string): WindowsBridgeSurface {
  return {
    windows: {
      windowId,
      list: () =>
        ipcRenderer.invoke(RunnerHostInvoke.windowsList) as Promise<
          readonly WindowSummary[]
        >,
      onChange: (handler) =>
        subscribe<readonly WindowSummary[]>(
          RunnerHostEvent.windowsChange,
          handler,
        ),
      requestNew: (initialRoute) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowsRequestNew,
          initialRoute,
        ) as Promise<void>,
      requestFocus: (targetWindowId) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowsRequestFocus,
          targetWindowId,
        ) as Promise<void>,
      requestClose: (targetWindowId) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowsRequestClose,
          targetWindowId,
        ) as Promise<void>,
      requestOpenEpicInNewWindow: (epicId, title, tabId) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
          epicId,
          title,
          tabId,
        ) as Promise<OpenEpicInNewWindowResult>,
      ownership: buildOwnershipBridge(),
      perWindowState: buildPerWindowStateBridge(),
      authSession: buildAuthSessionBridge(),
    },
  };
}
