import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { modelProvidersQueryKeys } from "@/lib/query-keys/model-providers-query-keys";

/** Call only for a done credential mutation. Cancel in-flight fetches before invalidating so a pre-mutation response cannot overwrite the fresh catalog. */
export async function invalidateAfterModelProviderMutation(args: {
  readonly queryClient: QueryClient;
  readonly hostId: string | null;
  readonly providerId: ProviderId;
}): Promise<void> {
  if (args.hostId === null) return;
  const listScope = {
    queryKey: modelProvidersQueryKeys.listScope(args.hostId),
  };
  const catalogScope = {
    queryKey: modelProvidersQueryKeys.modelCatalogScope(args.hostId),
  };
  const rateLimitScope = {
    queryKey: queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
      args.hostId,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "opencode",
        profileId: null,
      },
    ),
    exact: true,
  };
  await Promise.all([
    args.queryClient.cancelQueries(listScope),
    args.queryClient.cancelQueries(catalogScope),
    ...(args.providerId === "opencode"
      ? [args.queryClient.cancelQueries(rateLimitScope)]
      : []),
  ]);
  if (args.providerId === "opencode") {
    void args.queryClient.resetQueries(rateLimitScope);
  }
  void args.queryClient.invalidateQueries(listScope);
  void args.queryClient.invalidateQueries(catalogScope);
}
