import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Whether THIS window is on screen (shown and not minimised), as main sees it.
 * The renderer ANDs it with the Page Visibility API, which stays `"visible"`
 * through minimise and hide while a WebRTC video plane has turned background
 * throttling off (`electron-main/windows/background-rendering.ts`).
 */
export interface WindowVisibilityBridgeSurface {
  /** The startup read; main's replay fires before any renderer subscription. */
  snapshot(): Promise<boolean>;
  /** Fired only when this window's own on-screen answer changes. */
  onChange(handler: Listener<boolean>): Disposable;
}

export function buildWindowVisibilityBridge(): WindowVisibilityBridgeSurface {
  return {
    snapshot: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.windowVisibilitySnapshot,
      ) as Promise<boolean>,
    onChange: (handler) =>
      subscribe<boolean>(RunnerHostEvent.windowVisibilityChange, handler),
  };
}
