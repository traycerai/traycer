import { ipcRenderer } from "electron";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
} from "../ipc-contracts/app-update-types";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface AppUpdateBridgeSurface {
  appUpdates: {
    getSnapshot(): Promise<DesktopAppUpdateSnapshot>;
    checkForUpdates(
      intent: DesktopAppUpdateCheckIntent,
    ): Promise<DesktopAppUpdateSnapshot>;
    setAllowPrerelease(
      allowPrerelease: boolean,
    ): Promise<DesktopAppUpdateSnapshot>;
    downloadUpdate(): Promise<DesktopAppUpdateSnapshot>;
    installUpdate(): Promise<DesktopAppUpdateSnapshot>;
    onChange(handler: Listener<DesktopAppUpdateSnapshot>): Disposable;
  };
}

export function buildAppUpdateBridge(): AppUpdateBridgeSurface {
  return {
    appUpdates: {
      getSnapshot: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateGetSnapshot,
        ) as Promise<DesktopAppUpdateSnapshot>,
      checkForUpdates: (intent) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateCheck,
          intent,
        ) as Promise<DesktopAppUpdateSnapshot>,
      setAllowPrerelease: (allowPrerelease) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateSetAllowPrerelease,
          allowPrerelease,
        ) as Promise<DesktopAppUpdateSnapshot>,
      downloadUpdate: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateDownload,
        ) as Promise<DesktopAppUpdateSnapshot>,
      installUpdate: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateInstall,
        ) as Promise<DesktopAppUpdateSnapshot>,
      onChange: (handler) =>
        subscribe<DesktopAppUpdateSnapshot>(
          RunnerHostEvent.appUpdateChange,
          handler,
        ),
    },
  };
}
