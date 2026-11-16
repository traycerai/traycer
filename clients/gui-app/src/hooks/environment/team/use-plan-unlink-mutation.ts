import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloudMutation } from "@/hooks/environment/use-environment-cloud";
import { environmentMutationKeys } from "@/lib/query-keys";

export function useConfigurationPlanUnlinkMutation() {
  const queries = useQueryClient();
  return useEnvironmentCloudMutation({
    method: "environment.plans.unlink",
    mutationKey: environmentMutationKeys.plansUnlink(),
    errorMessage: "Couldn't unlink this plan.",
    invalidateMethods: ["environment.list"],
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.plans.list",
        "environment.configuration.items",
      ]),
  });
}
