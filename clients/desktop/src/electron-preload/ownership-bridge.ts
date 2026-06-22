import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  OwnershipClaimResult,
  OwnershipEntry,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface OwnershipBridgeSurface {
  snapshot(): Promise<readonly OwnershipEntry[]>;
  claim(tabId: string, epicId: string): Promise<OwnershipClaimResult>;
  release(tabId: string): Promise<void>;
  onChange(handler: Listener<readonly OwnershipEntry[]>): Disposable;
}

export function buildOwnershipBridge(): OwnershipBridgeSurface {
  return {
    snapshot: () =>
      ipcRenderer.invoke(RunnerHostInvoke.ownershipSnapshot) as Promise<
        readonly OwnershipEntry[]
      >,
    claim: (tabId, epicId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.ownershipClaim,
        tabId,
        epicId,
      ) as Promise<OwnershipClaimResult>,
    release: (tabId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.ownershipRelease,
        tabId,
      ) as Promise<void>,
    onChange: (handler) =>
      subscribe<readonly OwnershipEntry[]>(
        RunnerHostEvent.ownershipChange,
        handler,
      ),
  };
}
