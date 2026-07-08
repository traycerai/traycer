import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { QueryActivityOptions } from "@/hooks/harnesses/use-gui-harness-catalog";

const PROVIDERS_LIST_REFRESH_MS = 15 * 60 * 1000;
const PROVIDERS_LIST_PENDING_REFRESH_MS = 800;

export function useProvidersList(
  activity: QueryActivityOptions,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: PROVIDERS_LIST_REFRESH_MS,
      // The host returns the list immediately with pending version/auth
      // probes. Poll quickly while probes are pending; once settled, refresh
      // only on the steady catalog cadence while this query stays mounted.
      refetchInterval: (query) => {
        const data = query.state.data;
        const pending =
          data?.providers.some(
            (p) =>
              p.authPending ||
              p.availabilityPending ||
              p.candidates.some((c) => c.versionPending),
          ) ?? false;
        return pending
          ? PROVIDERS_LIST_PENDING_REFRESH_MS
          : PROVIDERS_LIST_REFRESH_MS;
      },
    },
  });
}
