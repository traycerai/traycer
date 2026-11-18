import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  PerWindowSnapshot,
  PerWindowStateCapabilities,
  PerWindowStatePatch,
  PerWindowStateUpdateAcknowledgement,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface PerWindowStateBridgeSurface {
  get(): Promise<PerWindowSnapshot>;
  capabilities(): Promise<PerWindowStateCapabilities>;
  update(
    patch: PerWindowStatePatch,
  ): Promise<PerWindowStateUpdateAcknowledgement | void>;
  clear(): Promise<void>;
  onChange(handler: Listener<PerWindowSnapshot>): Disposable;
}

export function buildPerWindowStateBridge(): PerWindowStateBridgeSurface {
  return {
    get: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.perWindowStateGet,
      ) as Promise<PerWindowSnapshot>,
    capabilities: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.perWindowStateCapabilities,
      ) as Promise<PerWindowStateCapabilities>,
    update: (patch) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.perWindowStateUpdate,
        patch,
      ) as Promise<PerWindowStateUpdateAcknowledgement | void>,
    clear: () =>
      ipcRenderer.invoke(RunnerHostInvoke.perWindowStateClear) as Promise<void>,
    onChange: (handler) =>
      subscribe<PerWindowSnapshot>(
        RunnerHostEvent.perWindowStateChange,
        handler,
      ),
  };
}
