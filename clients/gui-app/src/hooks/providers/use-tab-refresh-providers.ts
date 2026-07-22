import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { toastFromHostError } from "@/lib/host-error-toast";
import { commitAuthoritativeProvidersList } from "@/hooks/providers/commit-authoritative-providers-list";

type ProvidersListRequest = RequestOfMethod<HostRpcRegistry, "providers.list">;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

/**
 * Tab-scoped twin of `useRefreshProviders`: force-refreshes provider auth on the
 * CURRENT tab's host (not the app-wide active host) and writes the result
 * under that host's `providers.list` key, so the re-auth gate reflects the
 * host the composer actually runs turns on. The tab host is fixed for the
 * tab's life, so there is no host-swap race to capture in `onMutate`.
 */
export function useTabRefreshProviders(): () => Promise<void> {
  const client = useTabHostClient();
  const tabHostId = useTabHostId();
  const queryClient = useQueryClient();
  const mutation = useHostMutation<HostRpcRegistry, "providers.list">({
    client,
    method: "providers.list",
    mapVariables: (variables: ProvidersListRequest) => variables,
    options: {
      mutationKey: providersMutationKeys.refresh(),
      onSuccess: async (data: ProvidersListResponse) => {
        await commitAuthoritativeProvidersList({
          queryClient,
          hostId: tabHostId,
          update: () => data,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh providers."),
    },
  });

  const { mutateAsync } = mutation;
  return useCallback(async () => {
    if (client === null) return;
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        tabHostId,
        "providers.list",
        {},
      ),
    );
    await mutateAsync({ forceAuthRefresh: true });
  }, [client, mutateAsync, queryClient, tabHostId]);
}
