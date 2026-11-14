import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloudMutation } from "@/hooks/environment/use-environment-cloud";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Every save addresses the row revision the editor read, including creates. */
export function useConfigurationItemMutations() {
  const queries = useQueryClient();
  // Every page projection of this configuration, on every scope that read it,
  // and no other configuration. A conflict rereads the current value just as a
  // successful save does; a `forbidden` answer rereads the reader's role,
  // which `environment.list` carries and this invalidation includes.
  const reread = (environmentId: string): void => {
    invalidateConfigurationReads(queries, environmentId, [
      "environment.configuration.items",
    ]);
  };
  const put = useEnvironmentCloudMutation({
    method: "environment.configuration.items.put",
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    errorMessage: "Couldn't save these settings.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const remove = useEnvironmentCloudMutation({
    method: "environment.configuration.items.delete",
    mutationKey: environmentMutationKeys.configurationItemsDelete(),
    errorMessage: "Couldn't remove these settings.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  return { put, remove };
}
