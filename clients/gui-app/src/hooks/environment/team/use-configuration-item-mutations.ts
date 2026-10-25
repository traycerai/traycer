import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

/** Every save addresses the row revision the editor read, including creates. */
export function useConfigurationItemMutations() {
  const client = useHostClient();
  const queries = useQueryClient();
  const reread = (
    environmentId: string,
    hostId: string | null,
    result: EnvironmentConfigurationItemWriteResponse,
  ): void => {
    // Every page projection of this configuration, on every host that read
    // it, and no other configuration.
    invalidateConfigurationReads(queries, environmentId, [
      "environment.configuration.items",
    ]);
    if (hostId === null || result.outcome !== "forbidden") return;
    void queries.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(
        hostRpcServingTierHostId(
          "environment.list",
          hostId,
          readProcessHostRpcTierPlan(),
          null,
        ),
        "environment.list",
      ),
    });
  };
  const put = useHostScopedMutationForClient(client, {
    method: "environment.configuration.items.put",
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    errorMessage: "Couldn't save these settings.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.items.put")();
      return Promise.resolve(request);
    },
    // A conflict rereads the current value just as a successful save does.
    onSuccess: (result, request, hostId) =>
      reread(request.environmentId, hostId, result),
  });
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.configuration.items.delete",
    mutationKey: environmentMutationKeys.configurationItemsDelete(),
    errorMessage: "Couldn't remove these settings.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.items.delete")();
      return Promise.resolve(request);
    },
    onSuccess: (result, request, hostId) =>
      reread(request.environmentId, hostId, result),
  });
  return { put, remove };
}
