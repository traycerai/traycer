import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

export interface WorktreeQuerySuccessOrder {
  orderFor(queryKey: readonly unknown[]): number;
}

const worktreeQuerySuccessOrders = new WeakMap<
  QueryClient,
  WorktreeQuerySuccessOrder
>();

/**
 * Install when the QueryClient is created, before either the shared listing
 * or a selection can populate its cache. TanStack's dataUpdatedAt has only
 * millisecond resolution, so same-tick updates need their success order too.
 */
export function worktreeQuerySuccessOrderFor(
  queryClient: QueryClient,
): WorktreeQuerySuccessOrder {
  const existing = worktreeQuerySuccessOrders.get(queryClient);
  if (existing !== undefined) return existing;
  const queryCache = queryClient.getQueryCache();
  const orderByQuery = new WeakMap<object, number>();
  let nextOrder = 0;
  queryCache.subscribe((event) => {
    const queryKey: unknown = event.query.queryKey;
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      !Array.isArray(queryKey) ||
      !hostQueryKeys.matchesMethodOnAnyHost(queryKey, "worktree.listAllForHost")
    )
      return;
    nextOrder += 1;
    orderByQuery.set(event.query, nextOrder);
  });
  const tracker: WorktreeQuerySuccessOrder = {
    orderFor: (queryKey) => {
      const query = queryCache.find({ queryKey, exact: true });
      return query === undefined ? 0 : (orderByQuery.get(query) ?? 0);
    },
  };
  worktreeQuerySuccessOrders.set(queryClient, tracker);
  return tracker;
}
