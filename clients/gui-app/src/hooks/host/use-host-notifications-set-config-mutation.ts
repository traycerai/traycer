import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { notificationsMutationKeys } from "@/lib/query-keys";

const NOTIFICATIONS_CONFIG_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["host.notifications.getConfig"];

export function useHostNotificationsSetConfig(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.setConfig">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notifications.setConfig">,
  { readonly hostId: string | null }
> {
  return useHostNotificationsSetConfigForClient(useHostClient());
}

export function useHostNotificationsSetConfigForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.setConfig">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notifications.setConfig">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "host.notifications.setConfig",
    mutationKey: notificationsMutationKeys.setConfig(),
    errorMessage: "Couldn't save notification settings.",
    invalidateMethods: NOTIFICATIONS_CONFIG_INVALIDATIONS,
  });
}
