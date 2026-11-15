import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

/**
 * The directory entry the Access and setup tests' host has, in a module that
 * imports nothing at run time: a `vi.mock` factory for
 * `@/hooks/host/use-host-directory-entry` reads it, and the test support's own
 * imports reach that module, so a factory that imported the support would wait
 * on the module it is building.
 */

export const ACCESS_HOST_ID = "host-a";
export const ACCESS_HOST_NAME = "dev-box";

const LOCAL_ACCESS_HOST_DIRECTORY_ENTRY: HostDirectoryEntry = {
  hostId: ACCESS_HOST_ID,
  label: ACCESS_HOST_NAME,
  kind: "local",
  websocketUrl: "ws://127.0.0.1:0",
  version: "1.5.0",
  transportDialability: "dialable",
};

let accessHostDirectoryEntry = LOCAL_ACCESS_HOST_DIRECTORY_ENTRY;

export function setAccessHostDirectoryEntry(entry: HostDirectoryEntry): void {
  accessHostDirectoryEntry = entry;
}

export function resetAccessHostDirectoryEntry(): void {
  accessHostDirectoryEntry = LOCAL_ACCESS_HOST_DIRECTORY_ENTRY;
}

export function accessHostDirectoryEntryFor(
  hostId: string | null,
): HostDirectoryEntry | null {
  return hostId !== null && accessHostDirectoryEntry.hostId === hostId
    ? accessHostDirectoryEntry
    : null;
}
