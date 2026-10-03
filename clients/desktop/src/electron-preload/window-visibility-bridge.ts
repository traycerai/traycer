import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Main's shown/not-minimised answer. Desktop keeps throttling disabled for
 * video receiver stats (#1613) and transport keepalives, so DOM visibility
 * alone cannot report hide/minimise.
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
