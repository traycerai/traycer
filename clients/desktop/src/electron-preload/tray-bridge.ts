import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DesktopTrayEpic,
  DesktopTrayIndicatorState,
} from "../ipc-contracts/host-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface TrayBridgeSurface {
  trayState: {
    setEpics(epics: readonly DesktopTrayEpic[]): Promise<void>;
    setIndicator(state: DesktopTrayIndicatorState): Promise<void>;
    onEpicSelected(handler: Listener<string>): Disposable;
  };
}

export function buildTrayBridge(): TrayBridgeSurface {
  return {
    trayState: {
      setEpics: (epics) =>
        ipcRenderer.invoke(RunnerHostInvoke.traySetEpics, epics),
      setIndicator: (state) =>
        ipcRenderer.invoke(RunnerHostInvoke.traySetIndicator, state),
      onEpicSelected: (handler) =>
        subscribe<string>(RunnerHostEvent.trayEpicSelected, handler),
    },
  };
}
