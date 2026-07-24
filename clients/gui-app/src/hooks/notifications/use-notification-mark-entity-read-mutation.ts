import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromBackgroundHostError } from "@/lib/host-error-toast";
import { invalidateNotificationIndicatorsForEntities } from "@/lib/notifications/notification-indicator-cache";
import { notificationsMutationKeys } from "@/lib/query-keys";

interface HostNotificationEntityReadContext {
  readonly hostId: string | null;
}

export function useNotificationMarkEntityRead(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.markRead">,
  HostRpcError,
  HostNotificationsEntityRef,
  HostNotificationEntityReadContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.notifications.markRead",
    HostNotificationEntityReadContext,
    HostNotificationsEntityRef
  >({
    client,
    method: "host.notifications.markRead",
    mapVariables: (entity) => ({ kind: "entity", entity }),
    options: {
      mutationKey: notificationsMutationKeys.markEntityRead(),
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      onSuccess: (_data, entity, context) => {
        if (context.hostId === null) return;
        if ((client.getActiveHostId() ?? null) !== context.hostId) return;
        invalidateNotificationIndicatorsForEntities(
          queryClient,
          context.hostId,
          [entity],
          client,
        );
      },
      onError: (error) => {
        toastFromBackgroundHostError(
          error,
          "Couldn't mark viewed notifications as read.",
        );
      },
    },
  });
}
