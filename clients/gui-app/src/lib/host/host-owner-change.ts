import {
  readHostDirectoryEntry,
  subscribeAnyHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { retireRemoteSessionsForHost } from "@traycer-clients/shared/host-transport/remote/index";
import { retireHostStreamClientsForHost } from "@/lib/host/host-stream-client-cache";

/**
 * Whose computer a remote row says it is: kind and id, so a rename is the
 * same owner, and `""` for a row with no owner.
 */
function hostOwnerKey(entry: RemoteHostDirectoryEntry): string {
  return entry.owner === null ? "" : `${entry.owner.kind}:${entry.owner.id}`;
}

/** The owner each held remote computer was opened under. */
const openedUnder = new Map<string, string>();
let stopWatching: (() => void) | null = null;

/**
 * Records the owner `target` is being opened under, from the row the open is
 * built for, and starts the watch. Called at every remote transport build.
 */
export function noteRemoteHostOpened(target: RemoteHostDirectoryEntry): void {
  openedUnder.set(target.hostId, hostOwnerKey(target));
  stopWatching ??= subscribeAnyHostRowChanged(retireOnOwnerChange);
}

/**
 * A stream opened for one owner never serves another: when a held computer's
 * row names a different owner (none to someone counts), every stream client
 * and session held for it is closed, pinned ones included, and its holders
 * rebuild against the row as it now reads. A computer with no remote row to
 * read is left as it is until one is read.
 */
function retireOnOwnerChange(): void {
  for (const [hostId, previous] of [...openedUnder]) {
    const entry = readHostDirectoryEntry(hostId);
    if (entry === null || !isRemoteHostDirectoryEntry(entry)) continue;
    const owner = hostOwnerKey(entry);
    if (owner === previous) continue;
    openedUnder.set(hostId, owner);
    retireHostStreamClientsForHost(hostId);
    retireRemoteSessionsForHost(hostId);
  }
}

/** Test-only: forgets every recorded owner and stops the watch. */
export function resetHostOwnerChangeForTest(): void {
  openedUnder.clear();
  stopWatching?.();
  stopWatching = null;
}
