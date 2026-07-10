import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useHostNotificationsConfig(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.getConfig">,
  HostRpcError
> {
  return useHostNotificationsConfigForClient(useHostClient());
}

export function useHostNotificationsConfigForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.getConfig">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "host.notifications.getConfig">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.notifications.getConfig",
    params: {},
    options: null,
  });
}
