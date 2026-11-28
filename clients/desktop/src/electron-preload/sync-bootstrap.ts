import { ipcRenderer } from "electron";

export function readSyncString(channel: string, fallback: string): string {
  const value = ipcRenderer.sendSync(channel);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function readSyncBoolean(channel: string, fallback: boolean): boolean {
  const value = ipcRenderer.sendSync(channel);
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A synchronous numeric read. `fallback` is what the preload uses when main
 * declines to answer (an unknown or untrusted sender returns `null`), so
 * callers pass a value their own domain treats as "not issued" rather than a
 * plausible number.
 */
export function readSyncNumber(channel: string, fallback: number): number {
  return syncNumberOf(ipcRenderer.sendSync(channel), fallback);
}

export function readSyncNumberFor(
  channel: string,
  argument: string,
  fallback: number,
): number {
  return syncNumberOf(ipcRenderer.sendSync(channel, argument), fallback);
}

/** A synchronous string read for one argument; anything but a non-empty string is null. */
export function readSyncNullableStringFor(
  channel: string,
  argument: string,
): string | null {
  const value: unknown = ipcRenderer.sendSync(channel, argument);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function syncNumberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}
