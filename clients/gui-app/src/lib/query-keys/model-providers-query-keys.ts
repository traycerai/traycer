import type { QueryKey } from "@tanstack/react-query";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/** Keys for the Model Providers surface (upstream LLM credentials). */
export const modelProvidersQueryKeys = {
  /** One provider's upstream catalog. */
  list: (hostId: string | null, providerId: ProviderId): QueryKey =>
    hostQueryKeys.method<HostRpcRegistry, "providers.listModelProviders">(
      hostId,
      "providers.listModelProviders",
      { providerId },
    ),

  /** Every cached catalog on a host, whatever provider. */
  listScope: (hostId: string | null): QueryKey =>
    hostQueryKeys.methodScope(hostId, "providers.listModelProviders"),

  /** The model catalog a credential mutation must retire. */
  modelCatalogScope: (hostId: string | null): QueryKey =>
    hostQueryKeys.methodScope(hostId, "agent.gui.listModels"),
};
