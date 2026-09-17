import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Whether THIS window is on screen (shown and not minimised), as main sees it.
 * Renderer parking cannot read it from the Page Visibility API in this app:
 * every window runs with `backgroundThrottling: false`, which keeps
 * `document.visibilityState` at `"visible"` through minimise and hide.
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
