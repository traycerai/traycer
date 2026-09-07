import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { uiQueryKeys } from "@/lib/query-keys";

interface HostDirectoryLike {
  readonly list: () => Promise<readonly HostDirectoryEntry[]>;
}

let nextDirectoryId = 0;
const directoryIds = new WeakMap<HostDirectoryLike, string>();
const directoriesById = new Map<string, HostDirectoryLike>();

/** The directory object itself is held weakly so we do not leak it beyond its natural lifetime. */
export function registerHostPickerDirectory(
  directory: HostDirectoryLike,
): string {
  const existing = directoryIds.get(directory);
  if (existing !== undefined) return existing;
  nextDirectoryId += 1;
  const directoryId = `host-directory:${nextDirectoryId}`;
  directoryIds.set(directory, directoryId);
  directoriesById.set(directoryId, directory);
  return directoryId;
}

/**
 * Stable key (directory id only). Invalidate in place; a revision-in-key blanked `data` and flashed loading on every registry poll.
 */
export function useHostPickerList(
  directoryId: string | null,
): UseQueryResult<readonly HostDirectoryEntry[]> {
  return useQuery<readonly HostDirectoryEntry[]>(
    hostPickerListQueryOptions(directoryId),
  );
}

function hostPickerListQueryOptions(directoryId: string | null) {
  if (directoryId === null) {
    return queryOptions<readonly HostDirectoryEntry[]>({
      queryKey: uiQueryKeys.hostPickerMissing(),
      queryFn: () => Promise.resolve([]),
      enabled: false,
    });
  }
  return queryOptions<readonly HostDirectoryEntry[]>({
    queryKey: uiQueryKeys.hostPicker(directoryId),
    queryFn: () => {
      const registeredDirectory = directoriesById.get(directoryId);
      if (registeredDirectory === undefined) {
        return Promise.resolve([]);
      }
      return registeredDirectory.list();
    },
    // Under the global 60s staleTime, a consumer that mounted late was served ANOTHER consumer's boot-time fetch of the same key - an empty list captured before the host published - and never refetched, rendering every bound tab "Bound host is offline" for the whole session (2026-07-14 incident).
    staleTime: 0,
    gcTime: 30_000,
  });
}
