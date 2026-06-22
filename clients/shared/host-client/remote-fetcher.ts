import type { HostDirectoryEntry } from "./host-directory";

/**
 * Stub for the forthcoming remote-host discovery endpoint.
 *
 * Real remote discovery (D3 in the Tech Plan) is intentionally deferred. The
 * GUI-owned `HostDirectoryService` composes this fetcher with the runner
 * host's local-host snapshot to produce the merged directory. Today it
 * returns an empty list so `HostDirectoryService` always sees a stable
 * remote surface and later swaps in the real network call without changing
 * its composition wiring.
 *
 * The fetcher takes no parameters by design: auth scoping, base URL, and
 * error reporting all belong to the real implementation this stub replaces.
 */
export type RemoteHostFetcher = () => Promise<readonly HostDirectoryEntry[]>;

export const fetchRemoteHosts: RemoteHostFetcher = async () => {
  return [];
};
