import { ipcRenderer } from "electron";
import type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutsSnapshot,
  GlobalShortcutStatus,
} from "../ipc-contracts/global-shortcuts-types";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface GlobalShortcutsBridgeSurface {
  globalShortcuts: {
    getSnapshot(): Promise<GlobalShortcutsSnapshot>;
    set(
      id: GlobalShortcutId,
      intent: GlobalShortcutIntent,
    ): Promise<GlobalShortcutStatus>;
    onChange(handler: Listener<GlobalShortcutsSnapshot>): Disposable;
  };
}

export function buildGlobalShortcutsBridge(): GlobalShortcutsBridgeSurface {
  return {
    globalShortcuts: {
      getSnapshot: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.globalShortcutsGetSnapshot,
        ) as Promise<GlobalShortcutsSnapshot>,
      set: (id, intent) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.globalShortcutsSet,
          id,
          intent,
        ) as Promise<GlobalShortcutStatus>,
      onChange: (handler) =>
        subscribe<GlobalShortcutsSnapshot>(
          RunnerHostEvent.globalShortcutsChange,
          handler,
        ),
    },
  };
}
