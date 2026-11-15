import { describe, expect, it, vi } from "vitest";
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  hostTransportKeyFor,
  dialableHostEndpointFor,
} from "@/lib/host/transport-key";

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:9/stream",
    version: "2.0.0",
    transportDialability: "dialable",
    ...overrides,
  };
}

function remoteEntry(
  overrides: Partial<RemoteHostDirectoryEntry>,
): RemoteHostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "1.2.3",
    transportDialability: "dialable",
    publicKey: "pubkey-a",
    relayFuseGrace: false,
    sandbox: null,
    owner: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...overrides,
  };
}

describe("minimum-version transport gate", () => {
  it("uses the local entry version and remote appVersion for both key and endpoint", () => {
    const localAtFloor = entry({ version: "2.0.0" });
    const localBelowFloor = entry({ version: "1.5.4" });
    const remoteAtFloor = remoteEntry({
      version: "9.9.9",
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "2.0.0",
        lastSeenAt: null,
      },
    });
    const remoteBelowFloor = remoteEntry({
      ...remoteAtFloor,
      remoteStatus: { ...remoteAtFloor.remoteStatus, appVersion: "1.5.4" },
    });

    expect(hostTransportKeyFor(localAtFloor, false)).not.toBeNull();
    expect(dialableHostEndpointFor(localAtFloor, false)).not.toBeNull();
    expect(hostTransportKeyFor(localBelowFloor, false)).toBeNull();
    expect(dialableHostEndpointFor(localBelowFloor, false)).toBeNull();

    expect(hostTransportKeyFor(remoteAtFloor, false)).not.toBeNull();
    expect(dialableHostEndpointFor(remoteAtFloor, false)).not.toBeNull();
    expect(hostTransportKeyFor(remoteBelowFloor, false)).toBeNull();
    expect(dialableHostEndpointFor(remoteBelowFloor, false)).toBeNull();
  });
});
