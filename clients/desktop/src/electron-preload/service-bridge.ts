import { ipcRenderer } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";

export interface ServiceBridgeSurface {
  install(): Promise<void>;
  uninstall(purge: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  upgrade(): Promise<void>;
  /** Linux-only. Calls `loginctl enable-linger $USER`. */
  enableLinger(): Promise<void>;
  /** Read the last `maxLines` lines of the host's log file. */
  getLogTail(maxLines: number): Promise<string | null>;
}

export function buildServiceBridge(): ServiceBridgeSurface {
  return {
    install: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceInstall) as Promise<void>,
    uninstall: (purge) =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceUninstall, {
        purge,
      }) as Promise<void>,
    start: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceStart) as Promise<void>,
    stop: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceStop) as Promise<void>,
    restart: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceRestart) as Promise<void>,
    upgrade: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceUpgrade) as Promise<void>,
    enableLinger: () =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceEnableLinger) as Promise<void>,
    getLogTail: (maxLines) =>
      ipcRenderer.invoke(RunnerHostInvoke.serviceGetLogTail, {
        maxLines,
      }) as Promise<string | null>,
  };
}
