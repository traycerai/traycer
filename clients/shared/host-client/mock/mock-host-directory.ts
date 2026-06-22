import type { HostDirectoryEntry } from "../host-directory";

/**
 * Prebuilt mock host directory entries used by `gui-app` dev and preview
 * flows and by shared tests. Exposes "local", "remote", and "mock" kinds so
 * picker UX can be exercised without a real runner or backend registry.
 */
export const mockLocalHostEntry: HostDirectoryEntry = {
  hostId: "mock-local",
  label: "Mock Mac",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "0.0.0-mock",
  status: "available",
};

export const mockRemoteHostEntry: HostDirectoryEntry = {
  hostId: "mock-remote",
  label: "Mock Remote Host",
  kind: "remote",
  websocketUrl: "wss://mock-remote.traycer.invalid/rpc",
  version: "0.0.0-mock",
  status: "available",
};

export const mockInProcessHostEntry: HostDirectoryEntry = {
  hostId: "mock-in-process",
  label: "Mock In-Process Host",
  kind: "mock",
  websocketUrl: null,
  version: "0.0.0-mock",
  status: "available",
};

export const mockHostDirectoryEntries: readonly HostDirectoryEntry[] = [
  mockLocalHostEntry,
  mockRemoteHostEntry,
  mockInProcessHostEntry,
];
