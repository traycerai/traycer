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

/**
 * Assigns and returns a stable, serialisable id for a directory so it can
 * participate in a TanStack query key. The directory object itself is held
 * weakly so we do not leak it beyond its natural lifetime.
 */
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
 * Loads the entries for the currently bound host directory.
 *
 * The key is STABLE (directory id only). Directory-change notifications force
 * a refetch via `invalidateQueries` on this key - never by minting a new key:
 * a revision-in-key design blanked `data` to `undefined` for every consumer
 * on every emit, and the 15s registry poll turned that into an app-wide
 * loading flash (terminal tiles unmounted through the reachability gate).
 * A same-key invalidate keeps the previous `data` during the refetch. When no
 * directory is bound the query is keyed on `queryKeys.hostPickerMissing()`
 * and disabled, matching the rest of the host-aware query surface.
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
    // `list()` is a synchronous in-memory snapshot behind a promise - there
    // is nothing to cache. Under the global 60s staleTime, a consumer that
    // mounted late was served ANOTHER consumer's boot-time fetch of the same
    // key - an empty list captured before the host published - and never
    // refetched, rendering every bound tab "Bound host is offline" for the
    // whole session (2026-07-14 incident). `staleTime: 0` (every mount
    // refetches) paired with the onChange -> invalidate wiring in
    // `useHostDirectoryList` is the load-bearing fix - keep BOTH.
    staleTime: 0,
    gcTime: 30_000,
  });
}
