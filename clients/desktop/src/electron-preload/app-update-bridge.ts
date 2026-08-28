import { ipcRenderer } from "electron";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateSnapshot,
  DesktopCompatRecoveryPlan,
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
    ): Promise<DesktopAppUpdateChannelChange>;
    downloadUpdate(): Promise<DesktopAppUpdateSnapshot>;
    installUpdate(): Promise<DesktopAppUpdateSnapshot>;
    resolveCompatRecovery(request: {
      readonly minimumEpoch: number;
      readonly hostAllowsRcRecovery: boolean;
    }): Promise<DesktopCompatRecoveryPlan>;
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
        ) as Promise<DesktopAppUpdateChannelChange>,
      downloadUpdate: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateDownload,
        ) as Promise<DesktopAppUpdateSnapshot>,
      installUpdate: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateInstall,
        ) as Promise<DesktopAppUpdateSnapshot>,
      resolveCompatRecovery: (request) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.appUpdateResolveCompatRecovery,
          request,
        ) as Promise<DesktopCompatRecoveryPlan>,
      onChange: (handler) =>
        subscribe<DesktopAppUpdateSnapshot>(
          RunnerHostEvent.appUpdateChange,
          handler,
        ),
    },
  };
}
