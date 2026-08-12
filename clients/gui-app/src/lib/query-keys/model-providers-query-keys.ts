import type { QueryKey } from "@tanstack/react-query";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Keys for the Model Providers surface (upstream LLM credentials).
 *
 * Its own module rather than an arm of `providers-native-query-keys.ts`: that
 * family exists because MCP/plugins/skills all ride the `providers.list`
 * carrier with a `native` query and therefore need a semantic suffix to stay
 * out of the classic catalog's cache slot. These four methods are dedicated
 * RPCs, so the ordinary `["host", hostId, method, params]` shape already
 * separates them and there is nothing to disambiguate.
 */
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

  /**
   * The model catalog a credential mutation must retire.
   *
   * Connecting or disconnecting an upstream provider changes WHICH MODELS the
   * host can offer, and `agent.gui.listModels` is cached with
   * `staleTime: Infinity` (see `use-gui-harness-catalog.ts`) precisely so that
   * nothing refetches it on its own. Without this invalidation the model picker
   * would keep serving the pre-mutation list for the rest of the app session -
   * the one place the user goes to see that the connect worked.
   *
   * `agent.gui.listHarnesses` is deliberately NOT invalidated: harness
   * availability is a property of the installed CLI, which an upstream
   * credential does not touch, and re-probing every harness is the fan-out
   * `useRefreshHarnessCatalog` exists to keep behind an explicit user action.
   */
  modelCatalogScope: (hostId: string | null): QueryKey =>
    hostQueryKeys.methodScope(hostId, "agent.gui.listModels"),
};
