import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { toastFromHostError } from "@/lib/host-error-toast";

type ProvidersListRequest = RequestOfMethod<HostRpcRegistry, "providers.list">;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

type RefreshContext = {
  readonly hostId: string | null;
};

/**
 * Returns a function that force-refreshes provider auth for the active host,
 * then invalidates harness availability that provider changes can affect.
 * Resolves once the triggered work settles so the caller can drive a spinner.
 */
export function useRefreshProviders(): () => Promise<void> {
  const client = useHostClient();
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
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (data: ProvidersListResponse, _variables, ctx) => {
        if (ctx.hostId === null) return;
        queryClient.setQueryData(
          hostQueryKeys.method<HostRpcRegistry, "providers.list">(
            ctx.hostId,
            "providers.list",
            { native: null },
          ),
          data,
        );
        for (const method of PROVIDER_INVALIDATIONS.filter(
          (entry) => entry !== "providers.list",
        )) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(ctx.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh providers."),
    },
  });

  // Depend on the stable `mutateAsync`, NOT the whole `mutation` object - the
  // latter is a fresh reference every render, which made this callback (and thus
  // the providers panel's `onRefresh`) churn on every render and re-render the
  // refresh control on each provider-fetch tick.
  const { mutateAsync } = mutation;
  return useCallback(async () => {
    if (client.getActiveHostId() === null) return;
    await mutateAsync({ forceAuthRefresh: true, native: null });
  }, [client, mutateAsync]);
}
