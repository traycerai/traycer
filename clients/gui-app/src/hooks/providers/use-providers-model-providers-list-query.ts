import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProvidersListModelProvidersResponse } from "@traycer/protocol/host/provider-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The upstream LLM provider catalog for one Traycer provider.
 *
 * A cold read can START the managed OpenCode server (the host leases it lazily),
 * so this query is deliberately quiet: no polling policy in the method table,
 * and a stale window long enough that re-opening the tab inside it reuses the
 * cache. The catalog only changes as a result of an auth mutation on this same
 * surface, and those invalidate this key directly - there is nothing for a timer
 * to discover.
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
