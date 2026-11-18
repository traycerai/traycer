import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type { EpicVisibilityEntry } from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface EpicVisibilityBridgeSurface {
  /**
   * The whole per-window map as it stands now. The startup read: main's replay
   * fires on the preload's synchronous `windowId` read, before any renderer
   * subscription exists.
   */
  snapshot(): Promise<readonly EpicVisibilityEntry[]>;
  /** This window's own visible-Epic roll-up, reported on every change. */
  report(epicIds: readonly string[]): Promise<void>;
  /** The whole per-window map, including this window's own last report. */
  onChange(handler: Listener<readonly EpicVisibilityEntry[]>): Disposable;
}

export function buildEpicVisibilityBridge(): EpicVisibilityBridgeSurface {
  return {
    snapshot: () =>
      ipcRenderer.invoke(RunnerHostInvoke.epicVisibilitySnapshot) as Promise<
        readonly EpicVisibilityEntry[]
      >,
    report: (epicIds) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.epicVisibilityReport,
        // A plain array: the structured clone across the IPC boundary rejects
        // a `Set`, and the caller's own collection type must not decide the
        // wire shape.
        Array.from(epicIds),
      ) as Promise<void>,
    onChange: (handler) =>
      subscribe<readonly EpicVisibilityEntry[]>(
        RunnerHostEvent.epicVisibilityChange,
        handler,
      ),
  };
}
