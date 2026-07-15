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
 * The directory id + revision is part of the query key so directory-change
 * notifications can force a refetch simply by bumping `revision`. When no
 * directory is bound the query is keyed on `queryKeys.hostPickerMissing()`
 * and disabled, matching the rest of the host-aware query surface.
 */
export function useHostPickerList(
  directoryId: string | null,
  revision: number,
): UseQueryResult<readonly HostDirectoryEntry[]> {
  return useQuery<readonly HostDirectoryEntry[]>(
    hostPickerListQueryOptions(directoryId, revision),
  );
}

function hostPickerListQueryOptions(
  directoryId: string | null,
  revision: number,
) {
  if (directoryId === null) {
    return queryOptions<readonly HostDirectoryEntry[]>({
      queryKey: uiQueryKeys.hostPickerMissing(),
      queryFn: () => Promise.resolve([]),
      enabled: false,
    });
  }
  return queryOptions<readonly HostDirectoryEntry[]>({
    queryKey: uiQueryKeys.hostPicker(directoryId, revision),
    queryFn: () => {
      const registeredDirectory = directoriesById.get(directoryId);
      if (registeredDirectory === undefined) {
        return Promise.resolve([]);
      }
      return registeredDirectory.list();
    },
    // `list()` is a synchronous in-memory snapshot behind a promise - there
    // is nothing to cache. Under the global 60s staleTime, a consumer that
    // mounted at revision 0 was served ANOTHER consumer's boot-time fetch of
    // the same key - an empty list captured before the host published - and
    // never refetched, rendering every bound tab "Bound host is offline" for
    // the whole session (2026-07-14 incident). Always refetch on mount, and
    // let superseded revision entries fall out of the cache quickly.
    staleTime: 0,
    gcTime: 30_000,
  });
}
