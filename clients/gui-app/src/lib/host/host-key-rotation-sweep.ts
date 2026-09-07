import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * Sweep a remote host's query scope when its public key rotates under the same host id.
 * Watch the directory; never prune last-seen keys (empty/refill is not a rebuild).
 */
export function buildHostKeyRotationSweep(deps: {
  /** Invalidates one host's query scope. Announcing forms need not apply. */
  readonly sweepHostScope: (hostId: string) => void;
}): (entries: readonly HostDirectoryEntry[]) => void {
  // Last key per host, never pruned: directory empty/refill is not a rebuild.
  const lastKeyByHost = new Map<string, string>();
  return (entries) => {
    for (const entry of entries) {
      if (!isRemoteHostDirectoryEntry(entry)) {
        continue;
      }
      const previous = lastKeyByHost.get(entry.hostId);
      lastKeyByHost.set(entry.hostId, entry.publicKey);
      if (previous === undefined || previous === entry.publicKey) {
        continue;
      }
      deps.sweepHostScope(entry.hostId);
    }
  };
}
