import { ipcRenderer } from "electron";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

export type { Disposable };
export type Listener<T> = (value: T) => void;

export function subscribe<T>(
  channel: string,
  handler: Listener<T>,
): Disposable {
  const wrapped = (_event: unknown, payload: unknown): void => {
    handler(payload as T);
  };
  ipcRenderer.on(channel, wrapped);
  return {
    dispose: () => {
      ipcRenderer.removeListener(channel, wrapped);
    },
  };
}
