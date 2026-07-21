import type { QueryClient } from "@tanstack/react-query";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys } from "@/lib/query-keys";

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

/**
 * Commits the one authoritative providers snapshot only after cancelling the
 * ordinary list observer that could otherwise publish an older raw response.
 */
export async function commitAuthoritativeProvidersList(args: {
  readonly queryClient: QueryClient;
  readonly hostId: string;
  readonly update: (
    previous: ProvidersListResponse | undefined,
  ) => ProvidersListResponse | undefined;
}): Promise<void> {
  const queryKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
    args.hostId,
    "providers.list",
    {},
  );
  await args.queryClient.cancelQueries({ queryKey, exact: true });
  args.queryClient.setQueryData<ProvidersListResponse>(queryKey, args.update);
  await Promise.all(
    PROVIDER_INVALIDATIONS.filter((method) => method !== "providers.list").map(
      (method) =>
        args.queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(args.hostId, method),
        }),
    ),
  );
}
