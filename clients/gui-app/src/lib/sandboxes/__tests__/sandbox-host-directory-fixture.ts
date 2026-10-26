import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * A sandbox host's directory row: a remote row carrying sandbox facts. `team`
 * names the owning team, or `null` for the person's own (Personal) sandbox.
 */
export function sandboxHostEntry(
  hostId: string,
  team: { readonly id: string; readonly name: string } | null,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: "Sandbox",
    kind: "remote",
    websocketUrl: "wss://relay.invalid/attach",
    version: "1.2.3",
    transportDialability: "dialable",
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    publicKey: `pubkey-${hostId}`,
    relayFuseGrace: false,
    sandbox: {
      state: "awake",
      frozen: false,
      profile: "agent",
      ownerTeamName: team === null ? null : team.name,
      ownerTeamId: team === null ? null : team.id,
    },
  };
}

/** A laptop-like local row, with no sandbox facts. */
export function plainHostEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };
}

/** Serves these rows as the host connection registry's directory. */
export function installHostDirectoryRows(
  rows: ReadonlyArray<HostDirectoryEntry>,
): void {
  const byId = new Map(rows.map((row) => [row.hostId, row]));
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => byId.get(hostId) ?? null,
      onDirectoryChanged: () => ({ dispose: () => undefined }),
    },
    leases: null,
  });
}

export function resetHostDirectoryRows(): void {
  resetHostConnectionRegistryForTest();
}
