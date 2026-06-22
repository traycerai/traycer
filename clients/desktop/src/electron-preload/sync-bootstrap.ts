import { ipcRenderer } from "electron";

export function readSyncString(channel: string, fallback: string): string {
  const value = ipcRenderer.sendSync(channel);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function readSyncBoolean(channel: string, fallback: boolean): boolean {
  const value = ipcRenderer.sendSync(channel);
  return typeof value === "boolean" ? value : fallback;
}
