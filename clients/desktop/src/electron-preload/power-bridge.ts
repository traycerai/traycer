import { ipcRenderer } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";

/**
 * Preload surface for renderer-driven sleep prevention. The renderer pushes
 * the recomputed `preventSleepWhileRunning && anyLocalAgentActive` boolean and
 * main reconciles a single `powerSaveBlocker` (see
 * `electron-main/app/sleep-blocker`).
 */
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
