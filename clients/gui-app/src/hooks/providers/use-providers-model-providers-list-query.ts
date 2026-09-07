import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProvidersListModelProvidersResponse } from "@traycer/protocol/host/provider-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Quiet on purpose: a cold read can start the managed OpenCode server. Auth mutations invalidate this key; there is nothing for a timer to discover.
 */
const MODEL_PROVIDERS_LIST_STALE_MS = 60_000;

export function useProvidersModelProvidersList(args: {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
}): UseQueryResult<ProvidersListModelProvidersResponse, HostRpcError> {
  const client = useHostClient();
  const params = useMemo(
    () => ({ providerId: args.providerId }),
    [args.providerId],
  );
  return useHostQuery<HostRpcRegistry, "providers.listModelProviders">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.listModelProviders",
    params,
    options: {
      enabled: args.enabled,
      staleTime: MODEL_PROVIDERS_LIST_STALE_MS,
    },
  });
}
