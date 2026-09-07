import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { toastFromHostError } from "@/lib/host-error-toast";
import { commitAuthoritativeProvidersList } from "@/hooks/providers/commit-authoritative-providers-list";

type ProvidersListRequest = RequestOfMethod<HostRpcRegistry, "providers.list">;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

type RefreshContext = {
  readonly hostId: string | null;
};

/** Returns a function that force-refreshes provider auth for the active host, then invalidates harness availability that provider changes can affect. */
export function useRefreshProviders(): () => Promise<void> {
  return useRefreshProvidersForClient(useHostClient());
}

/**
 * Client-scoped refresh of the host `client` addresses. Forced (`forceAuthRefresh: true`), not invalidated: a plain refetch re-serves the TTL-stale signed-out verdict.
 */
export function useRefreshProvidersForClient(
  client: HostClient<HostRpcRegistry> | null,
): () => Promise<void> {
  const queryClient = useQueryClient();
  const mutation = useHostMutation<
    HostRpcRegistry,
    "providers.list",
    RefreshContext
  >({
    client,
    method: "providers.list",
    mapVariables: (variables: ProvidersListRequest) => variables,
    options: {
      mutationKey: providersMutationKeys.refresh(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (data: ProvidersListResponse, _variables, ctx) => {
        if (ctx.hostId === null) return;
        // Drops the harness catalogs alongside the list, which is what makes good on this hook's contract under auto-enablement: a refresh can now change which providers are available at all - a terminal sign-in completing is observed exactly here - so the catalogs must move with it.
        await commitAuthoritativeProvidersList({
          queryClient,
          hostId: ctx.hostId,
          update: () => data,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh providers."),
    },
  });

  // Depend on the stable `mutateAsync`, NOT the whole `mutation` object - the latter is a fresh reference every render, which made this callback (and thus the providers panel's `onRefresh`) churn on every render and re-render the refresh control on each provider-fetch tick.
  const { mutateAsync } = mutation;
  return useCallback(async () => {
    const hostId = client?.getActiveHostId() ?? null;
    if (hostId === null) return;
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        hostId,
        "providers.list",
        { native: null },
      ),
    );
    await mutateAsync({ forceAuthRefresh: true, native: null });
  }, [client, mutateAsync, queryClient]);
}
