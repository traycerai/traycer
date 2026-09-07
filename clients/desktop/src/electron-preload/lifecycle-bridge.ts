import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  AppLifecycleBridge,
  CrossWindowUnsyncableReport,
  FreshUnsyncedSnapshotResponse,
  QuitDecisionResponse,
  QuitRequest,
  UnsyncedEditsSnapshot,
} from "../ipc-contracts/app-lifecycle-types";
import { subscribe } from "./subscribe";

export interface LifecycleBridgeSurface {
  appLifecycle: AppLifecycleBridge;
}

export function buildLifecycleBridge(): LifecycleBridgeSurface {
  return {
    appLifecycle: {
      quit: () =>
        ipcRenderer.invoke(RunnerHostInvoke.appLifecycleQuit) as Promise<void>,
      setUnsyncedEditsSnapshot: (snapshot: UnsyncedEditsSnapshot) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.setUnsyncedEditsSnapshot,
          snapshot,
        ) as Promise<void>,
      onQuitRequested: (handler) =>
        subscribe<QuitRequest>(RunnerHostEvent.quitRequested, handler),
      acknowledgeQuitRequest: (requestId: string) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.acknowledgeQuitRequest,
          requestId,
        ) as Promise<void>,
      respondToQuitRequest: (response: QuitDecisionResponse) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.respondToQuitRequest,
          response,
        ) as Promise<void>,
      onGetFreshUnsyncedSnapshot: (handler) =>
        subscribe<{ readonly requestId: string }>(
          RunnerHostEvent.getFreshUnsyncedSnapshot,
          handler,
        ),
      respondFreshUnsyncedSnapshot: (reply: FreshUnsyncedSnapshotResponse) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.freshUnsyncedSnapshotResponse,
          reply,
        ) as Promise<void>,
      unsyncableWorkAcrossWindows: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.unsyncableWorkAcrossWindows,
        ) as Promise<CrossWindowUnsyncableReport>,
    },
  };
}
