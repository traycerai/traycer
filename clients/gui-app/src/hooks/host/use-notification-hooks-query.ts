import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { notificationsMutationKeys } from "@/lib/query-keys";

export type NotificationHooksStatusQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.status">,
  HostRpcError
>;
export type NotificationHooksTestMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
  { readonly hostId: string | null }
>;
export type NotificationHooksSaveMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.save">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notificationHooks.save">,
  { readonly hostId: string | null }
>;

export function useNotificationHooksStatus(): NotificationHooksStatusQuery {
  return useNotificationHooksStatusForClient(useHostClient());
}

export function useNotificationHooksStatusForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksStatusQuery {
  return useHostQuery<HostRpcRegistry, "host.notificationHooks.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.notificationHooks.status",
    params: {},
    options: null,
  });
}

export function useNotificationHooksTest(): NotificationHooksTestMutation {
  return useNotificationHooksTestForClient(useHostClient());
}

export function useNotificationHooksTestForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksTestMutation {
  return useHostScopedMutationForClient(client, {
    method: "host.notificationHooks.test",
    mutationKey: notificationsMutationKeys.testHook(),
    errorMessage: "Couldn't run the hook test.",
    invalidateMethods: ["host.notificationHooks.status"],
  });
}

export function useNotificationHooksSave(): NotificationHooksSaveMutation {
  return useNotificationHooksSaveForClient(useHostClient());
}

export function useNotificationHooksSaveForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksSaveMutation {
  return useHostScopedMutationForClient(client, {
    method: "host.notificationHooks.save",
    mutationKey: notificationsMutationKeys.saveHooks(),
    errorMessage: "Couldn't save notification hooks.",
    invalidateMethods: ["host.notificationHooks.status"],
  });
}
