import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface MigrationRunChangePayload {
  readonly running: boolean;
  readonly originWindowId: string | null;
}

export interface MigrationBridgeSurface {
  announceRunning(payload: MigrationRunChangePayload): Promise<void>;
  getSnapshot(): Promise<MigrationRunChangePayload>;
  onChange(handler: Listener<MigrationRunChangePayload>): Disposable;
}

export function buildMigrationBridge(): MigrationBridgeSurface {
  return {
    announceRunning: (payload) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.migrationAnnounceRunning,
        payload,
      ) as Promise<void>,
    getSnapshot: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.migrationGetRunningSnapshot,
      ) as Promise<MigrationRunChangePayload>,
    onChange: (handler) =>
      subscribe<MigrationRunChangePayload>(
        RunnerHostEvent.migrationRunChange,
        handler,
      ),
  };
}
