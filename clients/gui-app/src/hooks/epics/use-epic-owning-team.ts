import { use, useCallback, useSyncExternalStore } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  currentTasksPinTailQueryKeyMatchesScope,
  epicPinReadingQueryKeyMatchesScope,
  cloudTaskCachesIncludeTeamTask,
  readEpicOwningTeamIdFromCloudTaskCaches,
  type CloudEpicTasksCacheScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The team that owns an epic, read from
 * the task lists already cached for the person (History and the pin readings
 * fill them; this reads, it never fetches). `null` while no cached row names
 * the epic, and for an epic no team owns. Outside a query client, `null`.
 */
export function useEpicOwningTeamId(epicId: string): string | null {
  return useCloudTaskCacheRead<string | null>(null, (queryClient, scope) =>
    epicId.length === 0
      ? null
      : readEpicOwningTeamIdFromCloudTaskCaches(queryClient, scope, epicId),
  );
}

/**
 * Whether the person has any cached task owned by `teamId`. `false` for
 * `null`, and while nothing cached says so.
 */
export function usePersonHasTeamTask(teamId: string | null): boolean {
  return useCloudTaskCacheRead<boolean>(false, (queryClient, scope) =>
    teamId === null
      ? false
      : cloudTaskCachesIncludeTeamTask(queryClient, scope, teamId),
  );
}

/**
 * A read over the person's cached task lists, re-run when one of them moves.
 * Reads, never fetches; `fallback` outside a query client or signed out.
 */
function useCloudTaskCacheRead<T extends string | boolean | null>(
  fallback: T,
  read: (queryClient: QueryClient, scope: CloudEpicTasksCacheScope) => T,
): T {
  const queryClient = use(QueryClientContext) ?? null;
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const subscribe = useCallback(
    (callback: () => void) => {
      if (queryClient === null || userId === null) return () => undefined;
      const scope = { hostId: null, userId };
      // Only the task lists this reads: every other query's events would
      // otherwise re-scan them for nothing.
      const cache = queryClient.getQueryCache();
      return cache.subscribe((event) => {
        // A removed query is no longer in the cache to look up, so any
        // removal re-reads: removals are rare, and one may be a task list.
        if (event.type === "removed") {
          callback();
          return;
        }
        // Looked up by hash for a typed key: the event's own query is `any`.
        const key = cache.get(event.query.queryHash)?.queryKey ?? [];
        if (
          cloudEpicTasksQueryKeyMatchesScope(key, scope) ||
          epicPinReadingQueryKeyMatchesScope(key, scope) ||
          currentTasksPinTailQueryKeyMatchesScope(key, scope)
        ) {
          callback();
        }
      });
    },
    [queryClient, userId],
  );
  const getSnapshot = useCallback((): T => {
    if (queryClient === null || userId === null) return fallback;
    return read(queryClient, { hostId: null, userId });
  }, [fallback, queryClient, read, userId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
