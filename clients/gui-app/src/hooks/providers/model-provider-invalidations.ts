import type { QueryClient } from "@tanstack/react-query";
import { modelProvidersQueryKeys } from "@/lib/query-keys/model-providers-query-keys";

/**
 * What a SETTLED upstream credential mutation retires, in one place so the
 * connect/disconnect mutation, the OAuth poll and the OAuth cancel cannot
 * disagree about it.
 *
 * Two caches, for two different reasons:
 *
 * 1. The catalog itself - `connected`, `source` and the disconnect affordance
 *    all move.
 * 2. `agent.gui.listModels` - the point of connecting a provider is that its
 *    models appear in the picker. That cache is `staleTime: Infinity` by
 *    design, so without this it would serve the pre-connect list for the rest
 *    of the app session.
 *
 * Called only for a `done` result. A `pending` OAuth attempt has changed
 * nothing yet, and invalidating on it would re-list (and so re-lease a managed
 * server) on every poll tick.
 */
export function invalidateAfterModelProviderMutation(args: {
  readonly queryClient: QueryClient;
  readonly hostId: string | null;
}): void {
  if (args.hostId === null) return;
  void args.queryClient.invalidateQueries({
    queryKey: modelProvidersQueryKeys.listScope(args.hostId),
  });
  void args.queryClient.invalidateQueries({
    queryKey: modelProvidersQueryKeys.modelCatalogScope(args.hostId),
  });
}
