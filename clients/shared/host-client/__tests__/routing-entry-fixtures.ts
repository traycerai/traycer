import {
  poolHostDirectoryEntry,
  type HostDirectoryEntry,
  type PoolHostDirectoryEntry,
} from "../host-directory";
import type {
  RemoteHostDirectoryEntry,
  RemoteHostSandboxFacts,
} from "../remote-fetcher";

export const localEntry: HostDirectoryEntry = {
  hostId: "host-local",
  label: "Local",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

export function remoteEntry(
  hostId: string,
  sandbox: RemoteHostSandboxFacts | null,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: `label-${hostId}`,
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey: `pubkey-${hostId}`,
    relayFuseGrace: false,
    sandbox,
    remoteStatus: {
      connectivity: "online",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt: null,
    },
  };
}

export function sandboxFacts(
  ownerTeamId: string | null,
): RemoteHostSandboxFacts {
  return {
    state: null,
    frozen: false,
    profile: null,
    ownerTeamName: ownerTeamId === null ? null : "Team",
    ownerTeamId,
  };
}

export const personalRemoteEntry = remoteEntry("host-personal-remote", null);
export const personalSandboxEntry = remoteEntry(
  "host-personal-sandbox",
  sandboxFacts(null),
);
export const teamSandboxEntry = remoteEntry(
  "host-team-sandbox",
  sandboxFacts("team-1"),
);

export const poolEntry: PoolHostDirectoryEntry = (() => {
  const entry = poolHostDirectoryEntry("wss://pool.test/rpc");
  if (entry === null) {
    throw new Error("pool fixture must build");
  }
  return entry;
})();
