import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { notificationsMutationKeys } from "@/lib/query-keys";

export type LongTurnAlertQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.getLongTurnAlert">,
  HostRpcError
>;

export type SetLongTurnAlertMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.setLongTurnAlert">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notifications.setLongTurnAlert">,
  { readonly hostId: string | null }
>;

const LONG_TURN_ALERT_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["host.notifications.getLongTurnAlert"];

export function useHostLongTurnAlertForClient(
  client: HostClient<HostRpcRegistry> | null,
): LongTurnAlertQuery {
  return useHostQuery<HostRpcRegistry, "host.notifications.getLongTurnAlert">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.notifications.getLongTurnAlert",
    params: {},
    options: null,
  });
}

export function useHostSetLongTurnAlertForClient(
  client: HostClient<HostRpcRegistry> | null,
): SetLongTurnAlertMutation {
  return useHostScopedMutationForClient(client, {
    method: "host.notifications.setLongTurnAlert",
    mutationKey: notificationsMutationKeys.setLongTurnAlert(),
    errorMessage: "Couldn't save the turn alert.",
    invalidateMethods: LONG_TURN_ALERT_INVALIDATIONS,
  });
}
