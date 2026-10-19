import { useCallback, useSyncExternalStore } from "react";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * The team that owns a host, from the person's host directory (the registry
 * `owner`), or `null` for a host no team owns and while the directory cannot
 * say. Read through the context-free registry, since the picker also renders
 * where no host runtime is mounted.
 */
export function useHostOwnerTeamId(hostId: string | null): string | null {
  const subscribe = useCallback(
    (callback: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, callback),
    [hostId],
  );
  const getSnapshot = useCallback(() => {
    if (hostId === null) return null;
    const entry = readHostDirectoryEntry(hostId);
    if (entry === null || !isRemoteHostDirectoryEntry(entry)) return null;
    return entry.sandbox?.ownerTeamId ?? null;
  }, [hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Whether a host is a team's sandbox. */
export function useOnTeamSandbox(hostId: string | null): boolean {
  return useHostOwnerTeamId(hostId) !== null;
}
