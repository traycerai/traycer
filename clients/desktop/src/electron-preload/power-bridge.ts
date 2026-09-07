import { ipcRenderer } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";

export interface PowerBridgeSurface {
  setSleepBlocked(blocked: boolean): Promise<void>;
}

export function buildPowerBridge(): PowerBridgeSurface {
  return {
    setSleepBlocked: (blocked) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.powerSetSleepBlocked,
        blocked,
      ) as Promise<void>,
  };
}
