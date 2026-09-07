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
 * `providers.list` on the current tab's host (`useTabHostClient`), not the app-wide active host.
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
    params: { native: null },
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: PROVIDERS_LIST_REFRESH_MS,
    },
  });
}
