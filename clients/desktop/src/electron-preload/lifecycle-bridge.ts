import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  AppLifecycleBridge,
  FreshUnsyncedSnapshotRequest,
  FreshUnsyncedSnapshotResponse,
  QuitDecisionResponse,
  QuitRequest,
  UnsyncedEditsSnapshot,
} from "../ipc-contracts/app-lifecycle-types";
import { subscribe } from "./subscribe";

export interface LifecycleBridgeSurface {
  /**
   * Desktop-only namespace. Not part of the cross-shell `IRunnerHost`
   * contract - renderer code must feature-detect
   * `window.runnerHost?.appLifecycle` before using it (mobile / gui-app-dev
   * shells leave this undefined).
   */
  appLifecycle: AppLifecycleBridge;
}

export function buildLifecycleBridge(): LifecycleBridgeSurface {
  return {
    appLifecycle: {
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
        subscribe<FreshUnsyncedSnapshotRequest>(
          RunnerHostEvent.getFreshUnsyncedSnapshot,
          handler,
        ),
      respondFreshUnsyncedSnapshot: (reply: FreshUnsyncedSnapshotResponse) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.freshUnsyncedSnapshotResponse,
          reply,
        ) as Promise<void>,
    },
  };
}
