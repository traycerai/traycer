import {
  hostListItemToDirectoryEntry,
  isRemoteHostDirectoryEntry,
  type HostListFetchResult,
  type RemoteHostFetcher,
  type RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { FleetHostRow } from "../mobile-runner-host";

// The baked dev host captures the port as of Vite startup, which goes stale
// whenever the dev host restarts; the dev-server endpoint re-reads the host's
// pid.json per request, so each directory refresh gets the live port.
// BROWSER-TESTING SCAFFOLDING (dev entry only): a shipped build carries no
// `devHost` and uses real remote-host discovery instead (see below).
export function buildDevHostFetcher(
  devHost: TraycerMobileDevHost,
): () => Promise<RemoteHostFetchOutcome> {
  // The baked config predates the directory's dialability field; the dev
  // host is a loopback WebSocket, which is the definition of dialable.
  const bakedHost: RemoteHostFetchOutcome = {
    kind: "hosts",
    entries: [{ ...devHost.host, transportDialability: "dialable" }],
  };
  return async () => {
    try {
      const response = await fetch(devHost.devHostPath);
      if (!response.ok) return bakedHost;
      const parsed: unknown = await response.json();
      if (parsed === null || typeof parsed !== "object") return bakedHost;
      const record = parsed as Record<string, unknown>;
      const { hostId, version, websocketUrl } = record;
      if (
        typeof hostId !== "string" ||
        typeof version !== "string" ||
        typeof websocketUrl !== "string"
      ) {
        return bakedHost;
      }
      return {
        kind: "hosts",
        entries: [
          {
            ...devHost.host,
            hostId,
            version,
            websocketUrl,
            transportDialability: "dialable",
          },
        ],
      };
    } catch {
      // The baked entry, not `failed`: this scaffolding's whole point is that
      // the dev host is reachable at a known port even when the pid re-read
      // misses.
      return bakedHost;
    }
  };
}

/** A stored sign-in: the bearer, and the account it belongs to. */
export interface DevHostSignIn {
  readonly bearerToken: string;
  readonly accountId: string;
}

/**
 * The last successful registry read, kept for the account that made it. One
 * per dev entry, shared by the directory and the fleet reads.
 */
export interface DevHostRegistryMemory {
  last: {
    readonly accountId: string;
    readonly entries: readonly HostDirectoryEntry[];
  } | null;
}

export function createDevHostRegistryMemory(): DevHostRegistryMemory {
  return { last: null };
}

/** Where the dev entry's discovery reads the account's host registry. */
export interface DevHostRegistrySource {
  /** The stored sign-in, or `null` while signed out. */
  readonly signIn: () => Promise<DevHostSignIn | null>;
  /** `GET /api/v3/hosts?include=sandboxState,owner` under that bearer. */
  readonly listRegisteredHosts: (
    bearerToken: string,
  ) => Promise<HostListFetchResult>;
  /** The relay every remote entry is dialed through. */
  readonly relayBaseUrl: string;
  readonly memory: DevHostRegistryMemory;
}

/**
 * The dev entry's directory discovery: the loopback dev host ADDED to the
 * account's registry hosts, never in place of them. Replacing them left every
 * account host - a connectable sandbox included - without a directory entry, so
 * no picker could select it.
 *
 * Signed out (or no stored sign-in) it is the dev host alone, as before. The
 * dev host's own registry twin is dropped: the loopback entry is the one the
 * browser dials.
 */
export function buildDevHostDiscovery(
  devHostFetch: () => Promise<RemoteHostFetchOutcome>,
  registry: DevHostRegistrySource,
): RemoteHostFetcher {
  return async (era) => {
    if (era.identity === null) return devHostFetch();
    return readDevHostDiscovery(devHostFetch, registry);
  };
}

/**
 * One discovery read, for the directory (behind its era check above) and for
 * the selection fleet (whose caller fences the account itself).
 *
 * Never `failed`: a registry read that does not answer (authn down, a 401)
 * keeps the freshly read dev host and this account's last good registry rows.
 * `failed` carried no dev host, so an authn outage took the dev
 * GUI's own loopback host out of the directory and the fleet.
 */
export async function readDevHostDiscovery(
  devHostFetch: () => Promise<RemoteHostFetchOutcome>,
  registry: DevHostRegistrySource,
): Promise<RemoteHostFetchOutcome> {
  const dev = await devHostFetch();
  const signIn = await registry.signIn();
  if (signIn === null) return dev;
  const devEntries = dev.kind === "hosts" ? dev.entries : [];
  const listed = await registry.listRegisteredHosts(signIn.bearerToken);
  if (listed.kind !== "ok") {
    const last = registry.memory.last;
    const retained =
      last !== null && last.accountId === signIn.accountId ? last.entries : [];
    return { kind: "hosts", entries: [...devEntries, ...retained] };
  }
  const devHostIds = new Set(devEntries.map((entry) => entry.hostId));
  const entries = listed.response.hosts
    .filter((item) => !devHostIds.has(item.hostId))
    .map((item) => hostListItemToDirectoryEntry(item, registry.relayBaseUrl));
  registry.memory.last = { accountId: signIn.accountId, entries };
  return { kind: "hosts", entries: [...devEntries, ...entries] };
}

/**
 * The selection fleet for the same discovery, so Activate accepts every host
 * the directory lists (it refuses one outside the fleet). A remote entry
 * carrying sandbox facts is a sandbox; the loopback dev host is not.
 */
export function fleetRowsOf(
  outcome: RemoteHostFetchOutcome,
): readonly FleetHostRow[] | null {
  return outcome.kind === "hosts"
    ? outcome.entries.map((entry) => ({
        hostId: entry.hostId,
        sandbox: isRemoteHostDirectoryEntry(entry) && entry.sandbox !== null,
        teamOwned:
          isRemoteHostDirectoryEntry(entry) &&
          entry.sandbox !== null &&
          entry.sandbox.ownerTeamId !== null,
      }))
    : null;
}
