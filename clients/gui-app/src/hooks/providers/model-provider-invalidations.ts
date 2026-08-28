import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { modelProvidersQueryKeys } from "@/lib/query-keys/model-providers-query-keys";

/**
 * What a SETTLED upstream credential mutation retires, in one place so the
 * connect/disconnect mutation, the OAuth poll and the OAuth cancel cannot
 * disagree about it.
 *
 * Two shared model-provider caches, plus OpenCode's account-usage cache:
 *
 * 1. The catalog itself - `connected`, `source` and the disconnect affordance
 *    all move.
 * 2. `agent.gui.listModels` - the point of connecting a provider is that its
 *    models appear in the picker. That cache is `staleTime: Infinity` by
 *    design, so without this it would serve the pre-connect list for the rest
 *    of the app session.
 * 3. OpenCode Go usage - an auth-store mutation can change the Go key, so its
 *    renderer-only last-good snapshot must be dropped before another read.
 *
 * Called only for a `done` result. A `pending` OAuth attempt has changed
 * nothing yet, and invalidating on it would re-list (and so re-lease a managed
 * server) on every poll tick.
 *
 * In-flight fetches on both scopes are cancelled before invalidating: a
 * request started before the mutation carries the pre-mutation state, and if
 * left running it can settle after the invalidation and publish that stale
 * snapshot over the fresh one.
 */
export async function invalidateAfterModelProviderMutation(args: {
  readonly queryClient: QueryClient;
  readonly hostId: string | null;
  readonly providerId: ProviderId;
}): Promise<void> {
  if (args.hostId === null) return;
  const listScope = {
    queryKey: modelProvidersQueryKeys.listScope(args.hostId),
  };
  const catalogScope = {
    queryKey: modelProvidersQueryKeys.modelCatalogScope(args.hostId),
  };
  const rateLimitScope = {
    queryKey: queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
      args.hostId,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "opencode",
        profileId: null,
      },
    ),
    exact: true,
  };
  await Promise.all([
    args.queryClient.cancelQueries(listScope),
    args.queryClient.cancelQueries(catalogScope),
    ...(args.providerId === "opencode"
      ? [args.queryClient.cancelQueries(rateLimitScope)]
      : []),
  ]);
  if (args.providerId === "opencode") {
    void args.queryClient.resetQueries(rateLimitScope);
  }
  void args.queryClient.invalidateQueries(listScope);
  void args.queryClient.invalidateQueries(catalogScope);
}
