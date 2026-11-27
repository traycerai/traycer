import type { QueryClient, QueryKey } from "@tanstack/react-query";

export { SANDBOX_COST_REFRESH_MS } from "@traycer-clients/shared/host-client/sandbox-cost-list";

const queuedRefreshes = new WeakSet<object>();

/**
 * The transport keeps reading even when TanStack replaces a fetch. Join a
 * pending fetch and save one refresh for when it succeeds, so a burst of
 * invalidations cannot restart a ledger read or immediately retry a failure.
 */
export function refreshSandboxCostQueries(
  client: QueryClient,
  queryKey: QueryKey,
): void {
  const active = client.getQueryCache().findAll({ queryKey, type: "active" });
  for (const query of active) {
    const pending = query.promise;
    if (
      query.state.fetchStatus === "idle" ||
      pending === undefined ||
      queuedRefreshes.has(query)
    ) {
      continue;
    }
    queuedRefreshes.add(query);
    void pending.then(
      () => {
        queuedRefreshes.delete(query);
        if (!query.isActive()) return;
        void client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
      },
      () => queuedRefreshes.delete(query),
    );
  }
  void client.invalidateQueries({ queryKey }, { cancelRefetch: false });
}
