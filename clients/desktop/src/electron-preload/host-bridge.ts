import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../ipc-contracts/host-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Eagerly subscribe at module load so the initial host snapshot pushed
 * during `RunnerIpcBridge.install()` is captured even if the renderer
 * constructs its `DesktopRunnerHost` after that push. New subscribers receive
 * the cached value synchronously and every subsequent transition via fan-out.
 */
let cachedLocalHost: DesktopLocalHostSnapshot | null = null;
const localHostHandlers = new Set<Listener<DesktopLocalHostSnapshot | null>>();

ipcRenderer.on(
  RunnerHostEvent.localHostChange,
  (_event: unknown, payload: unknown): void => {
    const snapshot = payload as DesktopLocalHostSnapshot | null;
    cachedLocalHost = snapshot;
    for (const handler of localHostHandlers) {
      handler(snapshot);
    }
  },
);

function subscribeLocalHost(
  handler: Listener<DesktopLocalHostSnapshot | null>,
): Disposable {
  localHostHandlers.add(handler);
  handler(cachedLocalHost);
  return {
    dispose: () => {
      localHostHandlers.delete(handler);
    },
  };
}

export interface HostBridgeSurface {
  onLocalHostChange(
    handler: Listener<DesktopLocalHostSnapshot | null>,
  ): Disposable;
  onSystemResumed(handler: () => void): Disposable;
  requestHostRespawn(): Promise<void>;
  hostPicker: {
    requestOpen(): Promise<void>;
    requestClose(): Promise<void>;
    onChange(handler: Listener<boolean>): Disposable;
  };
}

export function buildHostBridge(): HostBridgeSurface {
  return {
    onLocalHostChange: (handler) => subscribeLocalHost(handler),

    // A transient "machine woke" pulse - no snapshot to cache, so it routes
    // through the generic per-event subscription (unlike the cached
    // local-host snapshot above).
    onSystemResumed: (handler) =>
      subscribe<void>(RunnerHostEvent.systemResumed, handler),

    requestHostRespawn: () =>
      ipcRenderer.invoke(RunnerHostInvoke.requestHostRespawn) as Promise<void>,

    hostPicker: {
      requestOpen: () =>
        ipcRenderer.invoke(RunnerHostInvoke.hostPickerRequestOpen),
      requestClose: () =>
        ipcRenderer.invoke(RunnerHostInvoke.hostPickerRequestClose),
      onChange: (handler) =>
        subscribe<boolean>(RunnerHostEvent.hostPickerChange, handler),
    },
  };
}
