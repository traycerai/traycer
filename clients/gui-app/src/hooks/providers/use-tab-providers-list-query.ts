import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { QueryActivityOptions } from "@/hooks/harnesses/use-gui-harness-catalog";

const PROVIDERS_LIST_REFRESH_MS = 15 * 60 * 1_000;

/**
 * Tab-scoped `providers.list`: identical to `useProvidersList` but bound to the
 * CURRENT tab's host (`useTabHostClient`) rather than the app-wide active
 * host. The composer runs turns on the tab's host and those two scopes can
 * diverge (CLAUDE.md host model), so the re-auth gate must read auth from the
 * host the turn actually runs on. Keyed on the tab host id, so it dedupes
 * with the banner's context-reprovided read of the same provider state.
 */
export function useTabProvidersList(
  activity: QueryActivityOptions,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
> {
  const client = useTabHostClient();
  return useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: PROVIDERS_LIST_REFRESH_MS,
    },
  });
}
